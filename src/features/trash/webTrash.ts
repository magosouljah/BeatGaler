import type { Beat } from "../../types";
import type { PlatformTrashItem } from "../../platform/contracts";
import { beatFromWebLibraryEntry, normalizeWebLibraryManifest } from "../library/webLibrary";
import type {
  WebTransportLibraryIndexResult,
  WebTransportReplaceIndexResult,
} from "../cloud/webTransportWorkerProtocol";

type JsonRecord = Record<string, unknown>;

export interface WebTrashRuntime {
  getLibraryIndex(): Promise<WebTransportLibraryIndexResult>;
  replaceLibraryIndex(input: { manifest: unknown; expectedMessageId: number | null }): Promise<WebTransportReplaceIndexResult>;
  deleteMessages(messageIds: number[]): Promise<number>;
}

export interface WebTrashMutationResult<T> {
  value: T;
  index: WebTransportReplaceIndexResult | null;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trashBeat(value: unknown): JsonRecord | null {
  const row = record(value);
  return record(row?.beat) || row;
}

function trashId(value: unknown): string {
  const row = record(value);
  return text(row?.trash_id) || text(trashBeat(row)?.id);
}

function deletedById(root: JsonRecord): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of Array.isArray(root.deleted) ? root.deleted : []) {
    const row = record(value);
    const id = text(row?.beat_id) || text(row?.id);
    if (!id) continue;
    const deletedAt = Math.max(0, Math.trunc(Number(row?.deleted_at || row?.at || 0)));
    result.set(id, Math.max(result.get(id) || 0, deletedAt));
  }
  return result;
}

function identityId(value: unknown): string {
  return text(record(value)?.id);
}

function candidateRoot(current: WebTransportLibraryIndexResult, fields: JsonRecord): JsonRecord {
  const root = record(current.manifest) || {};
  return {
    ...root,
    schema: "beatgaler.telegram.library",
    version: 2,
    updated_at: Math.floor(Date.now() / 1000),
    ...fields,
  };
}

export function listWebTrashItems(manifest: unknown): PlatformTrashItem[] {
  const normalized = normalizeWebLibraryManifest(manifest);
  const root = record(manifest) || {};
  const deleted = deletedById(root);
  return normalized.trash
    .map(record)
    .filter((row): row is JsonRecord => Boolean(row))
    .map(row => ({ row, beat: trashBeat(row) }))
    .filter((value): value is { row: JsonRecord; beat: JsonRecord } => Boolean(value.beat))
    .filter(({ beat }) => !deleted.has(identityId(beat)))
    .map(({ row, beat }) => ({
      id: text(row.trash_id) || identityId(beat),
      beat_name: text(beat.name) || "Untitled beat",
      trashed_at: Math.max(0, Math.trunc(Number(row.trashed_at || 0))),
      is_cloud: true,
    }))
    .filter(item => Boolean(item.id))
    .sort((a, b) => b.trashed_at - a.trashed_at);
}

export async function moveWebBeatsToTrash(
  beatIds: string[],
  runtime: WebTrashRuntime,
  now = Math.floor(Date.now() / 1000),
): Promise<WebTrashMutationResult<string[]>> {
  const wanted = new Set(beatIds.map(id => id.trim()).filter(Boolean));
  if (wanted.size === 0) return { value: [], index: null };
  const current = await runtime.getLibraryIndex();
  normalizeWebLibraryManifest(current.manifest);
  const root = record(current.manifest) || {};
  const deleted = deletedById(root);
  const beats = Array.isArray(root.beats) ? root.beats : [];
  const currentTrash = Array.isArray(root.trash) ? root.trash : [];
  const alreadyTrashed = new Set(currentTrash.map(trashBeat).map(identityId).filter(Boolean));
  const moved: JsonRecord[] = [];
  const remaining = beats.filter(value => {
    const beat = record(value);
    const id = identityId(beat);
    if (deleted.has(id)) return false;
    if (!wanted.has(id)) return true;
    if (!alreadyTrashed.has(id) && beat) moved.push(beat);
    return false;
  });
  if (moved.length === 0) {
    return { value: Array.from(wanted).filter(id => alreadyTrashed.has(id)), index: null };
  }
  const added = moved.map(beat => ({
    trash_id: `cloud-trash:${identityId(beat)}:${crypto.randomUUID()}`,
    trashed_at: now,
    purge_after: now + 14 * 86400,
    beat,
  }));
  const candidate = candidateRoot(current, {
    beats: remaining,
    trash: [...added, ...currentTrash],
    deleted: Array.isArray(root.deleted) ? root.deleted : [],
  });
  const index = await runtime.replaceLibraryIndex({ manifest: candidate, expectedMessageId: current.messageId });
  return { value: moved.map(identityId), index };
}

