import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import { WEB_PLAYBACK_ROUTE_RECOVERY_EVENT } from "../../src/features/playback/webPlaybackRouteRecoveryEvents";

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

function beat(messageId: number, id = "beat-x"): Beat {
  return {
    id,
    name: id === "beat-x" ? "X" : "Y",
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

async function seedTwoRoutes(xMessageId: number, yMessageId: number): Promise<void> {
  const { updatePlaybackRoutingCacheFromManifest } = await import("../../src/features/playback/webPlaybackRoutingCache");
  updatePlaybackRoutingCacheFromManifest({
    beats: [
      { id: "beat-x", name: "X", bpm: 120, rating: 0, master: { telegram_message_id: xMessageId, mime: "audio/mpeg", size: 100000 } },
      { id: "beat-y", name: "Y", bpm: 121, rating: 0, master: { telegram_message_id: yMessageId, mime: "audio/mpeg", size: 100000 } },
    ],
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

  it("recovers one async continuation route failure and publishes the repaired URL", async () => {
    await seedAuthoritativeRoute(1500);
    let rejectFirst!: (error: Error) => void;
    const firstCompleted = new Promise<void>((_, reject) => { rejectFirst = reject; });
    harness.refresh.mockImplementation(async () => {
      await seedAuthoritativeRoute(1900);
      return snapshot([beat(1900)]);
    });
    harness.prepare
      .mockResolvedValueOnce({ url: "blob:stale-prefix", completed: firstCompleted })
      .mockResolvedValueOnce({ url: "blob:repaired-stream", completed: Promise.resolve() });

    const recoveryEvents: Array<{ phase: string; url?: string }> = [];
    const onRecovery = (event: Event) => recoveryEvents.push((event as CustomEvent).detail);
    window.addEventListener(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, onRecovery);
    const { webAdapter } = await import("../../src/platform/webAdapter");
    const prepared = await webAdapter.media.preparePlayback(beat(1500));
    expect(prepared.url).toBe("blob:stale-prefix");

    rejectFirst(routeError("ROUTE_MISSING"));
    await expect(prepared.completed).resolves.toBeUndefined();
    window.removeEventListener(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, onRecovery);

    expect(harness.prepare.mock.calls.map(call => call[1])).toEqual([1500, 1900]);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(recoveryEvents.map(event => event.phase)).toEqual(["begin", "ready"]);
    expect(recoveryEvents.at(-1)?.url).toBe("blob:repaired-stream");
    const { readWebPlaybackRoutingCache } = await import("../../src/features/playback/webPlaybackRoutingCache");
    expect(readWebPlaybackRoutingCache().routes["beat-x"]?.messageId).toBe(1900);
    expect(readWebPlaybackRoutingCache().suspect?.["beat-x"]).toBeUndefined();
  });

  it("consumes the async route retry once and never loops after the repaired stream also fails", async () => {
    await seedAuthoritativeRoute(1500);
    let rejectFirst!: (error: Error) => void;
    let rejectRetry!: (error: Error) => void;
    const firstCompleted = new Promise<void>((_, reject) => { rejectFirst = reject; });
    const retryCompleted = new Promise<void>((_, reject) => { rejectRetry = reject; });
    harness.refresh.mockImplementation(async () => {
      await seedAuthoritativeRoute(1900);
      return snapshot([beat(1900)]);
    });
    harness.prepare
      .mockResolvedValueOnce({ url: "blob:stale-prefix", completed: firstCompleted })
      .mockResolvedValueOnce({ url: "blob:retry", completed: retryCompleted });

    const recoveryEvents: Array<{ phase: string }> = [];
    const onRecovery = (event: Event) => recoveryEvents.push((event as CustomEvent).detail);
    window.addEventListener(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, onRecovery);
    const { webAdapter } = await import("../../src/platform/webAdapter");
    const prepared = await webAdapter.media.preparePlayback(beat(1500));
    rejectFirst(routeError("ROUTE_MISSING"));
    await vi.waitFor(() => expect(recoveryEvents.map(event => event.phase)).toContain("ready"));
    rejectRetry(routeError("ROUTE_MISSING"));

    await expect(prepared.completed).rejects.toMatchObject({ code: "ROUTE_MISSING" });
    window.removeEventListener(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, onRecovery);
    expect(harness.prepare.mock.calls.map(call => call[1])).toEqual([1500, 1900]);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(recoveryEvents.map(event => event.phase)).toEqual(["begin", "ready", "failed"]);
  });

  it("keeps an unchanged authoritative route instead of deleting it when reconcile cannot repair it", async () => {
    await seedAuthoritativeRoute(1500);
    harness.refresh.mockImplementation(async () => {
      await seedAuthoritativeRoute(1500);
      return snapshot([beat(1500)]);
    });
    harness.prepare.mockRejectedValueOnce(routeError("ROUTE_MISSING"));

    const { webAdapter } = await import("../../src/platform/webAdapter");
    await expect(webAdapter.media.preparePlayback(beat(1500))).rejects.toMatchObject({ code: "ROUTE_MISSING" });
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    const { readWebPlaybackRoutingCache } = await import("../../src/features/playback/webPlaybackRoutingCache");
    expect(readWebPlaybackRoutingCache().routes["beat-x"]?.messageId).toBe(1500);
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

  it("lets a Y click supersede X while X is reconciling and never performs X's stale retry", async () => {
    await seedTwoRoutes(1500, 2000);
    let finishRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => { finishRefresh = resolve; });
    harness.refresh.mockImplementation(async () => {
      await refreshGate;
      await seedTwoRoutes(1900, 2000);
      return snapshot([beat(1900, "beat-x"), beat(2000, "beat-y")]);
    });
    harness.prepare.mockImplementation(async (beatId: string, messageId: number) => {
      if (beatId === "beat-x" && messageId === 1500) throw routeError("ROUTE_MISSING");
      if (beatId === "beat-y" && messageId === 2000) return { url: "blob:y", completed: Promise.resolve() };
      if (beatId === "beat-x" && messageId === 1900) return { url: "blob:x-retry", completed: Promise.resolve() };
      throw new Error(`unexpected prepare ${beatId}/${messageId}`);
    });

    const { webAdapter } = await import("../../src/platform/webAdapter");
    const x = webAdapter.media.preparePlayback(beat(1500, "beat-x"));
    await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledOnce());

    const y = await webAdapter.media.preparePlayback(beat(2000, "beat-y"));
    expect(y.url).toBe("blob:y");
    finishRefresh();
    const xResult = await x;

    expect(xResult.url).toMatch(/^beatgaler-superseded:\d+$/);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.prepare.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ["beat-x", 1500],
      ["beat-y", 2000],
    ]);
  });
});
