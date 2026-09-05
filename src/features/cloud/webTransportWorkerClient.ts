import { playTrace } from "../playback/playTrace";
import type { WebTransportRuntime } from "./webTransportController";
import type { WebTransportSession } from "./webTransportSession";
import type {
  WebTransportDownloadInput,
  WebTransportDownloadResult,
  WebTransportDeleteMessagesInput,
  WebTransportDeleteMessagesResult,
  WebTransportErrorCode,
  WebTransportLibraryIndexResult,
  WebTransportPrefetchBatchInput,
  WebTransportPrefetchBatchResult,
  WebTransportPrefetchChunk,
  WebTransportPrefetchInput,
  WebTransportPrefetchResult,
  WebTransportPrefetchTerminal,
  WebTransportReplaceIndexInput,
  WebTransportReplaceIndexResult,
  WebTransportProgress,
  WebTransportStreamInput,
  WebTransportStreamResult,
  WebTransportUploadInput,
  WebTransportUploadResult,
  WebTransportWorkerCommand,
  WebTransportWorkerRequest,
  WebTransportWorkerResponse,
} from "./webTransportWorkerProtocol";

const WEB_TRANSPORT_BOOTSTRAP_REQUEST_TIMEOUT_MS = 30_000;
export const WEB_TRANSPORT_INVALIDATED_EVENT = "beatgaler:web-session-invalidated";
const PLAYBACK_PREFIX_ALIGNMENT_BYTES = 4096;
const NON_RESUMABLE_PREFIX_ERROR = "Galer Cloud returned a non-resumable partial playback prefix.";

function publishTransportInvalidated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WEB_TRANSPORT_INVALIDATED_EVENT));
}

function isReusablePlaybackPrefixEnd(offsetBytes: number, byteLength: number, totalBytes: number): boolean {
  const offset = Math.max(0, Math.floor(Number(offsetBytes) || 0));
  const bytes = Math.max(0, Math.floor(Number(byteLength) || 0));
  const total = Math.max(0, Math.floor(Number(totalBytes) || 0));
  if (bytes <= 0) return false;
  const end = offset + bytes;
  if (total > 0 && end >= total) return true;
  return end % PLAYBACK_PREFIX_ALIGNMENT_BYTES === 0;
}

function streamCancelledError(): DOMException {
  return new DOMException("Playback stream cancelled.", "AbortError");
}

export class WebTransportWorkerError extends Error {
  constructor(message: string, readonly code?: WebTransportErrorCode) {
    super(message);
    this.name = "WebTransportWorkerError";
  }
}

type PendingRequest = {
  operation: WebTransportWorkerRequest["op"];
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (progress: WebTransportProgress) => void;
  onChunk?: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>;
  onPrefetchChunk?: (progress: WebTransportPrefetchChunk) => void;
  onPrefetchTerminal?: (terminal: WebTransportPrefetchTerminal) => void;
  prefetchOffsetBytes?: number;
  invalidPrefetchMessageIds?: Set<number>;
  timeoutId: ReturnType<typeof setTimeout> | null;
  activeTimeoutMs: number | null;
};

export interface WebTransportStreamHandle {
  completed: Promise<WebTransportStreamResult>;
  cancel(): void;
}

export interface WebTransportPrefetchBatchHandle {
  completed: Promise<WebTransportPrefetchBatchResult>;
  cancelMessage(messageId: number): void;
  promoteMessage(messageId: number): Promise<void>;
  cancel(): void;
}

export class WebTransportWorkerClient implements WebTransportRuntime {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private sessionStartupMessageIds: number[] = [];
  private desiredPlaybackMessageId: number | null = null;
  private credentialRefreshEpoch = 0;
  private credentialRefreshPromise: Promise<void> | null = null;