export async function restoreWebBeatFromTrash(
  requestedTrashId: string,
  runtime: WebTrashRuntime,
): Promise<WebTrashMutationResult<Beat>> {
  const current = await runtime.getLibraryIndex();
  normalizeWebLibraryManifest(current.manifest);
  const root = record(current.manifest) || {};
  const trash = Array.isArray(root.trash) ? root.trash : [];
  const match = trash.find(value => trashId(value) === requestedTrashId);
  const payload = trashBeat(match);
  if (!payload) throw new Error("This beat is no longer in Trash. Refresh and try again.");
  const beatId = identityId(payload);
  if (!beatId) throw new Error("This Trash item is invalid.");
  if (deletedById(root).has(beatId)) {
    throw new Error("This beat was permanently deleted and cannot be restored.");
  }
  const beats = Array.isArray(root.beats) ? root.beats : [];
  const existing = beats.map(record).find(value => identityId(value) === beatId) || null;
  const nextTrash = trash.filter(value => trashId(value) !== requestedTrashId && identityId(trashBeat(value)) !== beatId);
  const nextBeats = existing ? beats : [...beats, payload];
  const candidate = candidateRoot(current, {
    beats: nextBeats,
    trash: nextTrash,
    deleted: Array.isArray(root.deleted) ? root.deleted : [],
  });
  const index = await runtime.replaceLibraryIndex({ manifest: candidate, expectedMessageId: current.messageId });
  return { value: beatFromWebLibraryEntry(existing || payload), index };
}

function collectMediaMessageIds(value: unknown, out = new Set<number>()): Set<number> {
  if (Array.isArray(value)) {
    for (const child of value) collectMediaMessageIds(child, out);
    return out;
  }
  const row = record(value);
  if (!row) return out;
  for (const [key, child] of Object.entries(row)) {
    if (key === "telegram_message_id") {
      const id = Number(child || 0);
      if (Number.isInteger(id) && id > 0) out.add(id);
    } else if (key === "telegram_file_id") {
      const match = /^direct:(\d+)$/.exec(String(child || ""));
      const id = Number(match?.[1] || 0);
      if (Number.isInteger(id) && id > 0) out.add(id);
    }
    collectMediaMessageIds(child, out);
  }
  return out;
}

export async function purgeWebTrash(
  runtime: WebTrashRuntime,
  now = Math.floor(Date.now() / 1000),
): Promise<WebTrashMutationResult<number>> {
  const current = await runtime.getLibraryIndex();
  normalizeWebLibraryManifest(current.manifest);
  const root = record(current.manifest) || {};
  const trash = Array.isArray(root.trash) ? root.trash : [];
  if (trash.length === 0) return { value: 0, index: null };
  const ids = new Set(trash.map(trashBeat).map(identityId).filter(Boolean));
  const tombstones = deletedById(root);
  for (const id of ids) tombstones.set(id, Math.max(tombstones.get(id) || 0, now));
  const deleted = Array.from(tombstones.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([beat_id, deleted_at]) => ({ beat_id, deleted_at }));
  const beats = (Array.isArray(root.beats) ? root.beats : []).filter(value => !ids.has(identityId(value)));
  const messageIds = Array.from(collectMediaMessageIds(trash)).sort((a, b) => a - b);
  const candidate = candidateRoot(current, { beats, trash: [], deleted });
  const index = await runtime.replaceLibraryIndex({ manifest: candidate, expectedMessageId: current.messageId });
  if (messageIds.length > 0) await runtime.deleteMessages(messageIds).catch(() => 0);
  return { value: ids.size, index };
}
