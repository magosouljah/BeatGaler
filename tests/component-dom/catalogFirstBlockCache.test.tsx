// @vitest-environment jsdom
// Arranque rápido (opción A, 2026-11-17): copia local del primer bloque. Casos: primera visita (sin copia → carga normal y se guarda),
// visita posterior (siembra provisional SIN esperar /beats, sin interacción, revalidación), cambio de cuenta, identidad insegura, datos
// obsoletos (revisión distinta → se sustituye sin STALE), cambio de época/generación/vault → invalidación, biblioteca bloqueada,
// errores de revalidación (offline/401) y almacenamiento lleno/corrupto/lento.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, filtersKey, type CatalogPage } from "../../src/features/library/catalog/catalogApi";
import {
  createFirstBlockCache, entryKey, identityOf, memoryFirstBlockBackend, FIRST_BLOCK_CACHE_MAX_ENTRIES_PER_ACCOUNT, type FirstBlockBackend, type FirstBlockIdentity,
} from "../../src/features/library/catalog/catalogFirstBlockCache";
import { createCatalogQueryStore } from "../../src/features/library/catalog/catalogQueryStore";
import { createCatalogServices, useLibraryComposition } from "../../src/features/library/catalog/catalogLibraryProvider";
import { CatalogGalleryWorkspace } from "../../src/features/library/catalog/CatalogGalleryWorkspace";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
afterEach(() => { for (const r of roots) act(() => r.unmount()); roots = []; document.body.innerHTML = ""; });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function mount(node: React.ReactNode) { const el = document.createElement("div"); document.body.appendChild(el); const root = createRoot(el); roots.push(root); act(() => root.render(node)); return { el, root }; }
const DEFAULT_KEY = filtersKey(DEFAULT_FILTERS, "rating");
const ID: FirstBlockIdentity = { accountId: "u1", vaultId: "v", era: "era-fake", epoch: "1", generationId: "native-fake" };
async function firstPage(api: ReturnType<typeof createCatalogFakeApi>): Promise<CatalogPage> { return api.listBeats({ ...DEFAULT_FILTERS, sort: "rating", limit: 240, includeTotal: true, cursor: null, edge: null }); }
const quota = () => Object.assign(new Error("full"), { name: "QuotaExceededError" });

