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
import type { PlatformBeatEditFiles, PlatformTrashItem } from "../../platform/contracts";
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
  type WebTransportPrefetchTerminal,
  type WebTransportProgress,
  type WebTransportStreamInput,
  type WebTransportStreamResult,
  type WebTransportUploadInput,
  type WebTransportUploadResult,
} from "./webTransportWorkerProtocol";

export interface WebTransportPrefetchFilesHandle {
  completed: Promise<WebTransportPrefetchBatchResult>;
  cancelMessage(messageId: number): void;
  promoteMessage(messageId: number): Promise<void>;
  cancel(): void;
}

export interface WebStartupWarmCandidate {
  beatId: string;
  messageId: number;
  mimeType: string;
  sizeBytes?: number | null;
}

function positiveMessageId(value: unknown): number | null {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function nullableSize(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function normalizeStartupCandidates(candidates: readonly WebStartupWarmCandidate[]): WebStartupWarmCandidate[] {
  const seen = new Set<string>();
  const output: WebStartupWarmCandidate[] = [];
  for (const candidate of candidates) {
    const beatId = String(candidate.beatId || "").trim();
    const messageId = positiveMessageId(candidate.messageId);
    if (!beatId || !messageId || seen.has(beatId)) continue;
    seen.add(beatId);
    output.push({
      beatId,
      messageId,
      mimeType: String(candidate.mimeType || "").trim() || "audio/mpeg",
      sizeBytes: nullableSize(candidate.sizeBytes),
    });
    if (output.length >= 14) break;
  }
  return output;
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
  private readonly worker: WebTransportWorkerClient;
  private readonly controller: WebTransportController;
  private readonly uploadCheckpoints = new Map<string, Promise<WebTransportUploadResult>>();
  private playbackDataLanes = DEFAULT_PLAYBACK_DATA_LANES;
  private indexBarrier: () => Promise<void> = () => Promise.resolve();
  private indexReadPromise: Promise<WebTransportLibraryIndexResult> | null = null;

  constructor(startupCandidates: readonly WebStartupWarmCandidate[] = []) {
    const candidates = normalizeStartupCandidates(startupCandidates);
    this.worker = new WebTransportWorkerClient();
    this.controller = new WebTransportController(this.worker, undefined, {
      startupBeatIds: candidates.map(candidate => candidate.beatId),
      startupMessageIds: candidates.map(candidate => candidate.messageId),
    });
    playTrace("TRANSPORT_CODE_PREWARM_ENTER", { startup_beat_count: candidates.length });
    this.worker.prewarm();
  }

  setPlaybackDataLanes(lanes: number): void {
    this.playbackDataLanes = Math.max(1, Math.min(16, Math.trunc(Number(lanes) || DEFAULT_PLAYBACK_DATA_LANES)));
  }

  setIndexBarrier(barrier: () => Promise<void>): void {
    this.indexBarrier = barrier;
  }

  async connectPlaybackDataPlane(): Promise<void> {
    playTrace("DIRECT_START_DISPATCHED");
    await this.controller.connect();
    playTrace("DIRECT_MTPROTO_READY");
  }

  focusPlayback(messageId: number): Promise<void> {
    return this.worker.focusPlayback(messageId);
  }

  markPlaybackStable(messageId: number): Promise<void> {
    return this.worker.markPlaybackStable(messageId);
  }

  releasePlaybackFocus(messageId: number): Promise<void> {
    return this.worker.releasePlaybackFocus(messageId);
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

  getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {
    if (this.indexReadPromise) {
      playTrace("TRANSPORT_GET_INDEX_JOIN");
      return this.indexReadPromise;
    }
    let pending!: Promise<WebTransportLibraryIndexResult>;
    pending = (async () => {
      const started = Date.now();
      playTrace("TRANSPORT_GET_INDEX_ENTER");
      await this.indexBarrier();
      const connectStarted = Date.now();
      await this.controller.connect();
      playTrace("TRANSPORT_GET_INDEX_CONNECTED", { wait_ms: Date.now() - connectStarted });
      const operationStarted = Date.now();
      const result = await this.controller.withOperation(
        "get_index",
        { objectType: "index", objectIds: ["pinned"] },
        () => this.worker.getLibraryIndex(),
      );
      void reconcileWebTransportRouting(result.manifest).catch(error => {
        playTrace("TRANSPORT_ROUTING_RECONCILE_DEFERRED", {
          error_name: error instanceof Error ? error.name : "unknown",
        });
      });
      playTrace("TRANSPORT_GET_INDEX_DONE", {
        operation_ms: Date.now() - operationStarted,
        total_ms: Date.now() - started,
      });
      return result;
    })().finally(() => {
      if (this.indexReadPromise === pending) this.indexReadPromise = null;
    });
    this.indexReadPromise = pending;
    return pending;
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
              results[index] = await this.worker.download({ ...inputs[index], purpose: inputs[index].purpose || "artwork" });
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
    const result = await this.worker.prefetch(input);
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
    onTerminal?: (terminal: WebTransportPrefetchTerminal) => void,
  ): Promise<WebTransportPrefetchFilesHandle> {
    if (inputs.length === 0) {
      return {
        completed: Promise.resolve({ results: [] }),
        cancelMessage() {},
        promoteMessage: async () => {},
        cancel() {},
      };
    }
    const started = Date.now();
    const ids = Array.from(new Set(
      inputs.map(input => Number(input.messageId)).filter(id => Number.isInteger(id) && id > 0),
    ));
    playTrace("TRANSPORT_PREFETCH_BATCH_ENTER", { count: ids.length, lanes: this.playbackDataLanes });
    await this.controller.connect();
    const workerBatch = this.worker.prefetchBatch({
      inputs,
      maxConcurrency: this.playbackDataLanes,
    }, onChunk, onTerminal);
    const completed = workerBatch.completed.finally(() => {
      playTrace("TRANSPORT_PREFETCH_BATCH_DONE", { count: ids.length, total_ms: Date.now() - started });
    });
    return {
      completed,
      cancelMessage: workerBatch.cancelMessage,
      promoteMessage: workerBatch.promoteMessage,
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
    const stream = this.worker.stream({ ...input, purpose: input.purpose || "playback" }, onChunk);
    playTrace("TRANSPORT_STREAM_WORKER_STARTED", { total_ms: Date.now() - started });
    return {
      completed: stream.completed.finally(() => {
        playTrace("TRANSPORT_STREAM_DONE", { total_ms: Date.now() - started });
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
      if (artwork?.dataUrl) {
        restored = { ...restored, image_base64: artwork.dataUrl, image_preview_base64: artwork.dataUrl };
      }
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
    this.indexReadPromise = null;
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
  WebTransportPrefetchTerminal,
  WebTransportProgress,
  WebTransportStreamInput,
  WebTransportStreamResult,
  WebTransportUploadResult,
} from "./webTransportWorkerProtocol";
