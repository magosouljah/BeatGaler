// @vitest-environment jsdom
// M3.1 — Caracterización (R3) de las secuencias de edición del catálogo Web. Fija el comportamiento ACTUAL observado desde fuera:
// peticiones al Cloud falso (método, ruta, cuerpo, cabeceras de idempotencia/versión), envíos al Puerto Direct falso, avisos, evento de
// tarjeta ocupada/completa, refrescos (listBeats) y DOM del Drawer. No nombra funciones privadas ni mira internos. Etiqueta: FAKES.
// Los fallos conocidos se fijan TAL CUAL con `// FALLO CONOCIDO (Xnn): se conserva hasta M9`.
//  S1 guardar metadatos (PATCH)             S2 guardar el Drawer (individual y lote)        S3 soltar audio
//  S4 soltar portada                        S5 papelera (tarjeta y lote; el Drawer no tiene acción de papelera)
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

const { confirmMock, pickFile } = vi.hoisted(() => ({
  confirmMock: vi.fn(async (_o: { title: string; message: string; confirmLabel?: string }) => true),
  pickFile: vi.fn(async (): Promise<File | null> => null),
}));
vi.mock("../../src/lib/dialog", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/lib/dialog")>()), appConfirm: confirmMock, appAlert: vi.fn(async () => {}) }));
vi.mock("../../src/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform")>();
  return { ...actual, platform: { ...actual.platform, editor: { ...actual.platform.editor, pickFile } } };
});
import Drawer from "../../src/components/Drawer";
import { mountEditHarness, mp3, wav, png, type EditHarness } from "../helpers/catalogEditHarness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let h: EditHarness;
let roots: Root[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); try { localStorage.clear(); } catch { /* opcional */ } confirmMock.mockReset(); confirmMock.mockResolvedValue(true); pickFile.mockReset(); });
afterEach(async () => { vi.restoreAllMocks(); for (const r of roots) act(() => r.unmount()); roots = []; document.body.innerHTML = ""; await h?.teardown(); vi.useRealTimers(); });

type Kind = "success" | "uncertain" | "blocked" | "timeout" | "conflict";
const mountFor = (kind: Kind, extra: { legacyKey?: boolean } = {}) => mountEditHarness({ transferVerifyAfterPolls: kind === "blocked" ? 99 : kind === "timeout" ? 1e9 : undefined, ...extra });
/** Programa el resultado de una transferencia REPLACE en los dobles (sin tocar src/). */
function arm(kind: Kind, beatId: string) {
  if (kind === "uncertain") h.server.directState.faults.push("uncertain");
  if (kind === "blocked") h.server.setFailure({ route: /\/commit$/, status: 409, code: "VERSION_CONFLICT" }); // commit rechazado y la operación sigue en VERIFYING → RECONCILE
  if (kind === "conflict") { let once = false; h.onRequest((r) => { if (!once && r.method === "POST" && /\/commit$/.test(r.path)) { once = true; h.server.externalEdit(beatId); } }); } // otra sesión edita antes del commit
}
const settle = async (steps = 6, stepMs = 1500) => { for (let i = 0; i < steps; i++) await act(async () => { await vi.advanceTimersByTimeAsync(stepMs); }); };
const sig = (reqs: Array<{ method: string; path: string }>) => reqs.map((r) => `${r.method} ${r.path.replace(/top-\d+/, "top-N").replace(/op-\d+/, "op-N").replace(/sel-\d+/, "sel-N").replace(/set-\d+/, "set-N")}`);
const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };

/** Drawer montado con la capacidad de guardado de `CatalogAppShell`. */
async function openDrawer(ids: string[], props: Omit<Partial<React.ComponentProps<typeof Drawer>>, "onSaved"> & {
  saveReview?: React.ComponentProps<typeof Drawer>["onSaved"];
} = {}) {
  const sc = () => h.scope();
  for (const id of ids.length > 1 ? ids : []) await act(async () => { sc().toggleSelection(sc().toBeat(h.dto(id)), false); });
  const beat = sc().toBeat(h.dto(ids[0]));
  const selected = ids.length > 1 ? sc().selectedBeats : undefined;
  const onClose = vi.fn(); const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); roots.push(root);
  const { saveReview, ...drawerProps } = props;
  await act(async () => { root.render(<Drawer beat={beat} mode="edit" onClose={onClose} onReleaseAudio={() => {}} tagSuggestions={[]}
    selectedBeats={selected} mutationAllowed onWebSave={(request) => request.kind === "review" && saveReview
      ? saveReview(request.updated, request.onProgress)
      : sc().saveWebDrawer(request)} {...drawerProps} />); });
  const buttons = () => Array.from(host.querySelectorAll("button"));
  const find = (re: RegExp) => buttons().find((b) => re.test(b.textContent?.trim() ?? ""));
  return {
    host, onClose, text: () => host.textContent ?? "",
    bpm: () => host.querySelector('input[inputmode="decimal"]') as HTMLInputElement,
    async pickRow(slot: "MASTER" | "WAV" | "PROJECT", file: File, label: string) {
      pickFile.mockResolvedValueOnce(file);
      const row = buttons().filter((b) => b.textContent?.trim() === label || b.textContent?.trim() === "Replace").find((b) => b.parentElement?.textContent?.startsWith(slot))!;
      await act(async () => { row.click(); });
    },
    async addTag(tag: string) { const input = host.querySelector('input[placeholder^="Add tag"]') as HTMLInputElement; await act(async () => { setValue(input, tag); }); await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }); },
    async check(field: RegExp) { const label = Array.from(host.querySelectorAll("label")).find((l) => field.test(l.textContent ?? ""))!; await act(async () => { (label.querySelector("input") as HTMLInputElement).click(); }); },
    async click(label: string) {
      const button = buttons().find((b) => b.textContent?.trim() === label)!;
      await act(async () => { button.click(); });
    },
    async save(steps = 6) { const b = find(/^(Save changes|Apply to)/)!; await act(async () => { b.click(); }); await settle(steps); },
  };
}

