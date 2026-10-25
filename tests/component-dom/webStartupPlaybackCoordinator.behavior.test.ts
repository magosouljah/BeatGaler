import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Candidate = { beatId: string; messageId: number; mimeType: string; sizeBytes?: number | null };
  const transports: any[] = [];
  const sources: any[] = [];
  const prefetchDeferred = new Map<number, { promise: Promise<void>; resolve(): void; reject(error: Error): void }>();
  const resolveBeatGalerCloudApi = vi.fn<() => Promise<string>>();

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

    constructor(candidates: Candidate[] = []) {
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

  return { transports, sources, prefetchDeferred, deferred, resolveBeatGalerCloudApi, FakeTransport, FakeSources };
});

vi.mock("../../src/components/AccountGate", () => ({
  resolveBeatGalerCloudApi: harness.resolveBeatGalerCloudApi,
}));

vi.mock("../../src/features/cloud/webGalerCloudTransport", () => ({
  WebGalerCloudTransport: harness.FakeTransport,
}));

vi.mock("../../src/features/playback/webPlaybackSource", () => ({
  WebPlaybackSourceManager: harness.FakeSources,
}));

import { WebStartupPlaybackCoordinator } from "../../src/features/playback/webStartupPlaybackCoordinator";
import { updatePlaybackRoutingCacheFromManifest, updatePlaybackRoutingSort } from "../../src/features/playback/webPlaybackRoutingCache";
import { WEB_TRANSPORT_INVALIDATED_EVENT } from "../../src/features/cloud/webTransportEvents";
import { setActiveWebAccountId } from "../../src/features/auth/activeWebAccount";
import { saveCachedBeats } from "../../src/features/library/libraryPresentationCache";
import type { Beat } from "../../src/types";

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

function sourceCandidateIds(source: { prefetch: ReturnType<typeof vi.fn> }): number[] {
  return source.prefetch.mock.calls.map(call => Number(call[1]));
}

