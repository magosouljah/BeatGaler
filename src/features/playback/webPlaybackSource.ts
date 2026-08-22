import type { WebTransportStreamInput, WebTransportStreamResult } from "../cloud/webTransportWorkerProtocol";

export interface WebPlaybackTransport {
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
};

function supportsMediaSource(mimeType: string): boolean {
  return typeof MediaSource !== "undefined" &&
    typeof MediaSource.isTypeSupported === "function" &&
    MediaSource.isTypeSupported(mimeType);
}

function abortError(): DOMException {
  return new DOMException("Playback stream cancelled.", "AbortError");
}

/** Owns short-lived browser playback URLs. Cloud credentials never enter them. */
export class WebPlaybackSourceManager {
  private entries = new Map<string, PlaybackEntry>();
  private pending = new Map<string, Promise<PreparedWebPlayback>>();

  constructor(private readonly transport: WebPlaybackTransport) {}

  prepare(beatId: string, messageId: number, mimeType = "audio/mpeg"): Promise<PreparedWebPlayback> {
    const existing = this.entries.get(beatId);
    if (existing && !existing.released && !existing.failed) {
      return Promise.resolve({ url: existing.url, completed: existing.completed });
    }
    const pending = this.pending.get(beatId);
    if (pending) return pending;
    const preparation = (supportsMediaSource(mimeType)
      ? this.prepareMediaSource(beatId, messageId, mimeType)
      : this.prepareBlobFallback(beatId, messageId, mimeType)
    ).finally(() => this.pending.delete(beatId));
    this.pending.set(beatId, preparation);
    return preparation;
  }

  private async prepareMediaSource(beatId: string, messageId: number, mimeType: string): Promise<PreparedWebPlayback> {
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    // Playback errors are also reported by HTMLAudioElement; keep this promise
    // from becoming an unhandled rejection when a card changes mid-stream.
    void completed.catch(() => {});
    const entry: PlaybackEntry = {
      beatId,
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
    };
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

    try {
      const stream = await this.transport.streamFile({ messageId, mimeType }, chunk => {
        if (entry.released) return Promise.reject(abortError());
        if (entry.failed) return Promise.reject(new Error("Cloud audio stream failed."));
        return new Promise<void>((resolve, reject) => {
          entry.queue.push({ chunk, resolve, reject });
          pump();
        });
      });
      entry.cancel = stream.cancel;
      if (entry.released) {
        stream.cancel();
        throw abortError();
      }
      void stream.completed.then(() => {
        entry.streamDone = true;
        pump();
        finishIfReady();
      }, fail);
      return { url, completed };
    } catch (error) {
      fail(error);
      this.release(beatId);
      throw error;
    }
  }

  private async prepareBlobFallback(beatId: string, messageId: number, mimeType: string): Promise<PreparedWebPlayback> {
    const chunks: ArrayBuffer[] = [];
    let placeholder: PlaybackEntry | null = null;
    const stream = await this.transport.streamFile({ messageId, mimeType }, chunk => {
      if (!placeholder?.released) chunks.push(chunk);
    });
    placeholder = {
      beatId,
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
    };
    this.entries.set(beatId, placeholder);
    try {
      const result = await stream.completed;
      if (placeholder.released) throw abortError();
      const url = URL.createObjectURL(new Blob(chunks, { type: result.mimeType || "audio/mpeg" }));
      placeholder.url = url;
      placeholder.streamDone = true;
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
    this.entries.delete(beatId);
  }

  releaseAll(): void {
    for (const beatId of Array.from(this.entries.keys())) this.release(beatId);
  }
}
