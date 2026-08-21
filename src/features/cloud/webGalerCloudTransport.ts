import { WebTransportController } from "./webTransportController";
import { ensureWebTransportTopic } from "./webTransportSession";
import { WebTransportWorkerClient } from "./webTransportWorkerClient";
import type {
  WebTransportProgress,
  WebTransportUploadInput,
  WebTransportUploadResult,
} from "./webTransportWorkerProtocol";

export class WebGalerCloudTransport {
  private readonly worker = new WebTransportWorkerClient();
  private readonly controller = new WebTransportController(this.worker);

  async upload(
    input: Omit<WebTransportUploadInput, "threadId"> & { beatName: string },
    onProgress?: (progress: WebTransportProgress) => void,
  ): Promise<WebTransportUploadResult> {
    await this.controller.connect();
    const threadId = await ensureWebTransportTopic(input.beatId, input.beatName);
    return this.controller.withOperation("upload", () => this.worker.upload({
      file: input.file,
      filename: input.filename,
      beatId: input.beatId,
      kind: input.kind,
      threadId,
    }, onProgress));
  }

  disconnect(): Promise<void> {
    return this.controller.disconnect();
  }
}

export type { WebTransportProgress, WebTransportUploadResult } from "./webTransportWorkerProtocol";
