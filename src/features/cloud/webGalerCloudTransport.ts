import { WebTransportController } from "./webTransportController";
import { commitWebTransportIndexPointer, ensureWebTransportTopic } from "./webTransportSession";
import { WebTransportWorkerClient } from "./webTransportWorkerClient";
import type { Beat } from "../../types";
import { commitWebImportedBeat, type WebImportCommitProgress, type WebImportFiles } from "../import/webImportCommit";
import { commitWebBeatEdit, type WebBeatEditProgress } from "../edit/webBeatEdit";
import type { PlatformBeatEditFiles } from "../../platform/contracts";
import type { PlatformTrashItem } from "../../platform/contracts";
import { playTrace } from "../playback/playTrace";
import { listWebTrashItems, moveWebBeatsToTrash, purgeWebTrash, restoreWebBeatFromTrash } from "../trash/webTrash";
import type {
  WebTransportDownloadInput,
  WebTransportDownloadResult,
  WebTransportLibraryIndexResult,
  WebTransportPrefetchInput,
  WebTransportPrefetchResult,
  WebTransportProgress,
  WebTransportStreamInput,
  WebTransportStreamResult,
  WebTransportUploadInput,
  WebTransportUploadResult,
} from "./webTransportWorkerProtocol";

export class WebGalerCloudTransport {
  private readonly worker = new WebTransportWorkerClient();
  private readonly controller = new WebTransportController(this.worker);
  private readonly uploadCheckpoints = new Map<string, Promise<WebTransportUploadResult>>();

  constructor() {
    const started = Date.now();
    playTrace("TRANSPORT_PRECONNECT_ENTER");
    // Phase 3 / P2: load/evaluate the Worker module while control-plane prepare
    // is running. This does not initialize MTProto or change session ordering.
    this.worker.prewarm();
    void this.controller.connect().then(
      () => playTrace("TRANSPORT_PRECONNECT_READY", { elapsed_ms: Date.now() - started }),
      error => playTrace("TRANSPORT_PRECONNECT_DEFERRED", {
        elapsed_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "unknown",
      }),
    );
  }

  private checkpointKey(input: { file: File; beatId: string; kind: string }): string {
    return `${input.beatId}:${input.kind}:${input.file.name}:${input.file.size}:${input.file.lastModified}`;
  }

  private uploadOnce(
    input: WebTransportUploadInput & { beatName: string },
    onProgress?: (progress: WebTransportProgress) => void,
  ): Promise<WebTransportUploadResult> {
    const key = this.checkpointKey(input);
    const existing = this.uploadCheckpoints.get(key);
    if (existing) return existing;
    const pending = this.worker.upload(input, onProgress).catch(error => {
      this.uploadCheckpoints.delete(key);
      throw error;
    });
    this.uploadCheckpoints.set(key, pending);
    return pending;
  }

  async upload(
    input: Omit<WebTransportUploadInput, "threadId"> & { beatName: string },
    onProgress?: (progress: WebTransportProgress) => void,
  ): Promise<WebTransportUploadResult> {
    await this.controller.connect();
    const threadId = await ensureWebTransportTopic(input.beatId, input.beatName);
    return this.controller.withOperation(
      "upload",
      { objectType: "beat", objectIds: [input.beatId] },
      () => this.worker.upload({
        file: input.file,
        filename: input.filename,
        beatId: input.beatId,
        kind: input.kind,
        threadId,
      }, onProgress),
    );
  }

  async getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {
    const started = Date.now();
    playTrace("TRANSPORT_GET_INDEX_ENTER");
    const connectStarted = Date.now();
    await this.controller.connect();
    playTrace("TRANSPORT_GET_INDEX_CONNECTED", { wait_ms: Date.now() - connectStarted });
    const operationStarted = Date.now();
    const result = await this.controller.withOperation(
      "get_index",
      { objectType: "index", objectIds: ["pinned"] },
      () => this.worker.getLibraryIndex(),
    );
    playTrace("TRANSPORT_GET_INDEX_DONE", { operation_ms: Date.now() - operationStarted, total_ms: Date.now() - started });
    return result;
  }

