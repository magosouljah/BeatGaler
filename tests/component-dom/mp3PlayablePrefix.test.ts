import { describe, expect, it } from "vitest";
import { measureMp3PlayablePrefix, mp3DeclaredDuration } from "../../src/features/audio/mp3PlayablePrefix";

function frameLengthMpeg1Layer3(bitrateKbps: number, sampleRate = 44100, padding = 0): number {
  return Math.floor((144 * bitrateKbps * 1000) / sampleRate + padding);
}

function mpeg1Layer3Frame(bitrateIndex = 9, fill = 0): Uint8Array {
  const bitrates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const bitrate = bitrates[bitrateIndex - 1];
  const bytes = new Uint8Array(frameLengthMpeg1Layer3(bitrate));
  bytes.fill(fill);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  bytes[2] = bitrateIndex << 4;
  bytes[3] = 0x64;
  return bytes;
}

function mpeg2Layer3Frame(): Uint8Array {
  const bitrateKbps = 64;
  const byteLength = Math.floor((72 * bitrateKbps * 1000) / 22050);
  const bytes = new Uint8Array(byteLength);
  bytes[0] = 0xff;
  bytes[1] = 0xf3; // MPEG-2, Layer III, no CRC.
  bytes[2] = 8 << 4; // 64 kbps, 22.05 kHz.
  bytes[3] = 0x64;
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function synchsafe(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

describe("MP3 playable prefix meter", () => {
  it("reads the real MPEG frame count from Xing before the full song is buffered", () => {
    const first = mpeg1Layer3Frame();
    first.set([0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 1, 0, 0, 0x11, 0x39], 36); // Xing, frame count 4409.
    expect(mp3DeclaredDuration(first)).toBeCloseTo(4409 * 1152 / 44100, 6);
    expect(mp3DeclaredDuration(first.subarray(0, 100))).toBeNull();
  });

  it("reads VBRI's frame count and leaves headerless MP3 duration unknown", () => {
    const first = mpeg1Layer3Frame();
    first.set([0x56, 0x42, 0x52, 0x49], 36);
    first.set([0, 0, 0x11, 0x39], 50);
    expect(mp3DeclaredDuration(first)).toBeCloseTo(4409 * 1152 / 44100, 6);
    expect(mp3DeclaredDuration(mpeg1Layer3Frame())).toBeNull();
  });

  it("counts only complete MPEG frames", () => {
    const full = mpeg1Layer3Frame();
    const prefix = concat([
      ...Array.from({ length: 38 }, () => full),
      full.subarray(0, Math.floor(full.byteLength / 2)),
    ]);

    const measured = measureMp3PlayablePrefix(prefix);

    expect(measured.completeFrames).toBe(38);
    expect(measured.playableSeconds).toBeCloseTo((38 * 1152) / 44100, 6);
    expect(measured.playableSeconds).toBeLessThan(1);
  });

  it("crosses one second based on frame timing rather than a byte heuristic", () => {
    const frames = Array.from({ length: 39 }, (_, index) => mpeg1Layer3Frame(index % 2 === 0 ? 9 : 10, index));
    const measured = measureMp3PlayablePrefix(concat(frames));

    expect(measured.completeFrames).toBe(39);
    expect(measured.playableSeconds).toBeCloseTo((39 * 1152) / 44100, 6);
    expect(measured.playableSeconds).toBeGreaterThan(1);
  });

  it("waits when an ID3v2 tag extends beyond the downloaded prefix", () => {
    const bodySize = 96 * 1024;
    const header = concat([
      new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]),
      synchsafe(bodySize),
    ]);
    const prefix = new Uint8Array(64 * 1024);
    prefix.set(header);
    // Deliberately place MPEG-looking bytes inside the incomplete tag.
    prefix.set(mpeg1Layer3Frame().subarray(0, 100), 1024);

    const measured = measureMp3PlayablePrefix(prefix);

    expect(measured.waitingForId3).toBe(true);
    expect(measured.id3Bytes).toBe(10 + bodySize);
    expect(measured.completeFrames).toBe(0);
    expect(measured.playableSeconds).toBe(0);
  });

  it("skips a complete synchsafe ID3v2 tag before counting audio", () => {
    const body = new Uint8Array(32);
    const tag = concat([
      new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0]),
      synchsafe(body.byteLength),
      body,
    ]);
    const measured = measureMp3PlayablePrefix(concat([tag, mpeg1Layer3Frame(), mpeg1Layer3Frame()]));

    expect(measured.id3Bytes).toBe(tag.byteLength);
    expect(measured.firstFrameOffset).toBe(tag.byteLength);
    expect(measured.completeFrames).toBe(2);
  });

  it("uses MPEG-2 Layer III's 576 samples per frame", () => {
    const frames = Array.from({ length: 4 }, () => mpeg2Layer3Frame());
    const measured = measureMp3PlayablePrefix(concat(frames));

    expect(measured.completeFrames).toBe(4);
    expect(measured.playableSeconds).toBeCloseTo((4 * 576) / 22050, 6);
  });
});
