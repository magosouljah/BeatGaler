// E82: regresiones de la prueba del propietario — logo giratorio en avisos de progreso, estrellas distinguibles por forma y ID3 en MP3 descargados.
import { describe, expect, it } from "vitest";
import { readBlobAsArrayBuffer } from "../../src/features/audio/mp3Metadata";
import { downloadBeatFiles, withBeatGalerId3 } from "../../src/features/library/catalog/catalogDownloads";
import type { CatalogBeatFile } from "../../src/features/library/catalog/catalogCommandsApi";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const file = (role: string, over: Partial<CatalogBeatFile> = {}): CatalogBeatFile => ({ fileId: `f-${role}`, role, revision: "1", filename: role === "MASTER" ? "beat.mp3" : "cover.png", mime: null, sizeBytes: "1", status: "CURRENT", verified: true, slot: role, partCount: 1, current: true, ...over });
const bytes = async (b: Blob) => new Uint8Array(await readBlobAsArrayBuffer(b));
const text = (u: Uint8Array) => Array.from(u).filter((c) => c > 0 && c < 0xfe).map((c) => String.fromCharCode(c)).join("");

describe("E82 descarga de MP3 con metadatos", () => {
  const audio = new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3])], { type: "audio/mpeg" });
  it("antepone un ID3v2.3 con título, BPM, tonalidad, tags, rating y portada; el audio queda intacto", async () => {
    const out = await withBeatGalerId3(audio, { metadata: { name: "Mi Beat", bpm: "140", key: "A minor", tags: ["trap", "dark"], rating: 4 }, artwork: async () => ({ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) }) });
    const u = await bytes(out); const s = text(u);
    expect(s.startsWith("ID3")).toBe(true); expect(u[3]).toBe(3);
    for (const f of ["TIT2", "TBPM", "TKEY", "TCON", "APIC"]) expect(s).toContain(f);
    expect(s).toContain("Mi Beat"); expect(s).toContain("140"); expect(s).toContain("trap; dark");
    expect(Array.from(u.slice(-7))).toEqual([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
  });
  it("sin portada legible descarga igualmente con el resto de tags; un MP3 que ya trae ID3 no se duplica", async () => {
    const out = await withBeatGalerId3(audio, { metadata: { name: "X" }, artwork: async () => { throw new Error("sin portada"); } });
    expect(text(await bytes(out))).toContain("TIT2");
    const tagged = new Blob([new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0])]);
    expect(await withBeatGalerId3(tagged, { metadata: { name: "X" } })).toBe(tagged);
  });
  it("downloadBeatFiles etiqueta solo el MP3 (MASTER), no WAV ni PROJECT", async () => {
    const saved: Record<string, Uint8Array> = {};
    const dl = async () => ({ blob: new Blob([new Uint8Array([9, 9, 9])]) });
    await downloadBeatFiles({ files: [file("MASTER"), file("WAV", { filename: "a.wav" })], kind: "ALL", beatName: "b", download: dl, save: (b, n) => { void bytes(b).then((u) => { saved[n] = u; }); }, mp3Tags: { metadata: { name: "B", rating: 3 } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(text(saved["beat.mp3"]).startsWith("ID3")).toBe(true); expect(Array.from(saved["a.wav"])).toEqual([9, 9, 9]);
  });
});
