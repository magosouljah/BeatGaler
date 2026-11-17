// @vitest-environment node
// Fusión de PROJECT (lógica del flujo web anterior), plan de importación con PROJECT y mensajes de fallo.
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_LOAD_FAILED, prepareProjectForBeat } from "../../src/features/library/catalog/catalogProjectMerge";
import { resolveImportPlan } from "../../src/features/library/catalog/catalogImportPlan";
import { importFailureMessage } from "../../src/features/library/catalog/useCatalogGalleryScope";
import { replaceBeatAudio } from "../../src/features/library/catalog/catalogAudioReplace";
import type { Beat } from "../../src/types";

const zipFile = async (entries: Record<string, string>, name = "p.zip") => { const z = new JSZip(); for (const [k, v] of Object.entries(entries)) z.file(k, v); return new File([await z.generateAsync({ type: "arraybuffer" })], name, { type: "application/zip" }); };
const names = async (f: File) => { const z = await JSZip.loadAsync(await f.arrayBuffer()); return Object.keys(z.files).filter((n) => !z.files[n].dir).sort(); };
const f = (name: string, body = "x") => new File([body], name);

describe("prepareProjectForBeat (fusión anterior)", () => {
  it("un .zip reemplaza el PROJECT completo y nunca descarga el actual", async () => {
    const incoming = await zipFile({ "a.txt": "1" }); const loadExisting = vi.fn();
    const out = await prepareProjectForBeat({ beatName: "Beat", incoming, hasProject: true, loadExisting });
    expect(out).toBe(incoming); expect(loadExisting).not.toHaveBeenCalled();
  });
  it("un archivo de DAW se fusiona: se quitan DAW viejos y Backup(s); samples y notas se conservan; entra el nuevo; el ZIP se llama «<beat>.zip»", async () => {
    const existing = await zipFile({ "viejo.flp": "d", "viejo.als": "d2", "Samples/kick.wav": "k", "Backup/x.flp": "b", "Backups/y.txt": "b2", "notas.txt": "n" });
    const out = await prepareProjectForBeat({ beatName: "Mi: beat?", incoming: f("nuevo.flp", "nuevo"), hasProject: true, loadExisting: async () => existing });
    expect(await names(out)).toEqual(["Samples/kick.wav", "nuevo.flp", "notas.txt"].sort()); expect(out.name).toBe("Mi_ beat_.zip"); expect(out.type).toBe("application/zip");
  });
  it("sin PROJECT previo el archivo de DAW se empaqueta solo y no se descarga nada", async () => {
    const loadExisting = vi.fn();
    const out = await prepareProjectForBeat({ beatName: "B", incoming: f("a.flp"), hasProject: false, loadExisting });
    expect(await names(out)).toEqual(["a.flp"]); expect(loadExisting).not.toHaveBeenCalled();
  });
  it("si el PROJECT actual no se puede cargar, ABORTA (no sustituye a ciegas)", async () => {
    await expect(prepareProjectForBeat({ beatName: "B", incoming: f("a.flp"), hasProject: true, loadExisting: async () => { throw new Error("net"); } })).rejects.toThrow(PROJECT_LOAD_FAILED);
    await expect(prepareProjectForBeat({ beatName: "B", incoming: f("a.flp"), hasProject: true, loadExisting: async () => null })).rejects.toThrow(PROJECT_LOAD_FAILED);
  });
});

describe("replaceBeatAudio PROJECT: un fallo de carga no sube nada", () => {
  const detail = { id: "b1", name: "Beat", bpm: "", key: "", tags: [], rating: 0, color: null, color2: null, version: "4", hasWav: false, hasProject: true, playback: null, artwork: null };
  it("fusiona con el ZIP actual y sube solo el PROJECT; si no puede cargarlo, no llama a replaceBeat", async () => {
    const replaceBeat = vi.fn(async () => ({ status: "committed", operationId: "o", beatId: "b1", version: "5", revision: "9", operation: {} }));
    const existing = await zipFile({ "Samples/s.wav": "s", "v.flp": "v" });
    const ok = await replaceBeatAudio({ mutations: { getBeat: async () => detail, replaceBeat } as never, confirm: async () => true, beatId: "b1", file: f("n.flp"), loadProject: async () => existing });
    expect(ok).toMatchObject({ status: "committed", kind: "PROJECT" });
    const sent = (replaceBeat.mock.calls[0] as unknown as [{ files: { project: File } }])[0].files.project; expect(await names(sent)).toEqual(["Samples/s.wav", "n.flp"].sort());
    replaceBeat.mockClear();
    const bad = await replaceBeatAudio({ mutations: { getBeat: async () => detail, replaceBeat } as never, confirm: async () => true, beatId: "b1", file: f("n.flp"), loadProject: async () => { throw new Error("x"); } });
    expect(bad).toMatchObject({ status: "failed", message: PROJECT_LOAD_FAILED }); expect(replaceBeat).not.toHaveBeenCalled();
  });
});

describe("resolveImportPlan con PROJECT y mensajes", () => {
  it("incluye el PROJECT elegido en la revisión", async () => {
    const beat = { id: "w", name: "B", bpm: "", key: "", tags: [], image_base64: null, has_wav: false } as unknown as Beat; const mp3 = f("a.mp3"); const zip = f("p.zip");
    const plan = await resolveImportPlan({ beat, hydrated: null, slotFiles: () => ({ MASTER: mp3, PROJECT: zip }), originalFile: mp3 });
    expect(plan.files.master).toBe(mp3); expect(plan.files.project).toBe(zip); expect(plan.files.wav).toBeNull();
  });
  it("tags quitados en la revisión no se vuelven a añadir (hidratado = versión editada)", async () => {
    const beat = { id: "w", name: "B", bpm: "", key: "", tags: ["lofi"], image_base64: null, has_wav: false } as unknown as Beat; const mp3 = f("a.mp3");
    const plan = await resolveImportPlan({ beat, hydrated: Promise.resolve(beat), slotFiles: () => ({ MASTER: mp3 }), originalFile: mp3 });
    expect(plan.beat.tags).toEqual(["lofi"]);
  });
  it("importFailureMessage: cuota del plan, transporte, PROJECT grande; el resto conserva su texto", () => {
    expect(importFailureMessage({ code: "QUOTA_EXCEEDED", detail: { used: 20, max: 20 } })).toMatch(/límite de beats \(20 de 20\).*Settings → Plan/);
    expect(importFailureMessage({ code: "TRANSFER_UNAVAILABLE" })).toMatch(/no se guardó/); expect(importFailureMessage({ code: "PROJECT_TOO_LARGE" })).toMatch(/tamaño máximo/);
    expect(importFailureMessage(new Error("otra cosa"))).toBe("otra cosa");
  });
});
