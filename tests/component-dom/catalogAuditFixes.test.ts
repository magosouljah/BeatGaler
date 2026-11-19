// @vitest-environment node
// Auditoría funcional BeatGaler antiguo ↔ Gallery PostgreSQL: regresiones recuperadas (Download, importación WAV/ID3, PROJECT por arrastre, papelera nativa, preparación de archivos).
import { describe, expect, it, vi } from "vitest";
import { downloadBeatFiles, filesForDownload, safeDownloadName } from "../../src/features/library/catalog/catalogDownloads";
import { resolveImportPlan } from "../../src/features/library/catalog/catalogImportPlan";
import { prepareCatalogFiles } from "../../src/features/library/catalog/catalogFilePrep";
import { createCatalogTrashSource } from "../../src/features/library/catalog/catalogTrashSource";
import { classifyDroppedAudio, replaceBeatAudio } from "../../src/features/library/catalog/catalogAudioReplace";
import { routeDrop } from "../../src/features/library/catalog/catalogDropRouting";
import type { CatalogBeatFile } from "../../src/features/library/catalog/catalogCommandsApi";
import type { Beat } from "../../src/types";

const file = (name: string, type = "", bytes: number[] = [1, 2, 3, 4]) => new File([new Uint8Array(bytes)], name, { type });
const bf = (over: Partial<CatalogBeatFile>): CatalogBeatFile => ({ fileId: "f1", role: "MASTER", revision: "1", filename: "a.mp3", mime: "audio/mpeg", sizeBytes: "4", status: "READY", verified: true, slot: "MASTER", partCount: 1, current: true, ...over });

describe("Download", () => {
  const files = [bf({ fileId: "m" }), bf({ fileId: "w", role: "WAV", filename: "hq.wav", slot: "FILES:0" }), bf({ fileId: "p", role: "PROJECT", filename: "proj.zip", slot: "PROJECT" }), bf({ fileId: "old", role: "MASTER", current: false, slot: null }), bf({ fileId: "art", role: "ARTWORK", filename: "c.png", slot: "ARTWORK" })];
  it("elige solo los archivos vigentes del tipo pedido; ALL = MASTER+WAV+PROJECT (sin portada ni versiones retiradas)", () => {
    expect(filesForDownload("MP3", files).map((f) => f.fileId)).toEqual(["m"]);
    expect(filesForDownload("WAV", files).map((f) => f.fileId)).toEqual(["w"]);
    expect(filesForDownload("PROJECT", files).map((f) => f.fileId)).toEqual(["p"]);
    expect(filesForDownload("ALL", files).map((f) => f.fileId)).toEqual(["m", "w", "p"]);
  });
  it("nombres seguros con extensión", () => {
    expect(safeDownloadName(bf({ filename: "a/b:c.mp3" }), "x")).toBe("a_b_c.mp3");
    expect(safeDownloadName(bf({ filename: null, role: "WAV" }), "Mi beat")).toBe("Mi beat.wav");
  });
  it("descarga y guarda cada archivo; un fallo conserva lo ya guardado y avisa", async () => {
    const saved: string[] = []; const download = vi.fn(async (id: string) => { if (id === "w") throw new Error("MEDIA_HASH_MISMATCH"); return { blob: new Blob(["x"]) }; });
    const r = await downloadBeatFiles({ files, kind: "ALL", beatName: "B", download, save: (_b, n) => saved.push(n) });
    expect(r).toMatchObject({ status: "failed", saved: ["a.mp3"], message: "MEDIA_HASH_MISMATCH" }); expect(saved).toEqual(["a.mp3"]);
    expect(await downloadBeatFiles({ files: [], kind: "WAV", beatName: "B", download, save: () => {} })).toEqual({ status: "empty" });
  });
});

describe("Importación: plan con ID3 y WAV", () => {
  const beat = { id: "w1", name: "Mi beat", bpm: "", key: "", tags: [], image_base64: null, has_wav: true } as unknown as Beat;
  it("WAV: sube el MP3 convertido como MASTER y el WAV como WAV; incorpora BPM/key/tags/portada del archivo", async () => {
    const wav = file("x.wav", "audio/wav"); const mp3 = file("x.mp3", "audio/mpeg");
    const hydrated = Promise.resolve({ ...beat, bpm: "140", key: "Am", tags: ["Trap", "trap", "lofi"], image_base64: "data:image/png;base64,AAAA" } as Beat);
    const plan = await resolveImportPlan({ beat, hydrated, slotFiles: () => ({ MASTER: mp3, WAV: wav }), originalFile: wav });
    expect(plan.files.master).toBe(mp3); expect(plan.files.wav).toBe(wav);
    expect(plan.beat).toMatchObject({ name: "Mi beat", bpm: "140", key: "Am", image_base64: "data:image/png;base64,AAAA" }); expect(plan.beat.tags.length).toBe(2);
  });
  it("MP3: el original es el MASTER; el nombre editado por el usuario se conserva; si el ID3 falla se importa igual; un WAV que no convierte falla", async () => {
    const mp3 = file("x.mp3", "audio/mpeg"); const b = { ...beat, has_wav: false, name: "Editado" } as Beat;
    const ok = await resolveImportPlan({ beat: b, hydrated: Promise.reject(new Error("id3")), slotFiles: () => ({ MASTER: mp3 }), originalFile: mp3 });
    expect(ok.files.master).toBe(mp3); expect(ok.files.wav).toBeNull(); expect(ok.beat.name).toBe("Editado");
    await expect(resolveImportPlan({ beat, hydrated: Promise.reject(new Error("wav-convert")), slotFiles: () => ({ WAV: file("x.wav") }), originalFile: file("x.wav") })).rejects.toThrow("wav-convert");
    await expect(resolveImportPlan({ beat, hydrated: Promise.resolve(beat), slotFiles: () => ({ WAV: file("x.wav") }), originalFile: file("x.wav") })).rejects.toThrow(/convertirse/);
  });
});