  constructor(
    private readonly bootstrapRequestTimeoutMs = WEB_TRANSPORT_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  ) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    playTrace("WORKER_CREATE_BEGIN");
    const worker = new Worker(new URL("./webTransport.worker.ts", import.meta.url), {
      type: "module",
      name: "galer-cloud-data-plane",
    });
    playTrace("WORKER_CREATED");
    worker.onmessage = event => this.onMessage(event.data as WebTransportWorkerResponse);
    worker.onerror = () => {
      playTrace("WORKER_ERROR");
      this.failPending("Galer Cloud Web Worker stopped unexpectedly.");
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      publishTransportInvalidated();
    };
    this.worker = worker;
    return worker;
  }

  prewarm(): void {
    playTrace("WORKER_PREWARM_BEGIN");
    try {
      this.ensureWorker();
      playTrace("WORKER_PREWARM_DISPATCHED");
    } catch (error) {
      playTrace("WORKER_PREWARM_DEFERRED", {
        error_name: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private clearPendingTimeout(pending: PendingRequest): void {
    if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
    pending.timeoutId = null;
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    this.clearPendingTimeout(pending);
    return pending;
  }

  private onIndexState(requestId: string, pending: PendingRequest, state: "active" | "paused"): void {
    if (pending.operation !== "get_index" || pending.activeTimeoutMs === null) return;
    if (state === "paused") {
      this.clearPendingTimeout(pending);
      playTrace("WORKER_INDEX_DEADLINE_PAUSED", { request_id: requestId });
      return;
    }
    if (pending.timeoutId !== null) return;
    pending.timeoutId = setTimeout(() => this.timeoutIndexRequest(requestId), pending.activeTimeoutMs);
    playTrace("WORKER_INDEX_DEADLINE_ACTIVE", { request_id: requestId, timeout_ms: pending.activeTimeoutMs });
  }

  private onPrefetchChunk(pending: PendingRequest, progress: WebTransportPrefetchChunk): void {
    if (isReusablePlaybackPrefixEnd(progress.offsetBytes, progress.chunk.byteLength, progress.totalBytes)) {
      pending.onPrefetchChunk?.(progress);
      return;
    }
    const invalid = pending.invalidPrefetchMessageIds ?? new Set<number>();
    pending.invalidPrefetchMessageIds = invalid;
    if (invalid.has(progress.messageId)) return;
    invalid.add(progress.messageId);
    pending.onPrefetchTerminal?.({
      messageId: progress.messageId,
      status: "FAILED",
      code: "TRANSFER_FAILED",
      error: NON_RESUMABLE_PREFIX_ERROR,
    });
    playTrace("WORKER_PREFETCH_NON_RESUMABLE", {
      message_id: progress.messageId,
      offset_bytes: progress.offsetBytes,
      bytes: progress.chunk.byteLength,
      total_bytes: progress.totalBytes,
    });
  }

  private normalizePrefetchBatchResult(
    result: WebTransportPrefetchBatchResult,
    invalidMessageIds: ReadonlySet<number> | undefined,
  ): WebTransportPrefetchBatchResult {
    if (!invalidMessageIds || invalidMessageIds.size === 0) return result;
    return {
      results: result.results.map(item => {
        const messageId = item.ok ? item.result.messageId : item.messageId;
        if (!invalidMessageIds.has(messageId)) return item;
        return {
          ok: false as const,
          messageId,
          error: NON_RESUMABLE_PREFIX_ERROR,
          code: "TRANSFER_FAILED" as const,
        };
      }),
    };
  }

  private onMessage(message: WebTransportWorkerResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if ("event" in message) {
      if (message.event === "progress") {
        pending.onProgress?.(message.progress);
      } else if (message.event === "prefetch-chunk") {
        this.onPrefetchChunk(pending, message.progress);
      } else if (message.event === "prefetch-terminal") {
        if (!pending.invalidPrefetchMessageIds?.has(message.terminal.messageId)) {
          pending.onPrefetchTerminal?.(message.terminal);
        }
      } else if (message.event === "index-state") {
        this.onIndexState(message.requestId, pending, message.state);
      } else if (message.event === "download-chunk") {
        void Promise.resolve(pending.onChunk?.(message.chunk, message.downloadedBytes, message.totalBytes))
          .then(() => this.sendStreamControl("stream_ack", message.requestId))
          .catch(error => {
            const failed = this.takePending(message.requestId);
            this.sendStreamControl("cancel", message.requestId);
            failed?.reject(error instanceof Error ? error : new Error(String(error)));
          });
      }
      return;
    }
    const completed = this.takePending(message.requestId);
    if (!completed) return;
    if (completed.operation === "initialize" || completed.operation === "verify" || completed.operation === "verify_identity") {
      playTrace("WORKER_RESPONSE_RECEIVED", {
        request_id: message.requestId,
        operation: completed.operation,
        ok: message.ok,
      });
    }
    if (!message.ok) {
      completed.reject(new WebTransportWorkerError(message.error, message.code));
      return;
    }
    if (completed.operation === "prefetch") {
      const result = message.result as WebTransportPrefetchResult;
      const offsetBytes = completed.prefetchOffsetBytes || 0;
      if (!isReusablePlaybackPrefixEnd(offsetBytes, result.prefix.byteLength, result.totalBytes)) {
        completed.reject(new WebTransportWorkerError(NON_RESUMABLE_PREFIX_ERROR, "TRANSFER_FAILED"));
        return;
      }
    }
    if (completed.operation === "prefetch_batch") {
      completed.resolve(this.normalizePrefetchBatchResult(
        message.result as WebTransportPrefetchBatchResult,
        completed.invalidPrefetchMessageIds,
      ));
      return;
    }
    completed.resolve(message.result);
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) {
      this.clearPendingTimeout(pending);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private timeoutRequest(requestId: string, operation: string): void {
    const timedOut = this.takePending(requestId);
    if (!timedOut) return;
    playTrace("WORKER_REQUEST_TIMEOUT", { request_id: requestId, operation });
    timedOut.reject(new Error(`Galer Cloud Web transport timed out during ${operation}.`));
    const worker = this.worker;
    if (worker) {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      publishTransportInvalidated();
    }
    this.failPending("Galer Cloud Web transport reset after an unresponsive worker request.");
  }

  private timeoutIndexRequest(requestId: string): void {
    const timedOut = this.takePending(requestId);
    if (!timedOut) return;
    playTrace("WORKER_INDEX_ACTIVE_TIMEOUT", { request_id: requestId });
    timedOut.reject(new Error("Galer Cloud Web transport timed out during active get_index."));
    this.sendIndexCancel(requestId);
  }

  private request<T>(
    command: WebTransportWorkerRequest,
    onProgress?: (progress: WebTransportProgress) => void,
    onChunk?: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
    requestId = crypto.randomUUID(),
    timeoutMs: number | null = null,
    onPrefetchChunk?: (progress: WebTransportPrefetchChunk) => void,
    onPrefetchTerminal?: (terminal: WebTransportPrefetchTerminal) => void,
    activeTimeoutMs: number | null = null,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = timeoutMs !== null && timeoutMs > 0
        ? setTimeout(() => this.timeoutRequest(requestId, command.op), timeoutMs)
        : null;
      this.pending.set(requestId, {
        operation: command.op,
        resolve: value => resolve(value as T),
        reject,
        onProgress,
        onChunk,
        onPrefetchChunk,
        onPrefetchTerminal,
        prefetchOffsetBytes: command.op === "prefetch" ? Math.max(0, Math.floor(Number(command.input.offsetBytes) || 0)) : undefined,
        invalidPrefetchMessageIds: command.op === "prefetch_batch" ? new Set<number>() : undefined,
        timeoutId,
        activeTimeoutMs,
      });
      try {
        const worker = this.ensureWorker();
        if (command.op === "initialize" || command.op === "verify" || command.op === "verify_identity") {
          playTrace("WORKER_REQUEST_POSTED", { request_id: requestId, operation: command.op });
        }
        worker.postMessage({ ...command, requestId } as WebTransportWorkerCommand);
      } catch (error) {
        const failed = this.takePending(requestId);
        failed?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async initialize(session: WebTransportSession, startupMessageIds: readonly number[]): Promise<void> {
    const sessionStartupMessageIds = Array.from(new Set(
      startupMessageIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0),
    )).slice(0, 14);
    this.sessionStartupMessageIds = sessionStartupMessageIds;
    await this.request({
      op: "initialize",
      startupMessageIds: sessionStartupMessageIds,
      session: {
        chat_id: session.chat_id,
        transport_user_id: session.transport_user_id,
        expected_bot_id: session.temp_auth.expected_bot_id,
        temp_api_id: session.temp_auth.api_id,
        temp_auth_key: session.temp_auth_key,
        temp_session_id: session.temp_session_id,
        temp_session_state: session.temp_session_state,
        temp_primary_dcs: session.temp_primary_dcs,
      },
    }, undefined, undefined, undefined, this.bootstrapRequestTimeoutMs);

    const desiredPlaybackMessageId = this.desiredPlaybackMessageId;
    if (desiredPlaybackMessageId !== null) {
      await this.request<void>({ op: "playback_focus", messageId: desiredPlaybackMessageId });
      playTrace("WORKER_PLAYBACK_FOCUS_REAPPLIED", { message_id: desiredPlaybackMessageId });
    }
  }

  async replaceCredentials(session: WebTransportSession): Promise<void> {
    this.credentialRefreshEpoch += 1;
    const refresh = this.initialize(session, this.sessionStartupMessageIds);
    this.credentialRefreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.credentialRefreshPromise === refresh) this.credentialRefreshPromise = null;
    }
  }

  async verifyIdentity(): Promise<void> {
    await this.request({ op: "verify_identity" }, undefined, undefined, undefined, this.bootstrapRequestTimeoutMs);
  }

  async verifyReady(): Promise<void> {
    await this.request({ op: "verify" }, undefined, undefined, undefined, this.bootstrapRequestTimeoutMs);
  }

  getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {
    return this.request<WebTransportLibraryIndexResult>(
      { op: "get_index" },
      undefined,
      undefined,
      undefined,
      null,
      undefined,
      undefined,
      this.bootstrapRequestTimeoutMs,
    );
  }

  replaceLibraryIndex(input: WebTransportReplaceIndexInput): Promise<WebTransportReplaceIndexResult> {
    return this.request<WebTransportReplaceIndexResult>({ op: "replace_index", input });
  }

  deleteMessages(input: WebTransportDeleteMessagesInput): Promise<WebTransportDeleteMessagesResult> {
    return this.request<WebTransportDeleteMessagesResult>({ op: "delete_messages", input });
  }

  download(input: WebTransportDownloadInput): Promise<WebTransportDownloadResult> {
    return this.request<WebTransportDownloadResult>({ op: "download", input });
  }

  prefetch(input: WebTransportPrefetchInput): Promise<WebTransportPrefetchResult> {
    return this.request<WebTransportPrefetchResult>(
      { op: "prefetch", input },
      undefined,
      undefined,
      undefined,
      this.bootstrapRequestTimeoutMs,
    );
  }

  prefetchBatch(
    input: WebTransportPrefetchBatchInput,
    onChunk?: (progress: WebTransportPrefetchChunk) => void,
    onTerminal?: (terminal: WebTransportPrefetchTerminal) => void,
  ): WebTransportPrefetchBatchHandle {
    const requestId = crypto.randomUUID();
    return {
      completed: this.request<WebTransportPrefetchBatchResult>(
        { op: "prefetch_batch", input },
        undefined,
        undefined,
        requestId,
        null,
        onChunk,
        onTerminal,
      ),
      cancelMessage: messageId => this.sendPrefetchControl(requestId, messageId),
      promoteMessage: messageId => this.focusPlayback(messageId),
      cancel: () => this.sendPrefetchControl(requestId),
    };
  }

  focusPlayback(messageId: number): Promise<void> {
    const id = Number(messageId || 0);
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve();
    this.desiredPlaybackMessageId = id;
    return this.request<void>({ op: "playback_focus", messageId: id });
  }

  markPlaybackStable(messageId: number): Promise<void> {
    const id = Number(messageId || 0);
    if (this.desiredPlaybackMessageId !== id) return Promise.resolve();
    return this.request<void>({ op: "playback_stable", messageId: id });
  }

  releasePlaybackFocus(messageId: number): Promise<void> {
    const id = Number(messageId || 0);
    if (this.desiredPlaybackMessageId === id) this.desiredPlaybackMessageId = null;
    return this.request<void>({ op: "playback_release", messageId: id });
  }

  stream(
    input: WebTransportStreamInput,
    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
  ): WebTransportStreamHandle {
    let cancelled = false;
    let activeRequestId: string | null = null;
    let confirmedOffset = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));

    const completed = (async (): Promise<WebTransportStreamResult> => {
      while (true) {
        if (cancelled) throw streamCancelledError();
        const attemptRefreshEpoch = this.credentialRefreshEpoch;
        const requestId = crypto.randomUUID();
        activeRequestId = requestId;
        try {
          return await this.request<WebTransportStreamResult>(
            { op: "stream", input: { ...input, offsetBytes: confirmedOffset } },
            undefined,
            async (chunk, downloadedBytes, totalBytes) => {
              await onChunk(chunk, downloadedBytes, totalBytes);
              confirmedOffset = Math.max(confirmedOffset, Math.floor(Number(downloadedBytes) || confirmedOffset));
            },
            requestId,
          );
        } catch (error) {
          if (cancelled) throw streamCancelledError();
          const refreshObserved = this.credentialRefreshEpoch !== attemptRefreshEpoch || this.credentialRefreshPromise !== null;
          if (!refreshObserved) throw error;
          const refresh = this.credentialRefreshPromise;
          if (refresh) await refresh;
          if (cancelled) throw streamCancelledError();
          playTrace("WORKER_STREAM_REFRESH_RESUME", {
            message_id: input.messageId,
            offset_bytes: confirmedOffset,
            refresh_epoch: this.credentialRefreshEpoch,
          });
        } finally {
          if (activeRequestId === requestId) activeRequestId = null;
        }
      }
    })();

    return {
      completed,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (activeRequestId) this.sendStreamControl("cancel", activeRequestId);
      },
    };
  }

  private sendStreamControl(op: "stream_ack" | "cancel", targetRequestId: string): void {
    this.ensureWorker().postMessage({ requestId: crypto.randomUUID(), op, targetRequestId } as WebTransportWorkerCommand);
  }

  private sendIndexCancel(targetRequestId: string): void {
    this.ensureWorker().postMessage({ requestId: crypto.randomUUID(), op: "cancel_index", targetRequestId } as WebTransportWorkerCommand);
  }

  private sendPrefetchControl(targetRequestId: string, messageId?: number): void {
    this.ensureWorker().postMessage({
      requestId: crypto.randomUUID(),
      op: "prefetch_batch_cancel",
      targetRequestId,
      ...(Number.isInteger(messageId) ? { messageId } : {}),
    } as WebTransportWorkerCommand);
  }

  upload(input: WebTransportUploadInput, onProgress?: (progress: WebTransportProgress) => void): Promise<WebTransportUploadResult> {
    return this.request<WebTransportUploadResult>({ op: "upload", input }, onProgress);
  }

  async shutdown(): Promise<void> {
    const worker = this.worker;
    this.desiredPlaybackMessageId = null;
    this.sessionStartupMessageIds = [];
    if (worker) {
      await this.request({ op: "shutdown" }).catch(() => {});
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    }
    this.failPending("Galer Cloud Web transport closed.");
    publishTransportInvalidated();
  }
}
