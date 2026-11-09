// T08 — Doble del cliente /catalog/v1 para fixtures (V04/V05, C(T08)). Implementa la misma interfaz que createCatalogApi con un
// servidor SQL simulado en memoria: filtros globales (q search-js-v1, tags exactos ANY/ALL, exclusión), orden por tupla, keyset
// con cursores opacos, edge=last, resolver legacy §5.2, contexto/provisión, revisión y feed. Cuenta cada llamada y permite
// fallos programados (offline, 401, 503, stale), latencia controlada y bloqueos de respuesta para probar respuestas tardías.
import type { CatalogApi, CatalogBeatDto, CatalogContext, CatalogLegacyPage, CatalogListRequest, CatalogPage, CatalogSort } from "../../src/features/library/catalog/catalogApi";
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";

export interface FakeBeat { id: string; name: string; bpm: string; key: string; tags: string[]; rating: number; manualRank: number; state: "ACTIVE" | "TRASH" }
export interface FakeCatalogOptions {
  n?: number;
  seed?: number;
  tenant?: string;
  generate?: (i: number) => Partial<FakeBeat>;
  provisioned?: boolean;
  latencyMs?: number;
}
type Failure = { kind: "offline" } | { kind: "status"; status: number; code: string } | null;

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bpmClass = (bpm: string) => { const n = Number(bpm); return Number.isNaN(n) ? 3 : n === -Infinity ? 0 : n === Infinity ? 2 : 1; };
const bpmVal = (bpm: string) => (bpmClass(bpm) === 1 ? Number(bpm) : 0);

