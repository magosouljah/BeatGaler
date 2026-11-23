// @vitest-environment jsdom
// Documento maestro 2026-11-17 §6.1 — defectos con riesgo de pérdida de trabajo, éxito falso u operaciones duplicadas (Gallery POSTGRES).
// Cada caso describe el comportamiento CORRECTO; sobre el código anterior fallaban (reproducción, ver EVIDENCIA E67).
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";
import { createCatalogMutations, createLocalOperationRefStore } from "../../src/features/library/catalog/catalogMutations";
import { createCatalogTrashSource } from "../../src/features/library/catalog/catalogTrashSource";

const { pickFile } = vi.hoisted(() => ({ pickFile: vi.fn(async (): Promise<File | null> => null) }));
vi.mock("../../src/platform", () => ({
  platform: {
    kind: "web",
    capabilities: { reviewBeatCloudCommit: true, browserCloudEditing: true, directGalerCloudTransport: false },
    importer: { slotFilesForBeat: () => ({}), pickSlotFile: vi.fn(async () => null) },
    editor: { pickFile, commit: vi.fn(async () => { throw new Error("legacy web editor must not be used by the catalog"); }) },
  },
}));
import Drawer from "../../src/components/Drawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; pickFile.mockReset(); document.body.innerHTML = ""; });

// Beat tal como lo produce beatFromCatalogDetail (Gallery POSTGRES).
function catalogBeat(over: Partial<Beat> = {}): Beat {
  return {
    id: "b1", name: "Before", folder_path: "", mp3_path: "", wav_path: null, playback_path: "", bpm: "120", key: "Cm", needs_resolution: false, tags: [], rating: 1,
    image_base64: null, image_preview_base64: null, image_crop: null, has_wav: false, has_stems: false, has_samples: false, samples_path: null, has_flp: false, has_als: false,
    stems_path: null, flp_path: null, als_path: null, other_files: [], color: "#777777", color2: "#999999", has_loop: false, loop_path: null, cloud_status: "SYNCED",
    telegram_file_id: "catalog:f-master", telegram_message_id: null, offline_available: false,
    assets: { master: { object_id: "catalog:f-master", revision: "1", filename: null }, wav: null, artwork: null, project: null, samples: null, stems: null, loop: null },
    ...over,
  } as Beat;
}
type CatalogSave = (input: { original: Beat; updated: Beat; files: Partial<Record<"MASTER" | "WAV" | "PROJECT", File>>; artworkRemoved: boolean }) => Promise<void>;
async function mountDrawer(beat: Beat, { catalogSave }: { catalogSave: CatalogSave }) {
  const onSaved = vi.fn(); const onClose = vi.fn();
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  cleanup = async () => act(async () => root.unmount());
  // mismas props que pasa CatalogAppShell
  await act(async () => { root.render(<Drawer beat={beat} mode="edit" onClose={onClose} onSaved={onSaved} onReleaseAudio={() => {}} mutationAllowed
    onWebSave={(request) => { if (request.kind === "edit") return catalogSave(request); }} />); });
  const button = (text: string) => Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.trim() === text);
  const save = async () => { await act(async () => { Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith("Save changes"))!.click(); }); await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  return { host, onSaved, onClose, button, save };
}