describe("M3.2b · guardar desde el Drawer Web", () => {
  it.each(["add", "replace", "remove"] as const)("lote %s: aplica el modo elegido en una operación", async (mode) => {
    h = await mountFor("success");
    const d = await openDrawer(["g0", "g1"], {
      selectedBeats: ["g0", "g1"].map((id) => ({ ...h.scope().toBeat(h.dto(id)), tags: ["shared"] })),
    });
    await d.check(/TAGS/);
    if (mode === "remove") {
      await d.click("Remove tags");
      await d.click("shared");
    } else {
      if (mode === "replace") await d.click("Replace tags");
      await d.addTag("Rock");
    }
    const m = h.mark();
    if (mode === "remove") {
      await d.click("Remove 1 tag from 2 beats");
      await settle();
    } else {
      await d.save();
    }
    const operations = h.writes(m).filter((r) => r.path === "/catalog/v1/operations");
    expect(operations).toHaveLength(1);
    expect(operations[0].body.kind).toBe("BULK_PATCH");
    expect(operations[0].body.patch).toEqual(mode === "replace" ? { tags: ["rock"] } : {});
    expect(operations[0].body.tagsOp).toEqual(mode === "replace" ? undefined : { op: mode, tags: [mode === "remove" ? "shared" : "rock"] });
    expect(d.onClose).toHaveBeenCalledOnce();
  });

  it("quita la portada desde el Drawer antes de reemplazar el archivo", async () => {
    h = await mountFor("success");
    const beat = h.scope().toBeat(h.dto("g0"));
    const d = await openDrawer(["g0"], { beat: { ...beat, image_base64: "data:image/png;base64,AAAA" } });
    await d.click("Remove");
    await d.pickRow("MASTER", mp3(), "Replace");
    const m = h.mark();
    await d.save();
    const writes = h.writes(m);
    expect(writes[0]).toMatchObject({ method: "PATCH", path: "/catalog/v1/beats/g0", body: { expectedVersion: "1", patch: { artwork: null } } });
    const operations = writes.filter((r) => r.path === "/catalog/v1/operations");
    expect(operations).toHaveLength(1);
    expect(operations[0].body).toMatchObject({ kind: "REPLACE", expectedVersion: "2" });
    expect(h.server.directSent).toHaveLength(1);
    expect(d.onClose).toHaveBeenCalledOnce();
  });

  it("en revisión de importación espera el guardado antes de cerrar", async () => {
    h = await mountFor("success");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onSaved = vi.fn(() => pending);
    const d = await openDrawer(["g0"], { reviewInfo: { current: 1, total: 1 }, saveReview: onSaved });
    await d.click("Save and finish");
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "g0", cloud_status: "PENDING_UPLOAD" }), expect.any(Function));
    expect(d.onClose).not.toHaveBeenCalled();
    await act(async () => { finish(); await pending; });
    expect(d.onClose).toHaveBeenCalledOnce();
  });
});

