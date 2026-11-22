// E86 — rating del MP3 (POPM de ID3v2) → estrellas 0–5 al importar.
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { id3v2TagSize, readId3Rating, readMp3Rating, starsFromPopmByte } from "../../src/features/audio/id3Rating";
import { buildBeatGalerId3Tag, stripId3MetadataForCloud } from "../../src/features/audio/mp3Metadata";
import { parseId3FromFile } from "../../src/features/import/webAudioMetadata";

const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const ss = (n: number) => Uint8Array.of((n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127);
const popmBody = (email: string, rating: number) => cat(latin1(email), Uint8Array.of(0, rating, 0, 0, 0, 0));
const frame = (v: 2 | 3 | 4, id: string, body: Uint8Array) => v === 2 ? cat(latin1(id), Uint8Array.of((body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255), body) : cat(latin1(id), v === 4 ? ss(body.length) : u32(body.length), Uint8Array.of(0, 0), body);
const tag = (v: 2 | 3 | 4, frames: Uint8Array[], { pad = 0, ext = false }: { pad?: number; ext?: boolean } = {}) => {
  const extHdr = ext ? (v === 4 ? cat(ss(6), Uint8Array.of(1, 0)) : cat(u32(6), Uint8Array.of(0, 0, 0, 0, 0, 0))) : new Uint8Array(0);
  const body = cat(extHdr, ...frames, new Uint8Array(pad));
  return cat(latin1("ID3"), Uint8Array.of(v, 0, ext ? 0x40 : 0), ss(body.length), body);
};

describe("E86 escala POPM → estrellas (la del escritorio)", () => {
  it("tramos 0 | 1–51 | 52–114 | 115–167 | 168–204 | ≥205", () => {
    expect([0, 1, 51, 52, 64, 114, 115, 128, 167, 168, 192, 196, 204, 205, 223, 255].map(starsFromPopmByte)).toEqual([0, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5]);
  });
  it("las convenciones habituales dan el mismo número de estrellas: Windows 1/64/128/196/255, BeatGaler (escritorio) 1/64/128/192/255 y web 51/102/153/204/255, Winamp 31/95/159", () => {
    expect([1, 64, 128, 196, 255].map(starsFromPopmByte)).toEqual([1, 2, 3, 4, 5]);
    expect([1, 64, 128, 192, 255].map(starsFromPopmByte)).toEqual([1, 2, 3, 4, 5]);
    expect([51, 102, 153, 204, 255].map(starsFromPopmByte)).toEqual([1, 2, 3, 4, 5]);
    expect([31, 95, 159].map(starsFromPopmByte)).toEqual([1, 2, 3]);
  });
});

describe("E86 lectura del POPM", () => {
  it("ID3v2.3 con el POPM del archivo real (email «BeatVault», 192) entre otros frames → 4", () => {
    const t = tag(3, [frame(3, "TBPM", cat(Uint8Array.of(0), latin1("159"))), frame(3, "POPM", popmBody("BeatVault", 192)), frame(3, "TCON", cat(Uint8Array.of(0), latin1("trap")))], { pad: 64 });
    expect(readId3Rating(t)).toBe(4);
  });
  it("ID3v2.4 (tamaños synchsafe), ID3v2.2 (POP, cabeceras de 6 bytes) y cabecera extendida", () => {
    expect(readId3Rating(tag(4, [frame(4, "POPM", popmBody("x@y", 255))]))).toBe(5);
    expect(readId3Rating(tag(2, [frame(2, "POP", popmBody("", 128))]))).toBe(3);
    expect(readId3Rating(tag(3, [frame(3, "POPM", popmBody("a", 64))], { ext: true }))).toBe(2);
    expect(readId3Rating(tag(4, [frame(4, "POPM", popmBody("a", 1))], { ext: true }))).toBe(1);
  });
  it("sin POPM, con valor 0, sin etiqueta o corrupta → 0 (sin lanzar); con varios POPM vale el primero con valor", () => {
    expect(readId3Rating(tag(3, [frame(3, "TBPM", cat(Uint8Array.of(0), latin1("120")))]))).toBe(0);
    expect(readId3Rating(tag(3, [frame(3, "POPM", popmBody("a", 0))]))).toBe(0);
    expect(readId3Rating(latin1("no es ID3 en absoluto"))).toBe(0);
    const t = tag(3, [frame(3, "POPM", popmBody("a", 192))]); expect(readId3Rating(t.subarray(0, 25))).toBe(0); // etiqueta truncada
    expect(readId3Rating(tag(3, [frame(3, "POPM", popmBody("a", 0)), frame(3, "POPM", popmBody("b", 128)), frame(3, "POPM", popmBody("c", 255))]))).toBe(3);
    expect(id3v2TagSize(latin1("ID3"))).toBe(0);
  });
  it("lee el File completo (MP3 con la etiqueta delante) y no se confunde con audio sin etiqueta", async () => {
    const audio = Uint8Array.of(0xff, 0xfb, 0x90, 0, 1, 2, 3);
    expect(await readMp3Rating(new File([cat(tag(3, [frame(3, "POPM", popmBody("BeatVault", 192))]), audio)], "a.mp3"))).toBe(4);
    expect(await readMp3Rating(new File([audio], "b.mp3"))).toBe(0);
  });
  it("ida y vuelta: el ID3 que BeatGaler escribe al descargar (1–5 estrellas) se vuelve a leer igual", async () => {
    for (const n of [1, 2, 3, 4, 5]) expect(await readMp3Rating(new File([buildBeatGalerId3Tag({ name: "x", rating: n })], "d.mp3"))).toBe(n);
    expect(await readMp3Rating(new File([buildBeatGalerId3Tag({ name: "x", rating: 0 })], "d.mp3"))).toBe(0);
  });
  it("lee ID3 de un MP3 sin lector global ni peticiones de red", async () => {
    const bytes = readFileSync("tests/e2e-web/fixtures/stage1-playback.mp3");
    const source = new File([new Uint8Array(bytes)], "stage1-playback.mp3", { type: "audio/mpeg" });
    const { file: audio } = await stripId3MetadataForCloud(source);
    const id3 = buildBeatGalerId3Tag(
      { name: "Stage 1", bpm: "140", key: "Cm", tags: ["Trap", "Dark"], rating: 4 },
      { mimeType: "image/png", bytes: Uint8Array.of(137, 80, 78, 71) },
    );
    const file = new File([id3, audio], source.name, { type: source.type });
    const appendChild = vi.spyOn(document.head, "appendChild");
    const fetch = vi.fn(() => Promise.reject(new Error("El lector ID3 debe funcionar sin red")));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(window).not.toHaveProperty("jsmediatags");
      expect(await parseId3FromFile(file)).toEqual({
        bpm: "140",
        key: "Cm",
        tags: ["trap", "dark"],
        image_base64: "data:image/png;base64,iVBORw==",
        rating: 4,
      });
      expect(appendChild).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      appendChild.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  const REAL = "E:/777/musica/ALL MY BEATS/Restless/Restless [159 F#].mp3";
  it.skipIf(!existsSync(REAL))("MP3 real del propietario (Restless [159 F#], 4 estrellas en su ID3) → 4", async () => {
    expect(await readMp3Rating(new File([readFileSync(REAL)], "Restless [159 F#].mp3"))).toBe(4);
  });
});
