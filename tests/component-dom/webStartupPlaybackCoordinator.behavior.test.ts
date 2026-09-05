import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Candidate = { beatId: string; messageId: number; mimeType: string; sizeBytes?: number | null };
  const transports: any[] = [];
  const sources: any[] = [];
  const prefetchDeferred = new Map<number, { promise: Promise<void>; resolve(): void; reject(error: Error): void }>();

  function deferred(messageId: number) {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const value = { promise, resolve, reject };
    prefetchDeferred.set(messageId, value);
    return value;
  }

  class FakeTransport {
    candidates: Candidate[];
    connectPlaybackDataPlane = vi.fn(async () => {});
    setIndexBarrier = vi.fn((barrier: () => Promise<void>) => { this.indexBarrier = barrier; });
    indexBarrier: (() => Promise<void>) | null = null;
    prefetchFile = vi.fn();
    prefetchFiles = vi.fn();
    focusPlayback = vi.fn(async () => {});
    markPlaybackStable = vi.fn(async () => {});
    releasePlaybackFocus = vi.fn(async () => {});
    streamFile = vi.fn();
    disconnect = vi.fn(async () => {});

    constructor(candidates: Candidate[]) {
      this.candidates = candidates;
      transports.push(this);
    }
  }

  class FakeSources {
    transport: any;
    prefetch = vi.fn((_: string, messageId: number) => {
      const pending = prefetchDeferred.get(messageId) || deferred(messageId);
      return pending.promise;
    });
    releaseAll = vi.fn();

    constructor(transport: any) {
      this.transport = transport;
      sources.push(this);
    }
  }

  return { transports, sources, prefetchDeferred, deferred, FakeTransport, FakeSources };
});

vi.mock("../../src/features/cloud/webGalerCloudTransport", () => ({
  WebGalerCloudTransport: harness.FakeTransport,
}));

vi.mock("../../src/features/playback/webPlaybackSource", () => ({
  WebPlaybackSourceManager: harness.FakeSources,
}));

import { WebStartupPlaybackCoordinator } from "../../src/features/playback/webStartupPlaybackCoordinator";
import { updatePlaybackRoutingCacheFromManifest, updatePlaybackRoutingSort } from "../../src/features/playback/webPlaybackRoutingCache";
import { WEB_TRANSPORT_INVALIDATED_EVENT } from "../../src/features/cloud/webTransportEvents";

function manifestBeat(index: number) {
  return {
    id: `beat-${index}`,
    name: `Beat ${index}`,
    bpm: 80 + index,
    rating: 100 - index,
    master: {
      telegram_message_id: 1000 + index,
      mime: "audio/mpeg",
      size: 200000,
    },
  };
}

describe("WebStartupPlaybackCoordinator behavior", () => {
  beforeEach(() => {
    localStorage.clear();
    harness.transports.length = 0;
    harness.sources.length = 0;
    harness.prefetchDeferred.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts exactly one Direct connection with zero candidates and opens the INDEX barrier", async () => {
    const coordinator = new WebStartupPlaybackCoordinator();
    const transport = harness.transports[0];

    const a = coordinator.start();
    const b = coordinator.start();
    expect(a).toBe(b);
    await expect(a).resolves.toBeUndefined();
    expect(transport.candidates).toEqual([]);
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledOnce();
    await expect(coordinator.waitUntilIndexAllowed()).resolves.toBeUndefined();
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("captures fourteen local candidates once and keeps INDEX closed until every candidate reaches READY or FAILED", async () => {
    updatePlaybackRoutingCacheFromManifest({
      beats: Array.from({ length: 20 }, (_, index) => manifestBeat(index + 1)),
      trash: [],
      deleted: [],
    });
    updatePlaybackRoutingSort("manual");

    for (let index = 1; index <= 14; index += 1) harness.deferred(1000 + index);
    const coordinator = new WebStartupPlaybackCoordinator();
    const transport = harness.transports[0];
    const source = harness.sources[0];

    expect(transport.candidates).toHaveLength(14);
    expect(transport.candidates.map((candidate: any) => candidate.messageId)).toEqual(
      Array.from({ length: 14 }, (_, index) => 1001 + index),
    );

    const startup = coordinator.start();
    const barrier = coordinator.waitUntilIndexAllowed();
    let barrierSettled = false;
    void barrier.then(() => { barrierSettled = true; });

    await vi.waitFor(() => expect(source.prefetch).toHaveBeenCalledTimes(14));
    for (let index = 1; index <= 13; index += 1) harness.prefetchDeferred.get(1000 + index)!.resolve();
    await Promise.resolve();
    expect(barrierSettled).toBe(false);

    // FAILED is a valid individual terminal for the startup barrier. It must not
    // wait for the rest of the batch completion object or masquerade as READY.
    harness.prefetchDeferred.get(1014)!.reject(Object.assign(new Error("missing"), { code: "ROUTE_MISSING" }));
    await expect(startup).resolves.toBeUndefined();
    await expect(barrier).resolves.toBeUndefined();
    expect(barrierSettled).toBe(true);
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("retries a transient Direct startup failure without creating a second coordinator or changing its candidate set", async () => {
    updatePlaybackRoutingCacheFromManifest({ beats: [manifestBeat(1)], trash: [], deleted: [] });
    harness.deferred(1001).resolve();
    const coordinator = new WebStartupPlaybackCoordinator();
    const transport = harness.transports[0];
    transport.connectPlaybackDataPlane.mockRejectedValueOnce(new Error("temporary transport failure"));

    await expect(coordinator.start()).rejects.toThrow("temporary transport failure");
    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledTimes(2);
    expect(transport.candidates.map((candidate: any) => candidate.messageId)).toEqual([1001]);
    coordinator.dispose();
  });

  it("purges SourceManager state on transport invalidation and detaches the listener on dispose", () => {
    const coordinator = new WebStartupPlaybackCoordinator();
    const source = harness.sources[0];

    window.dispatchEvent(new Event(WEB_TRANSPORT_INVALIDATED_EVENT));
    expect(source.releaseAll).toHaveBeenCalledOnce();

    coordinator.dispose();
    source.releaseAll.mockClear();
    window.dispatchEvent(new Event(WEB_TRANSPORT_INVALIDATED_EVENT));
    expect(source.releaseAll).not.toHaveBeenCalled();
  });
});
