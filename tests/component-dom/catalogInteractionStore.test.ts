// T13 / V07-A — InteractionStore: Select All server-side con count exacto; individual/Shift por extremos (nunca índices de ventana);
// seleccionado evictado sigue seleccionado; cambiar filtros borra con aviso solo si había count; sort conserva y reinicia ancla;
// revisión externa → conflicto y comandos deshabilitados (stale bloquea);
// bulk desde Drawer con reporte por lote y conflicto tras el lote 2;
// facetas con cache acotado; rename preview → confirmación → progreso y parcial nunca total. Sin reorden Web.
import { describe, expect, it } from "vitest";
import { createCatalogApi } from "../../src/features/library/catalog/catalogApi";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { SELECTION_CLEARED_NOTICE, createCatalogInteractionStore, type InteractionQuery } from "../../src/features/library/catalog/catalogInteractionStore";
import { WEB_FOUNDATION_CAPABILITIES } from "../../src/platform/capabilities";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

function harness(opts: Parameters<typeof createCatalogFakeCommands>[0] = {}) {
  const server = createCatalogFakeCommands(opts);
  const common = { fetchImpl: server.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }) };
  let account = "acc-1";
  const store = createCatalogInteractionStore({ commands: createCatalogCommandsApi(common), api: createCatalogApi(common), accountId: () => account, consumerId: "test", sleep: async () => {}, pollIntervalMs: 1, maxPollMs: 10_000, setReadyTimeoutMs: 10_000, facetsCacheMax: 3, now: () => Date.now() });
  const query = (over: Partial<InteractionQuery["filters"]> = {}, sort: InteractionQuery["sort"] = "rating"): InteractionQuery => ({ filters: { state: "ACTIVE", q: "", includeTags: [], excludeTags: [], includeMode: "any", ...over }, sort, revision: server.revision() });
  return { server, store, query, setAccount: (a: string) => { account = a; } };
}

