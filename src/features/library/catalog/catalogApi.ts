// T08 — Cliente tipado de /catalog/v1 (CONTRATO C5, NATIVO r2.1 §3.3, api-manifest.json v2 `delivered`).
// Solo metadata por HTTP: nunca construye WebGalerCloudTransport ni toca Telegram/INDEX. Las credenciales son la sesión
// Cloud existente (bearer + cookie). Errores estables como CatalogApiError{status, code, detail}; nunca "lista vacía" ante error.
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../../components/AccountGate";

export type CatalogSort = "manual" | "rating" | "name" | "bpm";
export type CatalogState = "ACTIVE" | "TRASH";
export type CatalogIncludeMode = "any" | "all";

export interface CatalogContext {
  authority: "POSTGRES";
  user_id: string;
  vault_id: string;
  chat_id: string | null;
  authority_era: string;
  authority_epoch: string;
  revision: string;
  generation_id: string;
  generation_origin: string | null;
  migration_state: string;
  counts: { active: number; trash: number; purging: number; pending: number };
  restore_hold: boolean;
  cleanup_enabled: boolean;
  capabilities?: Record<string, boolean>;
  limits?: Record<string, number>;
}

export interface CatalogFileRef { fileId: string; revision: string }
export interface CatalogBeatDto {
  id: string;
  version: string;
  state: CatalogState | "PURGING";
  name: string;
  bpm: string;
  key: string;
  tags: string[];
  rating: number;
  color: string | null;
  color2: string | null;
  artwork: CatalogFileRef | null;
  playback: CatalogFileRef | null;
  hasArtwork: boolean;
  hasWav: boolean;
  hasStems: boolean;
  hasProject: boolean;
  fileCount: number;
}

export interface CatalogPage {
  items: CatalogBeatDto[];
  authorityEra: string;
  epoch: string;
  revision: string;
  generationId: string;
  sortProfile: string;
  searchProfile: string;
  totalLibrary: number;
  totalMatched: number | null;
  startOrdinal: number;
  nextCursor: string | null;
  previousCursor: string | null;
  resumeCursor: string;
}
export interface CatalogLegacyPage extends CatalogPage {
  resolution: "exact" | "last" | "empty";
  resolvedOffset: number;
  requestedOffset: number;
  anchorOrdinal: number;
}
export interface CatalogFacet { key: string; label: string; count: number; representativeBeatId: string }
export interface CatalogFacetsPage { items: CatalogFacet[]; startOrdinal: number; totalFacets: number; nextCursor: string | null; revision: string }
export interface CatalogChangeEvent { seq: string; revision: string; kind: string; beatId: string | null; version: string | null; operationId: string | null; payload: Record<string, unknown>; at: string }
export interface CatalogChanges { events: CatalogChangeEvent[]; next: string; hasMore: boolean; latest: string; revision: string; epoch: string; authorityEra: string; generationId: string }

export interface CatalogQueryFilters {
  state: CatalogState;
  q: string;
  includeTags: readonly string[];
  excludeTags: readonly string[];
  includeMode: CatalogIncludeMode;
}
export interface CatalogListRequest extends Partial<CatalogQueryFilters> {
  sort?: CatalogSort;
  limit?: number;
  includeTotal?: boolean;
  cursor?: string | null;
  edge?: "last" | null;
}

export class CatalogApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "CatalogApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
export const isCatalogApiError = (error: unknown): error is CatalogApiError => error instanceof CatalogApiError;

export type CatalogContextResolution =
  | { status: "ready"; context: CatalogContext; provisioned: boolean }
  | { status: "reset_required"; error: CatalogApiError }
  | { status: "quarantined"; error: CatalogApiError }
  | { status: "unavailable"; error: CatalogApiError }
  | { status: "unauthenticated"; error: CatalogApiError }
  | { status: "offline"; error: Error };

