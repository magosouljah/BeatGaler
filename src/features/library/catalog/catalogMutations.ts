// T13 — Cliente de mutaciones sin INDEX (TAREAS §T13; MATRIZ-T §T13; CONTRATO C5–C7; NATIVO r2.1 §10 T13 simplificada).
//  - Metadata-only → PATCH con expectedVersion; 409 → resultado `conflict` tipado (la UI conserva el draft; nunca PATCH automático).
//  - Import/reemplazo → operación C7 (catalogTransfer): strip ID3 del MASTER, ZIP del PROJECT y progreso se conservan como
//    preparación de archivos, separados de la autoridad del catálogo; detalle SQL (GET /beats/:id) para versión y archivos; cero INDEX.
//  - Trash/restore en lotes ≤50 con versiones; un conflicto detiene los lotes siguientes y se reporta (sin éxito global falso).
//  - "Toda la papelera" y purge: job server-side (BULK_TRASH sobre selección; PURGE → T15 → estado `pending`, nunca éxito ficticio).
//  - Referencias de operación por cuenta persistidas (sin tokens ni secretos) para consultar el resultado tras recargar; un checkpoint
//    en memoria nunca marca una subida como exitosa.
import type { Beat } from "../../../types";
import type { BeatAssets, GalerCloudObjectRef } from "../../../domain/beat";
import { CatalogApiError, type CatalogBeatDto } from "./catalogApi";
import { BATCH_MAX, type CatalogBeatDetail, type CatalogBulkOperation, type CatalogCommandsApi, type CatalogMetadataPatch, type CatalogPurgeOperation, type CatalogVersionedItem } from "./catalogCommandsApi";
import { describePart, type CatalogTransfer, type CommitResult, type TransferIntent, type TransferOperationDto, type TransferPartSpec, type TransferRole, type UploadPartResult } from "./catalogTransfer";

export type MutationStage = "preparing" | "master" | "wav" | "artwork" | "project" | "library";
export interface MutationProgress { stage: MutationStage; uploadedBytes: number; totalBytes: number }
export interface TransferFiles { master?: File | null; wav?: File | null; artwork?: File | null; project?: File | null }
export interface PreparedTransferFiles { master?: File | null; wav?: File | null; artwork?: File | null; project?: File | null; projectFlags?: { openable: boolean; hasFlp: boolean; hasAls: boolean; hasSamples: boolean } | null }
export type PatchOutcome =
  | { status: "ok"; beat: CatalogBeatDto | null; revision: string; noop: boolean; operationId: string; replay: boolean }
  | { status: "conflict"; currentVersion: string | null; expectedVersion: string; error: CatalogApiError }
  | { status: "error"; error: CatalogApiError | Error };
export interface BatchReport {
  total: number;
  applied: Array<{ beatId: string; version: string }>;
  notExecuted: string[];
  conflict: { batchIndex: number; conflicts: unknown[]; error: CatalogApiError } | null;
  operationIds: string[];
  status: "COMPLETED" | "CONFLICT" | "PARTIAL" | "EMPTY";
}
export type TransferOutcome =
  | { status: "committed"; operationId: string; beatId: string; version: string; revision: string; operation: TransferOperationDto }
  | { status: "uncertain"; operationId: string; beatId: string; parts: string[]; operation: TransferOperationDto | null }
  | { status: "conflict" | "blocked" | "failed" | "canceled" | "timeout"; operationId: string; beatId: string; operation: TransferOperationDto | null; retained: boolean; error: CatalogApiError | null };
export interface OperationRef { operationId: string; kind: "IMPORT" | "REPLACE" | "BULK_TRASH" | "BULK_RESTORE" | "BULK_PATCH" | "TAG_RENAME" | "PURGE"; beatId: string | null; createdAt: number; label: string }
export interface OperationRefStore { load(accountId: string): OperationRef[]; save(accountId: string, refs: OperationRef[]): void }

export interface CatalogMutationsOptions {
  commands: CatalogCommandsApi;
  transfer: CatalogTransfer;
  accountId: () => string;
  refStore?: OperationRefStore;
  idempotencyKey?: () => string;
  now?: () => number;
  /** Preparación de archivos del cliente (strip ID3 del MASTER, ZIP del PROJECT); inyectable para pruebas. */
  prepareFiles?: (files: TransferFiles, beatName: string) => Promise<PreparedTransferFiles>;
  signal?: AbortSignal;
}

