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

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (progress: WebTransportProgress) => void;
  onChunk?: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>;
};

export interface WebTransportStreamHandle {
  completed: Promise<WebTransportStreamResult>;
  cancel(): void;
}

export class WebTransportWorkerClient implements WebTransportRuntime {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();

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

  private onMessage(message: WebTransportWorkerResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if ("event" in message) {
      if (message.event === "progress") pending.onProgress?.(message.progress);
      else {
        void Promise.resolve(pending.onChunk?.(message.chunk, message.downloadedBytes, message.totalBytes))
          .then(() => this.sendStreamControl("stream_ack", message.requestId))
          .catch(error => {
            this.pending.delete(message.requestId);
            this.sendStreamControl("cancel", message.requestId);
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          });
      }
      return;
    }
    this.pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }

  private request<T>(
    command: WebTransportWorkerRequest,
    onProgress?: (progress: WebTransportProgress) => void,
    onChunk?: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
    requestId = crypto.randomUUID(),
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, onProgress, onChunk });
      this.ensureWorker().postMessage({ ...command, requestId } as WebTransportWorkerCommand);
    });
  }

  async initialize(session: WebTransportSession): Promise<void> {
    await this.request({
      op: "initialize",
      session: {
        bot_token: session.bot_token,
        chat_id: session.chat_id,
        telegram_api_id: session.telegram_api_id,
        telegram_api_hash: session.telegram_api_hash,
      },
    });
  }

  async replaceCredentials(session: WebTransportSession): Promise<void> {
    await this.initialize(session);
  }

  async verifyReady(): Promise<void> {
    await this.request({ op: "verify" });
  }

  getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {
    return this.request<WebTransportLibraryIndexResult>({ op: "get_index" });
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
    this.ensureWorker().postMessage({
      requestId: crypto.randomUUID(),
      op,
      targetRequestId,
    } as WebTransportWorkerCommand);
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