describe("§6.1-1 Drawer: reemplazo de MASTER / WAV / PROJECT", () => {
  for (const [slot, label, file] of [["MASTER", "Replace", new File([new Uint8Array(8)], "new.mp3", { type: "audio/mpeg" })], ["WAV", "+ WAV", new File([new Uint8Array(8)], "hq.wav", { type: "audio/wav" })], ["PROJECT", "+ PROJECT", new File([new Uint8Array(8)], "p.zip", { type: "application/zip" })]] as const) {
    it(`${slot}: el archivo elegido llega al guardado del catálogo; nunca se cierra con éxito sin subirlo`, async () => {
      const catalogSave = vi.fn<CatalogSave>(async () => {});
      pickFile.mockResolvedValueOnce(file);
      const d = await mountDrawer(catalogBeat(), { catalogSave });
      const rows = Array.from(d.host.querySelectorAll("button")).filter((b) => (b.textContent?.trim() === label || b.textContent?.trim() === "Replace"));
      const row = rows.find((b) => b.parentElement?.textContent?.startsWith(slot))!;
      await act(async () => { row.click(); });
      expect(d.host.textContent).toContain(`Pending: ${file.name}`);
      await d.save();
      expect(catalogSave).toHaveBeenCalledOnce();
      expect(catalogSave.mock.calls[0][0].files[slot]).toBe(file);
      expect(d.onClose).toHaveBeenCalledOnce();
    });
  }
  it("si el guardado del catálogo falla, el Drawer sigue abierto con el archivo pendiente y el error visible (sin éxito falso)", async () => {
    const catalogSave = vi.fn<CatalogSave>(async () => { throw new Error("La subida no se pudo confirmar"); });
    pickFile.mockResolvedValueOnce(new File([new Uint8Array(8)], "hq.wav", { type: "audio/wav" }));
    const d = await mountDrawer(catalogBeat(), { catalogSave });
    await act(async () => { d.button("+ WAV")[0].click(); });
    await d.save();
    expect(d.onClose).not.toHaveBeenCalled(); expect(d.onSaved).not.toHaveBeenCalled();
    expect(d.host.textContent).toContain("Pending: hq.wav"); expect(d.host.textContent).toContain("La subida no se pudo confirmar");
  });
});

