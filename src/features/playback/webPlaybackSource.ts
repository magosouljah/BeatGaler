import { measureMp3PlayablePrefix } from "../audio/mp3PlayablePrefix";
import type { BeatCardWarmPriority } from "./webVisiblePlaybackPrefetch";
import {
  WEB_PLAYBACK_PREFETCH_MAX_BYTES,
  WEB_PLAYBACK_PREFETCH_TARGET_SECONDS,
  type WebTransportPrefetchBatchResult,
  type WebTransportPrefetchChunk,
  type WebTransportPrefetchInput,
  type WebTransportPrefetchResult,
  type WebTransportStreamInput,
  type WebTransportStreamResult,
} from "../cloud/webTransportWorkerProtocol";
import { playTrace } from "./playTrace";

export interface WebPlaybackTransport {
  prefetchFile?(input: WebTransportPrefetchInput): Promise<WebTransportPrefetchResult>;
  prefetchFiles(
    inputs: WebTransportPrefetchInput[],
    onChunk?: (progress: WebTransportPrefetchChunk) => void,
  ): Promise<{
    completed: Promise<WebTransportPrefetchBatchResult>;
    cancelMessage(messageId: number): void;
    cancel(): void;
  }>;
  streamFile(
    input: WebTransportStreamInput,
    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
  ): Promise<{ completed: Promise<WebTransportStreamResult>; cancel(): void }>;
}

export interface PreparedWebPlayback {
  url: string;
  completed: Promise<void>;
}

export interface WebPlaybackRuntimeState {
  beatId: string;
  currentTime: number;
  playing: boolean;
  waiting: boolean;
}

type QueuedChunk = {
  chunk: ArrayBuffer;
  origin: "prefetch" | "stream";
  appendSequence?: number;
  appendStartedAtMs?: number;
  resolve(): void;
  reject(error: Error): void;
};

type PlaybackEntry = {
  beatId: string;
  messageId: number;
  mimeType: string;
  url: string;
  cancel: (() => void) | null;
  released: boolean;
  completed: Promise<void>;
  mediaSource: MediaSource | null;
  sourceBuffer: SourceBuffer | null;
  queue: QueuedChunk[];
  appending: QueuedChunk | null;
  streamDone: boolean;
  failed: boolean;
  cachedBytes: number;
  cachedChunks: ArrayBuffer[];
  lastUsedAt: number;
  playbackObserved: boolean;
  playbackCurrentTime: number;
  playbackPlaying: boolean;
  playbackWaiting: boolean;
  streamDemandWaiters: Set<() => void>;
};

type PrefetchedPrefix = {
  beatId: string;
  messageId: number;
  mimeType: string;
  totalBytes: number;
  prefix: ArrayBuffer;
  playableSeconds: number;
  targetMet: boolean;
  exhausted: boolean;
  priority: BeatCardWarmPriority;
  lastUsedAt: number;
};

type PrefetchJob = {
  key: string;
  beatId: string;
  messageId: number;
  mimeType: string;
  priority: Exclude<BeatCardWarmPriority, "far">;
  inFlight: boolean;
  settled: boolean;
  resolve(): void;
  reject(error: Error): void;
};

type ActivePrefetchBatch = {
  priority: Exclude<BeatCardWarmPriority, "far">;
  jobs: PrefetchJob[];
  handle: Awaited<ReturnType<WebPlaybackTransport["prefetchFiles"]>> | null;
  preempted: boolean;
};

const DEFAULT_SESSION_CACHE_LIMIT_MB = 100;
const PREFETCH_FAILURE_COOLDOWN_MS = 10_000;
const PLAYBACK_BUFFER_AHEAD_TARGET_SECONDS = 1;

function supportsMediaSource(mimeType: string): boolean {
  return typeof MediaSource !== "undefined" &&
    typeof MediaSource.isTypeSupported === "function" &&
    MediaSource.isTypeSupported(mimeType);
}

function abortError(): DOMException {
  return new DOMException("Playback stream cancelled.", "AbortError");
}