describe("catalogFirstBlockCache", () => {
  it("guarda y lee solo con la identidad y la consulta EXACTAS (cuenta, vault, era, época, generación, filtros+orden)", async () => {
    const api = createCatalogFakeApi({ n: 300, tenant: "u1" }); const cache = createFirstBlockCache({ backend: memoryFirstBlockBackend() });
    const page = await firstPage(api);
    expect(await cache.write(ID, DEFAULT_KEY, page)).toEqual({ ok: true });
    const hit = await cache.read(ID, DEFAULT_KEY);
    expect(hit?.page.items.map((i) => i.id)).toEqual(page.items.map((i) => i.id)); expect(hit?.page.items.length).toBe(240); expect(hit?.revision).toBe(page.revision);
    for (const k of ["accountId", "vaultId", "era", "epoch", "generationId"] as const) expect(await cache.read({ ...ID, [k]: "otro" }, DEFAULT_KEY)).toBeNull();
    expect(await cache.read(ID, filtersKey(DEFAULT_FILTERS, "name"))).toBeNull();
    expect(await cache.read(ID, filtersKey({ ...DEFAULT_FILTERS, q: "x" }, "rating"))).toBeNull();
  });

  it("identityOf exige que la cuenta confirmada por el Cloud sea el user_id del contexto", () => {
    const ctx = { user_id: "u1", vault_id: "v", authority_era: "e", authority_epoch: "1", generation_id: "g" };
    expect(identityOf("u1", ctx)).toEqual({ accountId: "u1", vaultId: "v", era: "e", epoch: "1", generationId: "g" });
    expect(identityOf("u2", ctx)).toBeNull(); expect(identityOf("", ctx)).toBeNull();
  });

  it("registros corruptos, de otra versión o con IDs duplicados se descartan y se borran", async () => {
    const backend = memoryFirstBlockBackend(); const cache = createFirstBlockCache({ backend });
    const api = createCatalogFakeApi({ n: 10, tenant: "u1" }); await cache.write(ID, DEFAULT_KEY, await firstPage(api));
    const key = entryKey(ID, DEFAULT_KEY); const good = backend.map.get(key) as Record<string, unknown>;
    for (const bad of [{ ...good, v: 99 }, { ...good, page: { ...(good.page as object), items: [{ id: 1 }] } }, { ...good, page: { ...(good.page as object), startOrdinal: 5 } }, "basura",
      { ...good, page: { ...(good.page as { items: unknown[] }), items: [(good.page as { items: unknown[] }).items[0], (good.page as { items: unknown[] }).items[0]] } }]) {
      backend.map.set(key, bad);
      expect(await cache.read(ID, DEFAULT_KEY)).toBeNull(); expect(backend.map.has(key)).toBe(false);
    }
  });

  it("no guarda bloques vacíos, que no empiezan en 0 o que exceden el presupuesto de bytes", async () => {
    const api = createCatalogFakeApi({ n: 300, tenant: "u1" }); const page = await firstPage(api);
    const cache = createFirstBlockCache({ backend: memoryFirstBlockBackend(), maxBytes: 1000 });
    expect(await cache.write(ID, DEFAULT_KEY, page)).toEqual({ ok: false, reason: "too-large" });
    const ok = createFirstBlockCache({ backend: memoryFirstBlockBackend() });
    expect(await ok.write(ID, DEFAULT_KEY, { ...page, items: [] })).toMatchObject({ ok: false });
    expect(await ok.write(ID, DEFAULT_KEY, { ...page, startOrdinal: 240 })).toMatchObject({ ok: false });
  });

  it("almacenamiento lleno: libera las demás copias y reintenta una vez; si sigue lleno informa `quota` sin lanzar", async () => {
    const api = createCatalogFakeApi({ n: 20, tenant: "u1" }); const page = await firstPage(api);
    const mem = memoryFirstBlockBackend(); let fails = 1;
    const flaky: FirstBlockBackend = { ...mem, put: async (e) => { if (fails-- > 0) throw quota(); return mem.put(e); } };
    const cache = createFirstBlockCache({ backend: flaky });
    await createFirstBlockCache({ backend: mem }).write({ ...ID, accountId: "otra" }, DEFAULT_KEY, page);
    expect(mem.map.size).toBe(1);
    expect(await cache.write(ID, DEFAULT_KEY, page)).toEqual({ ok: true });
    expect([...mem.map.keys()]).toEqual([entryKey(ID, DEFAULT_KEY)]); // la copia ajena se liberó para hacer sitio
    const full = createFirstBlockCache({ backend: { ...mem, put: async () => { throw quota(); } } });
    expect(await full.write(ID, filtersKey(DEFAULT_FILTERS, "name"), page)).toEqual({ ok: false, reason: "quota" });
    const broken = createFirstBlockCache({ backend: { ...mem, put: async () => { throw new Error("disk"); } } });
    expect(await broken.write(ID, DEFAULT_KEY, page)).toEqual({ ok: false, reason: "error" });
  });

  it("lectura lenta o fallida → sin copia (nunca retrasa el arranque normal más del plazo)", async () => {
    const mem = memoryFirstBlockBackend();
    const slow = createFirstBlockCache({ backend: { ...mem, get: () => new Promise(() => {}) }, readTimeoutMs: 20 });
    expect(await slow.read(ID, DEFAULT_KEY)).toBeNull();
    const failing = createFirstBlockCache({ backend: { ...mem, get: async () => { throw new Error("io"); } } });
    expect(await failing.read(ID, DEFAULT_KEY)).toBeNull();
    expect(createFirstBlockCache({ backend: null }).available).toBe(false);
    expect(await createFirstBlockCache({ backend: null }).read(ID, DEFAULT_KEY)).toBeNull();
  });

  it("lectura anticipada (paralela a /context): candidates solo devuelve la cuenta pedida y pick exige identidad exacta; corrupto → se borra", async () => {
    const api = createCatalogFakeApi({ n: 10, tenant: "u1" }); const page = await firstPage(api); const mem = memoryFirstBlockBackend(); const cache = createFirstBlockCache({ backend: mem });
    await cache.write(ID, DEFAULT_KEY, page); await cache.write({ ...ID, accountId: "u2" }, DEFAULT_KEY, page);
    const list = cache.candidates("u1");
    expect((await list).every((e) => (e as FirstBlockIdentity).accountId === "u1")).toBe(true);
    expect((await cache.pick(list, ID, DEFAULT_KEY))?.page.items.length).toBe(page.items.length);
    expect(await cache.pick(list, { ...ID, epoch: "2" }, DEFAULT_KEY)).toBeNull();
    expect(await cache.pick(cache.candidates("u2"), ID, DEFAULT_KEY)).toBeNull();
    const key = entryKey(ID, DEFAULT_KEY); mem.map.set(key, { ...(mem.map.get(key) as object), v: 7 });
    expect(await cache.pick(cache.candidates("u1"), ID, DEFAULT_KEY)).toBeNull(); expect(mem.map.has(key)).toBe(false);
    const slow = createFirstBlockCache({ backend: { ...mem, all: () => new Promise(() => {}) }, readTimeoutMs: 20 });
    expect(await slow.candidates("u1")).toEqual([]);
  });

  it("dropBeat borra solo las copias de la cuenta que contienen el beat (portada quitada → no reaparece al volver)", async () => {
    const api = createCatalogFakeApi({ n: 10, tenant: "u1" }); const page = await firstPage(api); const mem = memoryFirstBlockBackend(); const cache = createFirstBlockCache({ backend: mem });
    await cache.write(ID, DEFAULT_KEY, page); await cache.write(ID, filtersKey({ ...DEFAULT_FILTERS, q: "zzz" }, "rating"), { ...page, items: page.items.filter((i) => i.id !== page.items[0].id) });
    await cache.write({ ...ID, accountId: "u2" }, DEFAULT_KEY, page);
    expect(await cache.dropBeat("u1", page.items[0].id)).toBe(1);
    expect(await cache.read(ID, DEFAULT_KEY)).toBeNull(); expect(await cache.read(ID, filtersKey({ ...DEFAULT_FILTERS, q: "zzz" }, "rating"))).not.toBeNull();
    expect(await cache.read({ ...ID, accountId: "u2" }, DEFAULT_KEY)).not.toBeNull();
  });

  it("acota copias por cuenta y la invalidación conserva solo la identidad vigente", async () => {
    const api = createCatalogFakeApi({ n: 5, tenant: "u1" }); const page = await firstPage(api); const mem = memoryFirstBlockBackend(); let t = 0;
    const cache = createFirstBlockCache({ backend: mem, now: () => ++t });
    for (let i = 0; i < FIRST_BLOCK_CACHE_MAX_ENTRIES_PER_ACCOUNT + 3; i++) await cache.write(ID, filtersKey({ ...DEFAULT_FILTERS, q: `q${i}` }, "rating"), page);
    expect(mem.map.size).toBe(FIRST_BLOCK_CACHE_MAX_ENTRIES_PER_ACCOUNT);
    await cache.write({ ...ID, epoch: "0" }, DEFAULT_KEY, page); await cache.write({ ...ID, accountId: "u2" }, DEFAULT_KEY, page);
    expect(await cache.invalidateAccount("u1", ID)).toBeGreaterThan(0);
    const left = [...mem.map.values()] as FirstBlockIdentity[];
    expect(left.every((e) => (e.accountId === "u1" ? e.epoch === "1" : e.accountId === "u2"))).toBe(true);
    await cache.invalidateAccount("u1"); expect(([...mem.map.values()] as FirstBlockIdentity[]).every((e) => e.accountId === "u2")).toBe(true);
  });
});