export function createCatalogFakeApi(options: FakeCatalogOptions = {}) {
  const n = options.n ?? 1000;
  const r = rng(options.seed ?? 777);
  const tenant = options.tenant ?? "fake-user";
  const beats: FakeBeat[] = Array.from({ length: n }, (_, i) => ({
    id: `g${i}`, name: `Beat ${Math.floor(r() * 1e6)}`, bpm: String(60 + Math.floor(r() * 200)), key: ["Cm", "F#m", "Ab", "D"][i % 4], tags: [i % 2 ? "odd" : "even", `t${i % 10}`],
    rating: Math.floor(r() * 6), manualRank: i * 1000, state: "ACTIVE", ...(options.generate ? options.generate(i) : {}),
  }));
  let revision = 1; let epoch = "1"; const era = "era-fake"; const generation = "native-fake";
  let provisioned = options.provisioned ?? true;
  const counters: Record<string, number> = {};
  const count = (k: string) => { counters[k] = (counters[k] || 0) + 1; };
  let failure: Failure = null;
  let latencyMs = options.latencyMs ?? 0;
  let gate: Promise<void> | null = null; let openGate: (() => void) | null = null;
  const events: Array<{ seq: string; revision: string; kind: string; beatId: string | null }> = [];

  const context = (): CatalogContext => ({ authority: "POSTGRES", user_id: tenant, vault_id: "v", chat_id: "-1", authority_era: era, authority_epoch: epoch, revision: String(revision), generation_id: generation, generation_origin: "NATIVE", migration_state: "IDLE",
    counts: { active: beats.filter((b) => b.state === "ACTIVE").length, trash: beats.filter((b) => b.state === "TRASH").length, purging: 0, pending: 0 }, restore_hold: true, cleanup_enabled: false });
  const dto = (b: FakeBeat): CatalogBeatDto => ({ id: b.id, version: "1", state: b.state, name: b.name, bpm: b.bpm, key: b.key, tags: b.tags.slice(), rating: b.rating, color: null, color2: null, artwork: null, playback: { fileId: `f-${b.id}`, revision: "1" }, hasArtwork: false, hasWav: false, hasStems: false, hasProject: false, fileCount: 1 });
  const comparator = (sort: CatalogSort) => (a: FakeBeat, b: FakeBeat) => {
    if (sort === "rating" && a.rating !== b.rating) return b.rating - a.rating;
    if (sort === "name" && a.name.toLowerCase() !== b.name.toLowerCase()) return cmpStr(a.name.toLowerCase(), b.name.toLowerCase());
    if (sort === "bpm") { const c = bpmClass(a.bpm) - bpmClass(b.bpm); if (c) return c; const v = bpmVal(a.bpm) - bpmVal(b.bpm); if (v) return v; }
    if (a.manualRank !== b.manualRank) return a.manualRank - b.manualRank;
    return cmpStr(a.id, b.id);
  };
  function matches(req: CatalogListRequest) {
    const q = (req.q ?? "").trim().toLowerCase();
    const inc = req.includeTags ?? []; const exc = req.excludeTags ?? []; const mode = req.includeMode ?? "any"; const state = req.state ?? "ACTIVE";
    return beats.filter((b) => b.state === state && (!q || b.name.toLowerCase().includes(q) || b.tags.some((t) => t.toLowerCase().includes(q)) || b.key.toLowerCase().includes(q) || String(b.bpm).includes(q))
      && (inc.length === 0 || (mode === "any" ? inc.some((t) => b.tags.includes(t)) : inc.every((t) => b.tags.includes(t)))) && !exc.some((t) => b.tags.includes(t))).sort(comparator(req.sort ?? "rating"));
  }
  const filterHash = (req: CatalogListRequest) => JSON.stringify({ s: req.state ?? "ACTIVE", q: (req.q ?? "").trim().toLowerCase(), m: req.includeMode ?? "any", i: [...(req.includeTags ?? [])].sort(), e: [...(req.excludeTags ?? [])].sort(), sort: req.sort ?? "rating", limit: req.limit ?? 100 });
  const sign = (payload: Record<string, unknown>) => `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fakesig`;
  const verify = (token: string, tenantId: string): Record<string, unknown> => {
    const [p, s] = token.split(".");
    if (s !== "fakesig" || !p) throw new CatalogApiError(400, "CURSOR_INVALID", "cursor is invalid", { reason: "SIGNATURE" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    if (payload.tenantId !== tenantId) throw new CatalogApiError(400, "CURSOR_INVALID", "cursor is invalid", { reason: "TENANT" });
    return payload;
  };
  async function guard(name: string): Promise<void> {
    count(name);
    if (gate) await gate;
    if (latencyMs) await new Promise((res) => setTimeout(res, latencyMs));
    if (failure?.kind === "offline") throw Object.assign(new Error("Could not reach BeatGaler Cloud."), { name: "CatalogNetworkError" });
    if (failure?.kind === "status") throw new CatalogApiError(failure.status, failure.code, `fake ${failure.code}`, {});
  }
  function page(rows: FakeBeat[], start: number, limit: number, req: CatalogListRequest, total: number | null, extra: Partial<CatalogLegacyPage> = {}): CatalogPage {
    const slice = rows.slice(start, start + limit);
    const base = { tenantId: tenant, revision: String(revision), fh: filterHash(req), limit, generation, epoch };
    const next = start + slice.length < rows.length ? sign({ ...base, direction: "forward", start: start + slice.length, total }) : null;
    const prev = start === 0 ? null : start < limit ? sign({ ...base, direction: "first", start: 0, total }) : sign({ ...base, direction: "backward", start: start - limit, total });
    return { items: slice.map(dto), authorityEra: era, epoch, revision: String(revision), generationId: generation, sortProfile: "catalog-order-v1", searchProfile: "search-js-v1",
      totalLibrary: beats.filter((b) => b.state === (req.state ?? "ACTIVE")).length, totalMatched: total, startOrdinal: start, nextCursor: next, previousCursor: prev, resumeCursor: sign({ ...base, direction: "resume", start, total }), ...extra };
  }

  const api: CatalogApi & { fake: FakeControls } = {
    async context(signal) { await guard("context"); if (signal?.aborted) throw new DOMException("aborted", "AbortError"); if (!provisioned) throw new CatalogApiError(404, "LIBRARY_NOT_PROVISIONED", "not provisioned", { provision: "POST /catalog/v1/library/provision" }); return context(); },
    async provision() { await guard("provision"); const created = !provisioned; provisioned = true; return { created, context: context() }; },
    async listBeats(req, signal) {
      await guard("listBeats");
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const limit = req.limit ?? 100;
      if (limit < 1 || limit > 240) throw new CatalogApiError(400, "INPUT_INVALID", "limit", { reason: "LIMIT" });
      if (req.cursor && req.edge) throw new CatalogApiError(400, "INPUT_INVALID", "cursor+edge", { reason: "CURSOR_AND_EDGE" });
      const rows = matches(req);
      if (req.cursor) {
        const c = verify(req.cursor, tenant);
        if (c.fh !== filterHash(req)) throw new CatalogApiError(400, "CURSOR_INVALID", "cursor is invalid", { reason: "REQUEST_MISMATCH" });
        if (c.revision !== String(revision) || c.epoch !== epoch || c.generation !== generation) throw new CatalogApiError(409, "CURSOR_STALE", "stale", { current_revision: String(revision) });
        const total = typeof c.total === "number" ? c.total : null;
        return page(rows, Number(c.start), limit, req, total);
      }
      if (req.edge === "last") { const start = Math.max(0, rows.length - limit); return page(rows, start, limit, req, rows.length); }
      return page(rows, 0, limit, req, req.includeTotal ? rows.length : (req.q || req.includeTags?.length || req.excludeTags?.length ? null : rows.length));
    },
    async legacyNavigation(offset, sort) {
      await guard("legacy");
      const req: CatalogListRequest = { state: "ACTIVE", sort, limit: 240 };
      const rows = matches(req); const N = rows.length;
      const extra = (resolution: "exact" | "last" | "empty", resolvedOffset: number): Partial<CatalogLegacyPage> => ({ resolution, resolvedOffset, requestedOffset: offset, anchorOrdinal: resolvedOffset });
      if (N === 0) return { ...page(rows, 0, 240, req, 0), ...extra("empty", 0) } as CatalogLegacyPage;
      if (offset >= N) { const lastStart = Math.floor((N - 1) / 240) * 240; return { ...page(rows, lastStart, 240, req, N), ...extra("last", lastStart) } as CatalogLegacyPage; }
      if (offset <= 10_000) return { ...page(rows, offset, 240, req, N), ...extra("exact", offset) } as CatalogLegacyPage;
      throw new CatalogApiError(409, "LEGACY_OFFSET_UNRESOLVABLE", "unresolvable", { max_offset: 10_000, total: N, action: "go-to-start" });
    },
    async facets(params = {}) { await guard("facets"); const scope = params.scope ?? "ACTIVE"; const m = new Map<string, number>(); for (const b of beats) if (b.state === scope) for (const t of new Set(b.tags.map((x) => x.trim().toLowerCase()))) m.set(t, (m.get(t) || 0) + 1); const items = [...m.entries()].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0])).map(([k, c]) => ({ key: k, label: k, count: c, representativeBeatId: "" })); return { items: items.slice(0, params.limit ?? 240), startOrdinal: 0, totalFacets: items.length, nextCursor: null, revision: String(revision) }; },
    async changes(after) { await guard("changes"); const a = Number(after); const ev = events.filter((e) => Number(e.seq) > a).slice(0, 240); return { events: ev.map((e) => ({ ...e, version: "2", operationId: null, payload: {}, at: new Date().toISOString() })), next: ev.length ? ev[ev.length - 1].seq : after, hasMore: false, latest: events.length ? events[events.length - 1].seq : "0", revision: String(revision), epoch, authorityEra: era, generationId: generation }; },
    async resolveContext(signal) {
      try { return { status: "ready", context: await api.context(signal), provisioned: false }; } catch (error) {
        if (error instanceof CatalogApiError && error.code === "LIBRARY_NOT_PROVISIONED") { try { const r = await api.provision(); return { status: "ready", context: r.context, provisioned: r.created }; } catch (inner) { return classify(inner); } }
        return classify(error);
      }
    },
    fake: {
      counters, beats,
      setFailure(f: Failure) { failure = f; },
      setLatency(ms: number) { latencyMs = ms; },
      hold() { gate = new Promise((res) => { openGate = res; }); },
      release() { openGate?.(); gate = null; openGate = null; },
      bumpRevision(kind = "BEAT_PATCHED", beatId: string | null = null) { revision++; events.push({ seq: String(events.length + 1), revision: String(revision), kind, beatId }); },
      bumpEpoch() { epoch = String(Number(epoch) + 1); revision++; },
      setProvisioned(v: boolean) { provisioned = v; },
      sorted(sort: CatalogSort, req: CatalogListRequest = {}) { return matches({ ...req, sort }).map((b) => b.id); },
    },
  };
  function classify(error: unknown) {
    if (error instanceof CatalogApiError) {
      if (error.status === 401) return { status: "unauthenticated" as const, error };
      if (error.code === "LIBRARY_RESET_REQUIRED") return { status: "reset_required" as const, error };
      if (error.code === "VAULT_QUARANTINED") return { status: "quarantined" as const, error };
      return { status: "unavailable" as const, error };
    }
    return { status: "offline" as const, error: error instanceof Error ? error : new Error(String(error)) };
  }
  return api;
}
export interface FakeControls {
  counters: Record<string, number>; beats: FakeBeat[];
  setFailure(f: Failure): void; setLatency(ms: number): void; hold(): void; release(): void;
  bumpRevision(kind?: string, beatId?: string | null): void; bumpEpoch(): void; setProvisioned(v: boolean): void;
  sorted(sort: CatalogSort, req?: CatalogListRequest): string[];
}