// ============================================================================================================
describe("S1 · guardar metadatos desde el Drawer (PATCH con expectedVersion y clave de idempotencia)", () => {
  it("éxito: un PATCH con expectedVersion de la tarjeta, clave de idempotencia, solo los campos cambiados; el Drawer se cierra y la biblioteca se refresca", async () => {
    h = await mountFor("success"); const d = await openDrawer(["g0"]); const m = h.mark(); const r0 = h.refreshes();
    await act(async () => { setValue(d.bpm(), "140"); }); await d.save();
    const w = h.writes(m);
    expect(sig(w)).toEqual(["PATCH /catalog/v1/beats/g0"]);
    expect(w[0].body).toEqual({ expectedVersion: "1", patch: { bpm: "140" } });
    expect(w[0].headers["Idempotency-Key"]).toMatch(/\S{8,}/);
    expect(w[0].headers["X-Catalog-Era"]).toBe("era-fake"); expect(w[0].headers["X-Catalog-Epoch"]).toBe("1");
    expect(h.server.beats.get("g0")!.bpm).toBe("140"); expect(h.server.beats.get("g0")!.version).toBe(2);
    expect(d.onClose).toHaveBeenCalledOnce(); expect(h.refreshes() - r0).toBe(1);
  });
  it("cada guardado lleva su propia clave de idempotencia (dos beats, dos claves distintas)", async () => {
    h = await mountFor("success"); const keys: string[] = [];
    for (const id of ["g0", "g1"]) { const d = await openDrawer([id]); const m = h.mark(); await act(async () => { setValue(d.bpm(), "150"); }); await d.save(); keys.push(h.writes(m)[0].headers["Idempotency-Key"]); }
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("sin cambios: no se emite ninguna petición de escritura y el Drawer se cierra", async () => {
    h = await mountFor("success"); const d = await openDrawer(["g0"]); const m = h.mark();
    await d.save();
    expect(h.writes(m)).toEqual([]); expect(d.onClose).toHaveBeenCalledOnce();
  });
  it("tonalidad heredada «Cm»: el Drawer la normaliza a «cm» y un guardado sin cambios del usuario emite igualmente un PATCH {key:\"cm\"} (comportamiento observado)", async () => {
    h = await mountFor("success", { legacyKey: true }); const d = await openDrawer(["g0"]); const m = h.mark();
    await d.save();
    expect(h.writes(m).map((r) => [r.method, r.body])).toEqual([["PATCH", { expectedVersion: "1", patch: { key: "cm" } }]]);
  });
  it("conflicto de versión (otra sesión editó antes): un solo PATCH, sin reintento automático, el Drawer queda abierto con el aviso y sin refresco", async () => {
    h = await mountFor("success"); const d = await openDrawer(["g0"]); h.server.externalEdit("g0"); const m = h.mark(); const r0 = h.refreshes();
    await act(async () => { setValue(d.bpm(), "140"); }); await d.save();
    expect(sig(h.writes(m))).toEqual(["PATCH /catalog/v1/beats/g0"]); expect(h.writes(m)[0].body.expectedVersion).toBe("1");
    expect(d.text()).toContain("Este beat cambió en otro dispositivo. Tus cambios siguen aquí: revisa y vuelve a guardar.");
    expect(d.onClose).not.toHaveBeenCalled(); expect(h.refreshes() - r0).toBe(0);
    expect(h.server.beats.get("g0")!.bpm).not.toBe("140");
  });
  it("error del servidor (503): un solo PATCH, el Drawer sigue abierto con el error, sin refresco", async () => {
    h = await mountFor("success"); const d = await openDrawer(["g0"]); const m = h.mark(); const r0 = h.refreshes();
    h.server.setFailure({ route: /\/beats\/g0$/, status: 503, code: "UNAVAILABLE" });
    await act(async () => { setValue(d.bpm(), "140"); }); await d.save();
    expect(sig(h.writes(m))).toEqual(["PATCH /catalog/v1/beats/g0"]);
    expect(d.text()).toContain("fake UNAVAILABLE"); expect(d.onClose).not.toHaveBeenCalled(); expect(h.refreshes() - r0).toBe(0);
  });
  // incierto / bloqueado / agotado: NO APLICAN a S1. Un PATCH metadata-only es una sola petición idempotente: el cliente lo reduce a ok | conflict | error.
});

// ============================================================================================================
describe("S2 · guardar el Drawer con archivos (REPLACE) — éxito / incierto / bloqueado / agotado / conflicto", () => {
  const PENDING = "La subida de «Beat 0» sigue confirmándose en el servidor. No se reenvía ni se borra nada: el beat aparecerá si se recibió; si no, se te avisará.";
  it("éxito: UNA operación REPLACE con expectedVersion, el archivo viaja por el Puerto Direct (nunca por el Cloud), el Drawer se cierra y se refresca", async () => {
    h = await mountFor("success"); const d = await openDrawer(["g0"]); const m = h.mark(); const r0 = h.refreshes();
    await d.pickRow("MASTER", mp3(), "Replace"); await d.save();
    const w = h.writes(m);
    expect(w.filter((r) => r.path === "/catalog/v1/operations")).toHaveLength(1);
    const op = w.find((r) => r.path === "/catalog/v1/operations")!;
    expect(op.body).toMatchObject({ kind: "REPLACE", beatId: "g0", expectedVersion: "1", metadata: null }); expect(op.body.parts.map((p: { role: string }) => p.role)).toEqual(["MASTER"]);
    expect(op.headers["Idempotency-Key"]).toBeTruthy();
    expect(h.server.directSent).toHaveLength(1);
    expect(d.onClose).toHaveBeenCalledOnce(); expect(h.refreshes() - r0).toBe(1);
  });
  it.each<[Kind]>([["uncertain"], ["blocked"], ["timeout"]])("%s: se lanza el aviso «pendiente, no reenviar» (el Drawer queda abierto con su archivo pendiente) Y se refresca", async (kind) => {
    h = await mountFor(kind); arm(kind, "g0"); const d = await openDrawer(["g0"]); const r0 = h.refreshes();
    await d.pickRow("MASTER", mp3(), "Replace"); await d.save(kind === "timeout" ? 420 : 6);
    expect(d.text()).toContain(PENDING); expect(d.text()).toContain("Pending: new.mp3"); expect(d.onClose).not.toHaveBeenCalled();
    expect(h.refreshes() - r0).toBe(1); // el pendiente del Drawer SÍ refresca (contraste con X04 en S3/S4)
    expect(h.server.directSent).toHaveLength(1);
  });
  it("conflicto de versión al confirmar: aviso de conflicto, el Drawer queda abierto, sin refresco", async () => {
    h = await mountFor("conflict"); arm("conflict", "g0"); const d = await openDrawer(["g0"]); const r0 = h.refreshes();
    await d.pickRow("MASTER", mp3(), "Replace"); await d.save();
    expect(d.text()).toContain("Este beat cambió en otro dispositivo. Tus cambios siguen aquí: revisa y vuelve a guardar."); expect(d.onClose).not.toHaveBeenCalled(); expect(h.refreshes() - r0).toBe(0);
  });
  it.each<[Kind]>([["uncertain"], ["blocked"], ["timeout"]])("tras %s, guardar otra vez NO reenvía: cero operaciones nuevas y cero bytes nuevos (C7.8); aviso de subida anterior sin refresco", async (kind) => {
    h = await mountFor(kind); arm(kind, "g0"); const d = await openDrawer(["g0"]);
    await d.pickRow("MASTER", mp3(), "Replace"); await d.save(kind === "timeout" ? 420 : 6);
    const m = h.mark(); const sent = h.server.directSent.length; const r0 = h.refreshes();
    await d.save();
    expect(h.writes(m).filter((r) => r.path === "/catalog/v1/operations")).toEqual([]); expect(h.server.directSent).toHaveLength(sent);
    expect(d.text()).toContain("Una subida anterior de este beat todavía se está confirmando en el servidor."); expect(d.onClose).not.toHaveBeenCalled(); expect(h.refreshes() - r0).toBe(0);
  });
  it("tras un conflicto, guardar otra vez crea una operación nueva (la anterior terminó sin efecto) pero con la versión vieja de la tarjeta: vuelve a chocar", async () => {
    h = await mountFor("conflict"); arm("conflict", "g0"); const d = await openDrawer(["g0"]);
    await d.pickRow("MASTER", mp3(), "Replace"); await d.save();
    const m = h.mark(); await d.save();
    const op = h.writes(m).filter((r) => r.path === "/catalog/v1/operations");
    expect(op).toHaveLength(1); expect(op[0].body.expectedVersion).toBe("1"); // el Drawer reutiliza la versión de la tarjeta: vuelve a chocar
    // El conflicto se detecta ahora al CREAR la operación: el error llega crudo del servidor (sin el texto amable del commit). Se conserva tal cual.
    expect(d.text()).toContain("Error: version"); expect(d.onClose).not.toHaveBeenCalled();
  });
  it("quitar portada + archivo en el mismo guardado: dos pasos (PATCH artwork:null con expectedVersion y luego REPLACE con la versión confirmada)", async () => {
    h = await mountFor("success"); const sc = h.scope(); const beat = sc.toBeat(h.dto("g0")); const m = h.mark();
    await h.drive(sc.saveDrawerToCatalog({ original: { ...beat, image_base64: "data:image/png;base64,AAAA" }, updated: { ...beat, image_base64: null }, files: { MASTER: mp3() }, artworkRemoved: true }));
    const w = h.writes(m);
    expect(w[0]).toMatchObject({ method: "PATCH", path: "/catalog/v1/beats/g0", body: { expectedVersion: "1", patch: { artwork: null } } });
    const op = w.find((r) => r.path === "/catalog/v1/operations")!; expect(op.body).toMatchObject({ kind: "REPLACE", expectedVersion: "2" });
    expect(sig(h.since(m)).indexOf("GET /catalog/v1/beats/g0")).toBeGreaterThan(sig(h.since(m)).indexOf("PATCH /catalog/v1/beats/g0")); // relee el detalle entre pasos
  });
  it("quitar portada sin archivos: un solo PATCH con artwork:null", async () => {
    h = await mountFor("success"); const sc = h.scope(); const beat = sc.toBeat(h.dto("g0")); const m = h.mark();
    await h.drive(sc.saveDrawerToCatalog({ original: { ...beat, image_base64: "data:image/png;base64,AAAA" }, updated: { ...beat, image_base64: null }, files: {}, artworkRemoved: true }));
    expect(h.writes(m).map((r) => [r.method, r.body])).toEqual([["PATCH", { expectedVersion: "1", patch: { artwork: null } }]]);
  });
  // FALLO CONOCIDO (X03): se conserva hasta M9. La vía `commitDrawerCloudMutation` (solo la alcanza el Drawer en Desktop) da un error genérico y NO refresca ante incierto;
  // `createBeatEditor().saveDrawer` (la vía Web) da el aviso «pendiente» y refresca. Se fija la vía genérica llamándola como lo hace el Drawer.
  it("X03 · commitDrawerCloudMutation ante incierto: error genérico «La operación quedó en estado uncertain…», sin refresco", async () => {
    h = await mountFor("uncertain"); arm("uncertain", "g0"); const sc = h.scope(); const beat = sc.toBeat(h.dto("g0")); const r0 = h.refreshes();
    const err = await h.drive(sc.commitDrawerCloudMutation({ ...beat, image_base64: "data:image/png;base64,iVBORw0KGgo=" }).then(() => null, (e: Error) => e));
    expect(err?.message).toBe("La operación quedó en estado uncertain; el servidor conserva el resultado."); expect(h.refreshes() - r0).toBe(0);
  });
});

describe("S2 · guardado en lote del Drawer (varios beats seleccionados)", () => {
  it("añadir tags: UNA operación BULK_PATCH sobre la selección con tagsOp add; aviso con el recuento y refresco", async () => {
    h = await mountFor("success"); const d = await openDrawer(["g0", "g1"]);
    await d.check(/TAGS/); await d.addTag("rock"); const m = h.mark(); const r0 = h.refreshes(); await d.save();
    const op = h.writes(m).find((r) => r.path === "/catalog/v1/operations")!;
    expect(op.body).toMatchObject({ kind: "BULK_PATCH", tagsOp: { op: "add", tags: ["rock"] } }); expect(op.body.patch).toEqual({});
    expect(op.headers["Idempotency-Key"]).toBeTruthy();
    expect(h.scope().notice).toBe("Edición en lote: 2/2 confirmados."); expect(h.refreshes() - r0).toBeGreaterThanOrEqual(1); expect(d.onClose).toHaveBeenCalledOnce();
    expect(h.server.beats.get("g0")!.tags).toContain("rock"); expect(h.server.beats.get("g1")!.tags).toContain("rock");
  });
  it("X06 · desde la interfaz del Drawer el tag escrito con mayúsculas llega en minúsculas tanto en lote como individual", async () => {
    h = await mountFor("success");
    const bulk = await openDrawer(["g0", "g1"]); await bulk.check(/TAGS/); await bulk.addTag("Rock"); const m = h.mark(); await bulk.save();
    expect(h.writes(m).find((r) => r.path === "/catalog/v1/operations")!.body.tagsOp.tags).toEqual(["rock"]);
    const one = await openDrawer(["g2"]); await one.addTag("Rock"); const m2 = h.mark(); await one.save();
    expect(h.writes(m2)[0].body.patch.tags).toContain("rock"); expect(h.writes(m2)[0].body.patch.tags).not.toContain("Rock");
  });
  // FALLO CONOCIDO (X06): se conserva hasta M9. Por debajo del Drawer las dos vías NO coinciden: el lote normaliza a minúsculas en el cliente
  // (Drawer.tsx, rama isBulk) pero `applyBulkUpdate` en sí envía lo que recibe, y el guardado individual (`saveDrawerToCatalog`) tampoco normaliza.
  it("X06 · por debajo del Drawer: applyBulkUpdate y saveDrawerToCatalog envían los tags tal cual, sin pasar a minúsculas", async () => {
    h = await mountFor("success"); const sc = h.scope(); const beat = sc.toBeat(h.dto("g0"));
    await h.drive(sc.saveDrawerToCatalog({ original: beat, updated: { ...beat, tags: ["Rock"] }, files: {}, artworkRemoved: false }));
    expect(h.writes()[h.writes().length - 1].body.patch.tags).toEqual(["Rock"]);
    await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g1")), false); }); await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g2")), false); });
    const m = h.mark(); await act(async () => { h.scope().applyBulkUpdate({ tags: ["Rock"] }, { tagsMode: "add" }); }); await settle();
    expect(h.writes(m).find((r) => r.path === "/catalog/v1/operations")!.body.tagsOp).toEqual({ op: "add", tags: ["Rock"] });
  });
  it("reemplazar tags en lote viaja como patch.tags (no como tagsOp)", async () => {
    h = await mountFor("success"); await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g0")), false); }); await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g1")), false); });
    const m = h.mark(); await act(async () => { h.scope().applyBulkUpdate({ tags: ["x1"] }, { tagsMode: "replace" }); }); await settle();
    const body = h.writes(m).find((r) => r.path === "/catalog/v1/operations")!.body; expect(body.patch).toEqual({ tags: ["x1"] }); expect(body.tagsOp).toBeUndefined();
  });
  it("modo de tags no soportado: aviso y ninguna petición de escritura", async () => {
    h = await mountFor("success"); await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g0")), false); }); const m = h.mark();
    await act(async () => { h.scope().applyBulkUpdate({ tags: ["x"] }, { tagsMode: "bogus" as unknown as "add" }); }); await settle(2);
    expect(h.scope().notice).toBe("En el catálogo, «añadir» o «quitar» tags en lote aún no está disponible: usa «reemplazar»."); expect(h.writes(m)).toEqual([]);
  });
  it("conflicto (la biblioteca cambió tras seleccionar): el lote no se aplica y el aviso lo cuenta", async () => {
    h = await mountFor("success"); await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g0")), false); }); await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g1")), false); });
    h.server.externalEdit("g3"); await act(async () => { h.scope().applyBulkUpdate({ rating: 4 }); }); await settle();
    expect(h.server.beats.get("g0")!.rating).not.toBe(4); expect(h.scope().notice).toMatch(/SELECTION_CONFLICT|library revision changed|conflict/i);
  });
});