describe("store: siembra provisional y revalidación", () => {
  const seedOf = (page: CatalogPage) => ({ filters: DEFAULT_FILTERS, sort: "rating" as const, revision: page.revision, totalMatched: page.totalMatched, totalLibrary: page.totalLibrary, page });

  it("siembra → provisional `ready` sin red y sin prefetch; revalidación con la misma revisión → vigente, mismos IDs, copia renovada", async () => {
    const api = createCatalogFakeApi({ n: 300, tenant: "u1" }); const page = await firstPage(api); const before = api.fake.counters.listBeats;
    const seen: string[] = []; const store = createCatalogQueryStore({ api, accountId: "u1", onFirstPage: (p, q) => seen.push(`${q.queryKey === DEFAULT_KEY}:${p.items.length}`) });
    expect(store.seedFirst(seedOf(page))).toBe(true);
    const s = store.getSnapshot(); expect(s.provisional).toBe(true); expect(s.status).toBe("ready"); expect(s.blocks[0].items.length).toBe(240);
    store.observeViewport({ firstOrdinal: 200, lastOrdinal: 239, perViewport: 40 }); expect(api.fake.counters.listBeats).toBe(before); // nada de red con cursores de la copia
    expect(store.seedFirst(seedOf(page))).toBe(false); // solo una vez, con el store vacío
    await store.revalidate();
    const r = store.getSnapshot(); expect(r.provisional).toBe(false); expect(r.blocks[0].items.map((i) => i.id)).toEqual(page.items.map((i) => i.id));
    expect(r.metrics.staleRecoveries).toBe(0); expect(seen).toEqual(["true:240"]);
  });

  it("datos obsoletos: la revisión cambió → el bloque se sustituye por el de PostgreSQL sin aviso STALE ni bloque vacío intermedio", async () => {
    const api = createCatalogFakeApi({ n: 300, tenant: "u1" }); const page = await firstPage(api);
    api.fake.beats[0].name = "Renombrado"; api.fake.beats[0].rating = 99; api.fake.bumpRevision();
    const store = createCatalogQueryStore({ api, accountId: "u1" }); store.seedFirst(seedOf(page));
    const statuses: Array<[boolean, number]> = []; store.subscribe(() => { const x = store.getSnapshot(); statuses.push([x.provisional, x.blocks.length]); });
    await store.revalidate();
    const r = store.getSnapshot(); expect(r.provisional).toBe(false); expect(r.revision).not.toBe(page.revision); expect(r.staleReset).toBe(false); expect(r.metrics.staleRecoveries).toBe(0);
    expect(r.blocks[0].items[0]).toMatchObject({ id: "g0", name: "Renombrado" });
    expect(statuses.every(([, n]) => n > 0)).toBe(true); // nunca se vació la Gallery
  });

  it("revalidación fallida (offline / 401 / 503) → se retira la copia y queda el estado normal de error", async () => {
    for (const [failure, status] of [[{ kind: "offline" as const }, "offline"], [{ kind: "status" as const, status: 401, code: "UNAUTHENTICATED" }, "unauthenticated"], [{ kind: "status" as const, status: 503, code: "CATALOG_UNAVAILABLE" }, "unavailable"]] as const) {
      const api = createCatalogFakeApi({ n: 50, tenant: "u1" }); const page = await firstPage(api);
      const store = createCatalogQueryStore({ api, accountId: "u1" }); store.seedFirst(seedOf(page));
      api.fake.setFailure(failure); await store.revalidate();
      const r = store.getSnapshot(); expect(r.provisional).toBe(false); expect(r.blocks.length).toBe(0); expect(r.status).toBe(status);
    }
  });
});

