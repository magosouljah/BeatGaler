import type { Beat } from "../../types";
import type { BeatAssets, GalerCloudObjectRef } from "../../domain/beat";

export interface WebTransportDownloadInput { messageId: number; mimeType?: string | null; }
export interface WebTransportDownloadResult { messageId: number; dataUrl: string; }
export interface WebTransportLibraryIndexResult { manifest: unknown; messageId: number | null; }
export const GALER_T_LIBRARY_SCHEMA = "beatgaler.telegram.library";
export const GALER_T_LIBRARY_VERSION = 2;
type JsonRecord = Record<string, unknown>;
export interface WebLibraryManifest { schema: typeof GALER_T_LIBRARY_SCHEMA; version: typeof GALER_T_LIBRARY_VERSION; beats: JsonRecord[]; trash: unknown[]; deleted: unknown[]; updated_at?: number; }
export interface WebLibraryTransport { getLibraryIndex(): Promise<WebTransportLibraryIndexResult>; downloadFiles(inputs: WebTransportDownloadInput[]): Promise<Array<WebTransportDownloadResult | null>>; }
export type WebLibraryLoadState = "ready" | "empty" | "no-results" | "offline" | "auth-failure" | "cloud-failure";
export interface WebLibraryLoadObservation { state: WebLibraryLoadState; durationMs: number; beatCount: number; }
export interface WebLibraryLoadOptions { online?: boolean; queryActive?: boolean; now?: () => number; onObservation?: (observation: WebLibraryLoadObservation) => void; }
function record(value: unknown): JsonRecord | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null; }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function positiveInteger(value: unknown): number | null { const number = Number(value || 0); return Number.isInteger(number) && number > 0 ? number : null; }
function directLocator(fileId: unknown, messageId: unknown): string | null { const raw = text(fileId).trim(); if (/^direct:\d+$/.test(raw)) return raw; const id = positiveInteger(messageId); if (id) return `direct:${id}`; return raw || null; }
function messageIdFromLocator(locator: string | null | undefined): number | null { const match = /^direct:(\d+)$/.exec(String(locator || "").trim()); return match ? positiveInteger(match[1]) : null; }
function firstPart(value: JsonRecord | null): JsonRecord | null { const parts = Array.isArray(value?.parts) ? value.parts : []; return record(parts[0]); }
function objectRef(source: JsonRecord | null, options: { revision?: string | null; fallbackFilename?: string | null; fallbackSize?: number | null } = {}): GalerCloudObjectRef | null { if (!source) return null; const part = firstPart(record(source.manifest)) || firstPart(source); const objectId = directLocator(part?.telegram_file_id ?? source.telegram_file_id, part?.telegram_message_id ?? source.telegram_message_id) || text(source.cloud_file_id).trim() || null; if (!objectId) return null; const size = Number(part?.size ?? source.size ?? options.fallbackSize ?? 0); const filename = text(part?.filename ?? source.filename ?? options.fallbackFilename).trim() || null; const mimeType = text(source.mime ?? source.mime_type).trim() || null; return { object_id: objectId, revision: options.revision || text(source.cloud_file_id).trim() || null, filename, mime_type: mimeType, size_bytes: Number.isFinite(size) && size >= 0 ? size : null }; }
function projectFlags(project: JsonRecord | null) { const manifest = record(project?.manifest); const flag = (name: string) => project?.[name] === true || manifest?.[name] === true; const hasFlp = flag("has_flp") || flag("openable"); return { hasFlp, hasAls: flag("has_als"), hasSamples: flag("has_samples") }; }
function filesByType(entry: JsonRecord): Map<string, JsonRecord> { const files = Array.isArray(entry.files) ? entry.files : []; const result = new Map<string, JsonRecord>(); for (const value of files) { const file = record(value); if (!file) continue; const type = text(file.type).trim().toUpperCase(); if (type && !result.has(type)) result.set(type, file); } return result; }
function assetsFromEntry(entry: JsonRecord): BeatAssets { const files = filesByType(entry); const project = record(entry.project); const projectManifest = record(project?.manifest); return { master: objectRef(record(entry.master)), wav: objectRef(files.get("WAV") || null, { revision: text(files.get("WAV")?.cloud_file_id) || null }), artwork: objectRef(record(entry.artwork)), project: objectRef(projectManifest, { revision: `PROJECT:${text(entry.id)}`, fallbackFilename: `${text(entry.name, "beat")}.zip`, fallbackSize: Number(project?.size || 0) }), samples: null, stems: objectRef(files.get("STEMS") || null, { revision: text(files.get("STEMS")?.cloud_file_id) || null }), loop: objectRef(files.get("LOOP") || null, { revision: text(files.get("LOOP")?.cloud_file_id) || null }) }; }
export function normalizeWebLibraryManifest(value: unknown): WebLibraryManifest { const source = record(value); if (!source || source.schema !== GALER_T_LIBRARY_SCHEMA) throw new Error("Galer Cloud returned an invalid library index."); const version = Number(source.version ?? 1); if (!Number.isInteger(version) || version < 1) throw new Error("Galer Cloud returned an unsupported library index."); if (version > GALER_T_LIBRARY_VERSION) throw new Error("This library requires a newer BeatGaler version."); const deleted = Array.isArray(source.deleted) ? source.deleted : []; const deletedIds = new Set(deleted.map(record).map(row => text(row?.beat_id ?? row?.id).trim()).filter(Boolean)); const beats = (Array.isArray(source.beats) ? source.beats.map(record).filter((beat): beat is JsonRecord => beat !== null) : []).filter(beat => !deletedIds.has(text(beat.id).trim())); const trash = (Array.isArray(source.trash) ? source.trash : []).filter(value => { const row = record(value); const beat = record(row?.beat) || row; return !deletedIds.has(text(beat?.id).trim()); }); return { schema: GALER_T_LIBRARY_SCHEMA, version: GALER_T_LIBRARY_VERSION, beats, trash, deleted, updated_at: Number.isFinite(Number(source.updated_at)) ? Number(source.updated_at) : undefined }; }
export function beatFromWebLibraryEntry(entry: JsonRecord): Beat { const id = text(entry.id).trim(); if (!id) throw new Error("Galer Cloud library contains a beat without an ID."); const name = text(entry.name, "Untitled").trim() || "Untitled"; const files = filesByType(entry); const assets = assetsFromEntry(entry); const flags = projectFlags(record(entry.project)); const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : []; const rating = Math.max(0, Math.min(255, Math.trunc(Number(entry.rating) || 0))); const otherFiles = Array.from(files.entries()).filter(([type]) => type === "OTHER").map(([, file]) => text(file.filename).trim()).filter(Boolean); return { id, name, folder_path: "", mp3_path: "", wav_path: null, playback_path: "", bpm: text(entry.bpm), key: text(entry.key), needs_resolution: false, tags, rating, image_base64: null, image_preview_base64: null, image_crop: null, has_wav: assets.wav !== null, has_stems: assets.stems !== null, has_samples: flags.hasSamples, samples_path: null, has_flp: flags.hasFlp, has_als: flags.hasAls, stems_path: null, flp_path: null, als_path: null, other_files: otherFiles, color: text(entry.color, "#666666"), color2: text(entry.color2, "#999999"), has_loop: assets.loop !== null, loop_path: null, cloud_status: Object.values(assets).some(Boolean) ? "CLOUD_ONLY" : null, telegram_file_id: assets.master?.object_id || null, telegram_message_id: messageIdFromLocator(assets.master?.object_id), offline_available: false, assets }; }

