import { describe, expect, it } from "vitest";
import { artworkFromDataUrl, dataUrlToFile, isMp3Master } from "../../src/features/library/catalog/catalogFileKinds";

const bytesOf = (f: File) => new Promise<number[]>((ok, ko) => { const r = new FileReader(); r.onload = () => ok(Array.from(new Uint8Array(r.result as ArrayBuffer))); r.onerror = () => ko(r.error); r.readAsArrayBuffer(f); });

describe("catalogFileKinds (C13)", () => {
  it("dataUrlToFile: png por defecto sin MIME, nombre del beat saneado, bytes base64", async () => {
    const f = dataUrlToFile("data:;base64,AQID", 'a/b:c*"d')!;
    expect(f.name).toBe("a_b_c_d.png");
    expect(f.type).toBe("image/png");
    expect(f.size).toBe(3);
    expect(await bytesOf(f)).toEqual([1, 2, 3]);
  });
  it("dataUrlToFile: no valida el MIME (conserva tipo ajeno con ext png) y nombre vacío cae a artwork", async () => {
    const f = dataUrlToFile("data:text/plain,hi%21", "")!;
    expect(f.name).toBe("artwork.png");
    expect(f.type).toBe("text/plain");
    expect(await bytesOf(f)).toEqual([104, 105, 33]);
  });
  it("dataUrlToFile: jpeg→jpg, webp→webp, vacío permitido, inválido→null", () => {
    expect(dataUrlToFile("data:image/jpeg;base64,AQ==", "x")!.name).toBe("x.jpg");
    expect(dataUrlToFile("data:image/webp;base64,AQ==", "x")!.name).toBe("x.webp");
    expect(dataUrlToFile("data:image/gif;base64,AQ==", "x")!.name).toBe("x.png");
    expect(dataUrlToFile("data:image/png;base64,", "x")!.size).toBe(0);
    expect(dataUrlToFile("nodata", "x")).toBeNull();
    expect(dataUrlToFile("data:image/png;base64,@@@", "x")).toBeNull();
  });
  it("artworkFromDataUrl: nombre fijo, MIME en minúsculas, bytes exactos", async () => {
    const f = artworkFromDataUrl("data:IMAGE/JPEG;base64,AQID")!;
    expect(f.name).toBe("artwork.jpg");
    expect(f.type).toBe("image/jpeg");
    expect(f.size).toBe(3);
    expect(await bytesOf(f)).toEqual([1, 2, 3]);
    expect(artworkFromDataUrl("data:image/avif;base64,AQ==")!.name).toBe("artwork.avif");
  });
  it("artworkFromDataUrl: rechaza sin MIME, MIME no soportado, vacío, inválido", () => {
    expect(artworkFromDataUrl("data:;base64,AQID")).toBeNull();
    expect(artworkFromDataUrl("data:text/plain,hi")).toBeNull();
    expect(artworkFromDataUrl("data:image/png;base64,")).toBeNull();
    expect(artworkFromDataUrl("data:image/png;base64,@@@")).toBeNull();
    expect(artworkFromDataUrl("x")).toBeNull();
  });
  it("isMp3Master: MIME mpeg/mp3 o extensión .mp3, sin distinguir mayúsculas", () => {
    expect(isMp3Master({ mime: "audio/mpeg" })).toBe(true);
    expect(isMp3Master({ mime: "AUDIO/MP3" })).toBe(true);
    expect(isMp3Master({ mime: null, filename: "Beat.MP3" })).toBe(true);
    expect(isMp3Master({ mime: "audio/wav", filename: "a.wav" })).toBe(false);
    expect(isMp3Master({ mime: "audio/mpeg3" })).toBe(false);
    expect(isMp3Master({ filename: "a.mp3.zip" })).toBe(false);
    expect(isMp3Master({})).toBe(false);
  });
});
