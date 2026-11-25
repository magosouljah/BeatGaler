// @vitest-environment jsdom
// M3.1b — Caracterización (R3) de la Sesión de importación del catálogo Web («Add beat» → revisión → «Save and finish»). Fija el comportamiento
// ACTUAL observado desde fuera: peticiones al Cloud falso (intents/reservas/recibos/commit, cuerpos, claves de idempotencia), envíos y orden
// frente al Puerto Direct falso, avisos, tarjeta de subida (`pendingCards`/`uploads`), evento de tarjeta ocupada y refrescos (listBeats).
// No nombra funciones privadas. Etiqueta: FAKES (ni Telegram, ni Cloud, ni PostgreSQL reales). Los fallos conocidos y las diferencias se fijan
// TAL CUAL (`// COMPORTAMIENTO ACTUAL` / `// FALLO CONOCIDO (Xnn)`).
//  I1 audio con éxito        I2 portada + PROJECT (y WAV)     I3 incierto/bloqueado/agotado: NO se reenvía (C7.8)
//  I4 rechazo del Cloud      I5 cancelar revisión / sin archivo   I6 dos importaciones seguidas   I7 secuencia visible de la tarjeta
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/dialog", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/lib/dialog")>()), appAlert: vi.fn(async () => {}) }));
vi.mock("../../src/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform")>(); const { fakeImporter } = await import("../helpers/catalogImportHarness");
  return { ...actual, platform: { ...actual.platform, importer: { ...actual.platform.importer, ...fakeImporter.port } } };
});
import { mountEditHarness, mp3, wav, type EditHarness } from "../helpers/catalogEditHarness";
import { fakeImporter, reviewBeat } from "../helpers/catalogImportHarness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let h: EditHarness;
beforeEach(() => { vi.useFakeTimers(); fakeImporter.reset(); try { localStorage.clear(); } catch { /* opcional */ } });
afterEach(async () => { vi.restoreAllMocks(); await h?.teardown(); vi.useRealTimers(); });

const PENDING = (n: string) => `La subida de «${n}» sigue confirmándose en el servidor. No se reenvía ni se borra nada: el beat aparecerá si se recibió; si no, se te avisará.`;
const UNCERTAIN = (n: string) => `La subida de «${n}» no se pudo confirmar. No se reenvía ni se borra nada: el servidor lo revisará y el beat aparecerá si Telegram lo recibió.`;
const DUP_PENDING = "Una subida anterior de este beat todavía se está confirmando en el servidor. No se vuelve a enviar para no duplicarla: espera a que termine (el beat aparecerá si se recibió).";
const settle = async (steps = 6, stepMs = 1500) => { for (let i = 0; i < steps; i++) await act(async () => { await vi.advanceTimersByTimeAsync(stepMs); }); };
const norm = (p: string) => p.replace(/top-\d+/, "top-N").replace(/%3A/g, ":");
const sig = (reqs: Array<{ method: string; path: string }>) => reqs.map((r) => `${r.method} ${norm(r.path)}`);
const sc = () => h.scope();
const opCreates = (m = 0) => h.writes(m).filter((r) => r.method === "POST" && r.path === "/catalog/v1/operations");
const tickets = (m = 0) => h.since(m).filter((r) => /send-ticket$/.test(r.path));
const dataUrl = "data:image/png;base64,iVBORw0KGgo=";