export function classifyWebLibraryLoadError(error: unknown, online = true): WebLibraryLoadState {
  if (!online) return "offline";
  const message = error instanceof Error ? error.message : String(error || "");
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|auth(?:entication)?\s*(?:failed|required)/i.test(message)) return "auth-failure";
  return "cloud-failure";
}

export function classifyWebLibraryResult(beatCount: number, queryActive = false): WebLibraryLoadState {
  if (beatCount > 0) return "ready";
  return queryActive ? "no-results" : "empty";
}

// Initial library load intentionally returns metadata only. Artwork remains represented by
// assets.artwork and is resolved on demand by the presentation/media path instead of blocking
// startup on an N-artwork download batch. Timing is emitted around the authoritative metadata
// phase so repeated cold/warm runs can compare the same boundary.
export async function loadWebLibrary(transport: WebLibraryTransport, options: WebLibraryLoadOptions = {}): Promise<Beat[]> {
  const now = options.now || (() => typeof performance !== "undefined" ? performance.now() : Date.now());
  const startedAt = now();
  try {
    const index = await transport.getLibraryIndex();
    const manifest = normalizeWebLibraryManifest(index.manifest);
    const beats = manifest.beats.map(beatFromWebLibraryEntry);
    options.onObservation?.({ state: classifyWebLibraryResult(beats.length, options.queryActive), durationMs: Math.max(0, now() - startedAt), beatCount: beats.length });
    return beats;
  } catch (error) {
    options.onObservation?.({ state: classifyWebLibraryLoadError(error, options.online ?? true), durationMs: Math.max(0, now() - startedAt), beatCount: 0 });
    throw error;
  }
}
