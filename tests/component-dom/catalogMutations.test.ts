// T13 — Cliente de mutaciones sin INDEX: PATCH con conflicto tipado (sin PATCH automático) y retry con la misma operación; trash/restore
// por lotes ≤50 con conflicto que detiene lo siguiente; import/reemplazo por operaciones C7 con preparación de archivos conservada
// (strip ID3 / ZIP inyectados), referencias de operación por cuenta (reload, cambio de cuenta), cuota, archivos retenidos tras conflicto;
// purge pendiente hasta T15; get_index/replace_index = 0 en todas las mutaciones POSTGRES.
import { describe, expect, it } from "vitest";
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { beatFromCatalogDetail, createCatalogMutations, createLocalOperationRefStore, metadataPatch, type OperationRef } from "../../src/features/library/catalog/catalogMutations";
import { createCatalogTransfer } from "../../src/features/library/catalog/catalogTransfer";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

function memoryStorage() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, dump: () => Object.fromEntries(m) }; }
function harness(opts: Parameters<typeof createCatalogFakeCommands>[0] = {}, account = "acc-1") {
  const server = createCatalogFakeCommands(opts);
  const common = { fetchImpl: server.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }) };
  const commands = createCatalogCommandsApi(common);
  const transfer = createCatalogTransfer({ ...common, sleep: async () => {}, pollIntervalMs: 1, idempotencyKey: () => `k-${Math.random().toString(36).slice(2)}` });
  const storage = memoryStorage();
  let accountId = account;
  const prepared: string[] = [];
  const mutations = createCatalogMutations({ commands, transfer, accountId: () => accountId, refStore: createLocalOperationRefStore(storage), idempotencyKey: () => `idem-${Math.random().toString(36).slice(2)}`,
    prepareFiles: async (files, beatName) => { prepared.push(`prepare:${beatName}:${[files.master && "master", files.wav && "wav", files.artwork && "artwork", files.project && "project"].filter(Boolean).join(",")}`); return { ...files, master: files.master ? new File([new Uint8Array(files.master.size)], "stripped.mp3", { type: "audio/mpeg" }) : null, project: files.project ? new File([new Uint8Array(files.project.size)], "project.zip", { type: "application/zip" }) : null, projectFlags: files.project ? { openable: true, hasFlp: true, hasAls: false, hasSamples: false } : null }; } });
  return { server, commands, transfer, mutations, storage, prepared, setAccount: (a: string) => { accountId = a; } };
}
const blob = (n: number, type = "audio/mpeg") => new File([new Uint8Array(n)], `f${n}.bin`, { type });

