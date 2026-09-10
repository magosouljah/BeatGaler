import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { getResolvedCloudApiBase, resolveBeatGalerCloudApi, restoreBeatGalerSession } from "../../src/components/AccountGate";
import { reserveWebTransportSession } from "../../src/features/cloud/webTransportSession";
import { useCloudLibraryEvents } from "../../src/features/cloud/useCloudLibraryEvents";
import { platform } from "../../src/platform";
import * as tauri from "../../src/lib/tauri";
import { libraryStateManager } from "../../src/lib/libraryStateManager";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const API_KEY = "beatgaler:cloud-api:v1";
const proxy = `${window.location.origin}/beatgaler-api`;

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

describe("Web Cloud API origin in Vite development", () => {
  it.each(["http://127.0.0.1:4000", "https://desktop-7l93a0j.tailabe8ff.ts.net", "http://localhost:9999/beatgaler-api"])(
    "ignores stale %s before resolution and replaces it with the current origin proxy",
    async stale => {
      localStorage.setItem(API_KEY, stale);
      const fetch = vi.fn(async () => new Response(JSON.stringify({ account_auth: true })));
      vi.stubGlobal("fetch", fetch);
      // Transport can read the base synchronously before the async health probe finishes.
      expect(getResolvedCloudApiBase()).toBe(proxy);
      await expect(resolveBeatGalerCloudApi()).resolves.toBe(proxy);
      expect(localStorage.getItem(API_KEY)).toBe(proxy);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${proxy}/auth/health`]);
    },
  );

  it("uses the proxy with empty storage and never falls back to a direct origin on failure", async () => {
    expect(getResolvedCloudApiBase()).toBe(proxy);
    localStorage.setItem(API_KEY, "http://127.0.0.1:4000");
    const fetch = vi.fn(async () => { throw new TypeError("Proxy unavailable"); });
    vi.stubGlobal("fetch", fetch);
    await expect(resolveBeatGalerCloudApi()).rejects.toThrow("Could not reach BeatGaler Cloud.");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${proxy}/auth/health`]);
    expect(localStorage.getItem(API_KEY)).toBeNull();
    expect(getResolvedCloudApiBase()).toBe(proxy);
  });

  it("restores auth, starts transport and connects event-driven library loading through the proxy", async () => {
    localStorage.setItem(API_KEY, "http://127.0.0.1:4000");
    localStorage.setItem("beatgaler:web-session-present:v1", "1");
    vi.spyOn(platform.cloudAuth, "syncSession").mockResolvedValue(undefined);
    vi.spyOn(tauri, "pollTelegramCloudStatus").mockResolvedValue({ connected: true, reachable: true } as any);
    vi.spyOn(tauri, "flushOfflineTrashIntents").mockResolvedValue(0);
    const reload = vi.spyOn(libraryStateManager, "reloadAuthoritative").mockResolvedValue([]);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url.startsWith(`${proxy}/`)).toBe(true);
      const path = url.slice(proxy.length);
      if (path === "/auth/health") return Response.json({ account_auth: true });
      expect(init?.method).toBe("POST");
      if (path === "/auth/session") {
        expect(init?.credentials).toBe("include");
        return Response.json({ user: { id: "user-1", username: "test", storage_ready: true } });
      }
      if (path === "/transport/session/start") {
        expect(init?.credentials).toBe("include");
        return Response.json({ mode: "galer-direct-temp-mtproto", session_id: "test-session",
          temp_auth: { dc_id: 2, api_id: 1, expected_bot_id: "123" } });
      }
      if (path === "/events/ticket") return Response.json({ ticket: "test-ticket" });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    let eventUrl = "";
    let ready: EventListener | undefined;
    vi.stubGlobal("EventSource", class {
      constructor(url: string) { eventUrl = url; }
      addEventListener(type: string, handler: EventListener) { if (type === "ready") ready = handler; }
      removeEventListener() {}
      close() {}
    });
    await expect(restoreBeatGalerSession()).resolves.toMatchObject({ id: "user-1" });
    await expect(reserveWebTransportSession()).resolves.toMatchObject({ session_id: "test-session" });
    const verified = vi.fn();
    const noop = () => {};
    function Events() {
      useCloudLibraryEvents({ setupDone: true, beatgalerUserId: "user-1",
        setConnectionState: noop, setCloudSessionVerified: verified, setSettings: noop, setBeats: noop,
        cloudMetaSnapshotRef: { current: null }, cloudLibrarySnapshotRef: { current: null },
        visibleLibraryFingerprintRef: { current: "" }, startupCookingResolvedRef: { current: false },
        startupPipelineStartedRef: { current: false }, startupEnginePrimeReadyRef: { current: false },
        progressiveRevealRunRef: { current: 0 }, clearReconciledTrashRuntimeStates: noop,
        clearArtworkHydration: noop, clearPlaybackPreparation: noop, setStartupCookingGate: noop });
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Events)));
      expect(eventUrl.startsWith(`${proxy}/events?`)).toBe(true);
      expect(eventUrl).toContain("ticket=test-ticket");
      await act(async () => { ready!(new Event("ready")); });
      expect(reload).toHaveBeenCalledOnce();
      expect(verified).toHaveBeenCalledWith(true);
      for (const path of ["/auth/session", "/transport/session/start", "/events/ticket"]) {
        expect(fetch.mock.calls.some(([url]) => url === `${proxy}${path}`)).toBe(true);
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});