describe("§6.1-2 Edición de un beat sin MASTER", () => {
  it("cambiar metadatos de un beat sin MASTER llega al guardado del catálogo (antes: cierre con éxito sin persistir)", async () => {
    const catalogSave = vi.fn<CatalogSave>(async () => {});
    const d = await mountDrawer(catalogBeat({ telegram_file_id: null, assets: { master: null, wav: { object_id: "catalog:b1:WAV", revision: "1" }, artwork: null, project: null, samples: null, stems: null, loop: null } as Beat["assets"] }), { catalogSave });
    const name = d.host.querySelector("input[value='Before']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "After"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    await d.save();
    expect(catalogSave).toHaveBeenCalledOnce(); expect(catalogSave.mock.calls[0][0].updated.name).toBe("After");
  });
});

describe("§6.1-3 Quitar portada", () => {
  it("«Remove» se comunica explícitamente (artworkRemoved) en lugar de perderse en un PATCH sin portada", async () => {
    const catalogSave = vi.fn<CatalogSave>(async () => {});
    const d = await mountDrawer(catalogBeat({ image_base64: "blob:fake/cover", image_preview_base64: "blob:fake/cover", has_artwork: true } as Partial<Beat>), { catalogSave });
    await act(async () => { d.button("Remove")[0].click(); });
    await d.save();
    expect(catalogSave).toHaveBeenCalledOnce(); expect(catalogSave.mock.calls[0][0].artworkRemoved).toBe(true);
  });
  it("contrato: solo el PATCH individual admite `artwork: null`; BULK_PATCH e IMPORT/REPLACE siguen rechazándolo; ningún otro valor", async () => {
    const rules = await import("../../cloud-server/catalog/metadata-rules.js" as string) as { validatePatch: (p: unknown, o?: { allowArtworkRemoval?: boolean }) => unknown };
    expect(rules.validatePatch({ artwork: null })).toMatchObject({ ok: false, errors: [{ field: "artwork", reason: "field is not patchable" }] });
    expect(rules.validatePatch({ artwork: null }, { allowArtworkRemoval: true })).toEqual({ ok: true, set: { artwork: null }, errors: [] });
    expect(rules.validatePatch({ artwork: { fileId: "f" } }, { allowArtworkRemoval: true })).toMatchObject({ ok: false, errors: [{ field: "artwork" }] });
    expect(rules.validatePatch({ artwork: null, bpm: "120" }, { allowArtworkRemoval: true })).toEqual({ ok: true, set: { artwork: null, bpm: "120" }, errors: [] });
  });
});

describe("§6.1-4 Vaciar papelera", () => {
  const fakeMutations = (final: "pending" | "blocked" | "partial" | "purged") => ({
    restoreBeats: vi.fn(), purgeTrash: vi.fn(async () => ({ status: "pending" as const, operationId: "p1", durable: true as const, operation: {} as never })),
    purgeState: vi.fn(async () => ({ status: final, operation: { status: final.toUpperCase(), progress: { total: 2, purged: final === "purged" ? 2 : final === "partial" ? 1 : 0, blocked: final === "purged" ? 0 : 1, pending: 0, objects: {} } } as never })),
  });
  it("E81: restore_hold / cleanup deshabilitado ya no impiden eliminar definitivamente (solo difieren la limpieza en Telegram, en el servidor)", async () => {
    const m = fakeMutations("purged");
    const src = createCatalogTrashSource({ api: { ...api, context: vi.fn(async () => ({ restore_hold: true, cleanup_enabled: false })) } as never, mutations: m as never, sleep: async () => {}, pollMax: 3 });
    await expect(src.purgeBeats()).resolves.toBeTypeOf("number"); expect(m.purgeTrash).toHaveBeenCalledOnce();
  });
  const api = { listBeats: vi.fn(async () => ({ items: [], nextCursor: null })) };
  it("purga aún pendiente al agotar el sondeo → nunca se informa como «borrado»", async () => {
    const src = createCatalogTrashSource({ api: api as never, mutations: fakeMutations("pending") as never, sleep: async () => {}, pollMax: 3 });
    await expect(src.purgeBeats()).rejects.toThrow(/pendiente|todavía|still/i);
  });
  it("purga BLOCKED/PARTIAL (beats que siguen en la papelera) → mensaje veraz, sin «puedes reintentarla» que no resolvería nada", async () => {
    for (const final of ["blocked", "partial"] as const) {
      const src = createCatalogTrashSource({ api: api as never, mutations: fakeMutations(final) as never, sleep: async () => {}, pollMax: 3 });
      const err = await src.purgeBeats().then(() => null, (e: Error) => e);
      expect(err).not.toBeNull(); expect(String(err?.message)).not.toMatch(/reintentarla/); expect(String(err?.message)).toMatch(/no se eliminó|no se borró/i);
    }
  });
  it("purga PURGED → éxito", async () => {
    const src = createCatalogTrashSource({ api: api as never, mutations: fakeMutations("purged") as never, sleep: async () => {}, pollMax: 3 });
    await expect(src.purgeBeats()).resolves.toBeTypeOf("number");
  });
});

// Transferencia mínima: la operación queda en RECONCILE (el cliente la ve como «blocked»), puede confirmarse más tarde en el servidor.
function reconcileTransfer() {
  let n = 0; const ops = new Map<string, string>();
  return {
    created: () => n,
    status: ops,
    createOperation: vi.fn(async () => { n++; const id = `op${n}`; ops.set(id, "TRANSFERRING"); return { operationId: id, beatId: `nb${n}`, status: "TRANSFERRING", parts: [] }; }),
    uploadPart: vi.fn(async () => ({ state: "VERIFIED" })), uploadProject: vi.fn(async () => ({ state: "VERIFIED" })),
    commit: vi.fn(async (id: string) => { ops.set(id, "RECONCILE"); return { status: "RECONCILE", operation: { operationId: id, status: "RECONCILE" }, error: null }; }),
    getOperation: vi.fn(async (id: string) => ({ operationId: id, status: ops.get(id) ?? "RECONCILE" })),
  };
}
function memoryStorage() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; }
const mp3 = () => new File([new Uint8Array(16)], "a.mp3", { type: "audio/mpeg" });
const meta = { name: "Dup test", bpm: "", key: "", tags: [], rating: 0, color: "#777777", color2: "#999999", image_base64: null };

