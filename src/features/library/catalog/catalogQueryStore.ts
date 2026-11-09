// T08 / V04 — Store acotado de bloques del catálogo (plan B §§3, 5, 7; r4 §3). Un store por Workspace/cuenta.
//  - Bloques contiguos de hasta 240 DTO; máximo 6 residentes (1.440 DTO) y ≤ 12 MiB serializados; evicción solo en extremos
//    fuera de la protección (viewport + overscan); evicción ≠ eliminación (no emite eventos de borrado).
//  - Máximo 2 peticiones en vuelo (una por dirección); una promesa por cursor; queryGeneration/requestGeneration descartan
//    respuestas tardías aunque abort no las impida.
//  - Antes de publicar append/prepend se validan tenant, era, época, generación, revisión, hash de filtros, perfil de orden,
//    startOrdinal y continuidad de ordinales; un ID distinto para el mismo ordinal/revisión es STOP-INTEGRITY.
//  - 409 CURSOR_STALE → una recuperación automática por generación (recarga del primer bloque conservando filtros).
//  - Snapshots inmutables estables para useSyncExternalStore. Nunca toda la biblioteca; nunca re-sort/filtro local.
import type { CatalogApi, CatalogBeatDto, CatalogContext, CatalogContextResolution, CatalogLegacyPage, CatalogPage, CatalogQueryFilters, CatalogSort } from "./catalogApi";
import { DEFAULT_FILTERS, filtersKey, isCatalogApiError } from "./catalogApi";

export const BLOCK_SIZE = 240;
export const MAX_BLOCKS = 6;
export const MAX_RESIDENT_ITEMS = MAX_BLOCKS * BLOCK_SIZE;
export const MAX_RESIDENT_BYTES = 12 * 1024 * 1024;
export const MAX_INFLIGHT = 2;
export const PREFETCH_VIEWPORTS_MIN = 1;
export const PREFETCH_VIEWPORTS_MAX = 3;
export const PREFETCH_VIEWPORTS_DEFAULT = 2;

export type CatalogStoreStatus =
  | "idle" | "resolving" | "loading" | "ready" | "empty" | "no-results"
  | "reset_required" | "quarantined" | "unavailable" | "unauthenticated" | "offline" | "error" | "integrity";

export interface CatalogBlock {
  startOrdinal: number;
  items: readonly CatalogBeatDto[];
  nextCursor: string | null;
  previousCursor: string | null;
  resumeCursor: string;
  bytes: number;
}
export interface CatalogEdgeError { code: string; status: number | null; message: string; direction: "forward" | "backward" | "first" }
export interface CatalogStoreMetrics {
  residentBlocks: number; residentItems: number; residentBytes: number;
  maxResidentBlocks: number; maxResidentItems: number; maxResidentBytes: number;
  inflight: number; maxInflight: number; requests: number; discardedLate: number; evictions: number; staleRecoveries: number; integrityStops: number;
}
export interface CatalogStoreSnapshot {
  status: CatalogStoreStatus;
  accountId: string | null;
  context: CatalogContext | null;
  filters: CatalogQueryFilters;
  sort: CatalogSort;
  queryKey: string;
  queryGeneration: number;
  revision: string | null;
  totalMatched: number | null;
  totalLibrary: number | null;
  blocks: readonly CatalogBlock[];
  firstOrdinal: number;            // primer ordinal residente (o 0)
  endOrdinal: number;              // último ordinal residente + 1
  hasBefore: boolean;
  hasAfter: boolean;
  loadingForward: boolean;
  loadingBackward: boolean;
  edgeError: CatalogEdgeError | null;
  staleReset: boolean;             // la última recarga fue por CURSOR_STALE (aviso UI)
  resumeCursor: string | null;     // cursor inclusivo del primer bloque residente (bgAnchor)
  legacy: { requestedOffset: number; resolution: "exact" | "last" | "empty"; resolvedOffset: number } | null;
  metrics: CatalogStoreMetrics;
}

export interface CatalogQueryStoreOptions {
  api: CatalogApi;
  accountId: string;
  initialFilters?: CatalogQueryFilters;
  initialSort?: CatalogSort;
  blockSize?: number;
  maxBlocks?: number;
  maxBytes?: number;
  onIntegrity?: (detail: Record<string, unknown>) => void;
}

const bytesOf = (items: readonly CatalogBeatDto[]): number => new TextEncoder().encode(JSON.stringify(items)).length;
const errorOf = (error: unknown, direction: CatalogEdgeError["direction"]): CatalogEdgeError =>
  isCatalogApiError(error) ? { code: error.code, status: error.status, message: error.message, direction }
    : { code: (error as { name?: string })?.name === "CatalogNetworkError" ? "OFFLINE" : "ERROR", status: null, message: error instanceof Error ? error.message : String(error), direction };

