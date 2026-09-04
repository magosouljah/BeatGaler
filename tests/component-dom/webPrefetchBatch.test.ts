import { describe, expect, it } from "vitest";
import {
  runWebPrefetchBatch,
  WEB_PREFETCH_BATCH_MAX_LANES,
} from "../../src/features/cloud/webPrefetchBatch";

function mpeg1Layer3Frame128K(): Uint8Array {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return frame;
}

function makeId3PrefixedMp3(id3BodyBytes = 80 * 1024): Uint8Array {
  const tag = new Uint8Array(10 + id3BodyBytes);
  tag.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]);
  tag[6] = (id3BodyBytes >> 21) & 0x7f;
  tag[7] = (id3BodyBytes >> 14) & 0x7f;
  tag[8] = (id3BodyBytes >> 7) & 0x7f;
  tag[9] = id3BodyBytes & 0x7f;
  const frame = mpeg1Layer3Frame128K();
  const audio = new Uint8Array(frame.byteLength * 80);
  for (let offset = 0; offset < audio.byteLength; offset += frame.byteLength) audio.set(frame, offset);
  const bytes = new Uint8Array(tag.byteLength + audio.byteLength);
  bytes.set(tag, 0);
  bytes.set(audio, tag.byteLength);
  return bytes;
}

describe("Web playback prefetch batching", () => {
  it("gives every visible candidate its first 64 KiB before any second round and never exceeds six lanes", async () => {
    const sources = new Map<number, Uint8Array>();
    for (let id = 1; id <= 14; id += 1) sources.set(id, makeId3PrefixedMp3());
    const calls: Array<{ messageId: number; offset: number }> = [];
    let active = 0;
    let maxActive = 0;

    const outcomes = await runWebPrefetchBatch(
      Array.from({ length: 14 }, (_, index) => ({ messageId: index + 1, mimeType: "audio/mpeg" })),
      async (input, offsetBytes) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push({ messageId: input.messageId, offset: offsetBytes });
        await Promise.resolve();
        const source = sources.get(input.messageId)!;
        const chunk = source.slice(offsetBytes, Math.min(source.byteLength, offsetBytes + 64 * 1024));
        active -= 1;
        return { chunk: chunk.buffer, totalBytes: source.byteLength, mimeType: "audio/mpeg" };
      },
    );

    expect(maxActive).toBe(WEB_PREFETCH_BATCH_MAX_LANES);
    const firstSecondRound = calls.findIndex(call => call.offset > 0);
    expect(firstSecondRound).toBe(14);
    expect(new Set(calls.slice(0, 14).map(call => call.messageId)).size).toBe(14);
    expect(outcomes.every(outcome => outcome.result && outcome.targetMet && !outcome.error)).toBe(true);
  });

  it("stops future speculative rounds for a foreground-selected beat while the rest of the batch continues", async () => {
    const source = makeId3PrefixedMp3();
    const calls = new Map<number, number[]>();
    let selectedBeatBecameForeground = false;

    const outcomes = await runWebPrefetchBatch(
      [
        { messageId: 1, mimeType: "audio/mpeg" },
        { messageId: 2, mimeType: "audio/mpeg" },
      ],
      async (input, offsetBytes) => {
        const offsets = calls.get(input.messageId) || [];
        offsets.push(offsetBytes);
        calls.set(input.messageId, offsets);
        const chunk = source.slice(offsetBytes, Math.min(source.byteLength, offsetBytes + 64 * 1024));
        return { chunk: chunk.buffer, totalBytes: source.byteLength, mimeType: "audio/mpeg" };
      },
      {
        shouldContinue: input => input.messageId !== 1 || !selectedBeatBecameForeground,
        onProgress: progress => {
          if (progress.input.messageId === 1) selectedBeatBecameForeground = true;
        },
      },
    );

    expect(calls.get(1)).toEqual([0]);
    expect(calls.get(2)).toEqual([0, 64 * 1024]);
    expect(outcomes[0].result?.prefix.byteLength).toBe(64 * 1024);
    expect(outcomes[0].targetMet).toBe(false);
    expect(outcomes[0].error).toBeNull();
    expect(outcomes[1].targetMet).toBe(true);
  });

  it("keeps the rest of a batch progressing when one candidate fails", async () => {
    const source = makeId3PrefixedMp3(0);
    const outcomes = await runWebPrefetchBatch(
      [
        { messageId: 10, mimeType: "audio/mpeg" },
        { messageId: 11, mimeType: "audio/mpeg" },
      ],
      async (input, offsetBytes) => {
        if (input.messageId === 10) throw new Error("502 Bad Gateway");
        const chunk = source.slice(offsetBytes, Math.min(source.byteLength, offsetBytes + 64 * 1024));
        return { chunk: chunk.buffer, totalBytes: source.byteLength, mimeType: "audio/mpeg" };
      },
    );

    expect(outcomes[0].error?.message).toContain("502");
    expect(outcomes[1].error).toBeNull();
    expect(outcomes[1].result?.prefix.byteLength).toBeGreaterThan(0);
  });
});