  async downloadFiles(inputs: WebTransportDownloadInput[]): Promise<Array<WebTransportDownloadResult | null>> {
    if (inputs.length === 0) return [];
    await this.controller.connect();
    return this.controller.withOperation(
      "load_artwork",
      { objectType: "message", objectIds: inputs.map(input => String(input.messageId)) },
      async () => {
        const results: Array<WebTransportDownloadResult | null> = new Array(inputs.length).fill(null);
        let cursor = 0;
        const workerCount = Math.min(4, inputs.length);
        await Promise.all(Array.from({ length: workerCount }, async () => {
          while (cursor < inputs.length) {
            const index = cursor++;
            try {
              results[index] = await this.worker.download(inputs[index]);
            } catch (error) {
              console.warn(`[web/library] artwork ${inputs[index].messageId} could not be hydrated`, error);
            }
          }
        }));
        return results;
      },
    );
  }

  async prefetchFile(input: WebTransportPrefetchInput): Promise<WebTransportPrefetchResult> {
    const started = Date.now();
    playTrace("TRANSPORT_PREFETCH_ENTER", { message_id: input.messageId });
    await this.controller.connect();
    const result = await this.controller.withOperation(
      "stream_master",
      { objectType: "message", objectIds: [String(input.messageId)] },
      () => this.worker.prefetch(input),
    );
    playTrace("TRANSPORT_PREFETCH_READY", {
      message_id: input.messageId,
      bytes: result.prefix.byteLength,
      total_ms: Date.now() - started,
    });
    return result;
  }

  async streamFile(
    input: WebTransportStreamInput,
    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
  ): Promise<{ completed: Promise<WebTransportStreamResult>; cancel(): void }> {
    const started = Date.now();
    playTrace("TRANSPORT_STREAM_ENTER");
    const connectStarted = Date.now();
    await this.controller.connect();
    playTrace("TRANSPORT_STREAM_CONNECTED", { wait_ms: Date.now() - connectStarted });
    const operationStarted = Date.now();
    const lease = await this.controller.beginOperation(
      "stream_master",
      { objectType: "message", objectIds: [String(input.messageId)] },
    );
    playTrace("TRANSPORT_STREAM_ADMITTED", { wait_ms: Date.now() - operationStarted });
    const stream = this.worker.stream(input, onChunk);
    playTrace("TRANSPORT_STREAM_WORKER_STARTED", { total_ms: Date.now() - started });
    return {
      completed: stream.completed.finally(() => {
        playTrace("TRANSPORT_STREAM_DONE", { total_ms: Date.now() - started });
        return this.controller.endOperation(lease).catch(() => {});
      }),
      cancel: stream.cancel,
    };
  }

  async commitImportedBeat(
    beat: Beat,
    files: WebImportFiles,
    sourceId: string,
    onProgress?: (progress: WebImportCommitProgress) => void,
  ): Promise<Beat> {
    await this.controller.connect();
    const lease = await this.controller.beginOperation(
      "commit_import",
      { objectType: "beat", objectIds: [beat.id] },
    );
    let topic: Promise<number> | null = null;
    try {
      const result = await commitWebImportedBeat(beat, files, {
        getLibraryIndex: () => this.worker.getLibraryIndex(),
        upload: async (input, progress) => {
          topic ||= ensureWebTransportTopic(input.beatId, input.beatName);
          const threadId = await topic;
          return this.uploadOnce({ ...input, threadId }, progress);
        },
        replaceLibraryIndex: input => this.worker.replaceLibraryIndex(input),
      }, onProgress);
      if (result.index) {
        await commitWebTransportIndexPointer({
          messageId: result.index.messageId,
          sourceId,
          beatCount: result.index.beatCount,
        }).catch(() => {});
      }
      for (const key of Array.from(this.uploadCheckpoints.keys())) {
        if (key.startsWith(`${beat.id}:`)) this.uploadCheckpoints.delete(key);
      }
      return result.beat;
    } finally {
      await this.controller.endOperation(lease).catch(() => {});
    }
  }

  async commitBeatEdit(
    original: Beat,
    updated: Beat,
    files: PlatformBeatEditFiles,
    sourceId: string,
    onProgress?: (progress: WebBeatEditProgress) => void,
  ): Promise<Beat> {
    await this.controller.connect();
    const lease = await this.controller.beginOperation(
      "commit_edit",
      { objectType: "beat", objectIds: [original.id] },
    );
    let topic: Promise<number> | null = null;
    try {
      const result = await commitWebBeatEdit(original, updated, files, {
        getLibraryIndex: () => this.worker.getLibraryIndex(),
        upload: async (input, progress) => {
          topic ||= ensureWebTransportTopic(input.beatId, input.beatName);
          const threadId = await topic;
          const uploaded = await this.uploadOnce({ ...input, threadId }, progress);
          return { ...uploaded, thread_id: threadId };
        },
        replaceLibraryIndex: input => this.worker.replaceLibraryIndex(input),
      }, onProgress);
      await commitWebTransportIndexPointer({
        messageId: result.index.messageId,
        sourceId,
        beatCount: result.index.beatCount,
      }).catch(() => {});
      for (const key of Array.from(this.uploadCheckpoints.keys())) {
        if (key.startsWith(`${original.id}:`)) this.uploadCheckpoints.delete(key);
      }
      return result.beat;
    } finally {
      await this.controller.endOperation(lease).catch(() => {});
    }
  }

