// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApi: vi.fn<() => Promise<string>>(),
  getResolvedBase: vi.fn(() => "http://sync-fallback.invalid"),
}));
vi.mock("../../src/features/auth/webSession", async importOriginal => ({
  ...(await importOriginal<object>()),
  getBeatGalerAuthToken: () => "session-token",
  resolveBeatGalerCloudApi: mocks.resolveApi,
  getResolvedCloudApiBase: mocks.getResolvedBase,
}));
vi.mock("../../src/lib/tauri", async importOriginal => ({
  ...(await importOriginal<object>()),
  flushOfflineTrashIntents: vi.fn(async () => 0),
  getCloudClientId: () => "desktop-client",
  isTauriAvailable: false,
  pollTelegramCloudStatus: vi.fn(async () => ({ connected: false, reachable: true, username: null })),
}));

import { useCloudLibraryEvents } from "../../src/features/cloud/useCloudLibraryEvents";
import { readWebCsrfToken, WEB_CSRF_SESSION_KEY } from "../../src/features/auth/webSessionBootstrap";

const noop = () => {};
const ref = <T,>(value: T) => ({ current: value });

function Probe() {
  useCloudLibraryEvents({
    setupDone: true,
    beatgalerUserId: "user-1",
    setConnectionState: noop,
    setCloudSessionVerified: noop,
    setSettings: noop,
    setBeats: noop,
    getActiveUploadIds: () => new Set<string>(),
    getUploadRevision: () => 0,
    cloudMetaSnapshotRef: ref(null),
    cloudLibrarySnapshotRef: ref(null),
    visibleLibraryFingerprintRef: ref(""),
    startupCookingResolvedRef: ref(false),
    startupPipelineStartedRef: ref(false),
    startupEnginePrimeReadyRef: ref(false),
    progressiveRevealRunRef: ref(0),
    clearReconciledTrashRuntimeStates: noop,
    clearArtworkHydration: noop,
    clearPlaybackPreparation: noop,
    setStartupCookingGate: noop,
  });
  return null;
}

describe("Web startup Cloud resolution race", () => {
  const sources: string[] = [];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", class { constructor(url: string) { sources.push(url); } addEventListener() {} removeEventListener() {} close() {} });
  });
  afterEach(() => {
    sources.length = 0;
    vi.unstubAllGlobals();
    mocks.resolveApi.mockReset();
  });

  it("resolves the Cloud API inside the event ticket connection attempt, and uses it for ticket and stream", async () => {
    let release!: (base: string) => void;
    mocks.resolveApi.mockReturnValue(new Promise<string>(resolve => { release = resolve; }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket: "t1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(createElement(Probe)); });

    // Discovery still pending: no ticket request may go to a synchronous fallback origin.
    expect(mocks.resolveApi).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { release("https://resolved.example/beatgaler-api"); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://resolved.example/beatgaler-api/events/ticket");
    expect(sources).toHaveLength(1);
    expect(sources[0].startsWith("https://resolved.example/beatgaler-api/events?")).toBe(true);
    expect(mocks.getResolvedBase).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("reads the CSRF token from the current-origin cookie before the stored fallback", () => {
    const cookie = vi.spyOn(document, "cookie", "get");
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "stale-stored");
    try {
      cookie.mockReturnValue("other=1; __Host-beatgaler_csrf=cookie%20token");
      expect(readWebCsrfToken()).toBe("cookie token");
      cookie.mockReturnValue("other=1");
      expect(readWebCsrfToken()).toBe("stale-stored");
    } finally {
      cookie.mockRestore();
      window.sessionStorage.removeItem(WEB_CSRF_SESSION_KEY);
    }
  });
});