/** «Add beat»: el navegador retiene el archivo y la revisión se abre (una visible). Devuelve el beat de revisión. */
async function addForReview(name: string, over: { file?: File; slots?: Parameters<typeof fakeImporter.retain>[2]; beat?: Parameters<typeof reviewBeat>[1] } = {}) {
  const b = reviewBeat(name, over.beat); fakeImporter.retain(b.id, over.file ?? mp3(`${name}.mp3`), over.slots);
  await act(async () => { sc().imports.addBeatsAndReview([b]); }); return b;
}
/** «Save and finish»: resuelve cuando la revisión se cierra (primer byte enviado) o la importación se rechaza antes de subir. */
async function save(b: ReturnType<typeof reviewBeat>) {
  let error: unknown = null; await h.drive(sc().imports.saveReview(b).catch((e) => { error = e; })); return error as Error | null;
}
/** Línea visible de la tarjeta/avisos para fijar la SECUENCIA de estados (no milisegundos). */
const view = () => { const s = sc(); return `revisión=${s.imports.review?.beat.name ?? "-"} subiendo=${s.imports.uploads.map((u) => u.name).join("+") || "-"} tarjetas=${s.imports.pendingCards.map((c) => c.beat.name).join("+") || "-"} aviso=${s.notice ?? "-"}`; };
/** Retiene el primer envío al Puerto Direct hasta `release()` (latencia controlada: permite ver la tarjeta mientras «sube»). */
function gateSend() { const port = h.server.directPort; const orig = port.send.bind(port); let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); port.send = (async (...a: Parameters<typeof orig>) => { await gate; return orig(...a); }) as typeof port.send; return release; }
/** Guarda sin avanzar más que lo justo (la subida sigue en segundo plano). */
async function saveQuick(b: ReturnType<typeof reviewBeat>) { const p = sc().imports.saveReview(b); for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(5); }); await p; }
const direct = () => h.server.directSent.map((d) => ({ caption: d.caption.replace(/top-\d+/, "top-N"), filename: d.filename, size: d.size }));

// ============================================================================================================
describe("I1 · añadir un beat (solo audio) con éxito", () => {
  it("la revisión se abre sin tocar el Cloud; guardar crea UNA operación IMPORT con clave de idempotencia y el archivo viaja por el Puerto Direct (nunca por el Cloud)", async () => {
    h = await mountEditHarness(); const b = await addForReview("Mi beat"); const m = h.mark();
    expect(sc().imports.review?.beat.id).toBe(b.id); expect(h.writes(m)).toEqual([]); expect(fakeImporter.released).toEqual([]);
    expect(await save({ ...b, bpm: "140", key: "cm", tags: ["trap"], rating: 4 })).toBeNull(); await settle();
    const creates = opCreates(m); expect(creates).toHaveLength(1);
    expect(creates[0].body).toMatchObject({ kind: "IMPORT", metadata: { name: "Mi beat", bpm: "140", key: "cm", tags: ["trap"], rating: 4 } });
    expect(creates[0].body.parts).toMatchObject([{ partKey: "MASTER:0", role: "MASTER", filename: "Mi beat.mp3", mime: "audio/mpeg", size: 2048 }]);
    expect(creates[0].body.parts[0].sha256).toMatch(/^[0-9a-f]{64}$/); expect(creates[0].headers["Idempotency-Key"]).toMatch(/\S{8,}/);
    expect(creates[0].headers["X-Catalog-Era"]).toBe("era-fake"); expect(creates[0].headers["X-Catalog-Epoch"]).toBe("1");
    expect(sig(h.writes(m))).toEqual(["POST /catalog/v1/operations", "POST /catalog/v1/operations/top-N/parts/MASTER:0/send-ticket", "PUT /catalog/v1/operations/top-N/parts/MASTER:0/direct-receipt", "POST /catalog/v1/operations/top-N/commit", "POST /catalog/v1/operations/top-N/commit"]);
    expect(direct()).toEqual([{ caption: "catalog:v1 op=top-N part=MASTER:0", filename: "Mi beat.mp3", size: 2048 }]);
    expect(h.since(m).every((r) => !(r.body instanceof Blob) && !(r.body instanceof Uint8Array) && !(r.body instanceof ArrayBuffer))).toBe(true); // ningún byte de archivo hacia el Cloud
  });
  it("tras el commit: el beat existe en el servidor, el archivo retenido se libera UNA vez, aviso «importado» y UN refresco de la Gallery; la clave de operación se olvida", async () => {
    h = await mountEditHarness(); const b = await addForReview("Mi beat"); const m = h.mark(); const r0 = h.refreshes();
    await save(b); await settle();
    expect([...h.server.beats.values()].filter((x) => x.name === "Mi beat")).toHaveLength(1);
    expect(fakeImporter.released).toEqual([b.id]); expect(sc().imports.review).toBeNull(); expect(sc().imports.uploads).toEqual([]);
    expect(sc().notice).toBe("«Mi beat» importado."); expect(h.refreshes() - r0).toBe(1);
    expect(h.services.mutations.pendingOperations()).toEqual([]);
    expect(h.writes(m).filter((r) => /\/commit$/.test(r.path))).toHaveLength(2); // COMPORTAMIENTO ACTUAL: primer commit 202 (recibo sin verificar) + segundo tras el sondeo
  });
  it("COMPORTAMIENTO ACTUAL: el nombre se recorta de espacios en `metadata`; sin portada ni PROJECT no hay más partes", async () => {
    h = await mountEditHarness(); const b = await addForReview("Con espacios"); await save({ ...b, name: "  Con espacios  " }); await settle();
    expect(opCreates()[0].body.metadata.name).toBe("Con espacios"); expect(opCreates()[0].body.parts).toHaveLength(1);
  });
});