describe("§6.1-7 Subidas duplicadas tras timeout/bloqueo", () => {
  it("IMPORT en RECONCILE/timeout: un segundo intento del mismo beat se rechaza sin crear otra operación mientras la primera no se resuelva", async () => {
    const transfer = reconcileTransfer();
    const m = createCatalogMutations({ commands: {} as never, transfer: transfer as never, accountId: () => "acc", refStore: createLocalOperationRefStore(memoryStorage()) });
    const first = await m.importBeat({ beat: meta, files: { master: mp3() } });
    expect(first.status).toBe("blocked");
    const second = await m.importBeat({ beat: meta, files: { master: mp3() } }).then((o) => o, (e: unknown) => e);
    expect(transfer.created()).toBe(1);
    expect(second).toBeInstanceOf(CatalogApiError); expect((second as CatalogApiError).code).toBe("OPERATION_PENDING");
  });
  it("cuando la primera operación termina en FAILED (terminal, sin efecto) sí se permite volver a importar", async () => {
    const transfer = reconcileTransfer();
    const m = createCatalogMutations({ commands: {} as never, transfer: transfer as never, accountId: () => "acc", refStore: createLocalOperationRefStore(memoryStorage()) });
    await m.importBeat({ beat: meta, files: { master: mp3() } });
    transfer.status.set("op1", "FAILED");
    transfer.commit.mockImplementationOnce(async (id: string) => ({ status: "COMMITTED", operation: { operationId: id, status: "COMMITTED", result: { version: "1", revision: "2" } } as never, error: null }) as never);
    const again = await m.importBeat({ beat: meta, files: { master: mp3() } });
    expect(transfer.created()).toBe(2); expect(again.status).toBe("committed");
  });
  it("REPLACE en RECONCILE: un segundo reemplazo del mismo beat se rechaza sin subir de nuevo", async () => {
    const transfer = reconcileTransfer();
    const m = createCatalogMutations({ commands: {} as never, transfer: transfer as never, accountId: () => "acc", refStore: createLocalOperationRefStore(memoryStorage()) });
    const orig = { name: "X", bpm: "", key: "", tags: [], rating: 0, color: null, color2: null } as never;
    await m.replaceBeat({ beatId: "b9", expectedVersion: "3", original: orig, updated: orig, files: { wav: new File([new Uint8Array(4)], "a.wav", { type: "audio/wav" }) } });
    const second = await m.replaceBeat({ beatId: "b9", expectedVersion: "3", original: orig, updated: orig, files: { wav: new File([new Uint8Array(4)], "b.wav", { type: "audio/wav" }) } }).then((o) => o, (e: unknown) => e);
    expect(transfer.created()).toBe(1); expect((second as CatalogApiError).code).toBe("OPERATION_PENDING");
  });
});

// ---- lógica de la Gallery extraída (catalogDrawerSave.ts) contra el servidor falso de mutaciones/transferencias ----
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createCatalogTransfer } from "../../src/features/library/catalog/catalogTransfer";
import { enqueueReview, nextReview, saveDrawerChanges, summarizePendingTransfers } from "../../src/features/library/catalog/catalogDrawerSave";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";
import { beatFromCatalogDetail } from "../../src/features/library/catalog/catalogMutations";

function mutationsHarness() {
  const server = createCatalogFakeCommands({ beats: fakeBeats(5) });
  const common = { fetchImpl: server.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }) };
  const mutations = createCatalogMutations({ commands: createCatalogCommandsApi(common), transfer: createCatalogTransfer({ ...common, direct: server.directPort, sleep: async () => {}, pollIntervalMs: 1 }), accountId: () => "acc", refStore: createLocalOperationRefStore(memoryStorage()), prepareFiles: async (f) => ({ ...f, projectFlags: null }) });
  const deps = { mutations, knownDto: () => undefined, loadProject: async () => null, dataUrlToFile: () => null, errorMessage: (e: unknown) => String((e as Error)?.message ?? e) };
  return { server, mutations, deps };
}
const shownOf = async (h: ReturnType<typeof mutationsHarness>, id: string) => beatFromCatalogDetail(await h.mutations.getBeat(id), null);