describe("WebStartupPlaybackCoordinator behavior", () => {
  beforeEach(() => {
    setActiveWebAccountId("user-A");
    localStorage.clear();
    harness.transports.length = 0;
    harness.sources.length = 0;
    harness.prefetchDeferred.clear();
    harness.resolveBeatGalerCloudApi.mockReset();
    harness.resolveBeatGalerCloudApi.mockResolvedValue("/beatgaler-api");
  });

  afterEach(() => {
    setActiveWebAccountId(null);
    vi.restoreAllMocks();
  });

  it("blocks Direct transport until the Cloud API has resolved", async () => {
    let releaseCloudResolution!: (value: string) => void;
    const cloudResolution = new Promise<string>(resolve => { releaseCloudResolution = resolve; });
    harness.resolveBeatGalerCloudApi.mockReturnValueOnce(cloudResolution);

    const coordinator = new WebStartupPlaybackCoordinator();
    const transport = harness.transports[0];
    const startup = coordinator.start();

    await Promise.resolve();
    expect(harness.resolveBeatGalerCloudApi).toHaveBeenCalledOnce();
    expect(transport.connectPlaybackDataPlane).not.toHaveBeenCalled();

    releaseCloudResolution("/beatgaler-api");
    await expect(startup).resolves.toBeUndefined();
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledOnce();
    coordinator.dispose();
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

  it("never prefetches A's route for empty B and reuses A's owned cache after return", async () => {
    saveCachedBeats([{ id: "beat-1", name: "A beat", telegram_message_id: 1001, tags: [], other_files: [] } as unknown as Beat]);
    updatePlaybackRoutingCacheFromManifest({ beats: [manifestBeat(1)], deleted: [], trash: [] });
    harness.deferred(1001).resolve();
    const firstA = new WebStartupPlaybackCoordinator();
    await firstA.start();
    expect(sourceCandidateIds(harness.sources[0])).toEqual([1001]);
    firstA.dispose();

    // Simulate logout and a B key polluted with A's otherwise valid entries.
    setActiveWebAccountId(null);
    const aLibrary = localStorage.getItem("beatvault:library:v2:user-A")!;
    const aRouting = localStorage.getItem("beatgaler:web-playback-routing:v2:user-A")!;
    setActiveWebAccountId("user-B");
    localStorage.setItem("beatvault:library:v2:user-B", aLibrary);
    localStorage.setItem("beatgaler:web-playback-routing:v2:user-B", aRouting);
    const emptyB = new WebStartupPlaybackCoordinator();
    await emptyB.start();
    expect(sourceCandidateIds(harness.sources[1])).toEqual([]);
    emptyB.dispose();

    setActiveWebAccountId(null);
    setActiveWebAccountId("user-A");
    const returnedA = new WebStartupPlaybackCoordinator();
    await returnedA.start();
    expect(sourceCandidateIds(harness.sources[2])).toEqual([1001]);
    returnedA.dispose();
  });

  it("captures fourteen local candidates once but opens INDEX as soon as Direct is connected", async () => {
    localStorage.setItem("beatvault:sort:v2", "manual");
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

    expect(transport.candidates).toEqual([]);

    const startup = coordinator.start();
    let startupSettled = false;
    void startup.then(() => { startupSettled = true; });

    await vi.waitFor(() => expect(source.prefetch).toHaveBeenCalledTimes(14));
    expect(source.prefetch.mock.calls.map((call: any[]) => call[1])).toEqual(Array.from({ length: 14 }, (_, index) => 1001 + index));
    await expect(coordinator.waitUntilIndexAllowed()).resolves.toBeUndefined();
    expect(startupSettled).toBe(false);
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledOnce();

    for (let index = 1; index <= 13; index += 1) harness.prefetchDeferred.get(1000 + index)!.resolve();
    harness.prefetchDeferred.get(1014)!.reject(Object.assign(new Error("missing"), { code: "ROUTE_MISSING" }));
    await expect(startup).resolves.toBeUndefined();
    expect(startupSettled).toBe(true);
    coordinator.dispose();
  });

  it("retries a transient Direct startup failure without creating a second coordinator or changing its candidate set", async () => {
    localStorage.setItem("beatvault:sort:v2", "manual");
    updatePlaybackRoutingCacheFromManifest({ beats: [manifestBeat(1)], trash: [], deleted: [] });
    updatePlaybackRoutingSort("manual");
    harness.deferred(1001).resolve();
    const coordinator = new WebStartupPlaybackCoordinator();
    const transport = harness.transports[0];
    transport.connectPlaybackDataPlane.mockRejectedValueOnce(new Error("temporary transport failure"));

    await expect(coordinator.start()).rejects.toThrow("temporary transport failure");
    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledTimes(2);
    expect(sourceCandidateIds(harness.sources[0])).toEqual([1001]);
    coordinator.dispose();
  });

  it("connects before identity and warms only confirmed account routes without a second connection", async () => {
    setActiveWebAccountId("user-A");
    updatePlaybackRoutingCacheFromManifest({ beats: [manifestBeat(1)], trash: [], deleted: [] });
    setActiveWebAccountId(null);
    const coordinator = new WebStartupPlaybackCoordinator();
    const transport = harness.transports[0];
    const source = harness.sources[0];
    await coordinator.prepareConnection();
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledOnce();
    expect(source.prefetch).not.toHaveBeenCalled();

    setActiveWebAccountId("user-A");
    harness.deferred(1001).resolve();
    await coordinator.start();
    expect(sourceCandidateIds(source)).toEqual([1001]);
    expect(transport.connectPlaybackDataPlane).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("does not prefetch A media when its connection finishes after switching to B", async () => {
    updatePlaybackRoutingCacheFromManifest({ beats: [manifestBeat(1)], trash: [], deleted: [] });
    const coordinator = new WebStartupPlaybackCoordinator();
    const transport = harness.transports[0];
    const source = harness.sources[0];
    let finishConnection!: () => void;
    transport.connectPlaybackDataPlane.mockImplementationOnce(() => new Promise<void>(resolve => { finishConnection = resolve; }));

    const startup = coordinator.start();
    await vi.waitFor(() => expect(transport.connectPlaybackDataPlane).toHaveBeenCalledOnce());
    setActiveWebAccountId(null);
    setActiveWebAccountId("user-B");
    finishConnection();

    await expect(startup).rejects.toThrow("Account changed before playback prefetch.");
    expect(source.prefetch).not.toHaveBeenCalled();
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