// ============================================================================================================
describe("I2 · con portada, PROJECT y WAV", () => {
  it("portada (data URL) + PROJECT: una sola operación con las partes MASTER, ARTWORK y PROJECT; los tres envíos por Direct, en ese orden; un commit final", async () => {
    h = await mountEditHarness(); const zip = new File([new Uint8Array(900).fill(5)], "proj.zip", { type: "application/zip" });
    const b = await addForReview("Con extras", { slots: { PROJECT: zip } }); const m = h.mark();
    await save({ ...b, image_base64: dataUrl }); await settle();
    const creates = opCreates(m); expect(creates).toHaveLength(1);
    expect(creates[0].body.parts.map((p: { role: string; partKey: string }) => `${p.role}/${p.partKey}`)).toEqual(["MASTER/MASTER:0", "ARTWORK/ARTWORK:0", "PROJECT/PROJECT:0"]);
    expect(creates[0].body.parts.find((p: { role: string }) => p.role === "PROJECT")).toMatchObject({ filename: "proj.zip", mime: "application/zip", size: 900 });
    expect(direct().map((d) => d.caption)).toEqual(["catalog:v1 op=top-N part=MASTER:0", "catalog:v1 op=top-N part=ARTWORK:0", "catalog:v1 op=top-N part=PROJECT:0"]);
    expect(new Set(tickets(m).map((t) => t.path.split("/")[4])).size).toBe(1); // todas las partes bajo la misma operación
    expect(sc().notice).toBe("«Con extras» importado."); expect(fakeImporter.released).toEqual([b.id]);
  });
  it("WAV: el MP3 convertido es el MASTER y el WAV original viaja como WAV HQ (dos partes, ambas por Direct)", async () => {
    h = await mountEditHarness(); const w = wav("beat.wav"); const conv = mp3("beat.mp3");
    const b = await addForReview("Beat wav", { file: w, slots: { MASTER: conv, WAV: w }, beat: { has_wav: true } as never }); const m = h.mark();
    await save(b); await settle();
    expect(opCreates(m)[0].body.parts.map((p: { role: string; partKey: string; filename: string }) => `${p.role}/${p.partKey}/${p.filename}`)).toEqual(["MASTER/MASTER:0/beat.mp3", "WAV/FILES:0:0/beat.wav"]);
    expect(h.server.directSent).toHaveLength(2);
  });
  it("WAV sin MP3 convertido: la importación falla ANTES de tocar el Cloud, la revisión sigue abierta y el archivo retenido", async () => {
    h = await mountEditHarness(); const b = await addForReview("Sin conv", { file: wav("x.wav"), beat: { has_wav: true } as never }); const m = h.mark();
    const err = await save(b);
    expect(err?.message).toBe("El WAV no pudo convertirse a MP3 para la reproducción."); expect(h.writes(m)).toEqual([]);
    expect(sc().imports.review?.beat.id).toBe(b.id); expect(fakeImporter.released).toEqual([]);
  });
  it("PROJECT demasiado grande para el plan (413 del ticket): COMPORTAMIENTO ACTUAL — el error llega tras haber enviado MASTER; la revisión se reabre con el aviso y el archivo intacto", async () => {
    h = await mountEditHarness(); const zip = new File([new Uint8Array(900)], "big.zip", { type: "application/zip" });
    const b = await addForReview("Grande", { slots: { PROJECT: zip } }); h.server.setFailure({ route: /parts\/PROJECT%3A0\/send-ticket$/, status: 413, code: "PROJECT_TOO_LARGE" });
    await save(b); await settle();
    expect(h.server.directSent.map((d) => d.filename)).toEqual(["Grande.mp3"]); // el MASTER ya salió antes de rechazar el PROJECT
    expect(sc().notice).toBe("No se pudo importar «Grande»: El PROJECT supera el tamaño máximo de tu plan. Tus cambios siguen en la revisión."); expect(sc().imports.review?.beat.id).toBe(b.id); expect(fakeImporter.released).toEqual([]);
  });
});

