import type { Beat } from "../../types";
import type { PlatformBeatEditFiles } from "../../platform/contracts";
import { beatFromWebLibraryEntry, normalizeWebLibraryManifest } from "../library/webLibrary";
import type {
  WebTransportLibraryIndexResult,
  WebTransportProgress,
  WebTransportReplaceIndexResult,
  WebTransportUploadResult,
} from "../cloud/webTransportWorkerProtocol";

type JsonRecord = Record<string, unknown>;
type EditUploadKind = "MASTER" | "WAV" | "PROJECT" | "ARTWORK";

export type WebBeatEditStage = "preparing" | "master" | "wav" | "artwork" | "project" | "library";

export interface WebBeatEditProgress extends WebTransportProgress {
  stage: WebBeatEditStage;
}

export interface WebBeatEditRuntime {
  getLibraryIndex(): Promise<WebTransportLibraryIndexResult>;
  upload(
    input: { file: File; filename: string; beatId: string; beatName: string; kind: EditUploadKind },
    onProgress?: (progress: WebTransportProgress) => void,
  ): Promise<WebTransportUploadResult>;
  replaceLibraryIndex(input: { manifest: unknown; expectedMessageId: number | null }): Promise<WebTransportReplaceIndexResult>;
}

export interface WebBeatEditResult {
  beat: Beat;
  index: WebTransportReplaceIndexResult;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function dataUrlFile(dataUrl: string, beatName: string): { file: File; bytes: Uint8Array } | null {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp|bmp|avif));base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const binary = atob(match[2].replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const extension = match[1].toLowerCase().includes("jpeg") ? "jpg" : match[1].split("/")[1];
  return {
    file: new File([bytes], `${beatName || "beat"}-artwork.${extension}`, {
      type: match[1].toLowerCase(),
      lastModified: 0,
    }),
    bytes,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function uploadManifest(upload: WebTransportUploadResult): JsonRecord {
  return {
    telegram_file_id: upload.telegram_file_id,
    telegram_message_id: upload.telegram_message_id,
    filename: upload.filename,
    original_size: upload.original_size,
    parts: upload.parts,
    transport: upload.transport,
  };
}

function cloudFileEntry(beatId: string, upload: WebTransportUploadResult): JsonRecord {
  return {
    cloud_file_id: `WAV:${beatId}`,
    type: "WAV",
    filename: upload.filename,
    size: upload.original_size,
    status: "SYNCED",
    manifest: uploadManifest(upload),
  };
}

function resultBeat(entry: JsonRecord, artworkDataUrl: string | null): Beat {
  const beat = beatFromWebLibraryEntry(entry);
  return artworkDataUrl
    ? { ...beat, image_base64: artworkDataUrl, image_preview_base64: artworkDataUrl }
    : beat;
}

/** Uploads changed slots first, then publishes exactly one replacement library INDEX. */
export async function commitWebBeatEdit(
  original: Beat,
  updated: Beat,
  files: PlatformBeatEditFiles,
  runtime: WebBeatEditRuntime,
  onProgress?: (progress: WebBeatEditProgress) => void,
): Promise<WebBeatEditResult> {
  const current = await runtime.getLibraryIndex();
  const manifest = normalizeWebLibraryManifest(current.manifest);
  const existingIndex = manifest.beats.findIndex(row => String(row.id || "") === original.id);
  if (existingIndex < 0) throw new Error("This beat is no longer in your Galer Cloud library. Refresh and try again.");

  const existing = manifest.beats[existingIndex];

  const artworkChanged = (updated.image_base64 || null) !== (original.image_base64 || null);
  const artworkAsset = artworkChanged && updated.image_base64 ? dataUrlFile(updated.image_base64, updated.name) : null;
  if (artworkChanged && updated.image_base64 && !artworkAsset) {
    throw new Error("Choose a valid artwork image before saving.");
  }

  const queued: Array<{ kind: EditUploadKind; file: File; stage: WebBeatEditStage }> = [];
  if (files.MASTER) queued.push({ kind: "MASTER", file: files.MASTER, stage: "master" });
  if (files.WAV) queued.push({ kind: "WAV", file: files.WAV, stage: "wav" });
  if (files.PROJECT) queued.push({ kind: "PROJECT", file: files.PROJECT, stage: "project" });
  if (artworkAsset) queued.push({ kind: "ARTWORK", file: artworkAsset.file, stage: "artwork" });
  const totalBytes = queued.reduce((total, item) => total + item.file.size, 0);
  onProgress?.({ stage: "preparing", uploadedBytes: 0, totalBytes });

  const uploads = new Map<EditUploadKind, WebTransportUploadResult>();
  let resolvedThreadId: number | null = null;
  let completedBytes = 0;
  for (const item of queued) {
    const upload = await runtime.upload({
      file: item.file,
      filename: item.file.name,
      beatId: original.id,
      beatName: updated.name,
      kind: item.kind,
    }, progress => onProgress?.({
      stage: item.stage,
      uploadedBytes: completedBytes + Math.min(item.file.size, progress.uploadedBytes),
      totalBytes,
    }));
    uploads.set(item.kind, upload);
    const uploadThreadId = Number((upload as WebTransportUploadResult & { thread_id?: number }).thread_id || 0);
    if (Number.isInteger(uploadThreadId) && uploadThreadId > 0) resolvedThreadId = uploadThreadId;
    completedBytes += item.file.size;
  }

  const next: JsonRecord = {
    ...existing,
    id: original.id,
    name: updated.name.trim(),
    bpm: updated.bpm,
    key: updated.key,
    tags: [...updated.tags],
    rating: updated.rating,
    color: updated.color,
    color2: updated.color2,
  };
  if (resolvedThreadId) next.telegram_topic_id = resolvedThreadId;

  const master = uploads.get("MASTER");
  if (master && files.MASTER) {
    next.master = {
      telegram_file_id: `direct:${master.telegram_message_id}`,
      telegram_message_id: master.telegram_message_id,
      filename: master.filename,
      mime: files.MASTER.type || "audio/mpeg",
      size: master.original_size,
      manifest: uploadManifest(master),
    };
  }

  const wav = uploads.get("WAV");
  if (wav) {
    const existingFiles = Array.isArray(existing.files) ? existing.files : [];
    next.files = [
      ...existingFiles.filter(value => String(record(value)?.type || "").toUpperCase() !== "WAV"),
      cloudFileEntry(original.id, wav),
    ];
  }

  const project = uploads.get("PROJECT");
  if (project) {
    next.project = {
      manifest: uploadManifest(project),
      size: project.original_size,
      openable: false,
      has_flp: false,
      has_als: false,
      has_samples: false,
    };
  }

  const artwork = uploads.get("ARTWORK");
  if (artwork && artworkAsset) {
    next.artwork = {
      telegram_file_id: `direct:${artwork.telegram_message_id}`,
      telegram_message_id: artwork.telegram_message_id,
      filename: artwork.filename,
      hash: await sha256(artworkAsset.bytes),
      mime: artworkAsset.file.type || "image/png",
      size: artwork.original_size,
      manifest: uploadManifest(artwork),
    };
  } else if (artworkChanged) {
    next.artwork = null;
  }

  const root = record(current.manifest) || {};
  const beats = manifest.beats.map((row, index) => index === existingIndex ? next : row);
  const candidate = {
    ...root,
    schema: "beatgaler.telegram.library",
    version: 2,
    updated_at: Math.floor(Date.now() / 1000),
    beats,
    trash: Array.isArray(root.trash) ? root.trash : [],
  };
  onProgress?.({ stage: "library", uploadedBytes: totalBytes, totalBytes });
  const index = await runtime.replaceLibraryIndex({ manifest: candidate, expectedMessageId: current.messageId });
  onProgress?.({ stage: "library", uploadedBytes: totalBytes, totalBytes });
  return { beat: resultBeat(next, updated.image_base64 || null), index };
}
