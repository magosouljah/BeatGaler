import { describe, expect, it } from "vitest";
import { browserId3Reader } from "../../src/lib/id3BrowserParser";

function synchsafe(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function frame(id: string, payload: number[]): number[] {
  const size = payload.length;
  return [
    ...Array.from(id).map(ch => ch.charCodeAt(0)),
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    0,
    0,
    ...payload,
  ];
}

function text(value: string): number[] {
  return [3, ...Array.from(new TextEncoder().encode(value))];
}

function syntheticId3(): Uint8Array {
  const pictureBytes = [1, 2, 3, 4, 5];
  const body = [
    ...frame("TBPM", text("140")),
    ...frame("TKEY", text("F#m")),
    ...frame("TCON", text("trap;dark")),
    ...frame("APIC", [
      0,
      ...Array.from("image/png").map(ch => ch.charCodeAt(0)),
      0,
      3,
      0,
      ...pictureBytes,
    ]),
  ];
  return new Uint8Array([
    0x49, 0x44, 0x33,
    3,
    0,
    0,
    ...synchsafe(body.length),
    ...body,
  ]);
}

describe("bundled browser ID3 parser", () => {
  it("reads the metadata BeatGaler consumes without network code", async () => {
    const file = new File([syntheticId3()], "probe.mp3", { type: "audio/mpeg" });
    const result = await new Promise<any>((resolve, reject) => {
      browserId3Reader.read(file, { onSuccess: resolve, onError: reject });
    });
    expect(result.tags.TBPM).toBe("140");
    expect(result.tags.bpm).toBe("140");
    expect(result.tags.TKEY).toBe("F#m");
    expect(result.tags.key).toBe("F#m");
    expect(result.tags.TCON).toBe("trap;dark");
    expect(result.tags.genre).toBe("trap;dark");
    expect(result.tags.picture).toEqual({ data: [1, 2, 3, 4, 5], format: "image/png" });
  });
});