function chunkBytes(chunks: readonly ArrayBuffer[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
}

function appendArrayBuffer(left: ArrayBuffer, right: ArrayBuffer): ArrayBuffer {
  if (left.byteLength === 0) return right.slice(0);
  if (right.byteLength === 0) return left.slice(0);
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(new Uint8Array(left), 0);
  output.set(new Uint8Array(right), left.byteLength);
  return output.buffer;
}

function traceNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function roundTraceSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sourceBufferSnapshot(sourceBuffer: SourceBuffer | null): {
  buffered_ranges: number;
  buffered_start_s: number | null;
  buffered_end_s: number | null;
  buffered_duration_s: number;
} {
  if (!sourceBuffer) {
    return { buffered_ranges: 0, buffered_start_s: null, buffered_end_s: null, buffered_duration_s: 0 };
  }
  try {
    const buffered = sourceBuffer.buffered;
    if (!buffered || buffered.length <= 0) {
      return { buffered_ranges: 0, buffered_start_s: null, buffered_end_s: null, buffered_duration_s: 0 };
    }
    let totalDuration = 0;
    let firstStart: number | null = null;
    let lastEnd: number | null = null;
    for (let index = 0; index < buffered.length; index += 1) {
      const start = buffered.start(index);
      const end = buffered.end(index);
      if (firstStart === null) firstStart = start;
      lastEnd = end;
      totalDuration += Math.max(0, end - start);
    }
    return {
      buffered_ranges: buffered.length,
      buffered_start_s: firstStart === null ? null : roundTraceSeconds(firstStart),
      buffered_end_s: lastEnd === null ? null : roundTraceSeconds(lastEnd),
      buffered_duration_s: roundTraceSeconds(totalDuration),
    };
  } catch {
    return { buffered_ranges: 0, buffered_start_s: null, buffered_end_s: null, buffered_duration_s: 0 };
  }
}

function bufferedAheadSeconds(sourceBuffer: SourceBuffer | null, currentTime: number): number {
  if (!sourceBuffer) return 0;
  try {
    const ranges = sourceBuffer.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const end = ranges.end(index);
      if (currentTime >= start - 0.05 && currentTime <= end + 0.05) {
        return Math.max(0, end - currentTime);
      }
      if (currentTime < start) return 0;
    }
  } catch {}
  return 0;
}

function warmPriorityRank(priority: BeatCardWarmPriority): number {
  if (priority === "visible") return 2;
  if (priority === "nearby") return 1;
  return 0;
}

/** Owns short-lived browser playback URLs and the browser-side warm-prefix policy. */
export class WebPlaybackSourceManager {
  private entries = new Map<string, PlaybackEntry>();
  private pending = new Map<string, Promise<PreparedWebPlayback>>();
  private prefixes = new Map<string, PrefetchedPrefix>();
  private prefetchPending = new Map<string, Promise<void>>();
  private prefetchJobs = new Map<string, PrefetchJob>();
  private prefetchRetryAfter = new Map<string, number>();
  private activePrefetchBatch: ActivePrefetchBatch | null = null;
  private drainScheduled = false;
  private sessionCacheLimitBytes = DEFAULT_SESSION_CACHE_LIMIT_MB * 1024 * 1024;
  private currentPlaybackBeatId: string | null = null;

  constructor(private readonly transport: WebPlaybackTransport) {}