// ============================================================================================================
describe("S3 · reemplazar audio soltando un archivo sobre la tarjeta", () => {
  const PEND = "No se pudo reemplazar el audio: El reemplazo sigue confirmándose en el servidor; no lo repitas. El archivo se actualizará si se recibió.";
  it("éxito: confirma antes de tocar nada; REPLACE con expectedVersion; tarjeta ocupada → completada; aviso y refresco", async () => {
    h = await mountFor("success"); const m = h.mark(); const r0 = h.refreshes();
    await h.drive(h.scope().replaceAudioByDrop("g0", mp3()));
    expect(confirmMock).toHaveBeenCalledOnce(); expect(confirmMock.mock.calls[0][0].title).toBe("Replace MP3?");
    const w = h.writes(m); const op = w.find((r) => r.path === "/catalog/v1/operations")!;
    expect(op.body).toMatchObject({ kind: "REPLACE", beatId: "g0", expectedVersion: "1", metadata: null }); expect(op.headers["Idempotency-Key"]).toBeTruthy();
    expect(h.server.directSent).toHaveLength(1);
    expect(h.busy).toEqual([{ beatId: "g0", active: true, success: false }, { beatId: "g0", active: false, success: true }]);
    expect(h.scope().notice).toBe("MP3 reemplazado."); expect(h.refreshes() - r0).toBe(1);
  });
  it("WAV nuevo: «Add WAV?», parte WAV, aviso «WAV añadido.»", async () => {
    h = await mountFor("success"); const m = h.mark();
    await h.drive(h.scope().replaceAudioByDrop("g0", wav()));
    expect(confirmMock.mock.calls[0][0].title).toBe("Add WAV?");
    expect(h.writes(m).find((r) => r.path === "/catalog/v1/operations")!.body.parts.map((p: { role: string }) => p.role)).toEqual(["WAV"]); expect(h.scope().notice).toBe("WAV añadido.");
  });
  it("cancelar la confirmación: no hay escrituras, la tarjeta no se marca ocupada, sin aviso", async () => {
    h = await mountFor("success"); confirmMock.mockResolvedValueOnce(false); const m = h.mark(); const r0 = h.refreshes();
    await h.drive(h.scope().replaceAudioByDrop("g0", mp3()));
    expect(h.writes(m)).toEqual([]); expect(h.busy).toEqual([]); expect(h.scope().notice).toBeNull(); expect(h.refreshes() - r0).toBe(0);
  });
  it("archivo no soportado: aviso y ni siquiera se lee el beat", async () => {
    h = await mountFor("success"); const m = h.mark();
    await h.drive(h.scope().replaceAudioByDrop("g0", new File(["x"], "nota.txt", { type: "text/plain" })));
    expect(h.since(m)).toEqual([]); expect(confirmMock).not.toHaveBeenCalled(); expect(h.busy).toEqual([]); expect(h.scope().notice).toBe("Solo se pueden soltar archivos MP3 o WAV.");
  });
  // FALLO CONOCIDO (X04): se conserva hasta M9. «Pendiente» (incierto/bloqueado/agotado): el aviso dice que se actualizará si se recibió, pero la tarjeta
  // termina como NO completada y la biblioteca NO se refresca (el Drawer y la importación sí refrescan en pendiente).
  it.each<[Kind]>([["uncertain"], ["blocked"], ["timeout"]])("X04 · %s: aviso «no lo repitas», tarjeta NO completada y SIN refresco", async (kind) => {
    h = await mountFor(kind); arm(kind, "g0"); const r0 = h.refreshes();
    await h.drive(h.scope().replaceAudioByDrop("g0", mp3()), 1500, 500);
    expect(h.scope().notice).toBe(PEND); expect(h.busy).toEqual([{ beatId: "g0", active: true, success: false }, { beatId: "g0", active: false, success: false }]);
    expect(h.refreshes() - r0).toBe(0); expect(h.server.directSent).toHaveLength(1);
  });
  it("conflicto de versión al confirmar: «Este beat cambió en otro dispositivo; no se reemplazó nada», tarjeta no completada, sin refresco", async () => {
    h = await mountFor("conflict"); arm("conflict", "g0"); const r0 = h.refreshes();
    await h.drive(h.scope().replaceAudioByDrop("g0", mp3()));
    expect(h.scope().notice).toBe("No se pudo reemplazar el audio: Este beat cambió en otro dispositivo; no se reemplazó nada. Vuelve a intentarlo.");
    expect(h.busy.at(-1)).toEqual({ beatId: "g0", active: false, success: false }); expect(h.refreshes() - r0).toBe(0);
  });
  it("conflicto al CREAR la operación (versión ya vieja): el error llega como aviso de fallo, sin bytes enviados", async () => {
    h = await mountFor("success"); confirmMock.mockImplementationOnce(async () => { h.server.externalEdit("g0"); return true; }); // la otra sesión edita entre leer el beat y confirmar
    await h.drive(h.scope().replaceAudioByDrop("g0", mp3()));
    expect(h.scope().notice).toMatch(/^No se pudo reemplazar el audio: /); expect(h.server.directSent).toHaveLength(0); expect(h.busy.at(-1)).toEqual({ beatId: "g0", active: false, success: false });
  });
  it.each<[Kind]>([["uncertain"], ["blocked"], ["timeout"]])("tras %s, soltar otra vez NO reenvía (C7.8): cero operaciones y cero bytes nuevos, aviso de subida anterior", async (kind) => {
    h = await mountFor(kind); arm(kind, "g0");
    await h.drive(h.scope().replaceAudioByDrop("g0", mp3()), 1500, 500);
    const m = h.mark(); const sent = h.server.directSent.length;
    await h.drive(h.scope().replaceAudioByDrop("g0", mp3("otra.mp3")));
    expect(h.writes(m).filter((r) => r.method === "POST")).toEqual([]); expect(h.server.directSent).toHaveLength(sent);
    expect(h.scope().notice).toBe("No se pudo reemplazar el audio: Una subida anterior de este beat todavía se está confirmando en el servidor. No se vuelve a enviar para no duplicarla: espera a que termine (el beat aparecerá si se recibió).");
  });
  it("tras un conflicto, soltar otra vez procede con la versión releída (la operación anterior terminó sin efecto)", async () => {
    h = await mountFor("conflict"); arm("conflict", "g0");
    await h.drive(h.scope().replaceAudioByDrop("g0", mp3()));
    const m = h.mark(); await h.drive(h.scope().replaceAudioByDrop("g0", mp3()));
    const op = h.writes(m).find((r) => r.path === "/catalog/v1/operations")!; expect(op.body.expectedVersion).toBe("2"); expect(h.scope().notice).toBe("MP3 reemplazado.");
  });
});

