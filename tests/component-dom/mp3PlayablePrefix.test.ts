import { describe, expect, it } from "vitest";
import { inspectMp3PlayablePrefix } from "../../src/features/audio/mp3PlayablePrefix";

const MPEG1_LAYER3_SAMPLE_RATE = 44_100;

function mpeg1Layer3Frame(bitrateIndex = 9): Uint8Array {
  // MPEG-1 Layer III, 44.1 kHz, no padding. Index 9 = 128 kbps, 11 = 192 kbps.
  const bitrateKbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrateIndex] || 0;
  const frameBytes = Math.floor((144 * bitrateKbps * 1000) / MPEG1_LAYER3_SAMPLE_RATE);
  const frame = new Uint8Array(frameBytes);
  frame.set([0xff, 0xfb, (bitrateIndex << 4) | 0x00, 0x00]);
  return frame;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function id3v23(bodyBytes: number): Uint8Array {
  const bytes = new Uint8Array(10 + bodyBytes);
  bytes.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]);
  bytes[6] = (bodyBytes >> 21) & 0x7f;
  bytes[7] = (bodyBytes >> 14) & 0x7f;
  bytes[8] = (bodyBytes >> 7) & 0x7f;
  bytes[9] = bodyBytes & 0x7f;
  return bytes;
}

describe("MP3 playable prefix duration", () => {
  it("counts complete MPEG frames until the prefix contains about one second", () => {
    const frame = mpeg1Layer3Frame();
    const bytes = concat(Array.from({ length: 39 }, () => frame));
    const result = inspectMp3PlayablePrefix(bytes);

    expect(result.completeFrames).toBe(39);
    expect(result.firstFrameOffset).toBe(0);
    expect(result.playableSeconds).toBeGreaterThan(1);
    expect(result.playableSeconds).toBeLessThan(1.1);
  });

  it("does not count an incomplete trailing frame", () => {
    const frame = mpeg1Layer3Frame();
    const bytes = concat([frame, frame.subarray(0, 100)]);
    const result = inspectMp3PlayablePrefix(bytes);

    expect(result.completeFrames).toBe(1);
    expect(result.playableSeconds).toBeCloseTo(1152 / MPEG1_LAYER3_SAMPLE_RATE, 6);
  });

  it("does not scan inside an ID3v2 tag that is larger than the current prefix", () => {
    const declaredBodyBytes = 80 * 1024;
    const partial = id3v23(declaredBodyBytes).subarray(0, 64 * 1024);
    // Plant bytes that look like a valid MP3 frame inside the tag body. They
    // must not be counted until the whole declared ID3 prefix has arrived.
    partial.set(mpeg1Layer3Frame().subarray(0, 417), 1024);

    const result = inspectMp3PlayablePrefix(partial);
    expect(result.completeFrames).toBe(0);
    expect(result.firstFrameOffset).toBeNull();
    expect(result.playableSeconds).toBe(0);
  });

  it("skips a complete large legacy ID3v2 prefix before measuring audio", () => {
    const tag = id3v23(80 * 1024);
    const frame = mpeg1Layer3Frame();
    const bytes = concat([tag, ...Array.from({ length: 39 }, () => frame)]);
    const result = inspectMp3PlayablePrefix(bytes);

    expect(result.firstFrameOffset).toBe(tag.byteLength);
    expect(result.completeFrames).toBe(39);
    expect(result.playableSeconds).toBeGreaterThan(1);
  });

  it("measures VBR prefixes from frame timing rather than average bytes", () => {
    const frame128 = mpeg1Layer3Frame(9);
    const frame192 = mpeg1Layer3Frame(11);
    const bytes = concat([frame128, frame192, frame128, frame192]);
    const result = inspectMp3PlayablePrefix(bytes);

    expect(frame128.byteLength).not.toBe(frame192.byteLength);
    expect(result.completeFrames).toBe(4);
    expect(result.playableSeconds).toBeCloseTo((4 * 1152) / MPEG1_LAYER3_SAMPLE_RATE, 6);
  });
});
