import type {
  WebTransportPrefetchInput,
  WebTransportPrefetchResult,
  WebTransportStreamInput,
  WebTransportStreamResult,
} from "../cloud/webTransportWorkerProtocol";
import type { WebPrefetchBatchOutcome } from "../cloud/webPrefetchBatch";
import { playTrace } from "./playTrace";

export interface WebPlaybackTransport {
  prefetchFile(input: WebTransportPrefetchInput): Promise<WebTransportPrefetchResult>;
  prefetchFiles?(
    inputs: readonly WebTransportPrefetchInput[],
    maxLanes?: number,
  ): Promise<WebPrefetchBatchOutcome[]>;
  streamFile(
    input: WebTransportStreamInput,
    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
  ): Promise<{ completed: Promise<WebTransportStreamResult>; cancel(): void }>;
}

export interface PreparedWebPlayback {
  url: string;
  completed: Promise<void>;
}

export interface WebPlaybackPrefetchCandidate {
  beatId: string;
  messageId: number;
  mimeType?: string | null;
}

export interface WebPlaybackPrefetchSnapshot {
  visible: readonly WebPlaybackPrefetchCandidate[];
  nearby: readonly WebPlaybackPrefetchCandidate[];
}

export type WebPlaybackBufferState = "idle" | "playing" | "waiting";
export interface WebPlaybackBufferSignal {
  beatId: string;
  currentTime: number;
  state: WebPlaybackBufferState;
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
  pendingStreamAck: (() => void) | null;
  streamDone: boolean;
  failed: boolean;
  cachedBytes: number;
  cachedChunks: ArrayBuffer[];
  lastUsedAt: number;
  playbackState: WebPlaybackBufferState;
  currentTime: number;
};

type PrefetchedPrefix = {
  beatId: string;
  messageId: number;
  mimeType: string;
  totalBytes: number;
  prefix: ArrayBuffer;
  lastUsedAt: number;
};

type PrefetchJob = {
  key: string;
  beatId: string;
  messageId: number;
  mimeType: string;
  zone: "visible" | "nearby";
  resolve(): void;
  reject(error: Error): void;
};

const DEFAULT_SESSION_CACHE_LIMIT_MB = 100;
const MAX_VISIBLE_PREFETCH_BATCH_CANDIDATES = 64;
const NEARBY_PREFETCH_BATCH_SIZE = 2;
const PREFETCH_FAILURE_COOLDOWN_MS = 10_000;
const PLAYBACK_BUFFER_TARGET_SECONDS = 1;
const PREFETCH_LANES_IDLE = 6;
const PREFETCH_LANES_DURING_PLAYBACK = 5;
export const WEB_PLAYBACK_BUFFER_SIGNAL_EVENT = "beatgaler:web-playback-buffer";

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

export function bufferAheadSeconds(sourceBuffer: SourceBuffer | null, currentTime: number): number {
  if (!sourceBuffer || !Number.isFinite(currentTime)) return 0;
  try {
    const buffered = sourceBuffer.buffered;
    for (let index = 0; index < buffered.length; index += 1) {
      const start = buffered.start(index);
      const end = buffered.end(index);
      if (currentTime >= start && currentTime <= end) return Math.max(0, end - currentTime);
    }
  } catch {}
  return 0;
}

/** Owns short-lived browser playback URLs. Cloud credentials never enter them. */
export class WebPlaybackSourceManager {
  private entries = new Map<string, PlaybackEntry>();
  private pending = new Map<string, Promise<PreparedWebPlayback>>();
  private prefixes = new Map<string, PrefetchedPrefix>();
  private prefetchPending = new Map<string, Promise<void>>();
  private prefetchQueue: PrefetchJob[] = [];
  private prefetchRetryAfter = new Map<string, number>();
  private prefetchBatchActive = false;
  private prefetchDrainScheduled = false;
  private visiblePrefetchBeatIds = new Set<string>();
  private nearbyPrefetchBeatIds = new Set<string>();
  private sessionCacheLimitBytes = DEFAULT_SESSION_CACHE_LIMIT_MB * 1024 * 1024;
  private readonly playbackSignalListener: ((event: Event) => void) | null;

  constructor(private readonly transport: WebPlaybackTransport) {
    this.playbackSignalListener = typeof window === "undefined"
      ? null
      : event => this.onPlaybackBufferSignal((event as CustomEvent<WebPlaybackBufferSignal>).detail);
    if (this.playbackSignalListener) {
      window.addEventListener(WEB_PLAYBACK_BUFFER_SIGNAL_EVENT, this.playbackSignalListener);
    }
  }