// ============================================================================================================
describe("I3 · resultado incierto / bloqueado / agotado: NUNCA se reenvía a ciegas (C7.8)", () => {
  type K = "uncertain" | "blocked" | "timeout";
  const mountK = (k: K) => mountEditHarness({ transferVerifyAfterPolls: k === "blocked" ? 99 : k === "timeout" ? 1e9 : undefined });
  const arm = (k: K) => { if (k === "uncertain") h.server.directState.faults.push("uncertain"); if (k === "blocked") h.server.setFailure({ route: /\/commit$/, status: 409, code: "VERSION_CONFLICT" }); };
  const steps = (k: K) => (k === "timeout" ? 420 : 8);
  const notice = (k: K, n: string) => (k === "uncertain" ? UNCERTAIN(n) : PENDING(n));
  it.each<[K]>([["uncertain"], ["blocked"], ["timeout"]])("%s: la tarjeta de subida desaparece, el archivo se libera, aviso persistente, un refresco, una sola operación y un solo envío", async (k) => {
    h = await mountK(k); const b = await addForReview("Dudoso"); arm(k); const m = h.mark(); const r0 = h.refreshes();
    expect(await save(b)).toBeNull(); await settle(steps(k));
    expect(opCreates(m)).toHaveLength(1); expect(h.server.directSent).toHaveLength(1);
    expect(sc().notice).toBe(notice(k, "Dudoso")); expect(sc().imports.uploads).toEqual([]); expect(sc().imports.pendingCards).toEqual([]); // COMPORTAMIENTO ACTUAL: ninguna tarjeta falsa permanente (la ficha suponía «pendiente»)
    expect(fakeImporter.released).toEqual([b.id]); expect(sc().imports.review).toBeNull(); expect(h.refreshes() - r0).toBe(1);
    expect(h.busy.filter((e) => e.beatId === b.id).map((e) => e.active)).toEqual([true, false]); // el overlay se enciende y se apaga sin «completado»
    expect(h.busy.some((e) => e.success)).toBe(false);
    expect(h.services.mutations.pendingOperations().map((r) => [r.kind, r.label, r.nameKey])).toEqual([["IMPORT", "Importar «Dudoso»", "dudoso"]]); // la referencia sigue persistida
    if (k === "uncertain") expect(h.writes(m).some((r) => /\/commit$/.test(r.path))).toBe(false); // ante incierto no se llega a confirmar
  });
  it.each<[K]>([["uncertain"], ["blocked"], ["timeout"]])("%s: volver a guardar el mismo nombre NO reenvía: cero operaciones y cero bytes nuevos; el error se muestra en la revisión abierta", async (k) => {
    h = await mountK(k); const b = await addForReview("Dudoso"); arm(k); await save(b); await settle(steps(k));
    h.server.setFailure(null); const b2 = await addForReview("DUDOSO", { beat: { id: "local_file_otro" } }); const m = h.mark(); const sent = h.server.directSent.length;
    const err = await save(b2);
    expect(err?.message).toBe(DUP_PENDING); expect(opCreates(m)).toEqual([]); expect(h.server.directSent).toHaveLength(sent); expect(tickets(m)).toEqual([]);
    expect(h.writes(m)).toEqual([]); expect(sc().imports.review?.beat.id).toBe("local_file_otro"); expect(fakeImporter.released).toEqual([b.id]); // el segundo archivo sigue retenido
  });
  it("C7.8: la identidad de la operación está persistida ANTES de entregar el primer byte al Puerto Direct", async () => {
    h = await mountEditHarness(); const b = await addForReview("Orden"); const seen: Array<{ pendingAtSend: string[] }> = [];
    const port = h.server.directPort; const orig = port.send.bind(port);
    port.send = (async (...a: Parameters<typeof orig>) => { seen.push({ pendingAtSend: h.services.mutations.pendingOperations().map((r) => `${r.kind}:${r.nameKey}`) }); return orig(...a); }) as typeof port.send;
    await save(b); await settle();
    expect(seen).toHaveLength(1); expect(seen[0].pendingAtSend).toEqual(["IMPORT:orden"]);
  });
  it("fallo DEFINITIVO del Direct antes de recibo (rechazo recuperable / no disponible): se reintenta la MISMA operación con un ticket nuevo (no es incierto) y termina bien", async () => {
    for (const f of ["rejected", "unavailable"] as const) {
      h = await mountEditHarness(); const b = await addForReview("Reintento"); h.server.directState.faults.push(f); const m = h.mark();
      expect(await save(b)).toBeNull(); await settle(8);
      expect(opCreates(m)).toHaveLength(1); expect(tickets(m)).toHaveLength(2); expect(h.writes(m).filter((r) => /send-report$/.test(r.path))).toHaveLength(1);
      expect(h.server.directSent).toHaveLength(1); expect(sc().notice).toBe("«Reintento» importado."); expect(fakeImporter.released).toEqual([b.id]);
      await h.teardown(); fakeImporter.reset();
    }
  });
});