  async listTrashItems(): Promise<PlatformTrashItem[]> {
    const current = await this.getLibraryIndex();
    return listWebTrashItems(current.manifest);
  }

  async moveBeatsToTrash(beatIds: string[], sourceId: string): Promise<string[]> {
    await this.controller.connect();
    const lease = await this.controller.beginOperation(
      "trash_move",
      { objectType: "beat", objectIds: beatIds },
    );
    try {
      const result = await moveWebBeatsToTrash(beatIds, {
        getLibraryIndex: () => this.worker.getLibraryIndex(),
        replaceLibraryIndex: input => this.worker.replaceLibraryIndex(input),
        deleteMessages: async ids => (await this.worker.deleteMessages({ messageIds: ids })).deleted,
      });
      if (result.index) {
        await commitWebTransportIndexPointer({
          messageId: result.index.messageId,
          sourceId,
          beatCount: result.index.beatCount,
        }).catch(() => {});
      }
      return result.value;
    } finally {
      await this.controller.endOperation(lease).catch(() => {});
    }
  }

  async restoreBeatFromTrash(trashId: string, sourceId: string): Promise<Beat> {
    await this.controller.connect();
    const lease = await this.controller.beginOperation(
      "trash_restore",
      { objectType: "trash", objectIds: [trashId] },
    );
    let restored: Beat;
    try {
      const result = await restoreWebBeatFromTrash(trashId, {
        getLibraryIndex: () => this.worker.getLibraryIndex(),
        replaceLibraryIndex: input => this.worker.replaceLibraryIndex(input),
        deleteMessages: async ids => (await this.worker.deleteMessages({ messageIds: ids })).deleted,
      });
      restored = result.value;
      if (result.index) {
        await commitWebTransportIndexPointer({
          messageId: result.index.messageId,
          sourceId,
          beatCount: result.index.beatCount,
        }).catch(() => {});
      }
    } finally {
      await this.controller.endOperation(lease).catch(() => {});
    }
    const match = /^direct:(\d+)$/.exec(String(restored.assets?.artwork?.object_id || ""));
    const messageId = Number(match?.[1] || 0);
    if (messageId > 0) {
      const [artwork] = await this.downloadFiles([{ messageId, mimeType: restored.assets?.artwork?.mime_type }]);
      if (artwork?.dataUrl) restored = { ...restored, image_base64: artwork.dataUrl, image_preview_base64: artwork.dataUrl };
    }
    return restored;
  }

  async purgeTrash(sourceId: string): Promise<number> {
    await this.controller.connect();
    const lease = await this.controller.beginOperation(
      "trash_purge",
      { objectType: "trash", objectIds: ["all"] },
    );
    try {
      const result = await purgeWebTrash({
        getLibraryIndex: () => this.worker.getLibraryIndex(),
        replaceLibraryIndex: input => this.worker.replaceLibraryIndex(input),
        deleteMessages: async ids => (await this.worker.deleteMessages({ messageIds: ids })).deleted,
      });
      if (result.index) {
        await commitWebTransportIndexPointer({
          messageId: result.index.messageId,
          sourceId,
          beatCount: result.index.beatCount,
        }).catch(() => {});
      }
      return result.value;
    } finally {
      await this.controller.endOperation(lease).catch(() => {});
    }
  }

  disconnect(): Promise<void> {
    this.uploadCheckpoints.clear();
    return this.controller.disconnect();
  }
}

export type {
  WebTransportDownloadInput,
  WebTransportDownloadResult,
  WebTransportLibraryIndexResult,
  WebTransportPrefetchInput,
  WebTransportPrefetchResult,
  WebTransportProgress,
  WebTransportStreamInput,
  WebTransportStreamResult,
  WebTransportUploadResult,
} from "./webTransportWorkerProtocol";