  private onPlaybackBufferSignal(signal: WebPlaybackBufferSignal | null | undefined): void {
    const beatId = String(signal?.beatId || "").trim();
    if (!beatId) return;
    const entry = this.entries.get(beatId);
    if (!entry || entry.released || entry.failed) return;
    entry.playbackState = signal?.state === "waiting" || signal?.state === "playing" ? signal.state : "idle";
    entry.currentTime = Math.max(0, Number(signal?.currentTime) || 0);
    const bufferAhead = bufferAheadSeconds(entry.sourceBuffer, entry.currentTime);
    playTrace("SOURCE_PLAYBACK_BUFFER", {
      beat_id: beatId,
      state: entry.playbackState,
      current_time_s: roundTraceSeconds(entry.currentTime),
      buffer_ahead_s: roundTraceSeconds(bufferAhead),
    });
    if (
      entry.pendingStreamAck &&
      (entry.playbackState !== "playing" || bufferAhead <= PLAYBACK_BUFFER_TARGET_SECONDS)
    ) {
      const release = entry.pendingStreamAck;
      entry.pendingStreamAck = null;
      playTrace("SOURCE_STREAM_ACK_RELEASED", {
        beat_id: beatId,
        state: entry.playbackState,
        buffer_ahead_s: roundTraceSeconds(bufferAhead),
      });
      release();
    }
    this.schedulePrefetchDrain();
  }

  private prefetchLaneLimit(): number {
    for (const entry of this.entries.values()) {
      if (
        !entry.released &&
        !entry.failed &&
        !entry.streamDone &&
        (entry.playbackState === "playing" || entry.playbackState === "waiting")
      ) return PREFETCH_LANES_DURING_PLAYBACK;
    }
    return PREFETCH_LANES_IDLE;
  }

  setPrefetchSnapshot(snapshot: WebPlaybackPrefetchSnapshot): Promise<void> {
    this.visiblePrefetchBeatIds = new Set(snapshot.visible.map(candidate => candidate.beatId));
    this.nearbyPrefetchBeatIds = new Set(
      snapshot.nearby
        .map(candidate => candidate.beatId)
        .filter(beatId => !this.visiblePrefetchBeatIds.has(beatId)),
    );

    const retained: PrefetchJob[] = [];
    for (const job of this.prefetchQueue) {
      if (this.visiblePrefetchBeatIds.has(job.beatId)) {
        job.zone = "visible";
        retained.push(job);
      } else if (this.nearbyPrefetchBeatIds.has(job.beatId)) {
        job.zone = "nearby";
        retained.push(job);
      } else {
        job.resolve();
      }
    }
    this.prefetchQueue = retained;

    const work = [
      ...snapshot.visible.map(candidate => this.prefetch(
        candidate.beatId,
        candidate.messageId,
        candidate.mimeType || "audio/mpeg",
        "visible",
      )),
      ...snapshot.nearby.map(candidate => this.prefetch(
        candidate.beatId,
        candidate.messageId,
        candidate.mimeType || "audio/mpeg",
        "nearby",
      )),
    ];
    this.schedulePrefetchDrain();
    return Promise.allSettled(work).then(() => undefined);
  }

