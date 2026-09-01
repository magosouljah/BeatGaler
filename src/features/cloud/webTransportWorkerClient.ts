import type { WebTransportRuntime } from "./webTransportController";
import type { WebTransportSession } from "./webTransportSession";
import type {
  WebTransportDownloadInput,
  WebTransportDownloadResult,
  WebTransportDeleteMessagesInput,
  WebTransportDeleteMessagesResult,
  WebTransportLibraryIndexResult,
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

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (progress: WebTransportProgress) => void;
  onChunk?: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

export interface WebTransportStreamHandle {
  completed: Promise<WebTransportStreamResult>;
  cancel(): void;
}

export class WebTransportWorkerClient implements WebTransportRuntime {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();

  constructor(
    private readonly bootstrapRequestTimeoutMs = WEB_TRANSPORT_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  ) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./webTransport.worker.ts", import.meta.url), { type: "module", name: "galer-cloud-data-plane" });
    worker.onmessage = event => this.onMessage(event.data as WebTransportWorkerResponse);
    worker.onerror = () => {
      this.failPending("Galer Cloud Web Worker stopped unexpectedly.");
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
    return pending;
  }

  private onMessage(message: WebTransportWorkerResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if ("event" in message) {
      if (message.event === "progress") pending.onProgress?.(message.progress);
      else {
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
    if (message.ok) completed.resolve(message.result);
    else completed.reject(new Error(message.error));
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) {
      if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private timeoutRequest(requestId: string, operation: string): void {
    const timedOut = this.takePending(requestId);
    if (!timedOut) return;

    timedOut.reject(new Error(`Galer Cloud Web transport timed out during ${operation}.`));

    // A silent worker has unknown internal state. Do not reuse it for retries:
    // terminate it so the next request gets a fresh data-plane runtime.
    const worker = this.worker;
    if (worker) {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    }
    this.failPending("Galer Cloud Web transport reset after an unresponsive worker request.");
  }

  private request<T>(
    command: WebTransportWorkerRequest,
    onProgress?: (progress: WebTransportProgress) => void,
    onChunk?: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
    requestId = crypto.randomUUID(),
    timeoutMs: number | null = null,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = timeoutMs !== null && timeoutMs > 0
        ? setTimeout(() => this.timeoutRequest(requestId, command.op), timeoutMs)
        : null;
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
        onProgress,
        onChunk,
        timeoutId,
      });
      try {
        this.ensureWorker().postMessage({ ...command, requestId } as WebTransportWorkerCommand);
      } catch (error) {
        const failed = this.takePending(requestId);
        failed?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async initialize(session: WebTransportSession): Promise<void> {
    await this.request({
      op: "initialize",
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
  }

  async replaceCredentials(session: WebTransportSession): Promise<void> {
    await this.initialize(session);
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

  stream(
    input: WebTransportStreamInput,
    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
  ): WebTransportStreamHandle {
    const requestId = crypto.randomUUID();
    return {
      completed: this.request<WebTransportStreamResult>({ op: "stream", input }, undefined, onChunk, requestId),
      cancel: () => this.sendStreamControl("cancel", requestId),
    };
  }

  private sendStreamControl(op: "stream_ack" | "cancel", targetRequestId: string): void {
    this.ensureWorker().postMessage({ requestId: crypto.randomUUID(), op, targetRequestId } as WebTransportWorkerCommand);
  }

  upload(input: WebTransportUploadInput, onProgress?: (progress: WebTransportProgress) => void): Promise<WebTransportUploadResult> {
    return this.request<WebTransportUploadResult>({ op: "upload", input }, onProgress);
  }

  async shutdown(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    await this.request({ op: "shutdown" }).catch(() => {});
    worker.terminate();
    this.worker = null;
    this.failPending("Galer Cloud Web transport closed.");
  }
}