function Probe({ accountId, api, cache, onState, search = "" }: { accountId: string | null; api: ReturnType<typeof createCatalogFakeApi>; cache: ReturnType<typeof createFirstBlockCache>; onState: (s: ReturnType<typeof useLibraryComposition>) => void; search?: string }) {
  const r = useLibraryComposition({ accountId, enabled: true, api: api as never, firstBlockCache: cache, initialSearch: () => search });
  onState(r);
  return null;
}

describe("useLibraryComposition + copia local", () => {
  it("primera visita: sin copia, carga normal y la guarda; visita posterior: siembra provisional ANTES de /beats; otra cuenta no la ve", async () => {
    const mem = memoryFirstBlockBackend(); const cache = createFirstBlockCache({ backend: mem });
    const api = createCatalogFakeApi({ n: 300, tenant: "u1" }); let last: ReturnType<typeof useLibraryComposition> | null = null;
    mount(<Probe accountId="u1" api={api} cache={cache} onState={(s) => { last = s; }} />); await flush();
    const s1 = last!.services!; expect(s1.store.getSnapshot().provisional).toBe(false); expect(s1.store.getSnapshot().blocks.length).toBe(0);
    await act(async () => { await s1.store.loadFirst(); }); await flush();
    expect(mem.map.size).toBe(1);
    for (const r of roots) act(() => r.unmount()); roots = [];
    // visita posterior: /beats retenido → tras /context la Gallery ya tiene la copia provisional y la revalidación ya está en vuelo
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const gated = { ...api, listBeats: (...a: Parameters<typeof api.listBeats>) => gate.then(() => api.listBeats(...a)) } as typeof api;
    const listBefore = api.fake.counters.listBeats;
    mount(<Probe accountId="u1" api={gated} cache={cache} onState={(s) => { last = s; }} />); await flush();
    const s2 = last!.services!; expect(s2.store.getSnapshot().provisional).toBe(true); expect(s2.store.getSnapshot().blocks[0].items.length).toBe(240);
    expect(s2.store.startedFromSeed()).toBe(true); expect(api.fake.counters.listBeats).toBe(listBefore);
    open(); await act(async () => { await s2.store.revalidate(); }); // misma promesa: no hay segunda carga
    expect(s2.store.getSnapshot().provisional).toBe(false); expect(api.fake.counters.listBeats).toBe(listBefore + 1);
    for (const r of roots) act(() => r.unmount()); roots = [];
    // cambio de cuenta (mismo navegador, misma caché): u2 nunca recibe la copia de u1
    const api2 = createCatalogFakeApi({ n: 300, tenant: "u2" });
    mount(<Probe accountId="u2" api={api2} cache={cache} onState={(s) => { last = s; }} />); await flush();
    expect(last!.services!.store.getSnapshot().blocks.length).toBe(0); expect(last!.services!.store.getSnapshot().provisional).toBe(false);
  });

  it("consulta de la URL distinta, bgAnchor o bgPage → no se siembra; identidad insegura (user_id ≠ cuenta) → no se siembra y se invalida", async () => {
    const mem = memoryFirstBlockBackend(); const cache = createFirstBlockCache({ backend: mem });
    const api = createCatalogFakeApi({ n: 300, tenant: "u1" }); await cache.write(ID, DEFAULT_KEY, await firstPage(api));
    let last: ReturnType<typeof useLibraryComposition> | null = null;
    for (const search of ["?bgSort=name", "?bgAnchor=abc", "?bgPage=2", "?bgQ=beat"]) {
      mount(<Probe accountId="u1" api={api} cache={cache} search={search} onState={(s) => { last = s; }} />); await flush();
      expect(last!.services!.store.getSnapshot().provisional).toBe(false);
      for (const r of roots) act(() => r.unmount()); roots = [];
    }
    const impostor = createCatalogFakeApi({ n: 3, tenant: "otra-cuenta" });
    mount(<Probe accountId="u1" api={impostor} cache={cache} onState={(s) => { last = s; }} />); await flush();
    expect(last!.services!.store.getSnapshot().blocks.length).toBe(0); expect(mem.map.size).toBe(0);
  });

  it("cambio de época (o era/generación/vault) → la copia anterior no se usa y se borra; biblioteca en reinicio/cuarentena → se borra", async () => {
    const mem = memoryFirstBlockBackend(); const cache = createFirstBlockCache({ backend: mem });
    const api = createCatalogFakeApi({ n: 300, tenant: "u1" }); await cache.write(ID, DEFAULT_KEY, await firstPage(api));
    api.fake.bumpEpoch(); let last: ReturnType<typeof useLibraryComposition> | null = null;
    mount(<Probe accountId="u1" api={api} cache={cache} onState={(s) => { last = s; }} />); await flush();
    expect(last!.services!.store.getSnapshot().provisional).toBe(false); expect(mem.map.size).toBe(0);
    for (const r of roots) act(() => r.unmount()); roots = [];
    for (const code of ["LIBRARY_RESET_REQUIRED", "VAULT_QUARANTINED"]) {
      const apiR = createCatalogFakeApi({ n: 10, tenant: "u1" }); await cache.write(ID, DEFAULT_KEY, await firstPage(apiR)); expect(mem.map.size).toBe(1);
      apiR.fake.setFailure({ kind: "status", status: 409, code });
      mount(<Probe accountId="u1" api={apiR} cache={cache} onState={(s) => { last = s; }} />); await flush();
      expect(last!.services).toBeNull(); expect(mem.map.size).toBe(0);
      for (const r of roots) act(() => r.unmount()); roots = [];
    }
  });
});