describe("prepareCatalogFiles", () => {
  it("MASTER sin ID3v2/ID3v1 (bytes MPEG intactos); un .zip pasa tal cual; WAV y portada sin cambios", async () => {
    const frame = [0xff, 0xfb, 0x90, 0x00, 9, 9, 9, 9];
    const id3v2 = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4]; // cabecera ID3v2 con 4 bytes de cuerpo
    const withTag = file("a.mp3", "audio/mpeg", [...id3v2, ...frame]);
    const wav = file("a.wav", "audio/wav"); const zip = file("p.zip", "application/zip");
    const out = await prepareCatalogFiles({ master: withTag, wav, project: zip }, "Mi beat");
    expect(new Uint8Array(await out.master!.arrayBuffer())).toEqual(new Uint8Array(frame));
    expect(out.wav).toBe(wav); expect(out.project).toBe(zip); expect(out.projectFlags).toMatchObject({ openable: false });
  });
});

describe("PROJECT por arrastre sobre una tarjeta", () => {
  it("clasificación y ruta: .zip / DAW sobre tarjeta → reemplazo; fuera → aviso", () => {
    expect(classifyDroppedAudio(file("p.zip"))).toBe("PROJECT"); expect(classifyDroppedAudio(file("song.flp"))).toBe("PROJECT"); expect(classifyDroppedAudio(file("x.txt"))).toBeNull();
    expect(routeDrop({ files: [file("song.flp")], artwork: null, targetBeatId: "b-1" })).toMatchObject({ type: "replace-audio", beatId: "b-1" });
    expect(routeDrop({ files: [file("p.zip")], artwork: null, targetBeatId: null })).toMatchObject({ type: "alert", title: "Drop the project on a beat" });
  });
  it("confirma «Add project?» / «Replace project?» y sube solo el PROJECT del mismo beat", async () => {
    const detail = (hasProject: boolean) => ({ id: "b-1", name: "Mi beat", bpm: "", key: "", tags: [], rating: 0, color: null, color2: null, version: "3", hasWav: false, hasProject, playback: null, artwork: null });
    for (const [has, title] of [[false, "Add project?"], [true, "Replace project?"]] as const) {
      const replaceBeat = vi.fn(async () => ({ status: "committed", operationId: "o", beatId: "b-1", version: "4", revision: "9", operation: {} })); const confirm = vi.fn(async () => true); const z = file("p.zip");
      const r = await replaceBeatAudio({ mutations: { getBeat: async () => detail(has), replaceBeat } as never, confirm, beatId: "b-1", file: z });
      expect(r).toMatchObject({ status: "committed", kind: "PROJECT", replacedExisting: has }); expect(confirm.mock.calls[0][0].title).toBe(title);
      expect((replaceBeat.mock.calls[0] as unknown as [{ files: unknown }])[0].files).toEqual({ project: z });
    }
  });
});

describe("Papelera nativa (Settings → Trash)", () => {
  const dto = (id: string, name: string) => ({ id, name, version: "2", tags: [], bpm: "", key: "", rating: 0, state: "TRASH" });
  it("lista beats en TRASH, restaura con la versión esperada y vacía con la purga durable", async () => {
    const listBeats = vi.fn(async () => ({ items: [dto("b1", "Uno"), dto("b2", "Dos")] }));
    const restoreBeats = vi.fn(async () => ({ status: "COMPLETED" })); const purgeTrash = vi.fn(async () => ({ status: "pending", operationId: "op1" }));
    const states = ["pending", "purged"]; const purgeState = vi.fn(async () => ({ status: states.shift() }));
    const src = createCatalogTrashSource({ api: { listBeats } as never, mutations: { restoreBeats, purgeTrash, purgeState } as never, sleep: async () => {}, pollMs: 0 });
    const items = await src.listBeats(); expect(items.map((i) => [i.id, i.beat_name])).toEqual([["b1", "Uno"], ["b2", "Dos"]]);
    expect((listBeats.mock.calls[0] as unknown as [{ state: string }])[0].state).toBe("TRASH");
    expect((await src.restoreBeat("b1")).id).toBe("b1"); expect(restoreBeats).toHaveBeenCalledWith([{ beatId: "b1", expectedVersion: "2" }]);
    expect(await src.purgeBeats()).toBeGreaterThan(0); expect(purgeState).toHaveBeenCalledTimes(2);
  });
  it("restaurar con conflicto o un beat desconocido falla con aviso; purga bloqueada falla", async () => {
    const src = createCatalogTrashSource({ api: { listBeats: async () => ({ items: [dto("b1", "Uno")] }) } as never, mutations: { restoreBeats: async () => ({ status: "CONFLICT" }), purgeTrash: async () => ({ status: "blocked", operationId: "o" }), purgeState: vi.fn() } as never, sleep: async () => {} });
    await expect(src.restoreBeat("zz")).rejects.toThrow(/ya no está/); await src.listBeats();
    await expect(src.restoreBeat("b1")).rejects.toThrow(/cambió en otro dispositivo/); await expect(src.purgeBeats()).rejects.toThrow(/No se pudo eliminar definitivamente ningún beat/);
  });
});