describe("saveDrawerChanges (Drawer → catálogo)", () => {
  it("WAV elegido → operación REPLACE con la parte WAV, confirmada (versión del beat +1, referencia olvidada)", async () => {
    const h = mutationsHarness(); const shown = await shownOf(h, "g1");
    const r = await saveDrawerChanges(h.deps, { original: shown, updated: shown, files: { WAV: new File([new Uint8Array(32)], "hq.wav", { type: "audio/wav" }) }, artworkRemoved: false });
    expect(r.status).toBe("committed");
    expect(h.server.counters["PUT /catalog/v1/operations/:id/parts/:partKey/direct-receipt"]).toBe(1);
    // el doble no modela hasWav: se comprueba la operación (rol WAV) y la versión confirmada del beat
    const ops = h.mutations.pendingOperations(); expect(ops).toEqual([]); // confirmada → referencia olvidada
    expect(Number((await h.mutations.getBeat("g1")).version)).toBe(Number(shown.assets?.wav?.revision ?? 1) + 1);
  });
  it("sin archivos, solo metadatos (beat sin MASTER incluido) → PATCH persistido", async () => {
    const h = mutationsHarness(); const shown = await shownOf(h, "g2");
    const r = await saveDrawerChanges(h.deps, { original: shown, updated: { ...shown, bpm: "141", telegram_file_id: null }, files: {}, artworkRemoved: false });
    expect(r.status).toBe("patched"); expect((await h.mutations.getBeat("g2")).bpm).toBe("141");
  });
  it("portada quitada → UN PATCH con `artwork: null` + metadatos editados y la versión esperada; sin subir nada", async () => {
    const dto = { id: "b3", version: "7", name: "X", bpm: "90", key: "", tags: [], rating: 0, color: null, color2: null, playback: { fileId: "fm", revision: "1" }, artwork: { fileId: "fa", revision: "1" }, hasWav: false, hasProject: false, hasStems: false, hasArtwork: true, fileCount: 2, state: "ACTIVE" } as never;
    const patchBeat = vi.fn(async () => ({ status: "ok" as const, beat: null, revision: "12", noop: false, operationId: "o1", replay: false, idempotencyKey: "k" }));
    const replaceBeat = vi.fn();
    const deps = { mutations: { patchBeat, replaceBeat, getBeat: vi.fn(async () => dto) } as never, knownDto: () => dto, loadProject: async () => null, dataUrlToFile: () => null, errorMessage: (e: unknown) => String((e as Error)?.message ?? e) };
    const shown = beatFromCatalogDetail(dto, "blob:cover");
    const r = await saveDrawerChanges(deps, { original: shown, updated: { ...shown, bpm: "99", image_base64: null }, files: {}, artworkRemoved: true });
    expect(r).toEqual({ status: "patched", artworkRemoved: true });
    expect(patchBeat).toHaveBeenCalledOnce(); expect(patchBeat.mock.calls[0][0]).toEqual({ beatId: "b3", expectedVersion: "7", patch: { bpm: "99", artwork: null } });
    expect(replaceBeat).not.toHaveBeenCalled();
  });
  it("portada quitada con conflicto de versión → error, sin éxito; con error del servidor → error", async () => {
    const dto = { id: "b3", version: "7", name: "X", bpm: "90", key: "", tags: [], rating: 0, color: null, color2: null, playback: null, artwork: { fileId: "fa", revision: "1" }, hasWav: false, hasProject: false, hasStems: false, hasArtwork: true, fileCount: 1, state: "ACTIVE" } as never;
    const shown = beatFromCatalogDetail(dto, "blob:cover");
    for (const [res, re] of [[{ status: "conflict", currentVersion: "8", expectedVersion: "7", error: new CatalogApiError(409, "VERSION_CONFLICT", "x", {}) }, /cambió en otro dispositivo/], [{ status: "error", error: new Error("catálogo no disponible") }, /catálogo no disponible/]] as const) {
      const deps = { mutations: { patchBeat: vi.fn(async () => res), replaceBeat: vi.fn(), getBeat: vi.fn(async () => dto) } as never, knownDto: () => dto, loadProject: async () => null, dataUrlToFile: () => null, errorMessage: (e: unknown) => String((e as Error)?.message ?? e) };
      await expect(saveDrawerChanges(deps, { original: shown, updated: { ...shown, image_base64: null }, files: {}, artworkRemoved: true })).rejects.toThrow(re);
    }
  });
  it("portada quitada + WAV elegido → PATCH (portada+metadatos) y después REPLACE solo de archivos con la versión ya confirmada", async () => {
    const h = mutationsHarness(); const shown = { ...(await shownOf(h, "g3")), image_base64: "blob:cover" };
    const r = await saveDrawerChanges(h.deps, { original: shown, updated: { ...shown, image_base64: null }, files: { WAV: new File([new Uint8Array(16)], "hq.wav", { type: "audio/wav" }) }, artworkRemoved: true });
    expect(r).toEqual({ status: "committed", artworkRemoved: true });
    expect(h.server.counters["PATCH /catalog/v1/beats/:id"]).toBe(1); expect(h.server.counters["PUT /catalog/v1/operations/:id/parts/:partKey/direct-receipt"]).toBe(1);
  });
  it("transferencia en RECONCILE → error marcado `pending` (no éxito) y un segundo guardado no reenvía", async () => {
    const transfer = reconcileTransfer();
    const m = createCatalogMutations({ commands: {} as never, transfer: transfer as never, accountId: () => "acc", refStore: createLocalOperationRefStore(memoryStorage()) });
    const dto = { id: "b5", version: "2", name: "X", bpm: "", key: "", tags: [], rating: 0, color: null, color2: null, playback: null, artwork: null, hasWav: false, hasProject: false, hasStems: false, hasArtwork: false, fileCount: 1, state: "ACTIVE" } as never;
    const deps = { mutations: m, knownDto: () => dto, loadProject: async () => null, dataUrlToFile: () => null, errorMessage: (e: unknown) => String((e as Error)?.message ?? e) };
    const shown = beatFromCatalogDetail(dto, null);
    const e1 = await saveDrawerChanges(deps, { original: shown, updated: shown, files: { WAV: new File([new Uint8Array(4)], "a.wav", { type: "audio/wav" }) }, artworkRemoved: false }).then(() => null, (e) => e);
    expect((e1 as { pending?: boolean }).pending).toBe(true);
    const e2 = await saveDrawerChanges(deps, { original: shown, updated: shown, files: { WAV: new File([new Uint8Array(4)], "a.wav", { type: "audio/wav" }) }, artworkRemoved: false }).then(() => null, (e) => e);
    expect(String((e2 as Error).message)).toMatch(/todavía se está confirmando/); expect(transfer.created()).toBe(1);
  });
});