// ============================================================================================================
describe("I4 · rechazo / error del Cloud", () => {
  it("rechazos al CREAR la operación (cuota, nombre repetido, transporte): el error se muestra en la revisión abierta, sin subir nada, sin liberar, sin refresco", async () => {
    const cases: Array<[string, string]> = [["QUOTA_EXCEEDED", "Tu plan alcanzó el límite de beats. Revisa Settings → Plan para ampliarlo."], ["NAME_TAKEN", "Ya existe un beat llamado «». Cambia el nombre para continuar."], ["TRANSFER_UNAVAILABLE", "El servicio de almacenamiento de archivos no está disponible en este entorno. El beat no se guardó."]];
    for (const [code, text] of cases) {
      h = await mountEditHarness(); const b = await addForReview("Rechazado"); const m = h.mark(); const r0 = h.refreshes();
      h.server.setFailure({ route: /\/operations$/, status: 409, code });
      const err = await save(b);
      expect(err?.message).toBe(text); expect(sig(h.writes(m))).toEqual(["POST /catalog/v1/operations"]); expect(h.server.directSent).toEqual([]); // NAME_TAKEN: el doble no rellena el nombre (detail vacío)
      expect(sc().imports.review?.beat.id).toBe(b.id); expect(sc().imports.uploads).toEqual([]); expect(sc().imports.pendingCards).toEqual([]); expect(fakeImporter.released).toEqual([]); expect(h.refreshes() - r0).toBe(0);
      expect(h.busy).toEqual([]); await h.teardown(); fakeImporter.reset();
    }
  });
  it("error del Cloud al CONFIRMAR (commit 500): tarjeta fuera, aviso con «Tus cambios siguen en la revisión», la revisión se REABRE con lo editado y el archivo intacto; sin refresco", async () => {
    h = await mountEditHarness(); const b = await addForReview("Falla commit"); const m = h.mark(); const r0 = h.refreshes();
    h.server.setFailure({ route: /\/commit$/, status: 500, code: "BOOM" });
    const edited = { ...b, bpm: "99", tags: ["a"] }; expect(await save(edited)).toBeNull(); await settle(8);
    expect(sc().notice).toBe("No se pudo importar «Falla commit»: fake BOOM. Tus cambios siguen en la revisión.");
    expect(sc().imports.review?.beat).toMatchObject({ id: b.id, bpm: "99", tags: ["a"] }); expect(fakeImporter.released).toEqual([]); expect(fakeImporter.port.fileForBeat(b.id)).not.toBeNull();
    expect(sc().imports.uploads).toEqual([]); expect(sc().imports.pendingCards).toEqual([]); expect(h.refreshes() - r0).toBe(0); expect(h.server.directSent).toHaveLength(1);
    expect(h.busy.filter((e) => e.beatId === b.id).map((e) => e.active)).toEqual([true, false]);
    expect(h.writes(m).filter((r) => /\/commit$/.test(r.path))).toHaveLength(1);
    expect([...h.server.beats.values()].some((x) => x.name === "Falla commit")).toBe(false);
  });
  it("COMPORTAMIENTO ACTUAL: tras ese fallo, guardar de nuevo desde la revisión reabierta se RECHAZA por la regla de pendiente (la operación sigue sin resolver en el servidor): cero operaciones y cero bytes nuevos", async () => {
    h = await mountEditHarness(); const b = await addForReview("Falla commit"); h.server.setFailure({ route: /\/commit$/, status: 500, code: "BOOM" });
    await save(b); await settle(8); h.server.setFailure(null); const m = h.mark(); const sent = h.server.directSent.length;
    const err = await save(sc().imports.review!.beat); await settle(4);
    expect(err?.message).toBe(DUP_PENDING); expect(opCreates(m)).toEqual([]); expect(h.server.directSent).toHaveLength(sent); expect(sc().imports.review?.beat.id).toBe(b.id); expect(fakeImporter.released).toEqual([]);
  });
});

