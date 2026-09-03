import type {
  WebTransportPrefetchInput,
  WebTransportPrefetchResult,
  WebTransportStreamInput,
  WebTransportStreamResult,
} from "../cloud/webTransportWorkerProtocol";
import { playTrace } from "./playTrace";

export interface WebPlaybackTransport {
  prefetchFile(input: WebTransportPrefetchInput): Promise<WebTransportPrefetchResult>;
  streamFile(
    input: WebTransportStreamInput,
    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
  ): Promise<{ completed: Promise<WebTransportStreamResult>; cancel(): void }>;
}

export interface PreparedWebPlayback {
  url: string;
  completed: Promise<void>;
}

type QueuedChunk = {
  chunk: ArrayBuffer;
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
  resolve(): void;
  reject(error: Error): void;
};

const DEFAULT_SESSION_CACHE_LIMIT_MB = 100;
const MAX_PREFETCH_CONCURRENCY = 2;
const FOREGROUND_PREFETCH_PAUSE_MS = 1200;
const PREFETCH_FAILURE_COOLDOWN_MS = 10_000;

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

/** Owns short-lived browser playback URLs. Cloud credentials never enter them. */
export class WebPlaybackSourceManager {
  private entries = new Map<string, PlaybackEntry>();
  private pending = new Map<string, Promise<PreparedWebPlayback>>();
  private prefixes = new Map<string, PrefetchedPrefix>();
  private prefetchPending = new Map<string, Promise<void>>();
  private prefetchQueue: PrefetchJob[] = [];
  private prefetchRetryAfter = new Map<string, number>();
  private activePrefetches = 0;
  private prefetchPausedUntil = 0;
  private prefetchWakeTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionCacheLimitBytes = DEFAULT_SESSION_CACHE_LIMIT_MB * 1024 * 1024;

  constructor(private readonly transport: WebPlaybackTransport) {}

  prefetch(beatId: string, messageId: number, mimeType = "audio/mpeg"): Promise<void> {
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
    if (pending) return pending;

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
    this.prefetchQueue.push({ key, beatId, messageId, mimeType, resolve: resolveJob, reject: rejectJob });
    playTrace("SOURCE_PREFETCH_QUEUED", { beat_id: beatId, message_id: messageId });
    this.drainPrefetchQueue();
    return promise;
  }

  private drainPrefetchQueue(): void {
    if (this.prefetchWakeTimer) {
      clearTimeout(this.prefetchWakeTimer);
      this.prefetchWakeTimer = null;
    }
    const now = Date.now();
    if (now < this.prefetchPausedUntil) {
      this.prefetchWakeTimer = setTimeout(() => {
        this.prefetchWakeTimer = null;
        this.drainPrefetchQueue();
      }, this.prefetchPausedUntil - now);
      return;
    }
    while (this.activePrefetches < MAX_PREFETCH_CONCURRENCY && this.prefetchQueue.length > 0) {
      const job = this.prefetchQueue.shift()!;
      const entry = this.entries.get(job.beatId);
      if (entry?.messageId === job.messageId && !entry.released && !entry.failed) {
        job.resolve();
        continue;
      }
      const existingPrefix = this.prefixes.get(job.beatId);
      if (existingPrefix?.messageId === job.messageId) {
        job.resolve();
        continue;
      }
      this.activePrefetches += 1;
      playTrace("SOURCE_PREFETCH_BEGIN", { beat_id: job.beatId, message_id: job.messageId });
      void this.transport.prefetchFile({ messageId: job.messageId, mimeType: job.mimeType }).then(result => {
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
          bytes: result.prefix.byteLength,
        });
        this.enforceCacheBudget(job.beatId);
        job.resolve();
      }, error => {
        this.prefetchRetryAfter.set(job.key, Date.now() + PREFETCH_FAILURE_COOLDOWN_MS);
        playTrace("SOURCE_PREFETCH_ERROR", {
          beat_id: job.beatId,
          message_id: job.messageId,
          error_name: error instanceof Error ? error.name : "unknown",
        });
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => {
        this.activePrefetches -= 1;
        this.drainPrefetchQueue();
      });
    }
  }

  prepare(beatId: string, messageId: number, mimeType = "audio/mpeg"): Promise<PreparedWebPlayback> {
    this.prefetchPausedUntil = Math.max(this.prefetchPausedUntil, Date.now() + FOREGROUND_PREFETCH_PAUSE_MS);
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
    this.drainPrefetchQueue();
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
      streamDone: false,
      failed: false,
      cachedBytes: 0,
      cachedChunks: usablePrefix ? [usablePrefix.prefix] : [],
      lastUsedAt: Date.now(),
    };
    if (usablePrefix) {
      entry.cachedBytes = usablePrefix.prefix.byteLength;
      entry.queue.push({ chunk: usablePrefix.prefix, resolve: () => {}, reject: () => {} });
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
      entry.appending?.reject(failure);
      entry.appending = null;
      for (const queued of entry.queue.splice(0)) queued.reject(failure);
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
      entry.appending = next;
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
          entry.appending?.resolve();
          entry.appending = null;
          pump();
        });
        entry.sourceBuffer.addEventListener("error", () => fail(new Error("Cloud audio could not be decoded.")));
        pump();
      } catch (error) {
        fail(error);
      }
    }, { once: true });

    // The MediaSource URL is usable immediately. Do not hold the first user
    // click behind the cold Direct lease/MTProto handshake. The stream fills the
    // same MediaSource asynchronously; the audio element can enter its waiting
    // state now and begin as soon as the first MASTER bytes arrive.
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
            entry.queue.push({ chunk, resolve, reject });
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
        streamDone: true,
        failed: false,
        cachedBytes: usablePrefix.totalBytes || offsetBytes,
        cachedChunks: chunks,
        lastUsedAt: Date.now(),
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
      streamDone: false,
      failed: false,
      cachedBytes: offsetBytes,
      cachedChunks: chunks,
      lastUsedAt: Date.now(),
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

    const prefixCandidates = Array.from(this.prefixes.values())
      .filter(prefix => prefix.beatId !== protectedBeatId)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const prefix of prefixCandidates) {
      if (used <= this.sessionCacheLimitBytes) break;
      this.prefixes.delete(prefix.beatId);
      used -= prefix.prefix.byteLength;
    }

    const candidates = Array.from(this.entries.values())
      .filter(entry => entry.beatId !== protectedBeatId && entry.streamDone && !entry.failed)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of candidates) {
      if (used <= this.sessionCacheLimitBytes) break;
      const bytes = entry.cachedBytes;
      this.hardRelease(entry.beatId);
      used -= bytes;
      playTrace("SOURCE_SESSION_CACHE_EVICTED", { beat_id: entry.beatId, bytes });
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
    if (this.prefetchWakeTimer) clearTimeout(this.prefetchWakeTimer);
    this.prefetchWakeTimer = null;
    this.prefetchQueue.splice(0).forEach(job => job.reject(abortError()));
    this.prefetchRetryAfter.clear();
    this.prefixes.clear();
    for (const beatId of Array.from(this.entries.keys())) this.hardRelease(beatId);
  }
}
