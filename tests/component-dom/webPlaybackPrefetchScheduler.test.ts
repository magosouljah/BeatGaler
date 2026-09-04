import { describe, expect, it } from "vitest";
import { WebPlaybackSourceManager, type WebPlaybackTransport } from "../../src/features/playback/webPlaybackSource";
import type { WebTransportPrefetchInput } from "../../src/features/cloud/webTransportWorkerProtocol";
import type { WebPrefetchBatchOutcome } from "../../src/features/cloud/webPrefetchBatch";

function resultFor(input: WebTransportPrefetchInput): WebPrefetchBatchOutcome {
  return {
    input,
    result: {
      messageId: input.messageId,
      totalBytes: 256 * 1024,
      mimeType: input.mimeType || "audio/mpeg",
      prefix: new ArrayBuffer(64 * 1024),
    },
    playableSeconds: 1.1,
    targetMet: true,
    error: null,
  };
}

describe("Web playback viewport prefetch scheduler", () => {
  it("submits every visible beat together before admitting nearby beats in small batches", async () => {
    const batches: number[][] = [];
    const transport: WebPlaybackTransport = {
      async prefetchFile(input) {
        return resultFor(input).result!;
      },
      async prefetchFiles(inputs) {
        batches.push(inputs.map(input => input.messageId));
        await Promise.resolve();
        return inputs.map(resultFor);
      },
      async streamFile() {
        return { completed: Promise.resolve({ messageId: 1, totalBytes: 0, mimeType: "audio/mpeg" }), cancel() {} };
      },
    };
    const manager = new WebPlaybackSourceManager(transport);
    const visible = Array.from({ length: 14 }, (_, index) => ({
      beatId: `visible-${index}`,
      messageId: index + 1,
      mimeType: "audio/mpeg",
    }));
    const nearby = Array.from({ length: 3 }, (_, index) => ({
      beatId: `nearby-${index}`,
      messageId: 100 + index,
      mimeType: "audio/mpeg",
    }));

    await manager.setPrefetchSnapshot({ visible, nearby });

    expect(batches[0]).toEqual(visible.map(candidate => candidate.messageId));
    expect(batches[1]).toEqual([100, 101]);
    expect(batches[2]).toEqual([102]);
    expect(batches.flat().slice(0, 14)).toEqual(visible.map(candidate => candidate.messageId));
  });

  it("promotes a queued nearby beat when it becomes visible", async () => {
    let releaseFirst!: () => void;
    const firstBatch = new Promise<void>(resolve => { releaseFirst = resolve; });
    const batches: number[][] = [];
    let callCount = 0;
    const transport: WebPlaybackTransport = {
      async prefetchFile(input) { return resultFor(input).result!; },
      async prefetchFiles(inputs) {
        batches.push(inputs.map(input => input.messageId));
        callCount += 1;
        if (callCount === 1) await firstBatch;
        return inputs.map(resultFor);
      },
      async streamFile() {
        return { completed: Promise.resolve({ messageId: 1, totalBytes: 0, mimeType: "audio/mpeg" }), cancel() {} };
      },
    };
    const manager = new WebPlaybackSourceManager(transport);
    const first = manager.setPrefetchSnapshot({
      visible: [{ beatId: "a", messageId: 1 }],
      nearby: [{ beatId: "b", messageId: 2 }, { beatId: "c", messageId: 3 }, { beatId: "d", messageId: 4 }],
    });
    await Promise.resolve();
    const second = manager.setPrefetchSnapshot({
      visible: [{ beatId: "b", messageId: 2 }],
      nearby: [{ beatId: "c", messageId: 3 }, { beatId: "d", messageId: 4 }],
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(batches[0]).toEqual([1]);
    expect(batches[1]).toEqual([2]);
  });
});
