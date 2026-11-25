// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformMock = vi.hoisted(() => ({
  platform: {
    kind: "web" as string,
    events: { listen: vi.fn(async () => () => {}) },
    library: { restoreAuthoritative: vi.fn(), load: vi.fn(), commitSnapshot: vi.fn() },
  },
}));
vi.mock("../../src/platform", () => platformMock);

import { flushOfflineTrashIntents, getSettings, getTelegramCloudStatus, pollTelegramCloudStatus } from "../../src/lib/tauri";
import { getWebClientId } from "../../src/lib/webClientId";
import { useBeatDownloads } from "../../src/features/downloads/useBeatDownloads";
import { libraryStateManager } from "../../src/lib/libraryStateManager";

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(value);
}

beforeEach(() => {
  localStorage.clear();
  delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

afterEach(() => {
  vi.restoreAllMocks();
  platformMock.platform.kind = "web";
  platformMock.platform.events.listen.mockClear();
});

describe("Web startup bridge without Tauri (M10: comportamiento)", () => {
  it("answers the settings the Web shell needs with the stable installation id and a connected Cloud", async () => {
    const settings = await getSettings();
    expect(settings.beatgaler_user_id).toBe(getWebClientId());
    expect(settings.beatgaler_user_id).toMatch(/^beatgaler-web-/);
    expect(await getSettings()).toMatchObject({ beatgaler_user_id: settings.beatgaler_user_id, telegram_cloud_connected: true, telegram_cloud_username: null });
  });

  it("reports Cloud connectivity from the browser, never as disconnected", async () => {
    setOnline(true);
    expect(await pollTelegramCloudStatus()).toEqual({ connected: true, reachable: true, username: null });
    expect(await getTelegramCloudStatus()).toEqual({ connected: true, reachable: true, username: null });
    setOnline(false);
    expect(await pollTelegramCloudStatus()).toEqual({ connected: true, reachable: false, username: null });
    expect(await getTelegramCloudStatus()).toEqual({ connected: true, reachable: false, username: null });
  });

  it("does not throw through the Desktop offline-trash bridge during Web startup", async () => {
    await expect(flushOfflineTrashIntents()).resolves.toBe(0);
  });

  it("restores the authoritative library through the platform before loading it", async () => {
    const order: string[] = [];
    platformMock.platform.library.restoreAuthoritative.mockImplementation(async () => { order.push("restore"); });
    platformMock.platform.library.load.mockImplementation(async () => { order.push("load"); return [{ id: "b1", tags: [] }]; });
    const beats = await libraryStateManager.reloadAuthoritative();
    expect(order).toEqual(["restore", "load"]);
    expect(beats.map(beat => beat.id)).toEqual(["b1"]);
  });

  describe("native background-download listener", () => {
    let host: HTMLDivElement;
    let root: Root;

    async function mountDownloads() {
      function Probe() {
        useBeatDownloads({ connectionState: "online", beatRuntimeStatesRef: { current: new Map() } as never, transitionRuntime: vi.fn() as never });
        return null;
      }
      host = document.createElement("div");
      root = createRoot(host);
      await act(async () => { root.render(<Probe />); });
    }

    afterEach(async () => { await act(async () => { root.unmount(); }); });

    it("is never attached in the Web build", async () => {
      await mountDownloads();
      expect(platformMock.platform.events.listen).not.toHaveBeenCalled();
    });

    it("is attached on Desktop for the native download event", async () => {
      platformMock.platform.kind = "desktop";
      await mountDownloads();
      expect(platformMock.platform.events.listen).toHaveBeenCalledExactlyOnceWith("beatgaler-download-event", expect.any(Function));
    });
  });
});