  prefetch(
    beatId: string,
    messageId: number,
    mimeType = "audio/mpeg",
    zone: "visible" | "nearby" = "visible",
  ): Promise<void> {
    const key = `${beatId}:${messageId}`;
    const existingEntry = this.entries.get(beatId);
    if (existingEntry?.messageId === messageId && !existingEntry.released && !existingEntry.failed) {
      return Promise.resolve();
    }
    const existingPrefix = this.prefixes.get(beatId);
    if (existingPrefix?.messageId === messageId) {
      existingPrefix.lastUsedAt = Date.now();
      return Promise.resolve();
    }
    if (existingPrefix && existingPrefix.messageId !== messageId) this.prefixes.delete(beatId);
    const pending = this.prefetchPending.get(key);
    if (pending) {
      if (zone === "visible") {
        const queued = this.prefetchQueue.find(job => job.key === key);
        if (queued) queued.zone = "visible";
      }
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
    this.prefetchPending.set(key, promise);
    this.prefetchQueue.push({ key, beatId, messageId, mimeType, zone, resolve: resolveJob, reject: rejectJob });
    playTrace("SOURCE_PREFETCH_QUEUED", { beat_id: beatId, message_id: messageId, zone });
    this.schedulePrefetchDrain();
    return promise;
  }

  private schedulePrefetchDrain(): void {
    if (this.prefetchDrainScheduled) return;
    this.prefetchDrainScheduled = true;
    queueMicrotask(() => {
      this.prefetchDrainScheduled = false;
      this.drainPrefetchQueue();
    });
  }

  private pruneReadyPrefetchJobs(): void {
    const retained: PrefetchJob[] = [];
    for (const job of this.prefetchQueue) {
      const entry = this.entries.get(job.beatId);
      const prefix = this.prefixes.get(job.beatId);
      if (
        (entry?.messageId === job.messageId && !entry.released && !entry.failed) ||
        prefix?.messageId === job.messageId
      ) {
        job.resolve();
      } else {
        retained.push(job);
      }
    }
    this.prefetchQueue = retained;
  }

  private drainPrefetchQueue(): void {
    if (this.prefetchBatchActive) return;
    this.pruneReadyPrefetchJobs();
    if (this.prefetchQueue.length <= 0) return;
    const visible = this.prefetchQueue.filter(job => job.zone === "visible");
    const selected = visible.length > 0
      ? visible.slice(0, MAX_VISIBLE_PREFETCH_BATCH_CANDIDATES)
      : this.prefetchQueue.filter(job => job.zone === "nearby").slice(0, NEARBY_PREFETCH_BATCH_SIZE);
    if (selected.length <= 0) return;
    const selectedKeys = new Set(selected.map(job => job.key));
    this.prefetchQueue = this.prefetchQueue.filter(job => !selectedKeys.has(job.key));
    this.prefetchBatchActive = true;
    void this.executePrefetchBatch(selected).finally(() => {
      this.prefetchBatchActive = false;
      this.schedulePrefetchDrain();
    });
  }

  private traceVisibleCoverage(): void {
    const total = this.visiblePrefetchBeatIds.size;
    if (total <= 0) return;
    let ready = 0;
    for (const beatId of this.visiblePrefetchBeatIds) {
      const entry = this.entries.get(beatId);
      const prefix = this.prefixes.get(beatId);
      if ((entry && !entry.released && !entry.failed) || prefix) ready += 1;
    }
    playTrace("VISIBLE_COVERAGE", { ready, total });
  }

  private async executePrefetchBatch(jobs: readonly PrefetchJob[]): Promise<void> {
    for (const job of jobs) {
      playTrace("SOURCE_PREFETCH_BEGIN", { beat_id: job.beatId, message_id: job.messageId, zone: job.zone });
    }
    try {
      const outcomes = this.transport.prefetchFiles
        ? await this.transport.prefetchFiles(
            jobs.map(job => ({ messageId: job.messageId, mimeType: job.mimeType })),
            this.prefetchLaneLimit(),
          )
        : await Promise.all(jobs.map(async job => {
            try {
              const result = await this.transport.prefetchFile({ messageId: job.messageId, mimeType: job.mimeType });
              return {
                input: { messageId: job.messageId, mimeType: job.mimeType },
                result,
                playableSeconds: 0,
                targetMet: true,
                error: null,
              } satisfies WebPrefetchBatchOutcome;
            } catch (error) {
              return {
                input: { messageId: job.messageId, mimeType: job.mimeType },
                result: null,
                playableSeconds: 0,
                targetMet: false,
                error: error instanceof Error ? error : new Error(String(error)),
              } satisfies WebPrefetchBatchOutcome;
            }
          }));

      for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index];
        const outcome = outcomes[index];
        if (!outcome || outcome.error || !outcome.result) {
          const failure = outcome?.error || new Error("Galer Cloud returned an empty playback prefix.");
          this.prefetchRetryAfter.set(job.key, Date.now() + PREFETCH_FAILURE_COOLDOWN_MS);
          playTrace("SOURCE_PREFETCH_ERROR", {
            beat_id: job.beatId,
            message_id: job.messageId,
            zone: job.zone,
            error_name: failure.name,
          });
          job.reject(failure);
          continue;
        }
        const result = outcome.result;
        this.prefetchRetryAfter.delete(job.key);
        this.prefixes.set(job.beatId, {
          beatId: job.beatId,
          messageId: job.messageId,
          mimeType: result.mimeType || job.mimeType,
          totalBytes: result.totalBytes,
          prefix: result.prefix,
          lastUsedAt: Date.now(),
        });
        playTrace("SOURCE_PREFETCH_READY", {
          beat_id: job.beatId,
          message_id: job.messageId,
          zone: job.zone,
          bytes: result.prefix.byteLength,
          playable_seconds: roundTraceSeconds(outcome.playableSeconds),
          target_met: outcome.targetMet,
        });
        this.enforceCacheBudget(job.beatId);
        job.resolve();
      }
      this.traceVisibleCoverage();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const job of jobs) {
        this.prefetchRetryAfter.set(job.key, Date.now() + PREFETCH_FAILURE_COOLDOWN_MS);
        playTrace("SOURCE_PREFETCH_ERROR", {
          beat_id: job.beatId,
          message_id: job.messageId,
          zone: job.zone,
          error_name: failure.name,
        });
        job.reject(failure);
      }
    }
  }

  prepare(beatId: string, messageId: number, mimeType = "audio/mpeg"): Promise<PreparedWebPlayback> {
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
    const entry: PlaybackEntry = {
      beatId,
      messageId,
      mimeType: usablePrefix?.mimeType || mimeType,
      url,
      cancel: null,
      released: false,
      completed,
      mediaSource,
      sourceBuffer: null,
      queue: [],
      appending: null,
      pendingStreamAck: null,
      streamDone: false,
      failed: false,
      cachedBytes: 0,
      cachedChunks: usablePrefix ? [usablePrefix.prefix] : [],
      lastUsedAt: Date.now(),
      playbackState: "idle",
      currentTime: 0,
    };
    if (usablePrefix) {
      entry.cachedBytes = usablePrefix.prefix.byteLength;
      entry.queue.push({ chunk: usablePrefix.prefix, origin: "prefetch", resolve: () => {}, reject: () => {} });
      playTrace("SOURCE_PREFETCH_CONSUMED", {
        beat_id: beatId,
        message_id: messageId,
        bytes: usablePrefix.prefix.byteLength,
      });
    }
    this.entries.set(beatId, entry);

    const fail = (error: unknown) => {
      if (entry.released || entry.failed) return;
      entry.failed = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      entry.pendingStreamAck?.();
      entry.pendingStreamAck = null;
      entry.appending?.reject(failure);
      entry.appending = null;
      for (const queued of entry.queue.splice(0)) queued.reject(failure);
      rejectCompleted(failure);
      if (mediaSource.readyState === "open") {
        try { mediaSource.endOfStream("network"); } catch {}
      }
    };
    const finishIfReady = () => {
      if (!entry.streamDone || entry.queue.length > 0 || entry.appending || entry.sourceBuffer?.updating || entry.pendingStreamAck) return;
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
            const bufferAhead = bufferAheadSeconds(entry.sourceBuffer, entry.currentTime);
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
              buffer_ahead_s: roundTraceSeconds(bufferAhead),
              ...snapshot,
            });
            if (appended.origin === "prefetch") {
              playTrace("SOURCE_MSE_PREFETCH_BUFFERED", {
                beat_id: beatId,
                message_id: messageId,
                bytes: appended.chunk.byteLength,
                ...snapshot,
              });
              appended.resolve();
            } else if (entry.playbackState === "playing" && bufferAhead > PLAYBACK_BUFFER_TARGET_SECONDS) {
              entry.pendingStreamAck = appended.resolve;
              playTrace("SOURCE_STREAM_ACK_HELD", {
                beat_id: beatId,
                buffer_ahead_s: roundTraceSeconds(bufferAhead),
                target_s: PLAYBACK_BUFFER_TARGET_SECONDS,
              });
            } else {
              appended.resolve();
            }
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
          });
        });
        playTrace("SOURCE_STREAM_HANDLE_READY", { beat_id: beatId });
        entry.cancel = stream.cancel;
        if (entry.released) {
          stream.cancel();
          return;
        }
        void stream.completed.then(result => {
          entry.streamDone = true;
          entry.pendingStreamAck?.();
          entry.pendingStreamAck = null;
          entry.mimeType = result.mimeType || entry.mimeType;
          entry.cachedBytes = Math.max(entry.cachedBytes, result.totalBytes || entry.cachedBytes);
          entry.lastUsedAt = Date.now();
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
      placeholder = {
        beatId,
        messageId,
        mimeType: usablePrefix.mimeType || mimeType,
        url,
        cancel: null,
        released: false,
        completed,
        mediaSource: null,
        sourceBuffer: null,
        queue: [],
        appending: null,
        pendingStreamAck: null,
        streamDone: true,
        failed: false,
        cachedBytes: usablePrefix.totalBytes || offsetBytes,
        cachedChunks: chunks,
        lastUsedAt: Date.now(),
        playbackState: "idle",
        currentTime: 0,
      };
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
    placeholder = {
      beatId,
      messageId,
      mimeType,
      url: "",
      cancel: stream.cancel,
      released: false,
      completed: Promise.resolve(),
      mediaSource: null,
      sourceBuffer: null,
      queue: [],
      appending: null,
      pendingStreamAck: null,
      streamDone: false,
      failed: false,
      cachedBytes: offsetBytes,
      cachedChunks: chunks,
      lastUsedAt: Date.now(),
      playbackState: "idle",
      currentTime: 0,
    };
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

  release(beatId: string | null): void {
    if (!beatId) return;
    const entry = this.entries.get(beatId);
    if (!entry) return;
    if (entry.streamDone && !entry.failed) {
      entry.lastUsedAt = Date.now();
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
    entry.pendingStreamAck?.();
    entry.pendingStreamAck = null;
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
  }

  private cacheUsedBytes(): number {
    let used = 0;
    for (const entry of this.entries.values()) {
      if (entry.streamDone && !entry.failed) used += Math.max(0, entry.cachedBytes);
    }
    for (const prefix of this.prefixes.values()) used += prefix.prefix.byteLength;
    return used;
  }

  private enforceCacheBudget(protectedBeatId: string | null): void {
    if (this.sessionCacheLimitBytes <= 0) {
      for (const beatId of Array.from(this.entries.keys())) {
        if (beatId !== protectedBeatId) this.hardRelease(beatId);
      }
      this.prefixes.clear();
      return;
    }
    let used = this.cacheUsedBytes();
    if (used <= this.sessionCacheLimitBytes) return;

    // Full old beats are least valuable during audition. Preserve short warm
    // prefixes for what the user can see now before retaining complete tracks.
    const completedCandidates = Array.from(this.entries.values())
      .filter(entry => entry.beatId !== protectedBeatId && entry.streamDone && !entry.failed)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of completedCandidates) {
      if (used <= this.sessionCacheLimitBytes) break;
      const bytes = entry.cachedBytes;
      this.hardRelease(entry.beatId);
      used -= bytes;
      playTrace("SOURCE_SESSION_CACHE_EVICTED", { beat_id: entry.beatId, bytes, reason: "completed_lru" });
    }

    const evictPrefixes = (predicate: (prefix: PrefetchedPrefix) => boolean, reason: string) => {
      const candidates = Array.from(this.prefixes.values())
        .filter(prefix => prefix.beatId !== protectedBeatId && predicate(prefix))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const prefix of candidates) {
        if (used <= this.sessionCacheLimitBytes) break;
        this.prefixes.delete(prefix.beatId);
        used -= prefix.prefix.byteLength;
        playTrace("SOURCE_PREFETCH_CACHE_EVICTED", {
          beat_id: prefix.beatId,
          bytes: prefix.prefix.byteLength,
          reason,
        });
      }
    };

    // FAR prefixes should normally disappear from snapshots, but if one is
    // still cached it is cheaper to lose than near-scroll or visible coverage.
    evictPrefixes(
      prefix => !this.visiblePrefetchBeatIds.has(prefix.beatId) && !this.nearbyPrefetchBeatIds.has(prefix.beatId),
      "far_prefix_lru",
    );
    evictPrefixes(prefix => this.nearbyPrefetchBeatIds.has(prefix.beatId), "nearby_prefix_lru");
    evictPrefixes(prefix => this.visiblePrefetchBeatIds.has(prefix.beatId), "visible_prefix_last_resort");
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
    this.enforceCacheBudget(null);
    return this.cacheStatus();
  }

  clearCache(): { used_bytes: number; limit_mb: number } {
    this.prefixes.clear();
    this.prefetchRetryAfter.clear();
    for (const beatId of Array.from(this.entries.keys())) this.hardRelease(beatId);
    return this.cacheStatus();
  }

  releaseAll(): void {
    this.prefetchQueue.splice(0).forEach(job => job.reject(abortError()));
    this.prefetchRetryAfter.clear();
    this.prefixes.clear();
    this.visiblePrefetchBeatIds.clear();
    this.nearbyPrefetchBeatIds.clear();
    for (const beatId of Array.from(this.entries.keys())) this.hardRelease(beatId);
    if (this.playbackSignalListener && typeof window !== "undefined") {
      window.removeEventListener(WEB_PLAYBACK_BUFFER_SIGNAL_EVENT, this.playbackSignalListener);
    }
  }
}
