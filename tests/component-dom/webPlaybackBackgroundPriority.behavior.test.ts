import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const streamCalls: Array<{
    input: { messageId: number; purpose?: string };
    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>;
  }> = [];
  const connect = vi.fn(async () => {});
  const waitForVaultPeerReady = vi.fn(async () => {});
  const beginOperation = vi.fn(async (name: string) => ({
    operationId: `operation-${name}`,
    name,
    scope: { objectType: "message", objectIds: [] },
  }));
  const endOperation = vi.fn(async () => {});
  const withOperation = vi.fn(async (_name: string, _scope: unknown, work: () => Promise<unknown>) => work());
  const focusPlayback = vi.fn(async () => {});
  const markPlaybackStable = vi.fn(async () => {});
  const releasePlaybackFocus = vi.fn(async () => {});
  const prewarm = vi.fn();
  const prefetch = vi.fn(async (input: { messageId: number }) => ({ messageId: input.messageId, prefix: new ArrayBuffer(0), totalBytes: 0, mimeType: "audio/mpeg" }));
  const prefetchBatch = vi.fn(() => ({ completed: Promise.resolve({ results: [] }), cancelMessage() {}, promoteMessage: async () => {}, cancel() {} }));

  return {
    streamCalls,
    connect,
    waitForVaultPeerReady,
    beginOperation,
    endOperation,
    withOperation,
    focusPlayback,
    markPlaybackStable,
    releasePlaybackFocus,
    prewarm,
    prefetch,
    prefetchBatch,
  };
});

vi.mock("../../src/features/cloud/webTransportWorkerClient", () => ({
  WebTransportWorkerClient: class {
    prewarm = harness.prewarm;
    prefetch = harness.prefetch;
    prefetchBatch = harness.prefetchBatch;
    focusPlayback = harness.focusPlayback;
    markPlaybackStable = harness.markPlaybackStable;
    releasePlaybackFocus = harness.releasePlaybackFocus;
    stream(input: { messageId: number; purpose?: string }, onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>) {
      harness.streamCalls.push({ input, onChunk });
      return {
        completed: Promise.resolve({
          messageId: input.messageId,
          totalBytes: 64,
          mimeType: "application/octet-stream",
        }),
        cancel() {},
      };
    }
  },
}));

vi.mock("../../src/features/cloud/webTransportController", () => ({
  WebTransportController: class {
    connect = harness.connect;
    waitForVaultPeerReady = harness.waitForVaultPeerReady;
    beginOperation = harness.beginOperation;
    endOperation = harness.endOperation;
    withOperation = harness.withOperation;
  },
}));

