import type { Beat } from "../../types";
import { beatFromWebLibraryEntry, normalizeWebLibraryManifest } from "../library/webLibrary";
import type {
  WebTransportLibraryIndexResult,
  WebTransportProgress,
  WebTransportReplaceIndexResult,
  WebTransportUploadResult,
} from "../cloud/webTransportWorkerProtocol";

type JsonRecord = Record<string, unknown>;

export type WebImportCommitStage = "preparing" | "master" | "wav" | "artwork" | "project" | "library";

export interface WebImportCommitProgress extends WebTransportProgress {
  stage: WebImportCommitStage;
}

export interface WebImportCommitRuntime {
  getLibraryIndex(): Promise<WebTransportLibraryIndexResult>;
  upload(
    input: { file: File; filename: string; beatId: string; beatName: string; kind: "MASTER" | "WAV" | "PROJECT" | "ARTWORK" },
    onProgress?: (progress: WebTransportProgress) => void,
  ): Promise<WebTransportUploadResult>;
  replaceLibraryIndex(input: { manifest: unknown; expectedMessageId: number | null }): Promise<WebTransportReplaceIndexResult>;
}

export interface WebImportCommitResult {
  beat: Beat;
  index: WebTransportReplaceIndexResult | null;
}

export interface WebImportFiles {
  master: File;
  wav?: File | null;
  project?: File | null;
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
    file: new File([bytes], `${beatName || "beat"}-artwork.${extension}`, { type: match[1].toLowerCase(), lastModified: 0 }),
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

function cloudFileEntry(beatId: string, type: "WAV", upload: WebTransportUploadResult): JsonRecord {
  return {
    cloud_file_id: `${type}:${beatId}`,
    type,
    filename: upload.filename,
    size: upload.original_size,
    status: "SYNCED",
    manifest: uploadManifest(upload),
  };
}

function activeEntry(manifest: unknown, beatId: string): JsonRecord | null {
  const root = record(manifest);
  const rows = Array.isArray(root?.beats) ? root.beats : [];
  return rows.map(record).find(row => String(row?.id || "") === beatId) || null;
}

function tombstoneIds(manifest: unknown): Set<string> {
  const root = record(manifest);
  return new Set((Array.isArray(root?.deleted) ? root.deleted : [])
    .map(record)
    .map(row => String(row?.beat_id || row?.id || "").trim())
    .filter(Boolean));
}

function resultBeat(entry: JsonRecord, artworkDataUrl: string | null): Beat {
  const beat = beatFromWebLibraryEntry(entry);
  return artworkDataUrl ? { ...beat, image_base64: artworkDataUrl, image_preview_base64: artworkDataUrl } : beat;
}

/** Uploads available browser slots, then atomically publishes one authoritative library INDEX. */
export async function commitWebImportedBeat(
  beat: Beat,
  files: WebImportFiles,
  runtime: WebImportCommitRuntime,
  onProgress?: (progress: WebImportCommitProgress) => void,
): Promise<WebImportCommitResult> {
  const { master, wav = null, project = null } = files;
  onProgress?.({ stage: "preparing", uploadedBytes: 0, totalBytes: master.size + (wav?.size || 0) + (project?.size || 0) });
  const current = await runtime.getLibraryIndex();
  normalizeWebLibraryManifest(current.manifest);
  const deletedIds = tombstoneIds(current.manifest);
  if (deletedIds.has(beat.id)) {
    throw new Error("This beat was permanently deleted and cannot be added again with the same identity.");
  }
  const existing = activeEntry(current.manifest, beat.id);
  if (existing) {
    onProgress?.({ stage: "library", uploadedBytes: master.size, totalBytes: master.size });
    return { beat: resultBeat(existing, beat.image_base64), index: null };
  }

  const artworkAsset = beat.image_base64 ? dataUrlFile(beat.image_base64, beat.name) : null;
  const artworkFile = artworkAsset?.file || null;
  const totalBytes = master.size + (wav?.size || 0) + (project?.size || 0) + (artworkFile?.size || 0);
  const primary = await runtime.upload({
    file: master,
    filename: master.name,
    beatId: beat.id,
    beatName: beat.name,
    kind: "MASTER",
  }, progress => onProgress?.({
    stage: "master",
    uploadedBytes: Math.min(master.size, progress.uploadedBytes),
    totalBytes,
  }));

  let uploadedBytes = master.size;
  let uploadedWav: WebTransportUploadResult | null = null;
  if (wav) {
    uploadedWav = await runtime.upload({
      file: wav,
      filename: wav.name,
      beatId: beat.id,
      beatName: beat.name,
      kind: "WAV",
    }, progress => onProgress?.({
      stage: "wav",
      uploadedBytes: uploadedBytes + Math.min(wav.size, progress.uploadedBytes),
      totalBytes,
    }));
    uploadedBytes += wav.size;
  }

  let uploadedProject: WebTransportUploadResult | null = null;
  if (project) {
    uploadedProject = await runtime.upload({
      file: project,
      filename: project.name,
      beatId: beat.id,
      beatName: beat.name,
      kind: "PROJECT",
    }, progress => onProgress?.({
      stage: "project",
      uploadedBytes: uploadedBytes + Math.min(project.size, progress.uploadedBytes),
      totalBytes,
    }));
    uploadedBytes += project.size;
  }

  let artwork: WebTransportUploadResult | null = null;
  let artworkHash: string | null = null;
  if (artworkFile) {
    [artwork, artworkHash] = await Promise.all([
      runtime.upload({
        file: artworkFile,
        filename: artworkFile.name,
        beatId: beat.id,
        beatName: beat.name,
        kind: "ARTWORK",
      }, progress => onProgress?.({
        stage: "artwork",
        uploadedBytes: uploadedBytes + Math.min(artworkFile.size, progress.uploadedBytes),
        totalBytes,
      })),
      sha256(artworkAsset!.bytes),
    ]);
  }

  const primaryLocator = `direct:${primary.telegram_message_id}`;
  const entry: JsonRecord = {
    id: beat.id,
    sort_order: 0,
    name: beat.name,
    bpm: beat.bpm,
    key: beat.key,
    tags: [...(beat.tags || [])],
    rating: beat.rating,
    color: beat.color,
    color2: beat.color2,
    master: {
      telegram_file_id: primaryLocator,
      telegram_message_id: primary.telegram_message_id,
      filename: primary.filename,
      mime: master.type || "audio/mpeg",
      size: primary.original_size,
      manifest: uploadManifest(primary),
    },
    artwork: artwork ? {
      telegram_file_id: `direct:${artwork.telegram_message_id}`,
      telegram_message_id: artwork.telegram_message_id,
      filename: artwork.filename,
      hash: artworkHash,
      mime: artworkFile?.type || "image/png",
      size: artwork.original_size,
      manifest: uploadManifest(artwork),
    } : null,
    metadata_message_id: null,
    files: uploadedWav ? [cloudFileEntry(beat.id, "WAV", uploadedWav)] : [],
    project: uploadedProject ? {
      manifest: uploadManifest(uploadedProject),
      size: uploadedProject.original_size,
      openable: false,
      has_flp: false,
      has_als: false,
      has_samples: false,
    } : null,
  };

  const root = record(current.manifest) || {};
  const previousBeats = Array.isArray(root.beats)
    ? root.beats.map(record).filter(Boolean).filter(row => !deletedIds.has(String(row?.id || ""))) as JsonRecord[]
    : [];
  const candidate = {
    ...root,
    schema: "beatgaler.telegram.library",
    version: 2,
    updated_at: Math.floor(Date.now() / 1000),
    beats: [entry, ...previousBeats.filter(row => String(row.id || "") !== beat.id)]
      .map((row, index) => ({ ...row, sort_order: index })),
    trash: Array.isArray(root.trash) ? root.trash : [],
  };
  onProgress?.({ stage: "library", uploadedBytes: totalBytes, totalBytes });
  const index = await runtime.replaceLibraryIndex({ manifest: candidate, expectedMessageId: current.messageId });
  onProgress?.({ stage: "library", uploadedBytes: totalBytes, totalBytes });
  return { beat: resultBeat(entry, beat.image_base64), index };
}
