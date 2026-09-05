import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

const harness = vi.hoisted(() => {
  const prepare = vi.fn();
  const prefetch = vi.fn(async () => ({ prefix: new ArrayBuffer(64), totalBytes: 64 }));
  const refresh = vi.fn();
  const start = vi.fn(async () => {});
  const releaseAll = vi.fn();
  return { prepare, prefetch, refresh, start, releaseAll };
});

vi.mock("../../src/features/playback/webStartupPlaybackCoordinator", () => ({
  getWebStartupPlaybackCoordinator: () => ({
    start: harness.start,
    getTransport: () => ({}),
    getPlaybackSources: () => ({
      prepare: harness.prepare,
      prefetch: harness.prefetch,
      setPrefetchPriority() {},
      cacheStatus: () => ({ used_bytes: 0, limit_mb: 100 }),
      setCacheLimitMb: (limit_mb: number) => ({ used_bytes: 0, limit_mb }),
      clearCache: () => ({ used_bytes: 0, limit_mb: 100 }),
      forget() {},
      release() {},
      releaseAll: harness.releaseAll,
      updatePlaybackState() {},
    }),
  }),
  disconnectWebStartupPlaybackCoordinator: vi.fn(async () => {}),
}));

vi.mock("../../src/features/library/webLibraryWindow", () => ({
  WebLibraryWindowConsumer: class {
    refresh = harness.refresh;
    currentOrFirst = harness.refresh;
    at = harness.refresh;
  },
}));

vi.mock("../../src/features/playback/webVisiblePlaybackPrefetch", () => ({
  installBeatCardWarmObserver: () => () => {},
}));

function beat(messageId: number): Beat {
  return {
    id: "beat-x",
    name: "X",
    bpm: "120",
    key: "Cm",
    tags: [],
    rating: 0,
    color: "#111111",
    color2: "#222222",
    telegram_message_id: messageId,
    telegram_file_id: `direct:${messageId}`,
    playback_path: "",
    mp3_path: "",
    wav_path: null,
    image_base64: null,
    assets: {
      master: {
        object_id: `direct:${messageId}`,
        mime_type: "audio/mpeg",
        size_bytes: 100000,
      },
    },
  } as Beat;
}

function snapshot(beats: Beat[]) {
  return {
    beats,
    offset: 0,
    nextOffset: null,
    totalVisible: beats.length,
    materializedCount: beats.length,
    previousOffset: null,
    evidence: {
      pageSize: 60,
      totalVisible: beats.length,
      materializedCount: beats.length,
      maxMaterializedCount: beats.length,
      pageLoads: 1,
      avoidedRichMaterializations: 0,
      richMaterializationRatio: beats.length > 0 ? 1 : 0,
    },
  };
}

async function seedAuthoritativeRoute(messageId: number): Promise<void> {
  const { updatePlaybackRoutingCacheFromManifest } = await import("../../src/features/playback/webPlaybackRoutingCache");
  updatePlaybackRoutingCacheFromManifest({
    beats: [{
      id: "beat-x",
      name: "X",
      bpm: 120,
      rating: 0,
      master: {
        telegram_message_id: messageId,
        mime: "audio/mpeg",
        size: 100000,
      },
    }],
    deleted: [],
    trash: [],
  });
}

function routeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("Web stale playback route recovery", () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    harness.prepare.mockReset();
    harness.prefetch.mockClear();
    harness.refresh.mockReset();
    harness.start.mockClear();
    harness.releaseAll.mockClear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("reconciles 1500 missing to 1900 and performs exactly one current-intent retry", async () => {
    await seedAuthoritativeRoute(1500);
    const repairedBeat = beat(1900);
    harness.refresh.mockImplementation(async () => {
      await seedAuthoritativeRoute(1900);
      return snapshot([repairedBeat]);
    });
    harness.prepare
      .mockRejectedValueOnce(routeError("ROUTE_MISSING"))
      .mockResolvedValueOnce({ url: "blob:repaired", completed: Promise.resolve() });

    const reconciled = vi.fn();
    window.addEventListener("beatgaler:web-library-reconciled", reconciled);
    const { webAdapter } = await import("../../src/platform/webAdapter");
    const prepared = await webAdapter.media.preparePlayback(beat(1500));
    window.removeEventListener("beatgaler:web-library-reconciled", reconciled);

    expect(prepared.url).toBe("blob:repaired");
    expect(harness.prepare).toHaveBeenCalledTimes(2);
    expect(harness.prepare.mock.calls.map(call => call[1])).toEqual([1500, 1900]);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(reconciled).toHaveBeenCalledTimes(1);
    expect((reconciled.mock.calls[0][0] as CustomEvent).detail.beats).toEqual([repairedBeat]);
  });

  it("removes an authoritatively deleted beat and never loops or retries the stale route", async () => {
    await seedAuthoritativeRoute(1500);
    harness.refresh.mockImplementation(async () => {
      const { updatePlaybackRoutingCacheFromManifest } = await import("../../src/features/playback/webPlaybackRoutingCache");
      updatePlaybackRoutingCacheFromManifest({ beats: [], deleted: [{ id: "beat-x" }], trash: [] });
      return snapshot([]);
    });
    harness.prepare.mockRejectedValueOnce(routeError("ROUTE_MISSING"));

    const reconciled = vi.fn();
    window.addEventListener("beatgaler:web-library-reconciled", reconciled);
    const { webAdapter } = await import("../../src/platform/webAdapter");
    await expect(webAdapter.media.preparePlayback(beat(1500))).rejects.toMatchObject({ code: "ROUTE_MISSING" });
    window.removeEventListener("beatgaler:web-library-reconciled", reconciled);

    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(reconciled).toHaveBeenCalledTimes(1);
    expect((reconciled.mock.calls[0][0] as CustomEvent).detail.beats).toEqual([]);
    const { readWebPlaybackRoutingCache } = await import("../../src/features/playback/webPlaybackRoutingCache");
    expect(readWebPlaybackRoutingCache().routes["beat-x"]).toBeUndefined();
  });

  it("does not reinterpret a transport failure as a stale route or delete authority", async () => {
    await seedAuthoritativeRoute(1500);
    harness.prepare.mockRejectedValueOnce(routeError("TRANSFER_FAILED"));
    const { webAdapter } = await import("../../src/platform/webAdapter");

    await expect(webAdapter.media.preparePlayback(beat(1500))).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    const { readWebPlaybackRoutingCache } = await import("../../src/features/playback/webPlaybackRoutingCache");
    expect(readWebPlaybackRoutingCache().routes["beat-x"]?.messageId).toBe(1500);
  });
});