describe("catalogInteractionStore (V07-A)", () => {
  it("Select All = count exacto del servidor (no windowItems); un seleccionado evictado sigue seleccionado; deseleccionar todo → count 0 sin enumerar IDs", async () => {
    const h = harness({ beats: fakeBeats(600), setReadyAfterPolls: 2 });
    const p = h.store.selectAll(h.query({ includeTags: ["even"] }));
    expect(h.store.getSnapshot().selection.status).toBe("preparing");
    await p;
    const s = h.store.getSnapshot().selection;
    expect([s.status, s.count, s.defaultSelected]).toEqual(["active", 300, true]);
    expect(h.server.counters["GET /catalog/v1/query-sets/:id"]).toBe(2);
    // flags solo para residentes; un beat fuera de la ventana (evictado) sigue seleccionado en el servidor
    await h.store.refreshFlags(["g0", "g2", "g1"]);
    expect(h.store.getSnapshot().selection.flags).toEqual({ g0: true, g2: true, g1: false });
    expect(h.store.isSelected("g598")).toBe(true);
    expect(Object.keys(h.store.getSnapshot().selection.flags).length).toBe(3);
    await h.store.clearSelection();
    expect([h.store.getSnapshot().selection.status, h.store.getSnapshot().selection.count]).toEqual(["none", 0]);
    expect(h.server.counters["POST /catalog/v1/selections/:id/release"]).toBe(1);
    expect(h.server.counters["GET /catalog/v1/selections/:id"]).toBe(1);
  });

  it("individual + Shift por extremos beatId con ancla; sort conserva la membresía y reinicia el ancla; cambiar filtros borra con aviso solo si había count", async () => {
    const h = harness({ beats: fakeBeats(50) });
    const q = h.query();
    await h.store.toggle("g3", { ordinal: 3, query: q });
    let s = h.store.getSnapshot().selection;
    expect([s.status, s.count, s.defaultSelected, s.anchor?.beatId]).toEqual(["active", 1, false, "g3"]);
    await h.store.toggle("g10", { shiftKey: true, ordinal: 10, query: q });
    s = h.store.getSnapshot().selection;
    expect(s.count).toBe(8);
    const sel = h.server.selection(s.selectionId!)!;
    expect(sel.ops.at(-1)).toEqual({ kind: "INCLUDE_RANGE", fromBeatId: "g3", toBeatId: "g10" });
    expect(s.anchor?.beatId).toBe("g3"); // el ancla queda fija hasta un clic sin Shift
    await h.store.toggle("g3", { ordinal: 3, query: q }); // deselecciona el ancla
    expect(h.store.getSnapshot().selection.count).toBe(7);
    h.store.onSortChanged("name");
    s = h.store.getSnapshot().selection;
    expect([s.count, s.anchor, s.sort]).toEqual([7, null, "name"]);
    await h.store.onFiltersChanged(h.query({ q: "Beat 1" }));
    s = h.store.getSnapshot().selection;
    expect([s.status, s.count, s.notice]).toEqual(["none", 0, SELECTION_CLEARED_NOTICE]);
    h.store.dismissNotice();
    await h.store.onFiltersChanged(h.query({ q: "Beat 2" }));
    expect(h.store.getSnapshot().selection.notice).toBeNull(); // sin selección previa: sin aviso
    expect(h.server.legacy).toEqual({ getLibraryIndex: 0, replaceLibraryIndex: 0 });
  });

  it("revisión externa → selección en conflicto y comandos deshabilitados (stale bloquea bulk); un CAS fallido también deja conflicto", async () => {
    const h = harness({ beats: fakeBeats(20) });
    await h.store.selectAll(h.query());
    h.server.externalEdit("g1");
    h.store.onRevisionChanged(h.server.revision());
    expect(h.store.getSnapshot().selection.status).toBe("conflict");
    await expect(h.store.startBulk("BULK_PATCH", { rating: 5 })).rejects.toMatchObject({ code: "SELECTION_CONFLICT" });
    expect(h.server.counters["POST /catalog/v1/operations"]).toBeUndefined();
    await expect(h.store.toggle("g2", { query: h.query() })).rejects.toMatchObject({ code: "SELECTION_CONFLICT" });
    // reselección: nuevo Select All en la revisión actual
    await h.store.selectAll(h.query());
    expect(h.store.getSnapshot().selection.status).toBe("active");
  });


  it("bulk desde Drawer: operación durable sobre la selección congelada, reporte por lote; conflicto después del lote 2 conserva lo confirmado y nunca es éxito total", async () => {
    const h = harness({ beats: fakeBeats(130), bulkBatch: 50, conflictAtBatch: 3 });
    await h.store.selectAll(h.query());
    const r = await h.store.startBulk("BULK_PATCH", { key: "Zz" });
    expect([r.status, r.report.total, r.report.confirmed, r.report.notExecuted, r.report.conflictBatchSeq, r.report.completed]).toEqual(["CONFLICT", 130, 100, 30, 3, false]);
    expect([...h.server.beats.values()].filter((b) => b.key === "Zz").length).toBe(100);
    expect(h.store.getSnapshot().selection.status).toBe("none");
    expect(h.store.getSnapshot().bulk?.status).toBe("CONFLICT");
    const h2 = harness({ beats: fakeBeats(130), bulkBatch: 50, conflictAtBatch: 3 });
    await h2.store.selectAll(h2.query());
    const r2 = await h2.store.startBulk("BULK_TRASH");
    expect(r2.status).toBe("CONFLICT");
    expect(h.server.legacy).toEqual({ getLibraryIndex: 0, replaceLibraryIndex: 0 });
  });

  it("bulk cancelado en el servidor: el sondeo termina en CANCELLED, conserva lo confirmado, contabiliza el resto como cancelado y nunca es éxito total", async () => {
    const h = harness({ beats: fakeBeats(120), bulkBatch: 50 });
    const common = { baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }) };
    let polls = 0;
    const cancelAfterFirstPoll = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const res = await h.server.fetchImpl(i, init);
      const m = /\/operations\/(op-[^/?]+)$/.exec(String(i));
      if (m && init?.method === "GET" && ++polls === 1) await h.server.fetchImpl(`https://cloud.invalid/api/catalog/v1/operations/${m[1]}/cancel`, { method: "POST", headers: { "X-Catalog-Era": "era-fake", "X-Catalog-Epoch": "1" }, body: "{}" });
      return res;
    }) as typeof fetch;
    const store = createCatalogInteractionStore({ commands: createCatalogCommandsApi({ ...common, fetchImpl: cancelAfterFirstPoll }), api: createCatalogApi({ ...common, fetchImpl: h.server.fetchImpl }), accountId: () => "acc-1", sleep: async () => {}, pollIntervalMs: 1 });
    await store.selectAll(h.query());
    const r = await store.startBulk("BULK_TRASH");
    expect(r.status).toBe("CANCELLED");
    expect(r.report.confirmed).toBeGreaterThan(0);
    expect(r.report.confirmed).toBeLessThan(120);
    expect([r.report.cancelled, r.report.completed]).toEqual([120 - r.report.confirmed, false]);
    expect(store.getSnapshot().bulk?.status).toBe("CANCELLED");
  });

  it("bulk añadir/quitar tags desde Drawer (BULK_PATCH + tagsOp): nunca reemplaza el set, preserva el resto de tags; mismo reporte por lote que el resto de bulk; tagsOp vacío se rechaza", async () => {
    const h = harness({ beats: fakeBeats(40) });
    await h.store.selectAll(h.query({ includeTags: ["even"] }));
    const add = await h.store.startBulk("BULK_PATCH", {}, { op: "add", tags: ["Nuevo Tag"] });
    expect([add.status, add.report.total, add.report.confirmed, add.report.completed]).toEqual(["COMPLETED", 20, 20, true]);
    const g0 = h.server.beats.get("g0")!;
    expect(g0.tags).toContain("nuevo tag");
    expect(g0.tags).toEqual(expect.arrayContaining(["even", "t0"])); // el resto del set se conserva (nunca reemplaza)
    expect(h.store.getSnapshot().selection.status).toBe("none"); // selección consumida, como el resto de bulk
    await h.store.selectAll(h.query({ includeTags: ["even"] }));
    const remove = await h.store.startBulk("BULK_PATCH", {}, { op: "remove", tags: ["nuevo tag"] });
    expect([remove.status, remove.report.completed]).toEqual(["COMPLETED", true]);
    expect(h.server.beats.get("g0")!.tags).not.toContain("nuevo tag");
    expect(h.server.beats.get("g0")!.tags).toEqual(expect.arrayContaining(["even", "t0"]));
    await h.store.selectAll(h.query({ includeTags: ["even"] }));
    await expect(h.store.startBulk("BULK_PATCH", {}, { op: "add", tags: [] })).rejects.toBeTruthy();
  });

  it("facetas globales con cache acotado; capability reorder Web = false", async () => {
    const h = harness({ beats: fakeBeats(30) });
    const rev = h.server.revision();
    const f1 = await h.store.loadFacets({ revision: rev }); const f2 = await h.store.loadFacets({ revision: rev });
    expect(f1).toBe(f2); expect(h.server.counters["GET /catalog/v1/facets"]).toBe(1);
    expect(f1.items[0]).toMatchObject({ key: "even", count: 15 });
    await h.store.loadFacets({ revision: rev, q: "t1" }); await h.store.loadFacets({ revision: rev, scope: "TRASH" }); await h.store.loadFacets({ revision: "x" });
    expect(h.store.getSnapshot().facetsCacheSize).toBe(3);
    expect(WEB_FOUNDATION_CAPABILITIES.manualLibraryReorder).toBe(false);
  });

  it("rename: preview con counts ACTIVE/TRASH → confirmación → operación durable; parcial/conflicto nunca se presenta como éxito total; teardown por cuenta libera la selección", async () => {
    const h = harness({ beats: fakeBeats(120), bulkBatch: 50, conflictAtBatch: 2 });
    h.server.beats.get("g1")!.state = "TRASH";
    h.store.openRename("Odd"); h.store.setRenameTarget("impar");
    const preview = await h.store.previewRename();
    expect(preview).toMatchObject({ from: "odd", to: "impar", countActive: 59, countTrash: 1, mergesInto: false });
    const r = await h.store.confirmRename();
    expect([r?.status, r?.report.confirmed, r?.report.total, r?.report.completed]).toEqual(["CONFLICT", 50, 60, false]);
    expect(h.store.getSnapshot().rename?.stage).toBe("partial");
    expect(h.store.getSnapshot().rename?.error).toMatch(/50\/60/);
    expect(h.server.beats.get("g1")!.state).toBe("TRASH"); // el status TRASH no cambia por el rename
    const h2 = harness({ beats: fakeBeats(10) });
    h2.store.openRename("even"); h2.store.setRenameTarget("par"); await h2.store.previewRename();
    const r2 = await h2.store.confirmRename();
    expect([r2?.status, r2?.report.completed, h2.store.getSnapshot().rename?.stage]).toEqual(["COMPLETED", true, "done"]);
    expect([...h2.server.beats.values()].filter((b) => b.tags.includes("par")).length).toBe(5);
    // teardown (cambio de cuenta): estado vacío y selección liberada en el servidor
    await h2.store.selectAll(h2.query());
    const selId = h2.store.getSnapshot().selection.selectionId!;
    h2.setAccount("acc-2"); await h2.store.teardown();
    expect([h2.store.getSnapshot().selection.status, h2.store.getSnapshot().accountId, h2.store.getSnapshot().rename]).toEqual(["none", "acc-2", null]);
    expect(h2.server.selection(selId)?.status).toBe("RELEASED");
  });
});