// Polyfills mínimos de jsdom para montar el shell aprobado (mismos que catalogLibraryComposition.test.tsx).
function installDomPolyfills() {
  if (typeof window.matchMedia !== "function") (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (typeof (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver === "undefined") (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class { constructor(private cb: (entries: unknown[]) => void) {} observe(el: Element) { this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }]); } unobserve() {} disconnect() {} takeRecords() { return []; } };
  const image = (w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4), width: w | 0, height: h | 0 });
  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => new Proxy({}, { get(_t, key) {
    if (key === "measureText") return () => ({ width: 0 });
    if (key === "createLinearGradient" || key === "createRadialGradient" || key === "createPattern") return () => ({ addColorStop() {} });
    if (key === "createImageData" || key === "getImageData") return (a: number | { width: number; height: number }, b?: number, c?: number, d?: number) => (typeof a === "object" ? image(a.width, a.height) : image(c ?? a, d ?? (b ?? 1)));
    if (key === "canvas") return document.createElement("canvas");
    if (typeof key === "string") return () => undefined;
    return undefined;
  }, set() { return true; } });
  (HTMLCanvasElement.prototype as unknown as { toDataURL: unknown }).toDataURL = () => "data:image/png;base64,";
  const media = HTMLMediaElement.prototype as unknown as { play: unknown; pause: unknown; load: unknown };
  media.play = () => Promise.resolve(); media.pause = () => {}; media.load = () => {};
  const url = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  if (!url.createObjectURL) { url.createObjectURL = () => `blob:fake/${Math.random().toString(36).slice(2)}`; url.revokeObjectURL = () => {}; }
}