const REF_KEY = (accountId: string) => `beatgaler:catalog-ops:v1:${accountId}`;
export const MAX_OPERATION_REFS = 64;
export function createLocalOperationRefStore(storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): OperationRefStore {
  return {
    load(accountId) {
      try { const raw = storage?.getItem(REF_KEY(accountId)); const v = raw ? (JSON.parse(raw) as unknown) : []; return Array.isArray(v) ? (v as OperationRef[]).filter((r) => r && typeof r.operationId === "string" && !/token|secret/i.test(JSON.stringify(r))) : []; } catch { return []; }
    },
    save(accountId, refs) { try { storage?.setItem(REF_KEY(accountId), JSON.stringify(refs.slice(-MAX_OPERATION_REFS))); } catch { /* opcional */ } },
  };
}
const defaultKey = (): string => (globalThis.crypto && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Beat del modelo compartido a partir del detalle SQL (sin INDEX). Artwork/bytes se resuelven por referencias en T14. */
export function beatFromCatalogDetail(d: CatalogBeatDto & Partial<CatalogBeatDetail>, artworkDataUrl: string | null = null): Beat {
  const ref = (r: { fileId: string; revision: string } | null, filename: string | null = null): GalerCloudObjectRef | null => (r ? { object_id: `catalog:${r.fileId}`, revision: r.revision, filename } : null);
  const assets: BeatAssets = { master: ref(d.playback, null), wav: d.hasWav ? { object_id: `catalog:${d.id}:WAV`, revision: d.version } : null, artwork: ref(d.artwork), project: d.hasProject ? { object_id: `catalog:${d.id}:PROJECT`, revision: d.version } : null, samples: null, stems: d.hasStems ? { object_id: `catalog:${d.id}:STEMS`, revision: d.version } : null, loop: null };
  return {
    id: d.id, name: d.name, folder_path: "", mp3_path: "", wav_path: null, playback_path: "", bpm: d.bpm, key: d.key, needs_resolution: false, tags: [...d.tags], rating: d.rating,
    image_base64: artworkDataUrl, image_preview_base64: artworkDataUrl, image_crop: null, has_wav: d.hasWav, has_stems: d.hasStems, has_samples: false, samples_path: null, has_flp: d.hasProject, has_als: false,
    stems_path: null, flp_path: null, als_path: null, other_files: [], color: d.color ?? "#666666", color2: d.color2 ?? "#999999", has_loop: false, loop_path: null,
    cloud_status: "SYNCED", telegram_file_id: assets.master?.object_id ?? null, telegram_message_id: null, offline_available: false, assets,
  };
}

/** Diferencia metadata → patch mínimo (solo campos cambiados; los valores legacy no editados no viajan). */
export function metadataPatch(original: Pick<Beat, "name" | "bpm" | "key" | "tags" | "rating" | "color" | "color2">, updated: Pick<Beat, "name" | "bpm" | "key" | "tags" | "rating" | "color" | "color2">): CatalogMetadataPatch {
  const patch: CatalogMetadataPatch = {};
  if (updated.name.trim() !== original.name) patch.name = updated.name.trim();
  if (updated.bpm !== original.bpm) patch.bpm = updated.bpm;
  if (updated.key !== original.key) patch.key = updated.key;
  if (updated.rating !== original.rating) patch.rating = updated.rating;
  if (updated.color !== original.color) patch.color = updated.color;
  if (updated.color2 !== original.color2) patch.color2 = updated.color2;
  if (updated.tags.length !== original.tags.length || updated.tags.some((t, i) => t !== original.tags[i])) patch.tags = [...updated.tags];
  return patch;
}

const dataUrlToFile = (dataUrl: string, name: string): File | null => {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "image/png"; const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  try {
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return new File([bytes], `${name.replace(/[\\/:*?"<>|]+/g, "_") || "artwork"}.${ext}`, { type: mime });
  } catch { return null; }
};
const INFLIGHT = new Set(["PREPARED", "TRANSFERRING", "VERIFYING", "READY"]);

export function createCatalogMutations(options: CatalogMutationsOptions) {
  const { commands, transfer } = options;
  const refStore = options.refStore ?? createLocalOperationRefStore();
  const newKey = options.idempotencyKey ?? defaultKey;
  const now = options.now ?? (() => Date.now());
  const prepareFiles = options.prepareFiles ?? (async (files: TransferFiles) => ({ ...files, projectFlags: null }));

  // ---- referencias de operación por cuenta (reload / cambio de cuenta) ----
  function rememberOperation(ref: Omit<OperationRef, "createdAt">): OperationRef {
    const account = options.accountId();
    const full: OperationRef = { ...ref, createdAt: now() };
    refStore.save(account, [...refStore.load(account).filter((r) => r.operationId !== ref.operationId), full]);
    return full;
  }
  function forgetOperation(operationId: string): void { const account = options.accountId(); refStore.save(account, refStore.load(account).filter((r) => r.operationId !== operationId)); }
  function pendingOperations(): OperationRef[] { return refStore.load(options.accountId()); }
  async function resolvePendingTransfers(): Promise<Array<{ ref: OperationRef; operation: TransferOperationDto | null; terminal: boolean }>> {
    const out = [];
    for (const ref of pendingOperations().filter((r) => r.kind === "IMPORT" || r.kind === "REPLACE")) {
      try { const op = await transfer.getOperation(ref.operationId); const terminal = !INFLIGHT.has(op.status); if (terminal && op.status === "COMMITTED") forgetOperation(ref.operationId); out.push({ ref, operation: op, terminal }); } catch (error) {
        if (error instanceof CatalogApiError && error.status === 404) { forgetOperation(ref.operationId); continue; }
        out.push({ ref, operation: null, terminal: false });
      }
    }
    return out;
  }

  // ---- metadata-only → PATCH; 409 → conflicto tipado (sin PATCH automático) ----
  async function patchBeat({ beatId, expectedVersion, patch, idempotencyKey = newKey(), etag = null }: { beatId: string; expectedVersion: string; patch: CatalogMetadataPatch; idempotencyKey?: string; etag?: string | null }): Promise<PatchOutcome & { idempotencyKey: string }> {
    if (Object.keys(patch).length === 0) return { status: "ok", beat: null, revision: "", noop: true, operationId: "", replay: false, idempotencyKey };
    try {
      const r = await commands.patchBeat(beatId, { expectedVersion, patch, idempotencyKey, ifMatch: etag }, options.signal);
      return { status: "ok", beat: r.beat, revision: r.revision, noop: r.noop, operationId: r.operationId, replay: r.replay, idempotencyKey };
    } catch (error) {
      if (error instanceof CatalogApiError && error.code === "VERSION_CONFLICT") return { status: "conflict", currentVersion: typeof error.detail.current_version === "string" ? error.detail.current_version : null, expectedVersion, error, idempotencyKey };
      return { status: "error", error: error instanceof Error ? error : new Error(String(error)), idempotencyKey };
    }
  }

  // ---- trash/restore por lotes ≤50; un conflicto detiene lo siguiente; reporte veraz ----
  async function batched(mode: "trash" | "restore", items: CatalogVersionedItem[], { idempotencyKey = newKey() }: { idempotencyKey?: string } = {}): Promise<BatchReport> {
    const report: BatchReport = { total: items.length, applied: [], notExecuted: [], conflict: null, operationIds: [], status: "EMPTY" };
    if (items.length === 0) return report;
    for (let i = 0; i * BATCH_MAX < items.length; i++) {
      const batch = items.slice(i * BATCH_MAX, (i + 1) * BATCH_MAX);
      try {
        const r = mode === "trash" ? await commands.trashBeats(batch, `${idempotencyKey}:${i}`, options.signal) : await commands.restoreBeats(batch, `${idempotencyKey}:${i}`, options.signal);
        report.applied.push(...r.items); report.operationIds.push(r.operationId);
      } catch (error) {
        if (!(error instanceof CatalogApiError)) throw error;
        report.notExecuted.push(...items.slice(i * BATCH_MAX).map((x) => x.beatId));
        report.conflict = { batchIndex: i, conflicts: Array.isArray(error.detail.conflicts) ? (error.detail.conflicts as unknown[]) : [], error };
        report.status = "CONFLICT";
        return report;
      }
    }
    report.status = report.applied.length === items.length ? "COMPLETED" : "PARTIAL";
    return report;
  }
  const trashBeats = (items: CatalogVersionedItem[], o?: { idempotencyKey?: string }) => batched("trash", items, o);
  const restoreBeats = (items: CatalogVersionedItem[], o?: { idempotencyKey?: string }) => batched("restore", items, o);

  /** Toda la papelera / toda la selección: job server-side (BULK_TRASH o BULK_RESTORE), nunca descarga la lista al navegador. */
  async function bulkOverSelection({ kind, selectionId, selectionVersion, idempotencyKey = newKey() }: { kind: "BULK_TRASH" | "BULK_RESTORE"; selectionId: string; selectionVersion: string; idempotencyKey?: string }): Promise<CatalogBulkOperation> {
    const op = await commands.createBulkOperation({ kind, selectionId, selectionVersion, idempotencyKey }, options.signal);
    rememberOperation({ operationId: op.operationId, kind, beatId: null, label: kind === "BULK_TRASH" ? "Mover selección a la papelera" : "Restaurar selección" });
    return op;
  }
  /** Purge (T15, C9): intención durable en el servidor; la UI muestra «pendiente» hasta que el estado sea PURGED/PARTIAL/BLOCKED. Nunca éxito inmediato ni delete desde el cliente. */
  async function purgeTrash({ beatIds = null, idempotencyKey = newKey() }: { beatIds?: string[] | null; idempotencyKey?: string } = {}): Promise<{ status: "pending" | "purged" | "partial" | "blocked" | "cancelled"; operationId: string; durable: true; operation: CatalogPurgeOperation }> {
    const op = await commands.requestPurge({ beatIds, idempotencyKey }, options.signal);
    rememberOperation({ operationId: op.operationId, kind: "PURGE", beatId: null, label: beatIds ? `Eliminar definitivamente ${beatIds.length} beat(s)` : "Vaciar la papelera" });
    return { status: purgeStatus(op.status), operationId: op.operationId, durable: true, operation: op };
  }
  const purgeStatus = (s: CatalogPurgeOperation["status"]) => (s === "PURGED" ? "purged" : s === "PARTIAL" ? "partial" : s === "BLOCKED" ? "blocked" : s === "CANCELLED" ? "cancelled" : "pending") as "pending" | "purged" | "partial" | "blocked" | "cancelled";
  async function purgeState(operationId: string): Promise<{ status: "pending" | "purged" | "partial" | "blocked" | "cancelled"; operation: CatalogPurgeOperation }> {
    const op = await commands.getPurge(operationId, options.signal);
    const status = purgeStatus(op.status);
    if (status !== "pending") forgetOperation(operationId);
    return { status, operation: op };
  }

  // ---- import / reemplazo por operaciones C7 ----
  function partSpecs(prepared: PreparedTransferFiles): Array<{ spec: Promise<TransferPartSpec>; file: File; stage: MutationStage; role: TransferRole }> {
    const out: Array<{ spec: Promise<TransferPartSpec>; file: File; stage: MutationStage; role: TransferRole }> = [];
    if (prepared.master) out.push({ file: prepared.master, stage: "master", role: "MASTER", spec: describePart(prepared.master, { partKey: "MASTER:0", slotKey: "MASTER", role: "MASTER", filename: prepared.master.name, mime: prepared.master.type || "audio/mpeg" }) });
    if (prepared.wav) out.push({ file: prepared.wav, stage: "wav", role: "WAV", spec: describePart(prepared.wav, { partKey: "FILES:0:0", slotKey: "FILES:0", role: "WAV", filename: prepared.wav.name, mime: prepared.wav.type || "audio/wav" }) });
    if (prepared.artwork) out.push({ file: prepared.artwork, stage: "artwork", role: "ARTWORK", spec: describePart(prepared.artwork, { partKey: "ARTWORK:0", slotKey: "ARTWORK", role: "ARTWORK", filename: prepared.artwork.name, mime: prepared.artwork.type || "image/png" }) });
    if (prepared.project) out.push({ file: prepared.project, stage: "project", role: "PROJECT", spec: describePart(prepared.project, { partKey: "PROJECT:0", slotKey: "PROJECT", role: "PROJECT", filename: prepared.project.name, mime: prepared.project.type || "application/zip" }) });
    return out;
  }
  function outcomeOf(result: CommitResult, operationId: string, beatId: string): TransferOutcome {
    if (result.status === "COMMITTED") return { status: "committed", operationId, beatId, version: result.operation.result?.version ?? "", revision: result.operation.result?.revision ?? "", operation: result.operation };
    if (result.status === "TIMEOUT") return { status: "timeout", operationId, beatId, operation: result.operation, retained: true, error: null };
    const map = { CONFLICT: "conflict", BLOCKED: "blocked", FAILED: "failed", CANCELED: "canceled", RECONCILE: "blocked" } as const;
    return { status: map[result.status], operationId, beatId, operation: result.operation, retained: result.status !== "CANCELED", error: result.error };
  }
  async function runTransfer(intent: TransferIntent, prepared: PreparedTransferFiles, parts: Array<{ file: File; stage: MutationStage; role: TransferRole; spec: TransferPartSpec }>, { onProgress, kind, beatId: knownBeatId, label }: { onProgress?: (p: MutationProgress) => void; kind: "IMPORT" | "REPLACE"; beatId: string | null; label: string }): Promise<TransferOutcome> {
    const totalBytes = parts.reduce((n, p) => n + p.file.size, 0);
    onProgress?.({ stage: "preparing", uploadedBytes: 0, totalBytes });
    const op = await transfer.createOperation(intent, { idempotencyKey: newKey(), signal: options.signal });
    const beatId = knownBeatId ?? op.beatId;
    rememberOperation({ operationId: op.operationId, kind, beatId, label });
    let uploaded = 0; const uncertain: string[] = [];
    for (const p of parts) {
      onProgress?.({ stage: p.stage, uploadedBytes: uploaded, totalBytes });
      const r: UploadPartResult = p.role === "PROJECT"
        ? await transfer.uploadProject({ operationId: op.operationId, partKey: p.spec.partKey, blob: p.file, filename: p.file.name, signal: options.signal })
        : await transfer.uploadPart({ operationId: op.operationId, partKey: p.spec.partKey, blob: p.file, signal: options.signal });
      if (r.state === "UNCERTAIN") uncertain.push(p.spec.partKey);
      uploaded += p.file.size;
      onProgress?.({ stage: p.stage, uploadedBytes: uploaded, totalBytes });
    }
    onProgress?.({ stage: "library", uploadedBytes: totalBytes, totalBytes });
    if (uncertain.length) return { status: "uncertain", operationId: op.operationId, beatId, parts: uncertain, operation: await transfer.getOperation(op.operationId).catch(() => null) };
    const result = await transfer.commit(op.operationId, { signal: options.signal });
    const outcome = outcomeOf(result, op.operationId, beatId);
    if (outcome.status === "committed") forgetOperation(op.operationId);
    return outcome;
  }
  async function importBeat({ beat, files, onProgress }: { beat: Pick<Beat, "name" | "bpm" | "key" | "tags" | "rating" | "color" | "color2" | "image_base64">; files: TransferFiles; onProgress?: (p: MutationProgress) => void }): Promise<TransferOutcome> {
    if (!files.master) throw new CatalogApiError(400, "INPUT_INVALID", "Add a MASTER MP3 before saving this beat.", { reason: "IMPORT_REQUIRES_MASTER" });
    const prepared = await prepareFiles({ ...files, artwork: files.artwork ?? (beat.image_base64 ? dataUrlToFile(beat.image_base64, beat.name) : null) }, beat.name);
    const specs = partSpecs(prepared); const resolved = await Promise.all(specs.map(async (s) => ({ ...s, spec: await s.spec })));
    const metadata: Record<string, unknown> = { name: beat.name.trim(), bpm: beat.bpm, key: beat.key, tags: [...beat.tags], rating: beat.rating };
    if (beat.color) metadata.color = beat.color; if (beat.color2) metadata.color2 = beat.color2;
    return runTransfer({ kind: "IMPORT", parts: resolved.map((r) => r.spec), metadata }, prepared, resolved, { onProgress, kind: "IMPORT", beatId: null, label: `Importar «${beat.name}»` });
  }
  async function replaceBeat({ beatId, expectedVersion, original, updated, files, onProgress }: { beatId: string; expectedVersion: string; original: Pick<Beat, "name" | "bpm" | "key" | "tags" | "rating" | "color" | "color2">; updated: Pick<Beat, "name" | "bpm" | "key" | "tags" | "rating" | "color" | "color2">; files: TransferFiles; onProgress?: (p: MutationProgress) => void }): Promise<TransferOutcome | (PatchOutcome & { idempotencyKey: string })> {
    const patch = metadataPatch(original, updated);
    const prepared = await prepareFiles(files, updated.name || original.name);
    const specs = partSpecs(prepared);
    // Sin archivos nuevos → metadata-only → PATCH (nunca una operación de transferencia vacía).
    if (specs.length === 0) return patchBeat({ beatId, expectedVersion, patch });
    const resolved = await Promise.all(specs.map(async (s) => ({ ...s, spec: await s.spec })));
    return runTransfer({ kind: "REPLACE", beatId, expectedVersion, parts: resolved.map((r) => r.spec), metadata: Object.keys(patch).length ? patch : null }, prepared, resolved, { onProgress, kind: "REPLACE", beatId, label: `Reemplazar archivos de «${updated.name || original.name}»` });
  }

  return Object.freeze({ patchBeat, trashBeats, restoreBeats, bulkOverSelection, purgeTrash, purgeState, importBeat, replaceBeat, pendingOperations, resolvePendingTransfers, rememberOperation, forgetOperation, getBeat: (beatId: string) => commands.getBeat(beatId, options.signal) });
}
export type CatalogMutations = ReturnType<typeof createCatalogMutations>;
