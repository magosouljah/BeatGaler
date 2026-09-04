import { WebTransportController } from "./webTransportController";
import {
  commitWebTransportIndexPointer,
  ensureWebTransportTopic,
  reconcileWebTransportRouting,
} from "./webTransportSession";
import { WebTransportWorkerClient } from "./webTransportWorkerClient";
import type { Beat } from "../../types";
import { commitWebImportedBeat, type WebImportCommitProgress, type WebImportFiles } from "../import/webImportCommit";
import { commitWebBeatEdit, type WebBeatEditProgress } from "../edit/webBeatEdit";
import type { PlatformBeatEditFiles } from "../../platform/contracts";
import type { PlatformTrashItem } from "../../platform/contracts";
import { playTrace } from "../playback/playTrace";
import { listWebTrashItems, moveWebBeatsToTrash, purgeWebTrash, restoreWebBeatFromTrash } from "../trash/webTrash";
import {
  DEFAULT_PLAYBACK_DATA_LANES,
  type WebTransportDownloadInput,
  type WebTransportDownloadResult,
  type WebTransportLibraryIndexResult,
  type WebTransportPrefetchBatchResult,
  type WebTransportPrefetchChunk,
  type WebTransportPrefetchInput,
  type WebTransportPrefetchResult,
  type WebTransportProgress,
  type WebTransportStreamInput,
  type WebTransportStreamResult,
  type WebTransportUploadInput,
  type WebTransportUploadResult,
} from "./webTransportWorkerProtocol";

export interface WebTransportPrefetchFilesHandle {
  completed: Promise<WebTransportPrefetchBatchResult>;
  cancelMessage(messageId: number): void;
  cancel(): void;
}

export interface WebStartupWarmCandidate {
  beatId: string;
  messageId: number;
  mimeType: string;
}