export function createCatalogQueryStore(options: CatalogQueryStoreOptions) {
  const { api, accountId } = options;
  const blockSize = options.blockSize ?? BLOCK_SIZE;
  const maxBlocks = options.maxBlocks ?? MAX_BLOCKS;
  const maxBytes = options.maxBytes ?? MAX_RESIDENT_BYTES;
  const listeners = new Set<() => void>();
  let generation = 0;
  let staleRecoveredInGeneration = false;
  let controller: AbortController | null = null;
  let inflight: { forward?: Promise<void>; backward?: Promise<void>; first?: Promise<void> } = {};
  let protectedRange: { start: number; end: number } = { start: 0, end: 0 }; // ordinales protegidos (viewport + overscan)
  let destroyed = false;
  const metrics: CatalogStoreMetrics = { residentBlocks: 0, residentItems: 0, residentBytes: 0, maxResidentBlocks: 0, maxResidentItems: 0, maxResidentBytes: 0, inflight: 0, maxInflight: 0, requests: 0, discardedLate: 0, evictions: 0, staleRecoveries: 0, integrityStops: 0 };

  const base = (filters: CatalogQueryFilters, sort: CatalogSort): CatalogStoreSnapshot => ({
    status: "idle", accountId, context: null, filters, sort, queryKey: filtersKey(filters, sort), queryGeneration: generation, revision: null, totalMatched: null, totalLibrary: null,
    blocks: [], firstOrdinal: 0, endOrdinal: 0, hasBefore: false, hasAfter: false, loadingForward: false, loadingBackward: false, edgeError: null, staleReset: false, resumeCursor: null, legacy: null,
    metrics: { ...metrics },
  });
  let snapshot: CatalogStoreSnapshot = base(options.initialFilters ?? DEFAULT_FILTERS, options.initialSort ?? "rating");

  function publish(patch: Partial<CatalogStoreSnapshot>): void {
    if (destroyed) return;
    const blocks = patch.blocks ?? snapshot.blocks;
    metrics.residentBlocks = blocks.length;
    metrics.residentItems = blocks.reduce((n, b) => n + b.items.length, 0);
    metrics.residentBytes = blocks.reduce((n, b) => n + b.bytes, 0);
    metrics.maxResidentBlocks = Math.max(metrics.maxResidentBlocks, metrics.residentBlocks);
    metrics.maxResidentItems = Math.max(metrics.maxResidentItems, metrics.residentItems);
    metrics.maxResidentBytes = Math.max(metrics.maxResidentBytes, metrics.residentBytes);
    metrics.inflight = Object.values(inflight).filter(Boolean).length;
    metrics.maxInflight = Math.max(metrics.maxInflight, metrics.inflight);
    const first = blocks[0]; const last = blocks[blocks.length - 1];
    snapshot = {
      ...snapshot, ...patch, blocks,
      firstOrdinal: first ? first.startOrdinal : 0,
      endOrdinal: last ? last.startOrdinal + last.items.length : 0,
      hasBefore: first ? first.previousCursor !== null : false,
      hasAfter: last ? last.nextCursor !== null : false,
      resumeCursor: first ? first.resumeCursor : null,
      loadingForward: Boolean(inflight.forward), loadingBackward: Boolean(inflight.backward),
      metrics: { ...metrics },
    };
    for (const l of listeners) l();
  }

  // Validación de una página contra el contexto vigente antes de publicarla (V04 §11).
  function validatePage(page: CatalogPage, expectStart: number | null, direction: "forward" | "backward" | "first"): CatalogEdgeError | null {
    const ctx = snapshot.context;
    if (ctx && (page.authorityEra !== ctx.authority_era || page.epoch !== ctx.authority_epoch || page.generationId !== ctx.generation_id)) return { code: "CONTEXT_MISMATCH", status: null, message: "page belongs to another era/epoch/generation", direction };
    if (snapshot.revision !== null && page.revision !== snapshot.revision && snapshot.blocks.length > 0) return { code: "CURSOR_STALE", status: 409, message: "revision changed between blocks", direction };
    if (expectStart !== null && page.startOrdinal !== expectStart) return { code: "ORDINAL_GAP", status: null, message: `expected ordinal ${expectStart}, got ${page.startOrdinal}`, direction };
    if (page.items.length > blockSize) return { code: "BLOCK_TOO_LARGE", status: null, message: "server returned more than a block", direction };
    const ids = new Set<string>();
    for (const it of page.items) { if (ids.has(it.id)) return { code: "DUPLICATE_ID", status: null, message: `duplicate id ${it.id} in block`, direction }; ids.add(it.id); }
    return null;
  }
  function integrityStop(detail: Record<string, unknown>): void {
    metrics.integrityStops++;
    options.onIntegrity?.(detail);
    publish({ status: "integrity", edgeError: { code: "STOP_INTEGRITY", status: null, message: String(detail.message ?? "integrity violation"), direction: "first" } });
  }
  // Un DTO ya residente para el mismo ordinal debe ser el mismo ID (misma revisión): si no, STOP-INTEGRITY.
  function checkOverlap(page: CatalogPage): boolean {
    for (let k = 0; k < page.items.length; k++) {
      const existing = itemAt(page.startOrdinal + k);
      if (existing && existing.id !== page.items[k].id) { integrityStop({ message: "different id for the same ordinal and revision", ordinal: page.startOrdinal + k, existing: existing.id, incoming: page.items[k].id }); return false; }
    }
    return true;
  }
  function toBlock(page: CatalogPage): CatalogBlock {
    return { startOrdinal: page.startOrdinal, items: Object.freeze(page.items.slice()), nextCursor: page.nextCursor, previousCursor: page.previousCursor, resumeCursor: page.resumeCursor, bytes: bytesOf(page.items) };
  }
  // Evicción solo en extremos, nunca dentro de la protección; libera referencias al confirmar (plan B §5).
  function evict(blocks: CatalogBlock[]): CatalogBlock[] {
    const out = blocks.slice();
    const over = () => out.length > maxBlocks || out.reduce((n, b) => n + b.bytes, 0) > maxBytes;
    while (out.length > 1 && over()) {
      const first = out[0]; const last = out[out.length - 1];
      const firstProtected = first.startOrdinal + first.items.length > protectedRange.start && first.startOrdinal < protectedRange.end;
      const lastProtected = last.startOrdinal + last.items.length > protectedRange.start && last.startOrdinal < protectedRange.end;
      if (firstProtected && lastProtected) break; // STOP-BUDGET: no se crece; el llamador decide
      // extremo más alejado de la protección
      const dFirst = protectedRange.start - (first.startOrdinal + first.items.length);
      const dLast = last.startOrdinal - protectedRange.end;
      if (!lastProtected && (firstProtected || dLast >= dFirst)) out.pop(); else out.shift();
      metrics.evictions++;
    }
    return out;
  }
  function itemAt(ordinal: number): CatalogBeatDto | null {
    for (const b of snapshot.blocks) if (ordinal >= b.startOrdinal && ordinal < b.startOrdinal + b.items.length) return b.items[ordinal - b.startOrdinal];
    return null;
  }

  async function run(direction: "forward" | "backward" | "first", gen: number, fn: (signal: AbortSignal) => Promise<CatalogPage>, apply: (page: CatalogPage) => void): Promise<void> {
    if (destroyed) return;
    if (inflight[direction]) return inflight[direction];
    if (Object.values(inflight).filter(Boolean).length >= MAX_INFLIGHT) return; // nunca una cola ilimitada
    const ctrl = controller ?? (controller = new AbortController());
    metrics.requests++;
    const p = (async () => {
      try {
        const page = await fn(ctrl.signal);
        if (destroyed || gen !== generation) { metrics.discardedLate++; return; } // respuesta tardía de otra generación: se descarta
        apply(page);
      } catch (error) {
        if (destroyed || gen !== generation || ctrl.signal.aborted) { metrics.discardedLate++; return; }
        if (isCatalogApiError(error) && error.code === "CURSOR_STALE") { await recoverFromStale(gen); return; }
        if (isCatalogApiError(error) && error.status === 401) { publish({ status: "unauthenticated", edgeError: errorOf(error, direction) }); return; }
        const e = errorOf(error, direction);
        publish({ status: snapshot.blocks.length ? snapshot.status : (e.code === "OFFLINE" ? "offline" : e.status === 503 ? "unavailable" : "error"), edgeError: e });
      } finally {
        delete inflight[direction];
        if (!destroyed && gen === generation) publish({});
      }
    })();
    inflight[direction] = p;
    publish({});
    return p;
  }
  // Una recuperación automática por generación; conserva filtros y vuelve al primer bloque con aviso (plan B §7).
  async function recoverFromStale(gen: number): Promise<void> {
    if (gen !== generation) return;
    if (staleRecoveredInGeneration) { publish({ status: "error", edgeError: { code: "CURSOR_STALE", status: 409, message: "revision changed again; reload required", direction: "first" } }); return; }
    staleRecoveredInGeneration = true;
    metrics.staleRecoveries++;
    controller?.abort(); controller = null; inflight = {};
    publish({ blocks: [], revision: null, totalMatched: null, staleReset: true, edgeError: null, status: "loading" });
    await loadFirst({ keepGeneration: true });
  }
  function applyFirst(page: CatalogPage, legacy: CatalogStoreSnapshot["legacy"] = null): void {
    const err = validatePage(page, null, "first");
    if (err) { if (err.code === "CURSOR_STALE") { void recoverFromStale(generation); return; } integrityStop({ message: err.message, code: err.code }); return; }
    const block = toBlock(page);
    const status: CatalogStoreStatus = page.items.length === 0 ? (page.totalLibrary === 0 ? "empty" : "no-results") : "ready";
    publish({ status, blocks: [block], revision: page.revision, totalMatched: page.totalMatched, totalLibrary: page.totalLibrary, edgeError: null, legacy });
  }
  function listRequest(extra: { cursor?: string | null; edge?: "last" | null; includeTotal?: boolean }) {
    return { ...snapshot.filters, sort: snapshot.sort, limit: blockSize, includeTotal: extra.includeTotal ?? true, cursor: extra.cursor ?? null, edge: extra.edge ?? null };
  }

  // ---------- API pública ----------
  async function resolve(): Promise<CatalogContextResolution> {
    publish({ status: "resolving" });
    const gen = generation;
    const r = await api.resolveContext();
    if (destroyed || gen !== generation) return r;
    if (r.status === "ready") publish({ context: r.context, status: "loading" });
    else publish({ status: r.status, edgeError: r.status === "offline" ? errorOf(r.error, "first") : errorOf(r.error, "first") });
    return r;
  }
  async function loadFirst(opts: { keepGeneration?: boolean } = {}): Promise<void> {
    if (!opts.keepGeneration) newGeneration();
    const gen = generation;
    publish({ status: snapshot.context ? "loading" : snapshot.status, blocks: [], revision: null, totalMatched: null, legacy: null });
    return run("first", gen, (signal) => api.listBeats(listRequest({}), signal), (page) => applyFirst(page));
  }
  async function loadLast(): Promise<void> {
    newGeneration();
    const gen = generation;
    publish({ status: "loading", blocks: [], revision: null, totalMatched: null, legacy: null });
    return run("first", gen, (signal) => api.listBeats(listRequest({ edge: "last" }), signal), (page) => applyFirst(page));
  }
  // Reapertura por resumeCursor (bgAnchor): misma ruta GET /beats; cursor ajeno/viejo → 400/409 manejados (stale → recuperación).
  async function loadResume(cursor: string): Promise<void> {
    newGeneration();
    const gen = generation;
    publish({ status: "loading", blocks: [], revision: null, totalMatched: null, legacy: null });
    return run("first", gen, (signal) => api.listBeats(listRequest({ cursor }), signal), (page) => applyFirst(page));
  }
  // bgPage legacy → resolver §5.2 → bloque + ancla (una sola resolución por llegada).
  async function loadLegacy(offset: number): Promise<void> {
    newGeneration();
    const gen = generation;
    publish({ status: "loading", blocks: [], revision: null, totalMatched: null, filters: DEFAULT_FILTERS, queryKey: filtersKey(DEFAULT_FILTERS, snapshot.sort) });
    return run("first", gen, (signal) => api.legacyNavigation(offset, snapshot.sort, signal), (page) => {
      const lp = page as CatalogLegacyPage;
      applyFirst(lp, { requestedOffset: lp.requestedOffset, resolution: lp.resolution, resolvedOffset: lp.resolvedOffset });
    });
  }
  async function loadNext(): Promise<void> {
    const last = snapshot.blocks[snapshot.blocks.length - 1];
    if (!last || !last.nextCursor) return;
    const gen = generation; const cursor = last.nextCursor; const expect = last.startOrdinal + last.items.length;
    return run("forward", gen, (signal) => api.listBeats(listRequest({ cursor, includeTotal: false }), signal), (page) => {
      const err = validatePage(page, expect, "forward");
      if (err) { if (err.code === "CURSOR_STALE") { void recoverFromStale(gen); return; } integrityStop({ message: err.message, code: err.code }); return; }
      if (!checkOverlap(page)) return;
      const blocks = evict([...snapshot.blocks, toBlock(page)]);
      publish({ blocks, totalMatched: page.totalMatched ?? snapshot.totalMatched, edgeError: null });
    });
  }
  async function loadPrevious(): Promise<void> {
    const first = snapshot.blocks[0];
    if (!first || !first.previousCursor) return;
    const gen = generation; const cursor = first.previousCursor;
    return run("backward", gen, (signal) => api.listBeats(listRequest({ cursor, includeTotal: false }), signal), (page) => {
      // "first" devuelve el bloque 0 completo (puede solapar): se deduplica por ordinal exacto.
      const overlapEnd = Math.min(page.startOrdinal + page.items.length, first.startOrdinal);
      const err = validatePage(page, null, "backward");
      if (err) { if (err.code === "CURSOR_STALE") { void recoverFromStale(gen); return; } integrityStop({ message: err.message, code: err.code }); return; }
      if (!checkOverlap(page)) return;
      if (page.startOrdinal + page.items.length < first.startOrdinal) { integrityStop({ message: "gap between previous block and resident range", code: "ORDINAL_GAP" }); return; }
      const trimmed: CatalogPage = { ...page, items: page.items.slice(0, Math.max(0, overlapEnd - page.startOrdinal)), nextCursor: null };
      if (trimmed.items.length === 0) { publish({ blocks: [{ ...first, previousCursor: page.previousCursor }, ...snapshot.blocks.slice(1)] }); return; }
      const blocks = evict([toBlock(trimmed), ...snapshot.blocks]);
      publish({ blocks, edgeError: null });
    });
  }
  function retry(): Promise<void> {
    const e = snapshot.edgeError;
    publish({ edgeError: null });
    if (!e || e.direction === "first" || snapshot.blocks.length === 0) return loadFirst({ keepGeneration: true });
    return e.direction === "forward" ? loadNext() : loadPrevious();
  }
  // Protección y prefetch: el grid informa el rango de ordinales visibles+overscan y cuántos ordinales por viewport.
  function observeViewport(input: { firstOrdinal: number; lastOrdinal: number; perViewport: number; prefetchViewports?: number }): void {
    const pv = Math.min(PREFETCH_VIEWPORTS_MAX, Math.max(PREFETCH_VIEWPORTS_MIN, input.prefetchViewports ?? PREFETCH_VIEWPORTS_DEFAULT));
    protectedRange = { start: input.firstOrdinal, end: input.lastOrdinal + 1 };
    if (snapshot.status !== "ready") return;
    const lead = pv * Math.max(1, input.perViewport);
    if (snapshot.hasAfter && input.lastOrdinal + lead >= snapshot.endOrdinal) void loadNext();
    if (snapshot.hasBefore && input.firstOrdinal - lead < snapshot.firstOrdinal) void loadPrevious();
  }
  function setQuery(filters: CatalogQueryFilters, sort: CatalogSort = snapshot.sort): Promise<void> {
    const key = filtersKey(filters, sort);
    if (key === snapshot.queryKey && snapshot.blocks.length) return Promise.resolve();
    publish({ filters, sort, queryKey: key });
    return loadFirst();
  }
  function setSort(sort: CatalogSort): Promise<void> { return setQuery(snapshot.filters, sort); }
  function newGeneration(): void {
    generation++;
    staleRecoveredInGeneration = false;
    controller?.abort(); controller = null; inflight = {};
    publish({ queryGeneration: generation, staleReset: false, edgeError: null });
  }
  // Aviso de cambio (SSE o feed): invalida de forma acotada → recarga del primer bloque de la query vigente, sin refetch total.
  function notifyLibraryChanged(): void {
    if (snapshot.status === "idle" || snapshot.status === "resolving") return;
    void loadFirst({ keepGeneration: true });
  }
  function teardown(): void {
    controller?.abort(); controller = null; inflight = {};
    snapshot = { ...base(snapshot.filters, snapshot.sort), status: "idle", metrics: { ...metrics } };
    for (const l of listeners) l(); // los consumidores ven el estado vacío antes de soltar las suscripciones
    destroyed = true;
    listeners.clear();
  }

  return Object.freeze({
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    itemAt,
    resolve, loadFirst, loadLast, loadResume, loadLegacy, loadNext, loadPrevious, retry, observeViewport, setQuery, setSort, notifyLibraryChanged, teardown,
    limits: Object.freeze({ blockSize, maxBlocks, maxBytes, maxInflight: MAX_INFLIGHT }),
  });
}
export type CatalogQueryStore = ReturnType<typeof createCatalogQueryStore>;