describe("§6.1-5 summarizePendingTransfers (subidas interrumpidas al arrancar)", () => {
  const ref = (id: string, label: string) => ({ operationId: id, kind: "IMPORT" as const, beatId: null, createdAt: 0, label });
  it("confirmada → aviso y recarga; terminada sin efecto → aviso y se olvida; abierta → aviso sin reenvío; sin respuesta → nada", () => {
    const r = summarizePendingTransfers([
      { ref: ref("a", "Importar «A»"), operation: { status: "COMMITTED" } as never, terminal: true },
      { ref: ref("b", "Importar «B»"), operation: { status: "FAILED" } as never, terminal: true },
      { ref: ref("c", "Importar «C»"), operation: { status: "RECONCILE" } as never, terminal: false },
      { ref: ref("d", "Importar «D»"), operation: null, terminal: false },
    ]);
    expect(r.refresh).toBe(true); expect(r.forget).toEqual(["b"]);
    expect(r.notice).toContain("Subida completada: «A»"); expect(r.notice).toContain("no completada (no se guardó nada; vuelve a añadirlo): «B»"); expect(r.notice).toContain("confirmándose en el servidor (no la repitas): «C»"); expect(r.notice).not.toContain("«D»");
    expect(summarizePendingTransfers([]).notice).toBeNull();
  });
  it("resolvePendingTransfers ya no trata RECONCILE como terminal", async () => {
    const transfer = reconcileTransfer();
    const m = createCatalogMutations({ commands: {} as never, transfer: transfer as never, accountId: () => "acc", refStore: createLocalOperationRefStore(memoryStorage()) });
    await m.importBeat({ beat: meta, files: { master: mp3() } });
    const list = await m.resolvePendingTransfers();
    expect(list.map((x) => [x.operation?.status, x.terminal])).toEqual([["RECONCILE", false]]);
  });
});

describe("§6.1-6 cola de revisiones", () => {
  const e = (id: string) => ({ beat: catalogBeat({ id, name: id }), hydrated: null });
  it("un fallo en segundo plano NO sustituye la revisión abierta: queda en cola y se abre al cerrarla", () => {
    let st = enqueueReview(null, [], e("A"));
    st = enqueueReview(st.current, st.queue, e("B"));
    expect(st.current.beat.id).toBe("A"); expect(st.queue.map((x) => x.beat.id)).toEqual(["B"]);
    st = enqueueReview(st.current, st.queue, e("A")); // reabrir la misma revisión la actualiza sin duplicar
    expect(st.current.beat.id).toBe("A"); expect(st.queue.length).toBe(1);
    const n = nextReview(st.queue, () => true); expect(n.next?.beat.id).toBe("B"); expect(n.queue).toEqual([]);
    expect(nextReview([e("X"), e("Y")], (id) => id === "Y").next?.beat.id).toBe("Y"); // sin archivo retenido → se omite
  });
});