// ============================================================================================================
describe("I5 · cancelación por el usuario", () => {
  it("cancelar la revisión: libera el archivo, no emite NINGUNA petición y no importa nada", async () => {
    h = await mountEditHarness(); const b = await addForReview("Cancelado"); const m = h.mark(); const r0 = h.refreshes();
    await act(async () => { sc().imports.cancelReview(); });
    expect(sc().imports.review).toBeNull(); expect(fakeImporter.released).toEqual([b.id]); expect(h.since(m)).toEqual([]); expect(h.refreshes() - r0).toBe(0); expect(sc().notice).toBeNull();
  });
  it("una sola revisión visible: la segunda espera en cola y se abre al cancelar la primera (sin perder su archivo)", async () => {
    h = await mountEditHarness(); const a = await addForReview("A"); const b = await addForReview("B");
    expect(sc().imports.review?.beat.id).toBe(a.id); await act(async () => { sc().imports.cancelReview(); });
    expect(sc().imports.review?.beat.id).toBe(b.id); expect(fakeImporter.released).toEqual([a.id]); expect(fakeImporter.port.fileForBeat(b.id)).not.toBeNull();
  });
  it("sin archivo retenido: no se abre revisión, aviso «No se encontró el archivo…» y nada llega al Cloud", async () => {
    h = await mountEditHarness(); const m = h.mark();
    await act(async () => { sc().imports.addBeatsAndReview([reviewBeat("Huérfano")]); });
    expect(sc().imports.review).toBeNull(); expect(sc().notice).toBe("No se encontró el archivo del beat a importar."); expect(h.since(m)).toEqual([]);
  });
  // COMPORTAMIENTO ACTUAL: no existe cancelación de una subida EN CURSO desde la interfaz del hook (no hay `cancelUpload`; la revisión ya está cerrada y el
  // archivo retenido hasta que termine la subida). Lo único cancelable es la revisión antes de «Save and finish».
  it("no existe cancelación de una subida en curso: tras guardar, cancelReview no aborta ni libera nada", async () => {
    h = await mountEditHarness(); const b = await addForReview("En curso"); await save(b);
    expect(Object.keys(sc()).filter((k) => /cancel.*(upload|import)|abort/i.test(k))).toEqual([]);
    await act(async () => { sc().imports.cancelReview(); }); expect(fakeImporter.released).toEqual([]); await settle();
    expect(sc().notice).toBe("«En curso» importado."); expect(fakeImporter.released).toEqual([b.id]);
  });
});

