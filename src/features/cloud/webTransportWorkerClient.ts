import type { WebTransportRuntime } from "./webTransportController";
import type { WebTransportSession } from "./webTransportSession";
import type {
  WebTransportProgress,
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
};

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
      pending.onProgress?.(message.progress);
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
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, onProgress });
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
