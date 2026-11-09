// T08 / V04 + C(T08) — Store acotado contra el doble de /catalog/v1: bloques contiguos, budgets, singleflight, generaciones,
// respuestas tardías, evicción en extremos, stale con una recuperación, errores offline/401/503/empty/no-results, A→B, integridad.
import { describe, expect, it } from "vitest";
import { createCatalogQueryStore, MAX_BLOCKS, MAX_INFLIGHT } from "../../src/features/library/catalog/catalogQueryStore";
import { DEFAULT_FILTERS } from "../../src/features/library/catalog/catalogApi";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const residentIds = (store: ReturnType<typeof createCatalogQueryStore>) => { const s = store.getSnapshot(); const out: string[] = []; for (let i = s.firstOrdinal; i < s.endOrdinal; i++) out.push(store.itemAt(i)!.id); return out; };

describe("catalogQueryStore", () => {
  it("resuelve contexto, carga el primer bloque de 240 con total exacto y publica snapshots inmutables estables", async () => {
    const api = createCatalogFakeApi({ n: 1000 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    let notified = 0; store.subscribe(() => { notified++; });
    const before = store.getSnapshot();
    expect(before.status).toBe("idle");
    const r = await store.resolve();
    expect(r.status).toBe("ready");
    await store.loadFirst();
    const s = store.getSnapshot();
    expect(s).not.toBe(before);
    expect(store.getSnapshot()).toBe(s); // identidad estable sin cambios
    expect([s.status, s.blocks.length, s.blocks[0].items.length, s.totalMatched, s.totalLibrary, s.firstOrdinal, s.endOrdinal, s.hasBefore, s.hasAfter]).toEqual(["ready", 1, 240, 1000, 1000, 0, 240, false, true]);
    expect(residentIds(store)).toEqual(api.fake.sorted("rating").slice(0, 240));
    expect(s.resumeCursor).toBeTruthy();
    expect(notified).toBeGreaterThan(2);
    expect(api.fake.counters).toEqual({ context: 1, listBeats: 1 });
  });

  it("scroll continuo en ambos sentidos: bloques contiguos sin huecos ni duplicados, máximo 6 residentes, evicción solo en el extremo lejano, vuelta atrás por cursor de frontera", async () => {
    const api = createCatalogFakeApi({ n: 3000 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    const expected = api.fake.sorted("rating");
    for (let k = 0; k < 8; k++) {
      store.observeViewport({ firstOrdinal: store.getSnapshot().endOrdinal - 50, lastOrdinal: store.getSnapshot().endOrdinal - 1, perViewport: 35 });
      await settle();
    }
    let s = store.getSnapshot();
    expect(s.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(s.metrics.maxResidentBlocks).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(s.metrics.maxResidentItems).toBeLessThanOrEqual(MAX_BLOCKS * 240);
    expect(s.metrics.evictions).toBeGreaterThan(0);
    expect(s.firstOrdinal).toBeGreaterThan(0);
    expect(residentIds(store)).toEqual(expected.slice(s.firstOrdinal, s.endOrdinal));
    // continuidad de bloques
    for (let i = 1; i < s.blocks.length; i++) expect(s.blocks[i].startOrdinal).toBe(s.blocks[i - 1].startOrdinal + s.blocks[i - 1].items.length);
    // vuelta atrás: el bloque anterior llega por el cursor de frontera y se evicta el extremo final
    const firstBefore = s.firstOrdinal;
    store.observeViewport({ firstOrdinal: firstBefore, lastOrdinal: firstBefore + 20, perViewport: 35 });
    await settle();
    s = store.getSnapshot();
    expect(s.firstOrdinal).toBe(firstBefore - 240);
    expect(residentIds(store)).toEqual(expected.slice(s.firstOrdinal, s.endOrdinal));
    expect(s.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    // hasta el inicio: previousCursor null → hasBefore false; token "first" solapado se deduplica por ordinal
    for (let k = 0; k < 12 && store.getSnapshot().hasBefore; k++) { store.observeViewport({ firstOrdinal: store.getSnapshot().firstOrdinal, lastOrdinal: store.getSnapshot().firstOrdinal + 10, perViewport: 35 }); await settle(); }
    s = store.getSnapshot();
    expect([s.firstOrdinal, s.hasBefore]).toEqual([0, false]);
    expect(residentIds(store)).toEqual(expected.slice(0, s.endOrdinal));
    expect(s.metrics.maxInflight).toBeLessThanOrEqual(MAX_INFLIGHT);
    expect(s.metrics.integrityStops).toBe(0);
  });

  it("generaciones: cambiar la query aborta y descarta la respuesta tardía de la generación anterior; nunca mezcla bloques", async () => {
    const api = createCatalogFakeApi({ n: 600 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    api.fake.hold();
    const pending = store.loadNext(); // queda bloqueado en el fake
    await tick();
    expect(store.getSnapshot().loadingForward).toBe(true);
    const gen = store.getSnapshot().queryGeneration;
    const q2 = store.setQuery({ ...DEFAULT_FILTERS, includeTags: ["odd"] }, "manual"); // nueva generación
    api.fake.release();
    await pending; await q2; await settle();
    const s = store.getSnapshot();
    expect(s.queryGeneration).toBe(gen + 1);
    expect(residentIds(store)).toEqual(api.fake.sorted("manual", { includeTags: ["odd"] }).slice(0, 240));
    expect(s.metrics.discardedLate).toBeGreaterThanOrEqual(1);
    expect(s.blocks.every((b) => b.items.every((i) => i.tags.includes("odd")))).toBe(true);
  });

  it("CURSOR_STALE: una recuperación automática por generación (recarga del inicio con filtros y aviso); la segunda queda como error explícito", async () => {
    const api = createCatalogFakeApi({ n: 800 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.setQuery({ ...DEFAULT_FILTERS, q: "beat" }, "rating");
    api.fake.bumpRevision();
    await store.loadNext(); await settle();
    let s = store.getSnapshot();
    expect([s.status, s.staleReset, s.firstOrdinal, s.revision, s.metrics.staleRecoveries, s.filters.q]).toEqual(["ready", true, 0, "2", 1, "beat"]);
    api.fake.bumpRevision();
    await store.loadNext(); await settle();
    s = store.getSnapshot();
    expect([s.status, s.edgeError?.code]).toEqual(["error", "CURSOR_STALE"]);
    // una nueva generación (cambio de query) vuelve a permitir una recuperación
    await store.setQuery({ ...DEFAULT_FILTERS, q: "beat" }, "manual");
    api.fake.bumpRevision();
    await store.loadNext(); await settle();
    expect(store.getSnapshot().metrics.staleRecoveries).toBe(2);
  });

  it("errores: offline / 401 / 503 / empty / no-results sin lista vacía falsa; reintento contextual conserva el residente", async () => {
    const api = createCatalogFakeApi({ n: 500 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    api.fake.setFailure({ kind: "offline" });
    expect((await store.resolve()).status).toBe("offline");
    expect(store.getSnapshot().status).toBe("offline");
    api.fake.setFailure({ kind: "status", status: 401, code: "UNAUTHENTICATED" });
    expect((await store.resolve()).status).toBe("unauthenticated");
    api.fake.setFailure({ kind: "status", status: 503, code: "CATALOG_UNAVAILABLE" });
    expect((await store.resolve()).status).toBe("unavailable");
    api.fake.setFailure({ kind: "status", status: 409, code: "LIBRARY_RESET_REQUIRED" });
    expect((await store.resolve()).status).toBe("reset_required");
    api.fake.setFailure(null);
    await store.resolve(); await store.loadFirst();
    expect(store.getSnapshot().status).toBe("ready");
    // frontera en error: el residente se conserva y el reintento completa
    api.fake.setFailure({ kind: "status", status: 503, code: "CATALOG_QUERY_TIMEOUT" });
    await store.loadNext(); await settle();
    let s = store.getSnapshot();
    expect([s.status, s.edgeError?.code, s.edgeError?.direction, s.blocks.length]).toEqual(["ready", "CATALOG_QUERY_TIMEOUT", "forward", 1]);
    api.fake.setFailure(null);
    await store.retry(); await settle();
    s = store.getSnapshot();
    expect([s.edgeError, s.blocks.length, s.endOrdinal]).toEqual([null, 2, 480]);
    // no-results (filtros sin match) y empty (biblioteca vacía)
    await store.setQuery({ ...DEFAULT_FILTERS, q: "zzz-nada" }, "rating");
    expect(store.getSnapshot().status).toBe("no-results");
    const emptyApi = createCatalogFakeApi({ n: 0 });
    const es = createCatalogQueryStore({ api: emptyApi, accountId: "A" });
    await es.resolve(); await es.loadFirst();
    expect([es.getSnapshot().status, es.getSnapshot().totalLibrary]).toEqual(["empty", 0]);
    // offline a mitad: estado visible, sin fallback ni reset de lo residente
    api.fake.setFailure({ kind: "offline" });
    await store.setQuery({ ...DEFAULT_FILTERS, q: "beat" }, "rating"); await settle();
    expect(store.getSnapshot().status).toBe("offline");
  });

  it("edge=last y resumeCursor: último bloque con count consistente; la reapertura por GET /beats devuelve el mismo bloque y ordinal", async () => {
    const api = createCatalogFakeApi({ n: 1000 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadLast();
    let s = store.getSnapshot();
    expect([s.firstOrdinal, s.endOrdinal, s.totalMatched, s.hasAfter, s.hasBefore]).toEqual([760, 1000, 1000, false, true]);
    const resume = s.resumeCursor!;
    await store.loadFirst();
    await store.loadResume(resume);
    s = store.getSnapshot();
    expect([s.firstOrdinal, s.endOrdinal]).toEqual([760, 1000]);
    // cursor ajeno → 400 CURSOR_INVALID visible
    const other = createCatalogFakeApi({ n: 10, tenant: "B" });
    const sb = createCatalogQueryStore({ api: other, accountId: "B" });
    await sb.resolve(); await sb.loadResume(resume); await settle();
    expect([sb.getSnapshot().status, sb.getSnapshot().edgeError?.code]).toEqual(["error", "CURSOR_INVALID"]);
  });

  it("B01 en cliente: bgPage → resolver legacy → bloque + ancla; offsets 0/239/240/241/fuera de rango/>10.000", async () => {
    const api = createCatalogFakeApi({ n: 20_500 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve();
    for (const [offset, start, resolution] of [[0, 0, "exact"], [239, 239, "exact"], [240, 240, "exact"], [241, 241, "exact"], [10_000, 10_000, "exact"], [1_000_000_000, 20_400, "last"]] as const) {
      await store.loadLegacy(offset);
      const s = store.getSnapshot();
      expect([s.status, s.firstOrdinal, s.legacy?.resolution, s.legacy?.resolvedOffset]).toEqual(["ready", start, resolution, start]);
      expect(residentIds(store)).toEqual(api.fake.sorted("rating").slice(start, start + 240));
      expect(s.resumeCursor).toBeTruthy();
    }
    await store.loadLegacy(10_001); await settle();
    expect([store.getSnapshot().status, store.getSnapshot().edgeError?.code]).toEqual(["error", "LEGACY_OFFSET_UNRESOLVABLE"]);
    expect(api.fake.counters.listBeats ?? 0).toBe(0); // la resolución legacy no pagina
  });

  it("A→B: teardown descarta respuestas en vuelo y limpia; un ID distinto para el mismo ordinal/revisión es STOP-INTEGRITY", async () => {
    const api = createCatalogFakeApi({ n: 600 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    api.fake.hold();
    const p = store.loadNext(); await tick();
    store.teardown();
    api.fake.release(); await p; await settle();
    expect(store.getSnapshot().status).toBe("idle");
    expect(store.getSnapshot().blocks).toEqual([]);
    // integridad: un bloque legacy empieza en el ordinal 100 (resident 100..339); el token "first" de su frontera anterior devuelve 0..239,
    // que solapa 100..239 con lo residente. Si el servidor devuelve otro ID para un ordinal residente con la misma revisión → STOP-INTEGRITY.
    const api2 = createCatalogFakeApi({ n: 600 });
    const detail: Record<string, unknown>[] = [];
    const s2 = createCatalogQueryStore({ api: api2, accountId: "A", onIntegrity: (d) => detail.push(d) });
    await s2.resolve(); await s2.loadLegacy(100);
    expect([s2.getSnapshot().firstOrdinal, s2.getSnapshot().endOrdinal]).toEqual([100, 340]);
    const sorted = api2.fake.sorted("rating");
    const victim = api2.fake.beats.find((b) => b.id === sorted[150])!;
    victim.id = "intruso"; // misma revisión, distinto id en el ordinal 150
    await s2.loadPrevious(); await settle();
    const after = s2.getSnapshot();
    expect([after.status, after.metrics.integrityStops, detail.length, detail[0]?.ordinal]).toEqual(["integrity", 1, 1, 150]);
    expect(after.edgeError?.code).toBe("STOP_INTEGRITY");
    // sin la inconsistencia, el mismo retroceso deduplica el solape y deja 0..339 contiguos
    const api3 = createCatalogFakeApi({ n: 600 });
    const s3 = createCatalogQueryStore({ api: api3, accountId: "A" });
    await s3.resolve(); await s3.loadLegacy(100); await s3.loadPrevious(); await settle();
    const ok = s3.getSnapshot();
    expect([ok.status, ok.firstOrdinal, ok.endOrdinal, ok.hasBefore, ok.metrics.integrityStops]).toEqual(["ready", 0, 340, false, 0]);
    expect(residentIds(s3)).toEqual(api3.fake.sorted("rating").slice(0, 340));
  });
});