// ============================================================================================================
describe("I6 · dos importaciones seguidas: no se mezclan identidades", () => {
  it("la segunda revisión se abre al guardar la primera; cada beat tiene SU operación, SU clave, SU archivo y SU recibo; aviso agregado mientras ambas suben", async () => {
    h = await mountEditHarness(); const a = await addForReview("Alfa", { file: mp3("alfa.mp3") }); const bb = await addForReview("Beta", { file: mp3("beta.mp3") }); const m = h.mark();
    expect(sc().imports.review?.beat.id).toBe(a.id);
    await saveQuick({ ...a, bpm: "100" });
    expect(sc().imports.review?.beat.id).toBe(bb.id); expect(sc().notice).toBe("Subiendo «Alfa»… 100 %");
    await saveQuick({ ...bb, bpm: "200" });
    expect(sc().imports.uploads.map((u) => u.name)).toEqual(expect.arrayContaining(["Alfa", "Beta"])); expect(sc().notice).toMatch(/^Subiendo 2 beats… \d+ %$/);
    await settle();
    const creates = opCreates(m); expect(creates.map((r) => r.body.metadata.name)).toEqual(["Alfa", "Beta"]); expect(creates.map((r) => r.body.metadata.bpm)).toEqual(["100", "200"]);
    expect(new Set(creates.map((r) => r.headers["Idempotency-Key"])).size).toBe(2);
    const ops = tickets(m).map((t) => t.path.split("/")[4]); expect(new Set(ops).size).toBe(2);
    expect(h.server.directSent.map((d) => [d.filename, d.caption.split(" ")[1]])).toEqual([["alfa.mp3", `op=${ops[0]}`], ["beta.mp3", `op=${ops[1]}`]]);
    const named = [...h.server.beats.values()].filter((x) => ["Alfa", "Beta"].includes(x.name)); expect(named.map((x) => [x.name, x.bpm]).sort()).toEqual([["Alfa", "100"], ["Beta", "200"]]);
    expect(fakeImporter.released.sort()).toEqual([a.id, bb.id].sort()); expect(h.services.mutations.pendingOperations()).toEqual([]);
  });
  it("COMPORTAMIENTO ACTUAL: cada importación completada refresca la Gallery una vez (dos importaciones → dos refrescos)", async () => {
    h = await mountEditHarness(); const a = await addForReview("Alfa"); const bb = await addForReview("Beta"); const r0 = h.refreshes();
    await save(a); await save(bb); await settle(); expect(h.refreshes() - r0).toBe(2);
  });
  it("una importación incierta no bloquea OTRO nombre: la segunda se importa; solo el mismo nombre queda retenido", async () => {
    h = await mountEditHarness(); const a = await addForReview("Alfa"); h.server.directState.faults.push("uncertain"); await save(a); await settle();
    const bb = await addForReview("Beta"); const m = h.mark(); expect(await save(bb)).toBeNull(); await settle();
    expect(opCreates(m)).toHaveLength(1); expect([...h.server.beats.values()].some((x) => x.name === "Beta")).toBe(true); expect(h.services.mutations.pendingOperations().map((r) => r.nameKey)).toEqual(["alfa"]);
    expect(sc().notice).toBe(UNCERTAIN("Alfa")); // COMPORTAMIENTO ACTUAL: el aviso de incierto anterior permanece y no lo pisa el «importado» de la siguiente
  });
  it("COMPORTAMIENTO ACTUAL: el mismo nombre dos veces con la primera aún en vuelo se rechaza por la regla de pendiente (con otra mayúscula también)", async () => {
    h = await mountEditHarness({ transferVerifyAfterPolls: 99 }); const a = await addForReview("Alfa"); await save(a); // la primera sigue verificándose
    const dup = await addForReview("ALFA", { beat: { id: "local_file_dup" } }); const m = h.mark();
    const err = await save(dup); expect(err?.message).toBe(DUP_PENDING); expect(opCreates(m)).toEqual([]);
  });
});