// ============================================================================================================
describe("S4 · reemplazar portada soltando una imagen sobre la tarjeta", () => {
  const src = (f: File) => [{ kind: "file" as const, file: f }];
  const PEND = "No se pudo cambiar la portada: El cambio sigue confirmándose en el servidor; no lo repitas. La portada se actualizará si se recibió.";
  it("éxito: sin confirmación; tarjeta ocupada desde el inicio → completada; REPLACE solo con la parte ARTWORK; aviso y refresco", async () => {
    h = await mountFor("success"); const m = h.mark(); const r0 = h.refreshes();
    await h.drive(h.scope().replaceArtworkByDrop("g0", src(png())));
    expect(confirmMock).not.toHaveBeenCalled();
    const op = h.writes(m).find((r) => r.path === "/catalog/v1/operations")!; expect(op.body).toMatchObject({ kind: "REPLACE", beatId: "g0", expectedVersion: "1", metadata: null }); expect(op.body.parts.map((p: { role: string }) => p.role)).toEqual(["ARTWORK"]);
    expect(h.busy).toEqual([{ beatId: "g0", active: true, success: false }, { beatId: "g0", active: false, success: true }]);
    expect(h.scope().notice).toBe("Portada actualizada."); expect(h.refreshes() - r0).toBe(1); expect(h.server.directSent).toHaveLength(1);
  });
  it("sin imagen utilizable: aviso con el motivo, tarjeta ocupada → no completada, ninguna petición", async () => {
    h = await mountFor("success"); const m = h.mark();
    await h.drive(h.scope().replaceArtworkByDrop("g0", src(new File(["x"], "a.txt", { type: "text/plain" }))));
    expect(h.since(m)).toEqual([]); expect(h.scope().notice).toBe("No se pudo cambiar la portada: file: formato de imagen no compatible");
    expect(h.busy).toEqual([{ beatId: "g0", active: true, success: false }, { beatId: "g0", active: false, success: false }]);
  });
  // FALLO CONOCIDO (X04): se conserva hasta M9 (misma regla que S3: pendiente ⇒ tarjeta no completada y sin refresco).
  it.each<[Kind]>([["uncertain"], ["blocked"], ["timeout"]])("X04 · %s: aviso «no lo repitas», tarjeta NO completada y SIN refresco", async (kind) => {
    h = await mountFor(kind); arm(kind, "g0"); const r0 = h.refreshes();
    await h.drive(h.scope().replaceArtworkByDrop("g0", src(png())), 1500, 500);
    expect(h.scope().notice).toBe(PEND); expect(h.busy.at(-1)).toEqual({ beatId: "g0", active: false, success: false }); expect(h.refreshes() - r0).toBe(0); expect(h.server.directSent).toHaveLength(1);
  });
  it("conflicto de versión al confirmar: «la portada no se cambió», tarjeta no completada, sin refresco", async () => {
    h = await mountFor("conflict"); arm("conflict", "g0"); const r0 = h.refreshes();
    await h.drive(h.scope().replaceArtworkByDrop("g0", src(png())));
    expect(h.scope().notice).toBe("No se pudo cambiar la portada: Este beat cambió en otro dispositivo; la portada no se cambió. Vuelve a intentarlo."); expect(h.busy.at(-1)?.success).toBe(false); expect(h.refreshes() - r0).toBe(0);
  });
  it.each<[Kind]>([["uncertain"], ["blocked"], ["timeout"]])("tras %s, soltar otra imagen NO reenvía (C7.8)", async (kind) => {
    h = await mountFor(kind); arm(kind, "g0");
    await h.drive(h.scope().replaceArtworkByDrop("g0", src(png())), 1500, 500);
    const m = h.mark(); const sent = h.server.directSent.length;
    await h.drive(h.scope().replaceArtworkByDrop("g0", src(png("otra.png"))));
    expect(h.writes(m).filter((r) => r.method === "POST")).toEqual([]); expect(h.server.directSent).toHaveLength(sent);
    expect(h.scope().notice).toContain("Una subida anterior de este beat todavía se está confirmando en el servidor.");
  });
  it("la primera fuente inutilizable no impide usar la siguiente", async () => {
    h = await mountFor("success"); const m = h.mark();
    await h.drive(h.scope().replaceArtworkByDrop("g0", [{ kind: "file", file: new File(["x"], "a.txt", { type: "text/plain" }) }, { kind: "file", file: png() }]));
    expect(h.writes(m).find((r) => r.path === "/catalog/v1/operations")!.body.parts[0].role).toBe("ARTWORK"); expect(h.scope().notice).toBe("Portada actualizada.");
  });
});

