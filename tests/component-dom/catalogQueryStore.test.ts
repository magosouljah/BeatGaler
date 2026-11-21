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

// E79 — Estado único de la Gallery: un cambio confirmado (beat nuevo, reemplazo, papelera…) actualiza los bloques residentes EN EL SITIO.
describe("catalogQueryStore: actualización en el sitio (E79)", () => {
  const newBeat = (id: string, rating: number) => ({ id, name: `Nuevo ${id}`, bpm: "120", key: "Cm", tags: ["even"], rating, manualRank: -1, state: "ACTIVE" as const });
  const watch = (store: ReturnType<typeof createCatalogQueryStore>) => { const seen: Array<{ status: string; items: number; gen: number }> = []; store.subscribe(() => { const s = store.getSnapshot(); seen.push({ status: s.status, items: s.endOrdinal - s.firstOrdinal, gen: s.queryGeneration }); }); return seen; };

  it("un beat nuevo aparece una sola vez y en su posición según el orden vigente, sin vaciar la Gallery ni cambiar de generación", async () => {
    const api = createCatalogFakeApi({ n: 100 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    const gen = store.getSnapshot().queryGeneration; const seen = watch(store);
    api.fake.beats.push(newBeat("nuevo", 3)); api.fake.bumpRevision("BEAT_IMPORTED", "nuevo");
    store.notifyLibraryChanged(); await settle();
    const s = store.getSnapshot(); const ids = residentIds(store);
    expect(ids).toEqual(api.fake.sorted("rating")); // el orden lo decide PostgreSQL
    expect(ids.filter((id) => id === "nuevo")).toHaveLength(1);
    expect(ids.indexOf("nuevo")).toBeGreaterThan(0); expect(ids.indexOf("nuevo")).toBeLessThan(100); // en medio (rating 3), no al principio ni al final
    expect([s.status, s.revision, s.totalMatched, s.queryGeneration, s.staleReset]).toEqual(["ready", "2", 101, gen, false]);
    expect(seen.every((x) => x.status === "ready" && x.items >= 100 && x.gen === gen)).toBe(true); // nunca vacía, cargando ni otra generación
    expect(api.fake.counters.listBeats).toBe(2);
    // con otro orden y un filtro que lo excluye, el mismo cambio respeta ambos
    await store.setQuery({ ...DEFAULT_FILTERS, includeTags: ["odd"] }, "name");
    api.fake.beats.push(newBeat("otro", 5)); api.fake.bumpRevision();
    store.notifyLibraryChanged(); await settle();
    expect(residentIds(store)).toEqual(api.fake.sorted("name", { includeTags: ["odd"] })); expect(residentIds(store)).not.toContain("otro");
  });

  it("varios bloques residentes se vuelven a pedir completos y se sustituyen de una vez; el scroll continuo sigue con cursores nuevos", async () => {
    const api = createCatalogFakeApi({ n: 900 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst(); await store.loadNext(); await store.loadNext();
    expect(store.getSnapshot().endOrdinal).toBe(720);
    const seen = watch(store); const before = api.fake.counters.listBeats;
    api.fake.beats.push(newBeat("nuevo", 5)); api.fake.bumpRevision();
    store.notifyLibraryChanged(); await settle(12);
    const s = store.getSnapshot();
    expect([s.firstOrdinal, s.endOrdinal, s.blocks.length, s.revision]).toEqual([0, 720, 3, "2"]);
    expect(residentIds(store)).toEqual(api.fake.sorted("rating").slice(0, 720));
    expect(api.fake.counters.listBeats - before).toBe(3);
    expect(seen.every((x) => x.items === 720)).toBe(true); // sustitución atómica: ni bloques parciales ni lista vacía
    await store.loadNext(); await settle();
    expect([store.getSnapshot().endOrdinal, store.getSnapshot().metrics.staleRecoveries, store.getSnapshot().staleReset]).toEqual([901, 0, false]);
  });

  it("subidas simultáneas: los cambios que llegan durante una actualización provocan exactamente otra al terminar; ninguno se pierde", async () => {
    const api = createCatalogFakeApi({ n: 50 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    api.fake.hold();
    api.fake.beats.push(newBeat("uno", 5)); api.fake.bumpRevision(); store.notifyLibraryChanged(); await tick();
    api.fake.beats.push(newBeat("dos", 4)); api.fake.bumpRevision(); store.notifyLibraryChanged();
    api.fake.beats.push(newBeat("tres", 0)); api.fake.bumpRevision(); store.notifyLibraryChanged();
    api.fake.release(); await settle(12);
    expect(residentIds(store)).toEqual(api.fake.sorted("rating")); expect(store.getSnapshot().totalMatched).toBe(53);
    expect(api.fake.counters.listBeats).toBe(3); // carga inicial + actualización + una repetición (no una por aviso)
  });

  it("errores: si la actualización falla se conservan las tarjetas confirmadas; el prefetch no usa cursores que se van a sustituir", async () => {
    const api = createCatalogFakeApi({ n: 600 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    api.fake.setFailure({ kind: "offline" });
    store.notifyLibraryChanged(); await settle();
    let s = store.getSnapshot();
    expect([s.status, s.endOrdinal, s.revision]).toEqual(["ready", 240, "1"]);
    api.fake.setFailure(null);
    api.fake.beats.push(newBeat("nuevo", 5)); api.fake.bumpRevision();
    api.fake.hold(); store.notifyLibraryChanged(); await tick();
    const during = api.fake.counters.listBeats;
    store.observeViewport({ firstOrdinal: 200, lastOrdinal: 239, perViewport: 35 }); await tick(); // pediría el bloque siguiente con un cursor viejo
    expect(api.fake.counters.listBeats).toBe(during);
    api.fake.release(); await settle(12);
    s = store.getSnapshot();
    expect([s.status, s.revision, s.metrics.staleRecoveries, store.itemAt(0)?.id]).toEqual(["ready", "2", 0, api.fake.sorted("rating")[0]]);
    store.observeViewport({ firstOrdinal: 200, lastOrdinal: 239, perViewport: 35 }); await settle();
    expect(store.getSnapshot().endOrdinal).toBe(480); // ya con cursores vigentes
  });
});
