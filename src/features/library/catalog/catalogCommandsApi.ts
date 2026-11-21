// T13 — Cliente tipado de los comandos /catalog/v1 (CONTRATO C5/C6; T07 `delivered`; r4 §4/§6; api-manifest v5).
// Solo metadata y estado por HTTP: PATCH, trash/restore por lote ≤50, conjuntos de consulta, selección server-side (token/count/
// flags, CAS por selectionVersion), operaciones bulk/rename (crear, consultar) y detalle SQL de un beat.
// Nunca carga INDEX ni toca Telegram; las credenciales son la sesión Cloud existente. Errores estables como CatalogApiError.
import { CatalogApiError, type CatalogBeatDto, type CatalogSort, type CatalogState } from "./catalogApi";
import { validateBeatName } from "../../../lib/metadataValidation";

/** Valida el nombre ANTES de cualquier petición: se rechaza con un mensaje claro, nunca se recorta. El servidor repite la regla. */
export function assertBeatNameWithinLimit(name: unknown): void {
  if (typeof name !== "string") return;
  const r = validateBeatName(name);
  if (!r.valid) throw new CatalogApiError(400, "INPUT_INVALID", r.reason, { reason: "NAME_TOO_LONG", field: "name" });
}
import { catalogHttpError, createCatalogHttp, readCatalogJson } from "./catalogHttp";
import type { PlaybackApi } from "./catalogPlaybackSession";

export interface CatalogWriteHeaders { era: string; epoch: string }
export interface CatalogBeatFile { fileId: string; role: string; revision: string; filename: string | null; mime: string | null; sizeBytes: string; status: string; verified: boolean; slot: string | null; partCount: number; current: boolean }
export interface CatalogBeatDetail extends CatalogBeatDto {
  manualRank: string | null;
  trash: { trashId: string; trashedAt: string; purgeAfter: string } | null;
  updatedAt: string;
  etag: string;
  authorityEra: string;
  epoch: string;
  revision: string;
  generationId: string;
}
export type CatalogMetadataPatch = Partial<{ name: string; bpm: string; key: string; tags: string[]; rating: number; color: string | null; color2: string | null; crop: { x: number; y: number; w: number; h: number; unit: "ratio" } | null; /** Solo PATCH individual: `null` desvincula la portada (el archivo de Telegram no se toca). */ artwork: null }>;
/** Bulk add/remove de tags sobre BULK_PATCH (C12-V-INTERACTION, "bulk desde Drawer con reporte por lote"); nunca reemplaza el set. */
export type CatalogBulkTagsOp = { op: "add" | "remove"; tags: string[] };
export interface CatalogPatchResult { noop: boolean; beat: CatalogBeatDto | null; revision: string; eventSeq?: string; operationId: string; replay: boolean }
export interface CatalogVersionedItem { beatId: string; expectedVersion: string }
export interface CatalogBatchResult { items: Array<{ beatId: string; version: string }>; revision: string; operationId: string; replay: boolean }
export interface CatalogQuerySet { setId: string; status: "BUILDING" | "READY" | "STALE" | "FAILED" | "CANCELLED" | "RELEASED"; scope: string; baseRevision: string; memberCount: number; checkpointSeq: number; predicateHash: string; errorCode: string | null; created?: boolean }
export interface CatalogQuerySetQuery { state?: CatalogState; q?: string; includeTags?: string[]; excludeTags?: string[]; includeMode?: "any" | "all"; sort?: CatalogSort }
export type CatalogSelectionStatus = "ACTIVE" | "FROZEN" | "CONFLICT" | "RELEASED";
export interface CatalogSelection { selectionId: string; setId: string; sort: CatalogSort; defaultSelected: boolean; selectionVersion: string; status: CatalogSelectionStatus; count: number; baseRevision: string; currentRevision?: string; stale?: boolean; flags?: Record<string, boolean>; replay?: boolean; created?: boolean }
export type CatalogSelectionOp = { kind: "INCLUDE_IDS" | "EXCLUDE_IDS"; beatIds: string[] } | { kind: "INCLUDE_RANGE" | "EXCLUDE_RANGE"; fromBeatId: string; toBeatId: string } | { kind: "CLEAR" };
export type CatalogBulkKind = "BULK_PATCH" | "BULK_TRASH" | "BULK_RESTORE" | "TAG_RENAME";
export type CatalogBulkStatus = "QUEUED" | "RUNNING" | "CANCELLING" | "COMPLETED" | "PARTIAL" | "CONFLICT" | "CANCELLED" | "FAILED";
export interface CatalogBulkProgress { total: number; confirmed: number; notExecuted: number; cancelled: number; conflictBatchSeq: string | number | null }
export interface CatalogBulkOperation { operationId: string; kind: CatalogBulkKind; status: CatalogBulkStatus; setId: string | null; selectionId: string | null; selectionVersion: string | null; expectedRevision: string | null; committedRevision: string | null; progress: CatalogBulkProgress; createdAt: string; updatedAt: string; completedAt: string | null; created?: boolean; replay?: boolean; batches?: unknown[]; details?: unknown[] }
export interface CatalogRenamePreview { from: string; to: string; countActive: number; countTrash: number; mergesInto: boolean; revision: string; epoch: string; authorityEra: string }
export type CatalogPurgeStatus = "ENUMERATING" | "DELETING" | "PURGED" | "PARTIAL" | "BLOCKED" | "CANCELLED";
export interface CatalogPurgeItem { beatId: string; status: "PENDING" | "ENUMERATED" | "DELETING" | "PURGED" | "BLOCKED"; blockReason: string | null; objectsTotal: number; objectsDeleted: number }
export interface CatalogPurgeOperation { operationId: string; purgeId: string; kind: "PURGE"; status: CatalogPurgeStatus; scope: "ALL_TRASH" | "ITEMS"; baseRevision: string; progress: { total: number; purged: number; blocked: number; pending: number; objects: Record<string, number> }; /** E81: limpieza física en Telegram, en segundo plano (no afecta a la biblioteca). */ cleanup?: { deleted: number; kept: number; rejected: number; uncertain: number; pending: number }; items: CatalogPurgeItem[]; lastError: string | null; durable: true; created?: boolean; replay?: boolean }