export interface CatalogApiOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: () => string;
  token?: () => string | null;
  csrf?: () => string | null;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function buildQuery(req: CatalogListRequest): string {
  const p = new URLSearchParams();
  if (req.state) p.set("state", req.state);
  if (req.sort) p.set("sort", req.sort);
  if (req.q) p.set("q", req.q);
  for (const t of req.includeTags ?? []) p.append("includeTag", t);
  for (const t of req.excludeTags ?? []) p.append("excludeTag", t);
  if (req.includeMode) p.set("includeMode", req.includeMode);
  if (req.limit !== undefined) p.set("limit", String(req.limit));
  if (req.includeTotal) p.set("includeTotal", "true");
  if (req.cursor) p.set("cursor", req.cursor);
  if (req.edge) p.set("edge", req.edge);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function createCatalogApi(options: CatalogApiOptions = {}) {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const baseUrl = options.baseUrl ?? (() => getResolvedCloudApiBase());
  const token = options.token ?? (() => getBeatGalerAuthToken());
  const csrf = options.csrf ?? (() => { try { return sessionStorage.getItem("beatgaler:web-csrf:v1"); } catch { return null; } });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const bearer = token();
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      const c = csrf();
      if (c) headers["X-BeatGaler-CSRF"] = c;
    }
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
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof payload.code === "string" ? payload.code : response.status === 401 ? "UNAUTHENTICATED" : `HTTP_${response.status}`;
      throw new CatalogApiError(response.status, code, typeof payload.error === "string" ? payload.error : `Galer Cloud HTTP ${response.status}`, (payload.detail as Record<string, unknown>) ?? {});
    }
    return payload as T;
  }

  const api = {
    context: (signal?: AbortSignal) => request<CatalogContext>("GET", "/catalog/v1/context", undefined, signal),
    provision: (signal?: AbortSignal) => request<{ created: boolean; context: CatalogContext }>("POST", "/catalog/v1/library/provision", {}, signal),
    listBeats: (req: CatalogListRequest, signal?: AbortSignal) => request<CatalogPage>("GET", `/catalog/v1/beats${buildQuery(req)}`, undefined, signal),
    legacyNavigation: (offset: number, sort: CatalogSort, signal?: AbortSignal) => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new CatalogApiError(400, "LEGACY_OFFSET_INVALID", "legacy offset must be a safe non-negative integer", { action: "first-page" });
      return request<CatalogLegacyPage>("GET", `/catalog/v1/navigation/legacy?offset=${offset}&sort=${sort}&limit=240`, undefined, signal);
    },
    facets: (params: { scope?: CatalogState; q?: string; limit?: number; cursor?: string | null } = {}, signal?: AbortSignal) => {
      const p = new URLSearchParams();
      if (params.scope) p.set("scope", params.scope);
      if (params.q) p.set("q", params.q);
      if (params.limit !== undefined) p.set("limit", String(params.limit));
      if (params.cursor) p.set("cursor", params.cursor);
      const s = p.toString();
      return request<CatalogFacetsPage>("GET", `/catalog/v1/facets${s ? `?${s}` : ""}`, undefined, signal);
    },
    changes: (after: string, signal?: AbortSignal) => request<CatalogChanges>("GET", `/catalog/v1/changes?after=${encodeURIComponent(after)}`, undefined, signal),
    // NATIVO r2.1 §3.3: el cliente aprovisiona solo tras un 404, una vez. Ningún otro estado se aprovisiona ni cae a LEGACY.
    async resolveContext(signal?: AbortSignal): Promise<CatalogContextResolution> {
      const classify = (error: unknown): CatalogContextResolution => {
        if (isCatalogApiError(error)) {
          if (error.status === 401) return { status: "unauthenticated", error };
          if (error.code === "LIBRARY_RESET_REQUIRED") return { status: "reset_required", error };
          if (error.code === "VAULT_QUARANTINED") return { status: "quarantined", error };
          return { status: "unavailable", error };
        }
        return { status: "offline", error: error instanceof Error ? error : new Error(String(error)) };
      };
      try {
        return { status: "ready", context: await api.context(signal), provisioned: false };
      } catch (error) {
        if (isCatalogApiError(error) && error.code === "LIBRARY_NOT_PROVISIONED") {
          try {
            const r = await api.provision(signal);
            return { status: "ready", context: r.context, provisioned: r.created };
          } catch (inner) { return classify(inner); }
        }
        return classify(error);
      }
    },
  };
  return api;
}
export type CatalogApi = ReturnType<typeof createCatalogApi>;

// Hash de filtros equivalente al del servidor para claves de caché del cliente (no sustituye al firmado del cursor).
export function filtersKey(f: CatalogQueryFilters, sort: CatalogSort): string {
  const byBytes = (a: string, b: string) => (new TextEncoder().encode(a).join(",") < new TextEncoder().encode(b).join(",") ? -1 : 1);
  return JSON.stringify({ state: f.state, q: f.q.trim().toLowerCase(), includeMode: f.includeMode, include: [...new Set(f.includeTags)].sort(byBytes), exclude: [...new Set(f.excludeTags)].sort(byBytes), sort });
}
export const DEFAULT_FILTERS: CatalogQueryFilters = Object.freeze({ state: "ACTIVE", q: "", includeTags: [], excludeTags: [], includeMode: "any" });