describe("Shell con copia provisional", () => {
  it("pinta las tarjetas de la copia con el shell inerte (sin interacción ni facetas) y lo libera al revalidar con PostgreSQL", async () => {
    installDomPolyfills();
    const api = createCatalogFakeApi({ n: 30, tenant: "u1" }); const page = await firstPage(api);
    const server = createCatalogFakeCommands({ beats: fakeBeats(30) });
    const services = createCatalogServices({ api: api as never, accountId: "u1", context: { authority_era: "era-fake", authority_epoch: "1" }, fetchImpl: server.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c" });
    services.store.seedFirst({ filters: DEFAULT_FILTERS, sort: "rating", revision: page.revision, totalMatched: page.totalMatched, totalLibrary: page.totalLibrary, page });
    api.fake.hold(); const facetsBefore = api.fake.counters.facets ?? 0;
    const { el } = mount(<div style={{ height: 800 }}><CatalogGalleryWorkspace services={services} accountId="u1" context={{ authority_era: "era-fake", authority_epoch: "1", revision: page.revision }} viewportHeightFallback={800} /></div>);
    await flush(6);
    const root = el.querySelector("[data-catalog-mode='postgres'][data-account]")!;
    expect(root.getAttribute("data-catalog-provisional")).toBe("true"); expect(root.hasAttribute("inert")).toBe(true); expect(root.getAttribute("aria-busy")).toBe("true");
    expect(el.querySelectorAll("[data-card]").length).toBeGreaterThan(0); expect(api.fake.counters.facets ?? 0).toBe(facetsBefore);
    api.fake.release(); await flush(10);
    expect(root.hasAttribute("data-catalog-provisional")).toBe(false); expect(root.hasAttribute("inert")).toBe(false);
    expect(el.querySelectorAll("[data-card]").length).toBeGreaterThan(0); expect(services.store.getSnapshot().provisional).toBe(false);
    await services.teardown();
  });
});