function positiveMessageId(value: unknown): number | null {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function directMessageId(value: string | null | undefined): number | null {
  const match = /^direct:(\d+)$/.exec(String(value || "").trim());
  return positiveMessageId(match?.[1]);
}

function beatMasterMessageId(beat: Beat): number | null {
  return positiveMessageId(beat.telegram_message_id)
    || directMessageId(beat.assets?.master?.object_id)
    || directMessageId(beat.telegram_file_id);
}

function routingChangeForBeat(beat: Beat): Record<string, number | null> {
  return { [beat.id]: beatMasterMessageId(beat) };
}

export class WebGalerCloudTransport {
  private readonly worker = new WebTransportWorkerClient();
  private readonly controller = new WebTransportController(this.worker);
  private readonly uploadCheckpoints = new Map<string, Promise<WebTransportUploadResult>>();
  private startupWarmPromise: Promise<void> | null = null;
  private playbackDataLanes = DEFAULT_PLAYBACK_DATA_LANES;

  constructor() {
    // Preload Worker code/wasm immediately, but do not reserve the Direct lease
    // until presentation-cache startupBeatIds have been selected locally.
    playTrace("TRANSPORT_CODE_PREWARM_ENTER");
    this.worker.prewarm();
  }

  setPlaybackDataLanes(lanes: number): void {
    this.playbackDataLanes = Math.max(1, Math.min(16, Math.trunc(Number(lanes) || DEFAULT_PLAYBACK_DATA_LANES)));
  }

  startStartupWarm(
    candidates: readonly WebStartupWarmCandidate[],
    warm: (routed: WebStartupWarmCandidate[]) => Promise<void>,
  ): Promise<void> {
    if (this.startupWarmPromise) return this.startupWarmPromise;
    const normalized = candidates
      .filter(candidate => candidate.beatId && positiveMessageId(candidate.messageId))
      .slice(0, 14);
    this.controller.configureStartupBeatIds(normalized.map(candidate => candidate.beatId));
    if (normalized.length === 0) return Promise.resolve();

    const started = Date.now();
    this.startupWarmPromise = (async () => {
      const session = await this.controller.connect();
      const routed = normalized.map(candidate => {
        const cloudRoute = positiveMessageId(session.startup_routes?.[candidate.beatId]);
        if (!cloudRoute) {
          playTrace("TRANSPORT_STARTUP_ROUTE_FALLBACK", {
            beat_id: candidate.beatId,
            cached_message_id: candidate.messageId,
            routing_revision: Math.max(0, Number(session.routing_revision) || 0),
          });
        }
        return { ...candidate, messageId: cloudRoute || candidate.messageId };
      });
      playTrace("TRANSPORT_STARTUP_ROUTES_READY", {
        count: routed.length,
        cloud_routes: routed.filter((candidate, index) => candidate.messageId !== normalized[index].messageId).length,
        routing_revision: Math.max(0, Number(session.routing_revision) || 0),
      });
      await warm(routed);
      playTrace("TRANSPORT_STARTUP_WARM_READY", { count: routed.length, elapsed_ms: Date.now() - started });
    })().catch(error => {
      playTrace("TRANSPORT_STARTUP_WARM_DEFERRED", {
        elapsed_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    });
    return this.startupWarmPromise;
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
    if (this.startupWarmPromise) {
      await this.startupWarmPromise.catch(() => {});
      playTrace("TRANSPORT_GET_INDEX_AFTER_STARTUP_WARM");
    }
    const connectStarted = Date.now();
    await this.controller.connect();
    playTrace("TRANSPORT_GET_INDEX_CONNECTED", { wait_ms: Date.now() - connectStarted });
    const operationStarted = Date.now();
    const result = await this.controller.withOperation(
      "get_index",
      { objectType: "index", objectIds: ["pinned"] },
      () => this.worker.getLibraryIndex(),
    );
    // Telegram is authoritative; repair the tiny Cloud routing map without
    // delaying the caller/UI that just received the authoritative manifest.
    void reconcileWebTransportRouting(result.manifest).catch(error => {
      playTrace("TRANSPORT_ROUTING_RECONCILE_DEFERRED", { error_name: error instanceof Error ? error.name : "unknown" });
    });
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

  async prefetchFiles(
    inputs: WebTransportPrefetchInput[],
    onChunk?: (progress: WebTransportPrefetchChunk) => void,
  ): Promise<WebTransportPrefetchFilesHandle> {
    if (inputs.length === 0) {
      return {
        completed: Promise.resolve({ results: [] }),
        cancelMessage() {},
        cancel() {},
      };
    }
    const started = Date.now();
    const ids = Array.from(new Set(inputs.map(input => Number(input.messageId)).filter(id => Number.isInteger(id) && id > 0)));
    playTrace("TRANSPORT_PREFETCH_BATCH_ENTER", { count: ids.length, lanes: this.playbackDataLanes });
    await this.controller.connect();
    // One scoped WARM operation covers every startup candidate. Playback uses
    // streamFile(), which acquires an independent operation for the active beat.
    const lease = await this.controller.beginOperation(
      "stream_master",
      { objectType: "message", objectIds: ids.map(String) },
    );
    const workerBatch = this.worker.prefetchBatch({
      inputs,
      maxConcurrency: this.playbackDataLanes,
    }, onChunk);
    const completed = workerBatch.completed.finally(() => {
      playTrace("TRANSPORT_PREFETCH_BATCH_DONE", { count: ids.length, total_ms: Date.now() - started });
      return this.controller.endOperation(lease).catch(() => {});
    });
    return {
      completed,
      cancelMessage: workerBatch.cancelMessage,
      cancel: workerBatch.cancel,
    };
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
    // Foreground playback deliberately owns a separate authorization from warm.
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
          routingChanges: routingChangeForBeat(result.beat),
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
        routingChanges: routingChangeForBeat(result.beat),
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
          routingChanges: Object.fromEntries(beatIds.map(id => [id, null])),
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
          routingChanges: routingChangeForBeat(restored),
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
  WebTransportPrefetchBatchResult,
  WebTransportPrefetchChunk,
  WebTransportPrefetchInput,
  WebTransportPrefetchResult,
  WebTransportProgress,
  WebTransportStreamInput,
  WebTransportStreamResult,
  WebTransportUploadResult,
} from "./webTransportWorkerProtocol";
