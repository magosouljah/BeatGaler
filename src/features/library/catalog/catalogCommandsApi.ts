// T13 — Cliente tipado de los comandos /catalog/v1 (CONTRATO C5/C6; T07 `delivered`; r4 §4/§6; api-manifest v5).
// Solo metadata y estado por HTTP: PATCH, trash/restore por lote ≤50, conjuntos de consulta, selección server-side (token/count/
// flags, CAS por selectionVersion), operaciones bulk/rename (crear, consultar, cancelar, reanudar) y detalle SQL de un beat.
// Nunca carga INDEX ni toca Telegram; las credenciales son la sesión Cloud existente. Errores estables como CatalogApiError.
import { CatalogApiError, type CatalogBeatDto, type CatalogSort, type CatalogState } from "./catalogApi";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../../components/AccountGate";

export interface CatalogWriteHeaders { era: string; epoch: string }
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
export type CatalogMetadataPatch = Partial<{ name: string; bpm: string; key: string; tags: string[]; rating: number; color: string | null; color2: string | null; crop: { x: number; y: number; w: number; h: number; unit: "ratio" } | null }>;
/** Bulk add/remove de tags sobre BULK_PATCH (C12-V-INTERACTION, "bulk desde Drawer con reporte por lote"); nunca reemplaza el set. */
export type CatalogBulkTagsOp = { op: "add" | "remove"; tags: string[] };
export interface CatalogPatchResult { noop: boolean; beat: CatalogBeatDto | null; revision: string; eventSeq?: string; operationId: string; replay: boolean }
export interface CatalogVersionedItem { beatId: string; expectedVersion: string }
export interface CatalogBatchResult { items: Array<{ beatId: string; version: string }>; revision: string; operationId: string; replay: boolean }
export interface CatalogQuerySet { setId: string; status: "BUILDING" | "READY" | "STALE" | "FAILED" | "CANCELLED"; scope: string; baseRevision: string; memberCount: number; checkpointSeq: number; predicateHash: string; errorCode: string | null; created?: boolean }
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
export interface CatalogPurgeOperation { operationId: string; purgeId: string; kind: "PURGE"; status: CatalogPurgeStatus; scope: "ALL_TRASH" | "ITEMS"; baseRevision: string; progress: { total: number; purged: number; blocked: number; pending: number; objects: Record<string, number> }; items: CatalogPurgeItem[]; lastError: string | null; durable: true; created?: boolean; replay?: boolean }

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
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const baseUrl = options.baseUrl ?? (() => getResolvedCloudApiBase());
  const token = options.token ?? (() => getBeatGalerAuthToken());
  const csrf = options.csrf ?? (() => { try { return sessionStorage.getItem("beatgaler:web-csrf:v1"); } catch { return null; } });
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, { body, signal, idempotencyKey, ifMatch }: { body?: unknown; signal?: AbortSignal; idempotencyKey?: string; ifMatch?: string | null } = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const bearer = token();
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (method !== "GET") {
      const c = csrf();
      if (c) headers["X-BeatGaler-CSRF"] = c;
      const h = options.headers();
      headers["X-Catalog-Era"] = h.era; headers["X-Catalog-Epoch"] = h.epoch;
      headers["Content-Type"] = "application/json";
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (ifMatch) headers["If-Match"] = ifMatch;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl()}${path}`, { method, headers, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw Object.assign(new Error("Could not reach BeatGaler Cloud."), { name: "CatalogNetworkError", cause: error });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof payload.code === "string" ? payload.code : response.status === 401 ? "UNAUTHENTICATED" : `HTTP_${response.status}`;
      throw new CatalogApiError(response.status, code, typeof payload.error === "string" ? payload.error : `Galer Cloud HTTP ${response.status}`, (payload.detail as Record<string, unknown>) ?? {});
    }
    return { status: response.status, body: payload as T };
  }
  const enc = encodeURIComponent;

  return Object.freeze({
    getBeat: async (beatId: string, signal?: AbortSignal) => (await request<CatalogBeatDetail>("GET", `/catalog/v1/beats/${enc(beatId)}`, { signal })).body,
    patchBeat: async (beatId: string, { expectedVersion, patch, idempotencyKey, ifMatch = null }: { expectedVersion: string; patch: CatalogMetadataPatch; idempotencyKey: string; ifMatch?: string | null }, signal?: AbortSignal) =>
      (await request<CatalogPatchResult>("PATCH", `/catalog/v1/beats/${enc(beatId)}`, { body: { expectedVersion, patch }, idempotencyKey, ifMatch, signal })).body,
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
    cancelQuerySet: async (setId: string, signal?: AbortSignal) => (await request<CatalogQuerySet>("POST", `/catalog/v1/query-sets/${enc(setId)}/cancel`, { body: {}, signal })).body,
    releaseQuerySet: async (setId: string, signal?: AbortSignal) => (await request<CatalogQuerySet>("POST", `/catalog/v1/query-sets/${enc(setId)}/release`, { body: {}, signal })).body,
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
    createBulkOperation: async ({ kind, selectionId, selectionVersion, patch, tagsOp, idempotencyKey }: { kind: Exclude<CatalogBulkKind, "TAG_RENAME">; selectionId: string; selectionVersion: string; patch?: CatalogMetadataPatch; tagsOp?: CatalogBulkTagsOp; idempotencyKey: string }, signal?: AbortSignal) =>
      (await request<CatalogBulkOperation>("POST", "/catalog/v1/operations", { body: { kind, selectionId, selectionVersion, patch, tagsOp }, idempotencyKey, signal })).body,
    getOperation: async (operationId: string, detailsAfter: string | null = null, signal?: AbortSignal) =>
      (await request<CatalogBulkOperation>("GET", `/catalog/v1/operations/${enc(operationId)}${detailsAfter ? `?detailsAfter=${enc(detailsAfter)}` : ""}`, { signal })).body,
    cancelOperation: async (operationId: string, signal?: AbortSignal) => (await request<CatalogBulkOperation>("POST", `/catalog/v1/operations/${enc(operationId)}/cancel`, { body: {}, signal })).body,
    resumeOperation: async (operationId: string, revision: string, signal?: AbortSignal) => (await request<CatalogBulkOperation>("POST", `/catalog/v1/operations/${enc(operationId)}/resume`, { body: { revision }, signal })).body,
    /** T15: purge durable (C9). 202 = intención aceptada; el estado se observa en GET /operations/:id; nunca es un éxito inmediato. */
    requestPurge: async ({ beatIds = null, idempotencyKey }: { beatIds?: string[] | null; idempotencyKey: string }, signal?: AbortSignal) =>
      (await request<CatalogPurgeOperation>("POST", "/catalog/v1/operations", { body: beatIds ? { kind: "PURGE", beatIds } : { kind: "PURGE", scope: "ALL_TRASH" }, idempotencyKey, signal })).body,
    getPurge: async (operationId: string, signal?: AbortSignal) => (await request<CatalogPurgeOperation>("GET", `/catalog/v1/operations/${enc(operationId)}`, { signal })).body,
    renamePreview: async (from: string, to: string, signal?: AbortSignal) => (await request<CatalogRenamePreview>("POST", "/catalog/v1/tags/rename/preview", { body: { from, to }, signal })).body,
    renameTag: async (from: string, to: string, idempotencyKey: string, signal?: AbortSignal) => (await request<CatalogBulkOperation>("POST", "/catalog/v1/tags/rename", { body: { from, to }, idempotencyKey, signal })).body,
  });
}
export type CatalogCommandsApi = ReturnType<typeof createCatalogCommandsApi>;

/** Normalización visual de tags (trim+lower, versionada en Web; r4 §6). No cambia el filtro exacto de la Gallery. */
export const normalizeTagKey = (tag: string): string => tag.trim().toLowerCase();
