// T08 / V05 — Navegación URL del catálogo (plan B §5.3 y §7; C12 §5.2 B-legacy). Sin pager POSTGRES ni location.assign.
//  - Parámetros nuevos: bgAnchor (resumeCursor opaco), bgSort, bgQ, bgInclude/bgExclude (repetibles), bgMode, bgState.
//  - bgPage legacy: parser actual (Number del primer parámetro, entero >= 0); inválido/negativo/fracción → 0;
//    entero no seguro → LEGACY_OFFSET_INVALID con acción «primera página»; cursor + bgPage o bgPage + filtros → INPUT_INVALID.
//  - history.replaceState con debounce (300 ms) al estabilizar; pushState solo para cambios deliberados; historial acotado (16).
import type { CatalogIncludeMode, CatalogQueryFilters, CatalogSort, CatalogState } from "./catalogApi";
import { DEFAULT_FILTERS } from "./catalogApi";

export const BG_ANCHOR = "bgAnchor";
export const BG_SORT = "bgSort";
export const BG_Q = "bgQ";
export const BG_INCLUDE = "bgInclude";
export const BG_EXCLUDE = "bgExclude";
export const BG_MODE = "bgMode";
export const BG_STATE = "bgState";
export const BG_PAGE_LEGACY = "bgPage";
export const HISTORY_LIMIT = 16;
export const REPLACE_DEBOUNCE_MS = 300;
export const LEGACY_UNRESOLVABLE_COPY = "Este enlace antiguo no se puede abrir en esta posición.";
export const LEGACY_GO_TO_START_ACTION = "Ir al inicio";

const SORTS: readonly CatalogSort[] = ["manual", "rating", "name", "bpm"];
const STATES: readonly CatalogState[] = ["ACTIVE", "TRASH"];

export interface CatalogNavigationState {
  filters: CatalogQueryFilters;
  sort: CatalogSort;
  anchor: string | null;
}

export type LegacyPageRequest =
  | { kind: "none" }
  | { kind: "offset"; offset: number; canonical: string }
  | { kind: "invalid"; reason: "LEGACY_OFFSET_INVALID" | "INPUT_INVALID"; action: "first-page" };

// Parser legacy conservado (webLibraryNavigation.ts:16): Number(primer parámetro), entero >= 0, resto → 0; admite 0xF0 y 1e9.
export function parseLegacyBgPage(search: string): LegacyPageRequest {
  const params = new URLSearchParams(search);
  const raw = params.get(BG_PAGE_LEGACY);
  if (raw === null) return { kind: "none" };
  if (params.has(BG_ANCHOR) || params.has(BG_Q) || params.has(BG_INCLUDE) || params.has(BG_EXCLUDE)) return { kind: "invalid", reason: "INPUT_INVALID", action: "first-page" };
  const n = Number(raw || 0);
  if (!Number.isInteger(n) || n < 0) return { kind: "offset", offset: 0, canonical: "0" };
  if (!Number.isSafeInteger(n)) return { kind: "invalid", reason: "LEGACY_OFFSET_INVALID", action: "first-page" };
  return { kind: "offset", offset: n, canonical: String(n) };
}

export function readNavigationState(search: string): CatalogNavigationState {
  const p = new URLSearchParams(search);
  const sortRaw = p.get(BG_SORT);
  const stateRaw = p.get(BG_STATE);
  const modeRaw = p.get(BG_MODE);
  return {
    filters: {
      state: STATES.includes(stateRaw as CatalogState) ? (stateRaw as CatalogState) : DEFAULT_FILTERS.state,
      q: p.get(BG_Q) ?? "",
      includeTags: p.getAll(BG_INCLUDE),
      excludeTags: p.getAll(BG_EXCLUDE),
      includeMode: modeRaw === "all" ? "all" : ("any" as CatalogIncludeMode),
    },
    sort: SORTS.includes(sortRaw as CatalogSort) ? (sortRaw as CatalogSort) : "rating",
    anchor: p.get(BG_ANCHOR),
  };
}

export function buildGalleryUrl(href: string, state: CatalogNavigationState): string {
  const url = new URL(href);
  url.pathname = "/gallery";
  const keep = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (![BG_ANCHOR, BG_SORT, BG_Q, BG_INCLUDE, BG_EXCLUDE, BG_MODE, BG_STATE, BG_PAGE_LEGACY].includes(k)) keep.append(k, v);
  if (state.sort !== "rating") keep.set(BG_SORT, state.sort);
  if (state.filters.state !== "ACTIVE") keep.set(BG_STATE, state.filters.state);
  if (state.filters.q) keep.set(BG_Q, state.filters.q);
  for (const t of state.filters.includeTags) keep.append(BG_INCLUDE, t);
  for (const t of state.filters.excludeTags) keep.append(BG_EXCLUDE, t);
  if (state.filters.includeMode !== "any") keep.set(BG_MODE, state.filters.includeMode);
  if (state.anchor) keep.set(BG_ANCHOR, state.anchor);
  url.search = keep.toString() ? `?${keep.toString()}` : "";
  return url.toString();
}

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | null): void;
  pushState(data: unknown, unused: string, url?: string | null): void;
}
export interface HistoryWriterOptions {
  history?: HistoryLike;
  currentHref?: () => string;
  debounceMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => number;
  clearTimeoutImpl?: (id: number) => void;
}
// Escritor de historial acotado: replaceState con debounce para anclas que se estabilizan; pushState para cambios deliberados.
export function createHistoryWriter(options: HistoryWriterOptions = {}) {
  const history = options.history ?? (typeof window !== "undefined" ? window.history : null);
  const currentHref = options.currentHref ?? (() => (typeof window !== "undefined" ? window.location.href : "https://beatgaler.invalid/gallery"));
  const debounceMs = options.debounceMs ?? REPLACE_DEBOUNCE_MS;
  const setT = options.setTimeoutImpl ?? ((fn, ms) => (typeof window !== "undefined" ? window.setTimeout(fn, ms) : (setTimeout(fn, ms) as unknown as number)));
  const clearT = options.clearTimeoutImpl ?? ((id) => (typeof window !== "undefined" ? window.clearTimeout(id) : clearTimeout(id as unknown as NodeJS.Timeout)));
  const entries: string[] = [];
  let pending: number | null = null;
  let replaceCount = 0; let pushCount = 0;
  const remember = (url: string) => { entries.push(url); while (entries.length > HISTORY_LIMIT) entries.shift(); };
  return {
    // Ancla estabilizada: reemplaza la entrada actual, sin crear historial por cada bloque.
    replaceAnchor(state: CatalogNavigationState): void {
      if (pending !== null) clearT(pending);
      pending = setT(() => {
        pending = null;
        const url = buildGalleryUrl(currentHref(), state);
        if (url === currentHref()) return;
        history?.replaceState({ catalog: true }, "", url);
        replaceCount++;
      }, debounceMs);
    },
    // Cambio deliberado de query/detalle: una entrada nueva.
    pushQuery(state: CatalogNavigationState): void {
      if (pending !== null) { clearT(pending); pending = null; }
      const url = buildGalleryUrl(currentHref(), { ...state, anchor: null });
      history?.pushState({ catalog: true }, "", url);
      remember(url);
      pushCount++;
    },
    cancelPending(): void { if (pending !== null) { clearT(pending); pending = null; } },
    entries: () => entries.slice(),
    counters: () => ({ replaceCount, pushCount, pendingReplace: pending !== null }),
  };
}