  prefetch(
    beatId: string,
    messageId: number,
    mimeType = "audio/mpeg",
    priority: Exclude<BeatCardWarmPriority, "far"> = "visible",
  ): Promise<void> {
    const key = `${beatId}:${messageId}`;
    const existingEntry = this.entries.get(beatId);
    if (existingEntry?.messageId === messageId && !existingEntry.released && !existingEntry.failed) {
      return Promise.resolve();
    }

    const existingPrefix = this.prefixes.get(beatId);
    if (existingPrefix?.messageId === messageId) {
      existingPrefix.priority = priority;
      existingPrefix.lastUsedAt = Date.now();
      if (existingPrefix.targetMet || existingPrefix.exhausted) return Promise.resolve();
    } else if (existingPrefix) {
      this.prefixes.delete(beatId);
    }

    const pending = this.prefetchPending.get(key);
    if (pending) {
      const job = this.prefetchJobs.get(key);
      if (job && warmPriorityRank(priority) > warmPriorityRank(job.priority)) job.priority = priority;
      if (priority === "visible") this.preemptNearbyForVisible();
      this.schedulePrefetchDrain();
      return pending;
    }

    const retryAfter = this.prefetchRetryAfter.get(key) || 0;
    const now = Date.now();
    if (retryAfter > now) {
      playTrace("SOURCE_PREFETCH_COOLDOWN", {
        beat_id: beatId,
        message_id: messageId,
        retry_in_ms: retryAfter - now,
      });
      return Promise.resolve();
    }
    if (retryAfter) this.prefetchRetryAfter.delete(key);

    let resolveJob!: () => void;
    let rejectJob!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    }).finally(() => this.prefetchPending.delete(key));
    const job: PrefetchJob = {
      key,
      beatId,
      messageId,
      mimeType,
      priority,
      inFlight: false,
      settled: false,
      resolve: resolveJob,
      reject: rejectJob,
    };
    this.prefetchPending.set(key, promise);
    this.prefetchJobs.set(key, job);
    playTrace("SOURCE_PREFETCH_QUEUED", { beat_id: beatId, message_id: messageId, priority });
    if (priority === "visible") this.preemptNearbyForVisible();
    this.schedulePrefetchDrain();
    return promise;
  }

  setPrefetchPriority(
    beatId: string,
    messageId: number,
    mimeType: string,
    priority: BeatCardWarmPriority,
  ): void {
    const prefix = this.prefixes.get(beatId);
    if (prefix?.messageId === messageId) {
      prefix.priority = priority;
      prefix.lastUsedAt = Date.now();
    }
    const key = `${beatId}:${messageId}`;
    const job = this.prefetchJobs.get(key);

    if (priority === "far") {
      if (job) {
        this.activePrefetchBatch?.handle?.cancelMessage(messageId);
        this.settlePrefetchJob(job);
      }
      this.schedulePrefetchDrain();
      return;
    }

    if (job) {
      job.priority = priority;
      if (priority === "visible") this.preemptNearbyForVisible();
      this.schedulePrefetchDrain();
      return;
    }

    const entry = this.entries.get(beatId);
    if (entry?.messageId === messageId && !entry.released && !entry.failed) return;
    if (prefix?.messageId === messageId && (prefix.targetMet || prefix.exhausted)) return;
    void this.prefetch(beatId, messageId, mimeType, priority).catch(error => {
      playTrace("SOURCE_PREFETCH_PRIORITY_ERROR", {
        beat_id: beatId,
        message_id: messageId,
        error_name: error instanceof Error ? error.name : "unknown",
      });
    });
  }

  private preemptNearbyForVisible(): void {
    const batch = this.activePrefetchBatch;
    if (!batch || batch.priority !== "nearby" || batch.preempted) return;
    batch.preempted = true;
    playTrace("SOURCE_PREFETCH_NEARBY_PREEMPT", { count: batch.jobs.length });
    batch.handle?.cancel();
  }

  private schedulePrefetchDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drainPrefetchQueue();
    });
  }

  private prefixNeedsWork(job: PrefetchJob): boolean {
    const entry = this.entries.get(job.beatId);
    if (entry?.messageId === job.messageId && !entry.released && !entry.failed) return false;
    const prefix = this.prefixes.get(job.beatId);
    if (!prefix || prefix.messageId !== job.messageId) return true;
    return !prefix.targetMet && !prefix.exhausted;
  }

  private async drainPrefetchQueue(): Promise<void> {
    if (this.activePrefetchBatch) return;
    const now = Date.now();
    const candidates = Array.from(this.prefetchJobs.values()).filter(job => {
      if (job.settled || job.inFlight || !this.prefixNeedsWork(job)) return false;
      const retryAfter = this.prefetchRetryAfter.get(job.key) || 0;
      return retryAfter <= now;
    });
    if (candidates.length === 0) return;

    const priority: Exclude<BeatCardWarmPriority, "far"> = candidates.some(job => job.priority === "visible")
      ? "visible"
      : "nearby";
    const jobs = candidates.filter(job => job.priority === priority);
    if (jobs.length === 0) return;
    for (const job of jobs) job.inFlight = true;

    const batch: ActivePrefetchBatch = { priority, jobs, handle: null, preempted: false };
    this.activePrefetchBatch = batch;
    const inputs = jobs.map(job => ({
      messageId: job.messageId,
      mimeType: job.mimeType,
      offsetBytes: this.prefixes.get(job.beatId)?.messageId === job.messageId
        ? this.prefixes.get(job.beatId)!.prefix.byteLength
        : 0,
    }));
    playTrace("SOURCE_PREFETCH_BATCH_BEGIN", { priority, count: jobs.length });

    try {
      const handle = await this.transport.prefetchFiles(inputs, progress => this.acceptPrefetchChunk(batch, progress));
      batch.handle = handle;
      if (batch.preempted) handle.cancel();
      const result = await handle.completed;
      this.completePrefetchBatch(batch, result);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const retryAt = Date.now() + PREFETCH_FAILURE_COOLDOWN_MS;
      for (const job of jobs) {
        if (job.settled) continue;
        this.prefetchRetryAfter.set(job.key, retryAt);
        this.settlePrefetchJob(job, failure);
      }
      playTrace("SOURCE_PREFETCH_BATCH_ERROR", {
        priority,
        count: jobs.length,
        error_name: failure.name,
      });
    } finally {
      for (const job of jobs) job.inFlight = false;
      if (this.activePrefetchBatch === batch) this.activePrefetchBatch = null;
      this.schedulePrefetchDrain();
    }
  }

  private acceptPrefetchChunk(batch: ActivePrefetchBatch, progress: WebTransportPrefetchChunk): void {
    const job = batch.jobs.find(candidate => candidate.messageId === progress.messageId && !candidate.settled);
    if (!job) return;
    const current = this.prefixes.get(job.beatId);
    const existing = current?.messageId === job.messageId ? current : null;
    const expectedOffset = existing?.prefix.byteLength || 0;
    if (progress.offsetBytes !== expectedOffset) {
      playTrace("SOURCE_PREFETCH_GAP_IGNORED", {
        beat_id: job.beatId,
        message_id: job.messageId,
        expected_offset: expectedOffset,
        received_offset: progress.offsetBytes,
      });
      return;
    }

    const prefix = appendArrayBuffer(existing?.prefix || new ArrayBuffer(0), progress.chunk);
    const measurement = measureMp3PlayablePrefix(prefix);
    const totalBytes = Math.max(existing?.totalBytes || 0, progress.totalBytes || 0, prefix.byteLength);
    const targetMet = measurement.playableSeconds >= WEB_PLAYBACK_PREFETCH_TARGET_SECONDS;
    const exhausted = prefix.byteLength >= WEB_PLAYBACK_PREFETCH_MAX_BYTES || (totalBytes > 0 && prefix.byteLength >= totalBytes);
    const next: PrefetchedPrefix = {
      beatId: job.beatId,
      messageId: job.messageId,
      mimeType: progress.mimeType || job.mimeType,
      totalBytes,
      prefix,
      playableSeconds: measurement.playableSeconds,
      targetMet,
      exhausted,
      priority: job.priority,
      lastUsedAt: Date.now(),
    };
    this.prefixes.set(job.beatId, next);
    playTrace("SOURCE_PREFETCH_PROGRESS", {
      beat_id: job.beatId,
      message_id: job.messageId,
      bytes: prefix.byteLength,
      playable_seconds: roundTraceSeconds(measurement.playableSeconds),
      target_met: targetMet,
      priority: job.priority,
    });
    this.enforceCacheBudget(this.currentPlaybackBeatId);

    if (targetMet || exhausted) {
      batch.handle?.cancelMessage(job.messageId);
      this.settlePrefetchJob(job);
      playTrace("SOURCE_PREFETCH_READY", {
        beat_id: job.beatId,
        message_id: job.messageId,
        bytes: prefix.byteLength,
        playable_seconds: roundTraceSeconds(measurement.playableSeconds),
        target_met: targetMet,
      });
    }
  }

  private completePrefetchBatch(batch: ActivePrefetchBatch, result: WebTransportPrefetchBatchResult): void {
    const byMessageId = new Map(result.results.map(item => [item.ok ? item.result.messageId : item.messageId, item]));
    for (const job of batch.jobs) {
      if (job.settled) continue;
      const item = byMessageId.get(job.messageId);
      if (item && !item.ok) {
        const failure = new Error(item.error);
        this.prefetchRetryAfter.set(job.key, Date.now() + PREFETCH_FAILURE_COOLDOWN_MS);
        this.settlePrefetchJob(job, failure);
        continue;
      }
      if (batch.preempted) continue;

      const prefix = this.prefixes.get(job.beatId);
      if (prefix?.messageId === job.messageId) {
        prefix.exhausted = prefix.exhausted || !prefix.targetMet;
        prefix.lastUsedAt = Date.now();
      }
      this.settlePrefetchJob(job);
    }
  }

  private settlePrefetchJob(job: PrefetchJob, error?: Error): void {
    if (job.settled) return;
    job.settled = true;
    this.prefetchJobs.delete(job.key);
    if (error) job.reject(error);
    else job.resolve();
  }

  private cancelPrefetchForPlayback(beatId: string, messageId: number): void {
    const key = `${beatId}:${messageId}`;
    const job = this.prefetchJobs.get(key);
    if (!job) return;
    this.activePrefetchBatch?.handle?.cancelMessage(messageId);
    this.settlePrefetchJob(job);
  }

  prepare(beatId: string, messageId: number, mimeType = "audio/mpeg"): Promise<PreparedWebPlayback> {
    this.cancelPrefetchForPlayback(beatId, messageId);
    const mediaSourceSupported = supportsMediaSource(mimeType);
    playTrace("SOURCE_PREPARE", { beat_id: beatId, mime_type: mimeType, mode: mediaSourceSupported ? "mse" : "blob" });
    const existing = this.entries.get(beatId);
    if (existing && existing.messageId !== messageId) this.hardRelease(beatId);
    const reusable = this.entries.get(beatId);
    if (reusable && !reusable.released && !reusable.failed) {
      reusable.lastUsedAt = Date.now();
      if (!reusable.streamDone) {
        playTrace("SOURCE_ACTIVE_PLAYBACK_HIT", {
          beat_id: beatId,
          message_id: messageId,
          bytes: reusable.cachedBytes,
        });
        return Promise.resolve({ url: reusable.url, completed: reusable.completed });
      }

      const availableBytes = chunkBytes(reusable.cachedChunks);
      if (availableBytes > 0 && availableBytes >= reusable.cachedBytes) {
        const previousUrl = reusable.url;
        const url = URL.createObjectURL(new Blob(reusable.cachedChunks, { type: reusable.mimeType || mimeType }));
        reusable.url = url;
        reusable.mediaSource = null;
        reusable.sourceBuffer = null;
        if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
        playTrace("SOURCE_SESSION_CACHE_HIT", {
          beat_id: beatId,
          message_id: messageId,
          complete: true,
          bytes: availableBytes,
          fresh_blob_url: true,
        });
        return Promise.resolve({ url, completed: reusable.completed });
      }

      playTrace("SOURCE_SESSION_CACHE_INVALID", {
        beat_id: beatId,
        message_id: messageId,
        expected_bytes: reusable.cachedBytes,
        available_bytes: availableBytes,
      });
      this.hardRelease(beatId);
    }
    const pending = this.pending.get(beatId);
    if (pending) return pending;
    const preparation = (mediaSourceSupported
      ? this.prepareMediaSource(beatId, messageId, mimeType)
      : this.prepareBlobFallback(beatId, messageId, mimeType)
    ).finally(() => this.pending.delete(beatId));
    this.pending.set(beatId, preparation);
    this.schedulePrefetchDrain();
    return preparation;
  }

  private takePrefix(beatId: string, messageId: number): PrefetchedPrefix | null {
    const prefix = this.prefixes.get(beatId);
    if (!prefix) return null;
    if (prefix.messageId !== messageId) {
      this.prefixes.delete(beatId);
      return null;
    }
    this.prefixes.delete(beatId);
    return prefix;
  }

  private makePlaybackState(beatId: string, messageId: number, mimeType: string, url: string, completed: Promise<void>): PlaybackEntry {
    return {
      beatId,
      messageId,
      mimeType,
      url,
      cancel: null,
      released: false,
      completed,
      mediaSource: null,
      sourceBuffer: null,
      queue: [],
      appending: null,
      streamDone: false,
      failed: false,
      cachedBytes: 0,
      cachedChunks: [],
      lastUsedAt: Date.now(),
      playbackObserved: false,
      playbackCurrentTime: 0,
      playbackPlaying: false,
      playbackWaiting: false,
      streamDemandWaiters: new Set(),
    };
  }

  private prepareMediaSource(beatId: string, messageId: number, mimeType: string): Promise<PreparedWebPlayback> {
    playTrace("SOURCE_MSE_BEGIN", { beat_id: beatId });
    const prefetched = this.takePrefix(beatId, messageId);
    const usablePrefix = prefetched && (
      prefetched.totalBytes <= prefetched.prefix.byteLength || prefetched.prefix.byteLength % 4096 === 0
    ) ? prefetched : null;
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    let appendSequence = 0;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    void completed.catch(() => {});
    const entry = this.makePlaybackState(beatId, messageId, usablePrefix?.mimeType || mimeType, url, completed);
    entry.mediaSource = mediaSource;
    entry.cachedChunks = usablePrefix ? [usablePrefix.prefix] : [];
    let resolvePrefixBuffered: (() => void) | null = null;
    const prefixBuffered = usablePrefix
      ? new Promise<void>(resolve => { resolvePrefixBuffered = resolve; })
      : Promise.resolve();
    if (usablePrefix) {
      entry.cachedBytes = usablePrefix.prefix.byteLength;
      entry.queue.push({
        chunk: usablePrefix.prefix,
        origin: "prefetch",
        resolve: () => resolvePrefixBuffered?.(),
        reject: () => resolvePrefixBuffered?.(),
      });
      playTrace("SOURCE_PREFETCH_CONSUMED", {
        beat_id: beatId,
        message_id: messageId,
        bytes: usablePrefix.prefix.byteLength,
        playable_seconds: roundTraceSeconds(usablePrefix.playableSeconds),
        target_met: usablePrefix.targetMet,
      });
    }
    this.entries.set(beatId, entry);

    const fail = (error: unknown) => {
      if (entry.released || entry.failed) return;
      entry.failed = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      entry.appending?.reject(failure);
      entry.appending = null;
      for (const queued of entry.queue.splice(0)) queued.reject(failure);
      this.resolveStreamDemandWaiters(entry);
      rejectCompleted(failure);
      if (mediaSource.readyState === "open") {
        try { mediaSource.endOfStream("network"); } catch {}
      }
    };
    const finishIfReady = () => {
      if (!entry.streamDone || entry.queue.length > 0 || entry.appending || entry.sourceBuffer?.updating) return;
      if (mediaSource.readyState === "open") {
        try { mediaSource.endOfStream(); } catch {}
      }
      resolveCompleted();
    };
    const pump = () => {
      if (entry.released || entry.failed || !entry.sourceBuffer || entry.sourceBuffer.updating) return;
      const next = entry.queue.shift();
      if (!next) {
        finishIfReady();
        return;
      }
      next.appendSequence = ++appendSequence;
      next.appendStartedAtMs = traceNowMs();
      entry.appending = next;
      playTrace("SOURCE_MSE_APPEND_BEGIN", {
        beat_id: beatId,
        message_id: messageId,
        append_seq: next.appendSequence,
        origin: next.origin,
        bytes: next.chunk.byteLength,
        queue_depth: entry.queue.length,
      });
      try { entry.sourceBuffer.appendBuffer(next.chunk); } catch (error) { fail(error); }
    };

    mediaSource.addEventListener("sourceopen", () => {
      playTrace("SOURCE_MSE_SOURCEOPEN", { beat_id: beatId });
      if (entry.released || entry.sourceBuffer) return;
      if (entry.failed) {
        try { mediaSource.endOfStream("network"); } catch {}
        return;
      }
      try {
        entry.sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        entry.sourceBuffer.mode = "sequence";
        entry.sourceBuffer.addEventListener("updateend", () => {
          const appended = entry.appending;
          if (appended) {
            const snapshot = sourceBufferSnapshot(entry.sourceBuffer);
            playTrace("SOURCE_MSE_APPEND_DONE", {
              beat_id: beatId,
              message_id: messageId,
              append_seq: appended.appendSequence ?? null,
              origin: appended.origin,
              bytes: appended.chunk.byteLength,
              append_ms: appended.appendStartedAtMs === undefined
                ? null
                : Math.round((traceNowMs() - appended.appendStartedAtMs) * 10) / 10,
              queue_depth: entry.queue.length,
              media_source_state: mediaSource.readyState,
              ...snapshot,
            });
            if (appended.origin === "prefetch") {
              playTrace("SOURCE_MSE_PREFETCH_BUFFERED", {
                beat_id: beatId,
                message_id: messageId,
                bytes: appended.chunk.byteLength,
                ...snapshot,
              });
            }
            appended.resolve();
          }
          entry.appending = null;
          pump();
        });
        entry.sourceBuffer.addEventListener("error", () => fail(new Error("Cloud audio could not be decoded.")));
        pump();
      } catch (error) {
        fail(error);
      }
    }, { once: true });

    playTrace("SOURCE_URL_READY", { beat_id: beatId, mode: "mse" });
    void (async () => {
      try {
        const offsetBytes = usablePrefix?.prefix.byteLength || 0;
        if (usablePrefix && usablePrefix.totalBytes <= offsetBytes) {
          entry.streamDone = true;
          entry.cachedBytes = usablePrefix.totalBytes || offsetBytes;
          pump();
          finishIfReady();
          this.enforceCacheBudget(beatId);
          return;
        }

        if (usablePrefix?.targetMet) {
          await prefixBuffered;
          await this.waitForStreamDemand(entry);
          if (entry.released || entry.failed) return;
        }

        let firstChunkLogged = false;
        playTrace("SOURCE_STREAM_REQUEST", { beat_id: beatId, offset_bytes: offsetBytes });
        const stream = await this.transport.streamFile({ messageId, mimeType, offsetBytes }, chunk => {
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            playTrace("SOURCE_FIRST_CHUNK", { beat_id: beatId, bytes: chunk.byteLength, offset_bytes: offsetBytes });
          }
          if (entry.released) return Promise.reject(abortError());
          if (entry.failed) return Promise.reject(new Error("Cloud audio stream failed."));
          entry.cachedChunks.push(chunk);
          entry.cachedBytes += chunk.byteLength;
          return new Promise<void>((resolve, reject) => {
            entry.queue.push({ chunk, origin: "stream", resolve, reject });
            pump();
          }).then(() => this.waitForStreamDemand(entry));
        });
        playTrace("SOURCE_STREAM_HANDLE_READY", { beat_id: beatId });
        entry.cancel = stream.cancel;
        if (entry.released) {
          stream.cancel();
          return;
        }
        void stream.completed.then(result => {
          entry.streamDone = true;
          entry.mimeType = result.mimeType || entry.mimeType;
          entry.cachedBytes = Math.max(entry.cachedBytes, result.totalBytes || entry.cachedBytes);
          entry.lastUsedAt = Date.now();
          this.resolveStreamDemandWaiters(entry);
          playTrace("SOURCE_SESSION_CACHE_READY", {
            beat_id: beatId,
            message_id: messageId,
            bytes: entry.cachedBytes,
          });
          pump();
          finishIfReady();
          this.enforceCacheBudget(beatId);
        }, fail);
      } catch (error) {
        fail(error);
        this.hardRelease(beatId);
      }
    })();

    return Promise.resolve({ url, completed });
  }

  private async prepareBlobFallback(beatId: string, messageId: number, mimeType: string): Promise<PreparedWebPlayback> {
    playTrace("SOURCE_BLOB_BEGIN", { beat_id: beatId });
    const prefetched = this.takePrefix(beatId, messageId);
    const usablePrefix = prefetched && (
      prefetched.totalBytes <= prefetched.prefix.byteLength || prefetched.prefix.byteLength % 4096 === 0
    ) ? prefetched : null;
    const chunks: ArrayBuffer[] = usablePrefix ? [usablePrefix.prefix] : [];
    let firstChunkLogged = false;
    let placeholder: PlaybackEntry | null = null;
    const offsetBytes = usablePrefix?.prefix.byteLength || 0;
    if (usablePrefix) {
      playTrace("SOURCE_PREFETCH_CONSUMED", { beat_id: beatId, message_id: messageId, bytes: offsetBytes });
    }
    if (usablePrefix && usablePrefix.totalBytes <= offsetBytes) {
      const url = URL.createObjectURL(new Blob(chunks, { type: usablePrefix.mimeType || mimeType }));
      const completed = Promise.resolve();
      placeholder = this.makePlaybackState(beatId, messageId, usablePrefix.mimeType || mimeType, url, completed);
      placeholder.streamDone = true;
      placeholder.cachedBytes = usablePrefix.totalBytes || offsetBytes;
      placeholder.cachedChunks = chunks;
      this.entries.set(beatId, placeholder);
      this.enforceCacheBudget(beatId);
      playTrace("SOURCE_SESSION_CACHE_READY", {
        beat_id: beatId,
        message_id: messageId,
        bytes: placeholder.cachedBytes,
      });
      playTrace("SOURCE_URL_READY", { beat_id: beatId, mode: "blob", prefetched_only: true });
      return { url, completed };
    }
    const stream = await this.transport.streamFile({ messageId, mimeType, offsetBytes }, chunk => {
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        playTrace("SOURCE_FIRST_CHUNK", { beat_id: beatId, bytes: chunk.byteLength, offset_bytes: offsetBytes });
      }
      if (!placeholder?.released) chunks.push(chunk);
    });
    playTrace("SOURCE_STREAM_HANDLE_READY", { beat_id: beatId });
    placeholder = this.makePlaybackState(beatId, messageId, mimeType, "", Promise.resolve());
    placeholder.cancel = stream.cancel;
    placeholder.cachedBytes = offsetBytes;
    placeholder.cachedChunks = chunks;
    this.entries.set(beatId, placeholder);
    try {
      const result = await stream.completed;
      playTrace("SOURCE_BLOB_DOWNLOAD_DONE", { beat_id: beatId, chunks: chunks.length });
      if (placeholder.released) throw abortError();
      const url = URL.createObjectURL(new Blob(chunks, { type: result.mimeType || "audio/mpeg" }));
      placeholder.url = url;
      placeholder.mimeType = result.mimeType || placeholder.mimeType;
      placeholder.streamDone = true;
      placeholder.cachedBytes = result.totalBytes || chunkBytes(chunks);
      placeholder.lastUsedAt = Date.now();
      this.enforceCacheBudget(beatId);
      playTrace("SOURCE_SESSION_CACHE_READY", {
        beat_id: beatId,
        message_id: messageId,
        bytes: placeholder.cachedBytes,
      });
      playTrace("SOURCE_URL_READY", { beat_id: beatId, mode: "blob" });
      return { url, completed: Promise.resolve() };
    } catch (error) {
      placeholder.failed = true;
      this.entries.delete(beatId);
      throw error;
    }
  }

  updatePlaybackState(state: WebPlaybackRuntimeState): void {
    const entry = this.entries.get(state.beatId);
    if (!entry || entry.released || entry.failed) return;
    entry.playbackObserved = true;
    entry.playbackCurrentTime = Math.max(0, Number(state.currentTime) || 0);
    entry.playbackPlaying = Boolean(state.playing);
    entry.playbackWaiting = Boolean(state.waiting);
    entry.lastUsedAt = Date.now();
    if (state.playing || state.waiting) this.currentPlaybackBeatId = state.beatId;
    else if (this.currentPlaybackBeatId === state.beatId) this.currentPlaybackBeatId = state.beatId;
    this.wakeStreamDemandIfNeeded(entry);
  }

  private streamNeedsData(entry: PlaybackEntry): boolean {
    if (entry.released || entry.failed || entry.streamDone) return true;
    if (!entry.sourceBuffer) return true;
    if (entry.playbackObserved && !entry.playbackPlaying && !entry.playbackWaiting) return false;
    if (entry.playbackWaiting) return true;
    return bufferedAheadSeconds(entry.sourceBuffer, entry.playbackCurrentTime) < PLAYBACK_BUFFER_AHEAD_TARGET_SECONDS;
  }

  private waitForStreamDemand(entry: PlaybackEntry): Promise<void> {
    if (this.streamNeedsData(entry)) return Promise.resolve();
    return new Promise(resolve => entry.streamDemandWaiters.add(resolve));
  }

  private wakeStreamDemandIfNeeded(entry: PlaybackEntry): void {
    if (!this.streamNeedsData(entry)) return;
    this.resolveStreamDemandWaiters(entry);
  }

  private resolveStreamDemandWaiters(entry: PlaybackEntry): void {
    const waiters = Array.from(entry.streamDemandWaiters);
    entry.streamDemandWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  release(beatId: string | null): void {
    if (!beatId) return;
    const entry = this.entries.get(beatId);
    if (!entry) return;
    if (entry.streamDone && !entry.failed) {
      entry.lastUsedAt = Date.now();
      entry.playbackPlaying = false;
      entry.playbackWaiting = false;
      playTrace("SOURCE_SESSION_CACHE_RETAINED", {
        beat_id: beatId,
        message_id: entry.messageId,
        bytes: entry.cachedBytes,
      });
      return;
    }
    this.hardRelease(beatId);
  }

  private hardRelease(beatId: string): void {
    const entry = this.entries.get(beatId);
    if (!entry) return;
    entry.released = true;
    entry.cancel?.();
    this.resolveStreamDemandWaiters(entry);
    const cancelled = abortError();
    entry.appending?.reject(cancelled);
    entry.appending = null;
    for (const queued of entry.queue.splice(0)) queued.reject(cancelled);
    if (entry.sourceBuffer?.updating) {
      try { entry.sourceBuffer.abort(); } catch {}
    }
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.cachedChunks.length = 0;
    this.entries.delete(beatId);
    if (this.currentPlaybackBeatId === beatId) this.currentPlaybackBeatId = null;
  }

  private cacheUsedBytes(): number {
    let used = 0;
    for (const entry of this.entries.values()) {
      if (!entry.failed) used += Math.max(0, entry.cachedBytes);
    }
    for (const prefix of this.prefixes.values()) used += prefix.prefix.byteLength;
    return used;
  }

  private enforceCacheBudget(protectedBeatId: string | null): void {
    let used = this.cacheUsedBytes();
    if (used <= this.sessionCacheLimitBytes) return;

    const completedCandidates = Array.from(this.entries.values())
      .filter(entry => entry.beatId !== protectedBeatId && entry.streamDone && !entry.failed)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of completedCandidates) {
      if (used <= this.sessionCacheLimitBytes) break;
      const bytes = entry.cachedBytes;
      this.hardRelease(entry.beatId);
      used -= bytes;
      playTrace("SOURCE_SESSION_CACHE_EVICTED", { beat_id: entry.beatId, bytes, kind: "completed" });
    }

    const prefixesByPriority = Array.from(this.prefixes.values())
      .filter(prefix => prefix.beatId !== protectedBeatId)
      .sort((a, b) => warmPriorityRank(a.priority) - warmPriorityRank(b.priority) || a.lastUsedAt - b.lastUsedAt);
    for (const prefix of prefixesByPriority) {
      if (used <= this.sessionCacheLimitBytes) break;
      this.prefixes.delete(prefix.beatId);
      used -= prefix.prefix.byteLength;
      playTrace("SOURCE_SESSION_CACHE_EVICTED", {
        beat_id: prefix.beatId,
        bytes: prefix.prefix.byteLength,
        kind: `${prefix.priority}_prefix`,
      });
    }
  }

  cacheStatus(): { used_bytes: number; limit_mb: number } {
    return {
      used_bytes: this.cacheUsedBytes(),
      limit_mb: Math.round(this.sessionCacheLimitBytes / (1024 * 1024)),
    };
  }

  setCacheLimitMb(limitMb: number): { used_bytes: number; limit_mb: number } {
    const normalized = Number.isFinite(limitMb) ? Math.max(0, Math.round(limitMb)) : DEFAULT_SESSION_CACHE_LIMIT_MB;
    this.sessionCacheLimitBytes = normalized * 1024 * 1024;
    this.enforceCacheBudget(this.currentPlaybackBeatId);
    return this.cacheStatus();
  }

  clearCache(): { used_bytes: number; limit_mb: number } {
    this.prefixes.clear();
    this.prefetchRetryAfter.clear();
    this.activePrefetchBatch?.handle?.cancel();
    for (const job of Array.from(this.prefetchJobs.values())) this.settlePrefetchJob(job);
    for (const beatId of Array.from(this.entries.keys())) this.hardRelease(beatId);
    return this.cacheStatus();
  }

  releaseAll(): void {
    this.activePrefetchBatch?.handle?.cancel();
    this.activePrefetchBatch = null;
    for (const job of Array.from(this.prefetchJobs.values())) this.settlePrefetchJob(job, abortError());
    this.prefetchRetryAfter.clear();
    this.prefixes.clear();
    for (const beatId of Array.from(this.entries.keys())) this.hardRelease(beatId);
  }
}