import { WebGalerCloudTransport } from "../../src/features/cloud/webGalerCloudTransport";

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Web playback priority over secondary reads", () => {
  beforeEach(() => {
    harness.streamCalls.length = 0;
    harness.connect.mockClear();
    harness.waitForVaultPeerReady.mockClear();
    harness.beginOperation.mockClear();
    harness.endOperation.mockClear();
    harness.withOperation.mockClear();
    harness.focusPlayback.mockClear();
    harness.markPlaybackStable.mockClear();
    harness.releasePlaybackFocus.mockClear();
    harness.prewarm.mockClear();
    harness.prefetch.mockClear();
    harness.prefetchBatch.mockClear();
    harness.waitForVaultPeerReady.mockResolvedValue(undefined);
  });

  it("retains immediate Play and multiple warm requests until the vault peer is ready", async () => {
    let releasePeer!: () => void;
    const peer = new Promise<void>(resolve => { releasePeer = resolve; });
    harness.waitForVaultPeerReady.mockImplementation(() => peer);
    const transport = new WebGalerCloudTransport();

    await transport.focusPlayback(10);
    const stream = transport.streamFile({ messageId: 10, mimeType: "audio/mpeg", purpose: "playback" }, () => {});
    const focusedWarm = transport.prefetchFile({ messageId: 10, mimeType: "audio/mpeg" });
    const batch = transport.prefetchFiles([
      { messageId: 11, mimeType: "audio/mpeg" },
      { messageId: 12, mimeType: "audio/mpeg" },
    ]);
    await tick();
    expect(harness.focusPlayback).toHaveBeenCalledWith(10);
    expect(harness.streamCalls).toHaveLength(0);
    expect(harness.prefetch).not.toHaveBeenCalled();
    expect(harness.prefetchBatch).not.toHaveBeenCalled();

    releasePeer();
    const [playing, , warming] = await Promise.all([stream, focusedWarm, batch]);
    await Promise.all([playing.completed, warming.completed]);
    expect(harness.streamCalls).toHaveLength(1);
    expect(harness.prefetch).toHaveBeenCalledOnce();
    expect(harness.prefetchBatch).toHaveBeenCalledOnce();
  });

  it("returns PEER_NOT_RESOLVED without issuing media RPCs when bootstrap fails", async () => {
    const peerMiss = Object.assign(new Error("Vault peer unavailable"), { code: "PEER_NOT_RESOLVED" });
    harness.waitForVaultPeerReady.mockRejectedValue(peerMiss);
    const transport = new WebGalerCloudTransport();
    await expect(transport.streamFile({ messageId: 10, purpose: "playback" }, () => {}))
      .rejects.toMatchObject({ code: "PEER_NOT_RESOLVED" });
    await expect(transport.prefetchFile({ messageId: 10, mimeType: "audio/mpeg" }))
      .rejects.toMatchObject({ code: "PEER_NOT_RESOLVED" });
    await expect(transport.prefetchFiles([{ messageId: 11, mimeType: "audio/mpeg" }]))
      .rejects.toMatchObject({ code: "PEER_NOT_RESOLVED" });
    expect(harness.streamCalls).toHaveLength(0);
    expect(harness.prefetch).not.toHaveBeenCalled();
    expect(harness.prefetchBatch).not.toHaveBeenCalled();
  });

  it("physically holds a background stream before Worker start while Play is critical", async () => {
    const transport = new WebGalerCloudTransport();
    await transport.focusPlayback(10);

    let settled = false;
    const pending = transport.streamFile(
      { messageId: 20, mimeType: "image/jpeg", purpose: "other" },
      () => {},
    ).then(value => {
      settled = true;
      return value;
    });

    await tick();
    expect(settled).toBe(false);
    expect(harness.streamCalls).toHaveLength(0);

    await transport.markPlaybackStable(10);
    await pending;
    expect(harness.streamCalls).toHaveLength(1);
    expect(harness.streamCalls[0].input.purpose).toBe("other");
  });

  it("backpressures the next background chunk/ACK when Play becomes critical mid-stream", async () => {
    const transport = new WebGalerCloudTransport();
    const consumer = vi.fn(async () => {});
    await transport.streamFile(
      { messageId: 21, mimeType: "image/jpeg", purpose: "other" },
      consumer,
    );
    expect(harness.streamCalls).toHaveLength(1);

    await transport.focusPlayback(11);
    let chunkReleased = false;
    const chunk = Promise.resolve(
      harness.streamCalls[0].onChunk(new Uint8Array([1, 2, 3]).buffer, 3, 100),
    ).then(() => { chunkReleased = true; });

    await tick();
    expect(consumer).not.toHaveBeenCalled();
    expect(chunkReleased).toBe(false);

    await transport.markPlaybackStable(11);
    await chunk;
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(chunkReleased).toBe(true);
  });

  it("keeps playback lease-free while export scheduling uses the download capability", async () => {
    const transport = new WebGalerCloudTransport();

    const playback = await transport.streamFile(
      { messageId: 30, mimeType: "audio/mpeg", purpose: "playback" },
      () => {},
    );
    await playback.completed;
    expect(harness.beginOperation).not.toHaveBeenCalled();
    expect(harness.streamCalls[0].input.purpose).toBe("playback");

    const exported = await transport.streamFile(
      { messageId: 31, mimeType: "audio/wav", purpose: "export" },
      () => {},
    );
    await exported.completed;

    expect(harness.streamCalls[1].input.purpose).toBe("export");
    expect(harness.beginOperation).toHaveBeenCalledTimes(1);
    expect(harness.beginOperation).toHaveBeenCalledWith(
      "download",
      { objectType: "message", objectIds: ["31"] },
    );
    expect(harness.endOperation).toHaveBeenCalledTimes(1);
  });

  it("keeps artwork hydration inside load_artwork authorization and the background stream gate", async () => {
    const transport = new WebGalerCloudTransport();
    await transport.focusPlayback(12);

    let resolved = false;
    const hydration = transport.downloadFiles([{ messageId: 40, mimeType: "image/jpeg" }])
      .then(value => { resolved = true; return value; });

    await tick();
    expect(resolved).toBe(false);
    expect(harness.withOperation).toHaveBeenCalledWith(
      "load_artwork",
      { objectType: "message", objectIds: ["40"] },
      expect.any(Function),
    );
    expect(harness.streamCalls).toHaveLength(0);

    await transport.releasePlaybackFocus(12);
    await hydration;
    expect(harness.streamCalls).toHaveLength(1);
    expect(harness.streamCalls[0].input.purpose).toBe("other");
  });
});