describe("catalogMutations", () => {
  it("PATCH metadata-only: conflicto 409 → resultado `conflict` sin PATCH automático; retry con la misma clave de idempotencia replay; detalle SQL para la versión", async () => {
    const h = harness();
    const r1 = await h.mutations.patchBeat({ beatId: "g1", expectedVersion: "1", patch: { name: "Renamed" } });
    expect(r1.status).toBe("ok"); if (r1.status === "ok") expect(r1.beat?.version).toBe("2");
    // otro dispositivo edita; nuestro draft sigue siendo con versión 2 esperada → conflicto tipado
    h.server.externalEdit("g1");
    const r2 = await h.mutations.patchBeat({ beatId: "g1", expectedVersion: "2", patch: { bpm: "140" } });
    expect(r2.status).toBe("conflict"); if (r2.status === "conflict") { expect(r2.currentVersion).toBe("3"); expect(r2.expectedVersion).toBe("2"); }
    expect(h.server.beats.get("g1")!.bpm).not.toBe("140");
    expect(h.server.counters["PATCH /catalog/v1/beats/:id"]).toBe(2);
    // el detalle SQL da la versión actual; el retry (misma operación) reutiliza la clave: replay sin segundo efecto
    const detail = await h.mutations.getBeat("g1");
    const r3 = await h.mutations.patchBeat({ beatId: "g1", expectedVersion: detail.version, patch: { bpm: "140" }, idempotencyKey: "same-op" });
    const r4 = await h.mutations.patchBeat({ beatId: "g1", expectedVersion: detail.version, patch: { bpm: "140" }, idempotencyKey: "same-op" });
    expect([r3.status, r4.status]).toEqual(["ok", "ok"]); if (r4.status === "ok") expect(r4.replay).toBe(true);
    expect(h.server.beats.get("g1")!.version).toBe(4);
    expect(h.server.legacy).toEqual({ getLibraryIndex: 0, replaceLibraryIndex: 0 });
    // patch mínimo: los valores legacy no editados no viajan
    expect(metadataPatch({ name: "a", bpm: "1", key: "C", tags: ["x"], rating: 1, color: "#1", color2: "#2" }, { name: "a ", bpm: "2", key: "C", tags: ["x"], rating: 1, color: "#1", color2: "#2" })).toEqual({ bpm: "2" });
    const beat = beatFromCatalogDetail(detail);
    expect([beat.id, beat.cloud_status, beat.assets?.master?.object_id]).toEqual(["g1", "SYNCED", "catalog:f-g1"]);
  });

  it("trash/restore por lotes ≤50: 120 ítems → 3 lotes; un conflicto en el lote 2 detiene el 3 y el reporte nunca es éxito total; restore idempotente", async () => {
    const h = harness({ beats: fakeBeats(120) });
    const items = [...h.server.beats.values()].map((b) => ({ beatId: b.id, expectedVersion: String(b.version) }));
    h.server.externalEdit("g60"); // dentro del lote 2
    const r = await h.mutations.trashBeats(items, { idempotencyKey: "trash-1" });
    expect([r.status, r.applied.length, r.notExecuted.length, r.conflict?.batchIndex]).toEqual(["CONFLICT", 50, 70, 1]);
    expect(h.server.counters["POST /catalog/v1/beats/trash"]).toBe(2);
    expect([...h.server.beats.values()].filter((b) => b.state === "TRASH").length).toBe(50);
    const restoreItems = [...h.server.beats.values()].filter((b) => b.state === "TRASH").map((b) => ({ beatId: b.id, expectedVersion: String(b.version) }));
    const r2 = await h.mutations.restoreBeats(restoreItems, { idempotencyKey: "restore-1" });
    expect([r2.status, r2.applied.length]).toEqual(["COMPLETED", 50]);
    const r3 = await h.mutations.restoreBeats(restoreItems, { idempotencyKey: "restore-1" });
    expect(r3.status).toBe("COMPLETED"); // replay por clave (sin segundo efecto)
    expect(h.server.beats.get("g0")!.version).toBe(3);
    expect(await h.mutations.purgeTrash()).toEqual({ status: "pending", reason: "PURGE_DELIVERED_BY_T15", durable: false });
    expect(h.server.legacy).toEqual({ getLibraryIndex: 0, replaceLibraryIndex: 0 });
  });

  it("import: strip ID3/ZIP conservados como preparación, operación C7 (MASTER por capacidad, PROJECT por MASTER), progreso por etapas, commit; referencia de operación persistida y olvidada al confirmar", async () => {
    const h = harness();
    const stages: string[] = [];
    const r = await h.mutations.importBeat({ beat: { name: "Nuevo", bpm: "120", key: "Cm", tags: ["trap"], rating: 3, color: "#111", color2: "#222", image_base64: null }, files: { master: blob(3000), project: blob(500, "application/zip") }, onProgress: (p) => stages.push(`${p.stage}:${p.uploadedBytes}/${p.totalBytes}`) });
    expect(r.status).toBe("committed"); if (r.status === "committed") { expect(r.version).toBe("1"); expect(h.server.beats.get(r.beatId)?.name).toBe("Nuevo"); }
    expect(h.prepared).toEqual(["prepare:Nuevo:master,project"]);
    expect(stages[0]).toBe("preparing:0/3500"); expect(stages.at(-1)).toBe("library:3500/3500"); expect(stages.some((s) => s.startsWith("master:"))).toBe(true); expect(stages.some((s) => s.startsWith("project:"))).toBe(true);
    expect(h.server.counters["POST /catalog/v1/operations/:id/parts/:partKey/capability"]).toBe(1);
    expect(h.server.counters["PUT /catalog/v1/transfer/upload/:token"]).toBe(1);
    expect(h.server.counters["PUT /catalog/v1/operations/:id/parts/:partKey/project"]).toBe(1);
    expect(h.mutations.pendingOperations()).toEqual([]);
    expect(h.server.legacy).toEqual({ getLibraryIndex: 0, replaceLibraryIndex: 0 });
    await expect(h.mutations.importBeat({ beat: { name: "x", bpm: "", key: "", tags: [], rating: 0, color: "", color2: "", image_base64: null }, files: {} })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("reemplazo: conflicto de versión en el commit → `conflict` con archivos retenidos; reload recupera la referencia por cuenta; cambio de cuenta no la mezcla; cuota → error sin reintento", async () => {
    const h = harness({ transferVerifyAfterPolls: 2 });
    const original = { name: "Beat 5", bpm: "105", key: "F#m", tags: ["odd", "t5"], rating: 5, color: "", color2: "" };
    // mientras la parte se verifica, otro dispositivo edita el beat → el commit devuelve VERSION_CONFLICT y los objetos quedan retenidos
    let conflicted = false;
    const serverFetch = h.server.fetchImpl;
    const spyFetch: typeof fetch = async (input, init) => { const url = String(input); if (!conflicted && url.includes("/commit")) { conflicted = true; h.server.externalEdit("g5"); } return serverFetch(input, init); };
    const common = { fetchImpl: spyFetch, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }) };
    const storage = memoryStorage(); let account = "acc-A";
    const mutations = createCatalogMutations({ commands: createCatalogCommandsApi(common), transfer: createCatalogTransfer({ ...common, sleep: async () => {}, pollIntervalMs: 1 }), accountId: () => account, refStore: createLocalOperationRefStore(storage), prepareFiles: async (f) => ({ ...f, projectFlags: null }) });
    const r = await mutations.replaceBeat({ beatId: "g5", expectedVersion: "1", original, updated: { ...original, name: "Beat 5 v2" }, files: { master: blob(2000) } });
    expect(r.status).toBe("conflict"); if (r.status === "conflict") { expect(r.retained).toBe(true); expect(r.error?.code).toBe("VERSION_CONFLICT"); }
    expect(h.server.beats.get("g5")!.name).toBe("Edited elsewhere");
    // la referencia de la operación persiste (sin tokens) y se recupera tras "recargar"
    const refs = mutations.pendingOperations(); expect(refs.map((x: OperationRef) => x.kind)).toEqual(["REPLACE"]);
    expect(JSON.stringify(storage.dump())).not.toMatch(/token|T0000/);
    const resolved = await mutations.resolvePendingTransfers();
    expect(resolved.map((x) => [x.ref.kind, x.operation?.status, x.terminal])).toEqual([["REPLACE", "CONFLICT", true]]);
    // cambio de cuenta: la lista es por cuenta
    account = "acc-B"; expect(mutations.pendingOperations()).toEqual([]);
    account = "acc-A"; expect(mutations.pendingOperations().length).toBe(1);
    // sin archivos nuevos → metadata-only → PATCH (no una transferencia vacía)
    const p = await mutations.replaceBeat({ beatId: "g6", expectedVersion: "1", original: { ...original, name: "Beat 6" }, updated: { ...original, name: "Beat 6 renamed" }, files: {} });
    expect(p.status).toBe("ok");
    expect(h.server.counters["PATCH /catalog/v1/beats/:id"]).toBe(1);
    // cuota agotada: error visible, sin reintentos ni efectos
    const q = harness({ beats: fakeBeats(3), quotaMax: 3 });
    await expect(q.mutations.importBeat({ beat: { name: "x", bpm: "", key: "", tags: [], rating: 0, color: "", color2: "", image_base64: null }, files: { master: blob(10) } })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    expect(q.server.counters["POST /catalog/v1/operations"]).toBe(1);
    expect(q.mutations.pendingOperations()).toEqual([]);
    expect(h.server.legacy).toEqual({ getLibraryIndex: 0, replaceLibraryIndex: 0 });
  });

  it("errores estables: 428 sin cabeceras no ocurre (el cliente siempre envía era/época); CatalogApiError con código del servidor", async () => {
    const h = harness();
    h.server.setFailure({ code: "LIBRARY_FROZEN", status: 409, route: /beats\/g2$/ });
    const r = await h.mutations.patchBeat({ beatId: "g2", expectedVersion: "1", patch: { name: "x" } });
    expect(r.status).toBe("error"); if (r.status === "error") expect((r.error as CatalogApiError).code).toBe("LIBRARY_FROZEN");
  });
});