// ============================================================================================================
describe("I7 · la tarjeta de subida aparece y desaparece en la secuencia actual", () => {
  async function timeline(prepare?: () => (() => void) | void, run = 14000) {
    const tl: string[] = []; const push = () => { const v = view(); if (tl[tl.length - 1] !== v) tl.push(v); };
    const b = await addForReview("Tarjeta"); const release = prepare?.(); push();
    const p = sc().imports.saveReview(b); if (release) { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); push(); release(); } for (let t = 0; t < run; t += 250) { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); push(); } await p; push();
    return { tl, b };
  }
  it("éxito: revisión abierta → (se cierra y aparece la tarjeta con aviso «Subiendo»; overlay ocupado) → sube al 100 % → aviso «importado» con la tarjeta aún → la tarjeta se retira", async () => {
    h = await mountEditHarness(); const { tl, b } = await timeline();
    expect(tl).toEqual([
      "revisión=Tarjeta subiendo=- tarjetas=- aviso=-",
      "revisión=- subiendo=Tarjeta tarjetas=Tarjeta aviso=Subiendo «Tarjeta»… 100 %",
      "revisión=- subiendo=- tarjetas=Tarjeta aviso=«Tarjeta» importado.",
      "revisión=- subiendo=- tarjetas=- aviso=«Tarjeta» importado.",
    ]);
    // el overlay: ocupado (provisional) → ocupado (real) → completo (real, success) → libre (provisional)
    expect(h.busy.map((e) => `${e.beatId === b.id ? "prov" : "real"}:${e.active ? "on" : "off"}:${e.success ? "ok" : "-"}`)).toEqual(["prov:on:-", "real:on:-", "real:off:ok", "prov:off:-"]);
  });
  it("COMPORTAMIENTO ACTUAL: la tarjeta provisional se retira por la red de seguridad de 5 s cuando la real no llega a la vista (el doble de la Gallery no conoce el beat nuevo); el traspaso ocurre UNA sola vez", async () => {
    h = await mountEditHarness(); const b = await addForReview("Traspaso"); await save(b);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(sc().imports.pendingCards.map((c) => c.beat.name)).toEqual(["Traspaso"]); // commit hecho (~1,5 s) pero la tarjeta sigue
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(sc().imports.pendingCards).toEqual([]);
    expect(h.busy.filter((e) => e.success)).toHaveLength(1); await settle(); expect(h.busy.filter((e) => e.success)).toHaveLength(1);
  });
  it("incierto (envío en vuelo): revisión → tarjeta con «Subiendo… 0 %» → la tarjeta desaparece SIN «completado» y queda el aviso persistente", async () => {
    h = await mountEditHarness(); const { tl } = await timeline(() => { h.server.directState.faults.push("uncertain"); return gateSend(); });
    expect(tl).toEqual([
      "revisión=Tarjeta subiendo=- tarjetas=- aviso=-",
      "revisión=- subiendo=Tarjeta tarjetas=Tarjeta aviso=Subiendo «Tarjeta»… 0 %",
      `revisión=- subiendo=- tarjetas=- aviso=${UNCERTAIN("Tarjeta")}`,
    ]);
    expect(h.busy.map((e) => `${e.active}:${e.success}`)).toEqual(["true:false", "false:false"]);
  });
  it("error del Cloud en el commit: con el envío en vuelo la tarjeta muestra 0 %; al fallar el commit la tarjeta sale y la revisión vuelve en el mismo paso con el aviso de error", async () => {
    h = await mountEditHarness(); const { tl } = await timeline(() => { h.server.setFailure({ route: /\/commit$/, status: 500, code: "BOOM" }); return gateSend(); });
    expect(tl).toEqual([
      "revisión=Tarjeta subiendo=- tarjetas=- aviso=-",
      "revisión=- subiendo=Tarjeta tarjetas=Tarjeta aviso=Subiendo «Tarjeta»… 0 %",
      "revisión=Tarjeta subiendo=- tarjetas=- aviso=No se pudo importar «Tarjeta»: fake BOOM. Tus cambios siguen en la revisión.",
    ]);
  });
  it("con una búsqueda activa la tarjeta NO se dibuja (no encajaría en la vista): solo queda el aviso de progreso, y el beat se importa igual", async () => {
    h = await mountEditHarness(); const b = await addForReview("Tarjeta");
    await act(async () => { sc().filters.setSearch("beat"); await vi.advanceTimersByTimeAsync(600); }); await settle(1, 300);
    expect(await save(b)).toBeNull();
    expect(sc().imports.pendingCards).toEqual([]); expect(sc().imports.uploads.map((u) => u.name)).toEqual(["Tarjeta"]); expect(sc().notice).toBe("Subiendo «Tarjeta»… 100 %");
    await settle(); expect(sc().notice).toBe("«Tarjeta» importado."); expect(h.busy.some((e) => e.beatId === b.id)).toBe(false);
  });
  it("un aviso «importado» anterior no tapa el avance de la siguiente subida; un error o incierto anterior SÍ permanece", async () => {
    h = await mountEditHarness(); const a = await addForReview("Alfa"); await save(a); await settle(); expect(sc().notice).toBe("«Alfa» importado.");
    const b = await addForReview("Beta"); await save(b); expect(sc().notice).toBe("Subiendo «Beta»… 100 %"); await settle();
    h.server.directState.faults.push("uncertain"); const c = await addForReview("Gamma"); await save(c); await settle(); expect(sc().notice).toBe(UNCERTAIN("Gamma"));
    const d = await addForReview("Delta"); await save(d); expect(sc().notice).toBe(UNCERTAIN("Gamma")); // COMPORTAMIENTO ACTUAL: el aviso de error/incierto previo se conserva y tapa el progreso
  });
});