export interface CatalogCommandsOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: () => string;
  token?: () => string | null;
  csrf?: () => string | null;
  headers: () => CatalogWriteHeaders;
  timeoutMs?: number;
}

export const BATCH_MAX = 50;

export function createCatalogCommandsApi(options: CatalogCommandsOptions) {
  const http = createCatalogHttp(options, 20_000);

  // Política: toda escritura lleva CSRF, era/época del contexto y Content-Type; idempotencia e If-Match cuando el comando los aporta.
  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, { body, signal, idempotencyKey, ifMatch }: { body?: unknown; signal?: AbortSignal; idempotencyKey?: string; ifMatch?: string | null } = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {};
    if (method !== "GET") {
      const c = http.csrf();
      if (c) headers["X-BeatGaler-CSRF"] = c;
      const h = options.headers();
      headers["X-Catalog-Era"] = h.era; headers["X-Catalog-Epoch"] = h.epoch;
      headers["Content-Type"] = "application/json";
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (ifMatch) headers["If-Match"] = ifMatch;
    const response = await http.send(method, path, { headers, body, signal });
    const payload = await readCatalogJson(response);
    if (!response.ok) throw catalogHttpError(response, payload);
    return { status: response.status, body: payload as T };
  }
  const enc = encodeURIComponent;

  return Object.freeze({
    /** Archivos visibles del beat (MASTER, WAV, PROJECT…): base de «Download». */
    listBeatFiles: async (beatId: string, signal?: AbortSignal) => (await request<{ items: CatalogBeatFile[] }>("GET", `/catalog/v1/beats/${enc(beatId)}/files`, { signal })).body.items,
    getBeat: async (beatId: string, signal?: AbortSignal) => (await request<CatalogBeatDetail>("GET", `/catalog/v1/beats/${enc(beatId)}`, { signal })).body,
    patchBeat: async (beatId: string, { expectedVersion, patch, idempotencyKey, ifMatch = null }: { expectedVersion: string; patch: CatalogMetadataPatch; idempotencyKey: string; ifMatch?: string | null }, signal?: AbortSignal) => {
      assertBeatNameWithinLimit(patch?.name);
      return (await request<CatalogPatchResult>("PATCH", `/catalog/v1/beats/${enc(beatId)}`, { body: { expectedVersion, patch }, idempotencyKey, ifMatch, signal })).body;
    },
    trashBeats: async (items: CatalogVersionedItem[], idempotencyKey: string, signal?: AbortSignal) => {
      if (items.length > BATCH_MAX) throw new CatalogApiError(413, "PAYLOAD_TOO_LARGE", `trash batch exceeds ${BATCH_MAX} items`, { max: BATCH_MAX });
      return (await request<CatalogBatchResult>("POST", "/catalog/v1/beats/trash", { body: { items }, idempotencyKey, signal })).body;
    },
    restoreBeats: async (items: CatalogVersionedItem[], idempotencyKey: string, signal?: AbortSignal) => {
      if (items.length > BATCH_MAX) throw new CatalogApiError(413, "PAYLOAD_TOO_LARGE", `restore batch exceeds ${BATCH_MAX} items`, { max: BATCH_MAX });
      return (await request<CatalogBatchResult>("POST", "/catalog/v1/beats/restore", { body: { items }, idempotencyKey, signal })).body;
    },
    createQuerySet: async (query: CatalogQuerySetQuery, consumer: Record<string, unknown> = {}, signal?: AbortSignal) => (await request<CatalogQuerySet>("POST", "/catalog/v1/query-sets", { body: { query, consumer }, signal })).body,
    getQuerySet: async (setId: string, signal?: AbortSignal) => (await request<CatalogQuerySet>("GET", `/catalog/v1/query-sets/${enc(setId)}`, { signal })).body,
    createSelection: async ({ setId, sort, defaultSelected, consumerId }: { setId: string; sort: CatalogSort; defaultSelected: boolean; consumerId: string }, signal?: AbortSignal) =>
      (await request<CatalogSelection>("POST", "/catalog/v1/selections", { body: { setId, sort, defaultSelected, consumerId }, signal })).body,
    getSelection: async (selectionId: string, beatIds: string[] = [], signal?: AbortSignal) => {
      const p = new URLSearchParams(); for (const id of beatIds) p.append("beatId", id);
      const s = p.toString();
      return (await request<CatalogSelection>("GET", `/catalog/v1/selections/${enc(selectionId)}${s ? `?${s}` : ""}`, { signal })).body;
    },
    applySelectionOp: async (selectionId: string, { selectionVersion, op, idempotencyKey }: { selectionVersion: string; op: CatalogSelectionOp; idempotencyKey: string }, signal?: AbortSignal) =>
      (await request<CatalogSelection>("POST", `/catalog/v1/selections/${enc(selectionId)}/ops`, { body: { selectionVersion, op }, idempotencyKey, signal })).body,
    releaseSelection: async (selectionId: string, signal?: AbortSignal) => (await request<CatalogSelection>("POST", `/catalog/v1/selections/${enc(selectionId)}/release`, { body: {}, signal })).body,
    createBulkOperation: async ({ kind, selectionId, selectionVersion, patch, tagsOp, idempotencyKey }: { kind: Exclude<CatalogBulkKind, "TAG_RENAME">; selectionId: string; selectionVersion: string; patch?: CatalogMetadataPatch; tagsOp?: CatalogBulkTagsOp; idempotencyKey: string }, signal?: AbortSignal) => {
      assertBeatNameWithinLimit(patch?.name);
      return (await request<CatalogBulkOperation>("POST", "/catalog/v1/operations", { body: { kind, selectionId, selectionVersion, patch, tagsOp }, idempotencyKey, signal })).body;
    },
    getOperation: async (operationId: string, detailsAfter: string | null = null, signal?: AbortSignal) =>
      (await request<CatalogBulkOperation>("GET", `/catalog/v1/operations/${enc(operationId)}${detailsAfter ? `?detailsAfter=${enc(detailsAfter)}` : ""}`, { signal })).body,
    /** T15: purge durable (C9). 202 = intención aceptada; el estado se observa en GET /operations/:id; nunca es un éxito inmediato. */
    requestPurge: async ({ beatIds = null, idempotencyKey }: { beatIds?: string[] | null; idempotencyKey: string }, signal?: AbortSignal) =>
      (await request<CatalogPurgeOperation>("POST", "/catalog/v1/operations", { body: beatIds ? { kind: "PURGE", beatIds } : { kind: "PURGE", scope: "ALL_TRASH" }, idempotencyKey, signal })).body,
    getPurge: async (operationId: string, signal?: AbortSignal) => (await request<CatalogPurgeOperation>("GET", `/catalog/v1/operations/${enc(operationId)}`, { signal })).body,
    renamePreview: async (from: string, to: string, signal?: AbortSignal) => (await request<CatalogRenamePreview>("POST", "/catalog/v1/tags/rename/preview", { body: { from, to }, signal })).body,
    renameTag: async (from: string, to: string, idempotencyKey: string, signal?: AbortSignal) => (await request<CatalogBulkOperation>("POST", "/catalog/v1/tags/rename", { body: { from, to }, idempotencyKey, signal })).body,
    // Comandos musicales del servidor (T14): rondas Shuffle y vecinos de orden, con el mismo transporte que el resto de comandos
    // (timeout, CatalogNetworkError, 401 → UNAUTHENTICATED). La idempotencia de next/consume viaja en el CUERPO (contrato de routes.js).
    startRound: async (input: Parameters<PlaybackApi["startRound"]>[0]) => (await request<Awaited<ReturnType<PlaybackApi["startRound"]>>>("POST", "/catalog/v1/playback/rounds", { body: input })).body,
    nextInRound: async (input: Parameters<PlaybackApi["nextInRound"]>[0]) => (await request<Awaited<ReturnType<PlaybackApi["nextInRound"]>>>("POST", `/catalog/v1/playback/rounds/${enc(input.roundId)}/next`, { body: input })).body,
    consumeInRound: async (input: Parameters<PlaybackApi["consumeInRound"]>[0]) => (await request<Awaited<ReturnType<PlaybackApi["consumeInRound"]>>>("POST", `/catalog/v1/playback/rounds/${enc(input.roundId)}/consume`, { body: input })).body,
    releaseRound: async (roundId: string) => (await request<unknown>("POST", `/catalog/v1/playback/rounds/${enc(roundId)}/release`, { body: {} })).body,
    neighbor: async (input: Parameters<PlaybackApi["neighbor"]>[0]) => {
      const p = new URLSearchParams({ direction: input.direction, sort: input.sort }); if (input.beatId) p.set("beatId", input.beatId);
      return (await request<Awaited<ReturnType<PlaybackApi["neighbor"]>>>("GET", `/catalog/v1/query-sets/${enc(input.setId)}/neighbor?${p}`)).body;
    },
  });
}
export type CatalogCommandsApi = ReturnType<typeof createCatalogCommandsApi>;

/** Normalización visual de tags (trim+lower, versionada en Web; r4 §6). No cambia el filtro exacto de la Gallery. */
export const normalizeTagKey = (tag: string): string => tag.trim().toLowerCase();