// ============================================================================================================
describe("S5 · papelera (tarjeta y lote; el Drawer del catálogo no tiene acción de papelera)", () => {
  it("tarjeta · éxito: POST /beats/trash con expectedVersion e idempotencia; refresca; sin aviso", async () => {
    h = await mountFor("success"); const beat = h.scope().toBeat(h.dto("g0")); const m = h.mark(); const r0 = h.refreshes();
    await act(async () => { h.scope().deleteBeat(beat); }); await settle(2);
    const w = h.writes(m); expect(sig(w)).toEqual(["POST /catalog/v1/beats/trash"]);
    expect(w[0].body).toEqual({ items: [{ beatId: "g0", expectedVersion: "1" }] }); expect(w[0].headers["Idempotency-Key"]).toMatch(/\S{8,}/);
    expect(h.server.beats.get("g0")!.state).toBe("TRASH"); expect(h.refreshes() - r0).toBe(1); expect(h.scope().notice).toBeNull();
  });
  it("tarjeta · conflicto de versión: nada se aplica, aviso de «la biblioteca cambió» y refresca igualmente; un solo intento", async () => {
    h = await mountFor("success"); const beat = h.scope().toBeat(h.dto("g0")); h.server.externalEdit("g0"); const m = h.mark(); const r0 = h.refreshes();
    await act(async () => { h.scope().deleteBeat(beat); }); await settle(2);
    expect(sig(h.writes(m))).toEqual(["POST /catalog/v1/beats/trash"]); expect(h.server.beats.get("g0")!.state).toBe("ACTIVE");
    expect(h.scope().notice).toBe("La biblioteca cambió en otro dispositivo; revisa antes de borrar."); expect(h.refreshes() - r0).toBe(1);
  });
  it("tarjeta · cualquier error de API (503) se presenta con el MISMO aviso de conflicto (se conserva tal cual)", async () => {
    h = await mountFor("success"); const beat = h.scope().toBeat(h.dto("g0")); h.server.setFailure({ route: /\/beats\/trash$/, status: 503, code: "UNAVAILABLE" });
    await act(async () => { h.scope().deleteBeat(beat); }); await settle(2);
    expect(h.scope().notice).toBe("La biblioteca cambió en otro dispositivo; revisa antes de borrar."); expect(h.server.beats.get("g0")!.state).toBe("ACTIVE");
  });
  it("tarjeta · beat desconocido para la ventana: no se emite nada", async () => {
    h = await mountFor("success"); const m = h.mark();
    await act(async () => { h.scope().deleteBeat({ ...h.scope().toBeat(h.dto("g0")), id: "no-existe" }); }); await settle(2);
    expect(h.writes(m)).toEqual([]);
  });
  it("lote · éxito: BULK_TRASH sobre la selección; aviso con recuento y refresco", async () => {
    h = await mountFor("success"); await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g0")), false); }); await act(async () => { h.scope().toggleSelection(h.scope().toBeat(h.dto("g1")), false); });
    const m = h.mark(); const r0 = h.refreshes(); await act(async () => { h.scope().handleRemoveBulk(); }); await settle();
    const op = h.writes(m).find((r) => r.path === "/catalog/v1/operations")!; expect(op.body.kind).toBe("BULK_TRASH"); expect(op.headers["Idempotency-Key"]).toBeTruthy();
    expect(h.scope().notice).toBe("Papelera en lote: 2/2 confirmados."); expect(h.refreshes() - r0).toBeGreaterThanOrEqual(1);
    expect(h.server.beats.get("g0")!.state).toBe("TRASH"); expect(h.server.beats.get("g1")!.state).toBe("TRASH");
  });
});
