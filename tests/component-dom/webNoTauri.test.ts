// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriSentinels = vi.hoisted(() => {
  const fail = (surface: string) => vi.fn(() => {
    throw new Error(`BeatGaler Web attempted to call Tauri ${surface}`);
  });
  return {
    invoke: fail("invoke"),
    convertFileSrc: fail("convertFileSrc"),
    listen: fail("event.listen"),
    shellOpen: fail("shell.open"),
    dialogOpen: fail("dialog.open"),
    fsExists: fail("fs.exists"),
    fsReadFile: fail("fs.readFile"),
    fsWriteFile: fail("fs.writeFile"),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriSentinels.invoke,
  convertFileSrc: tauriSentinels.convertFileSrc,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriSentinels.listen,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: tauriSentinels.shellOpen,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: tauriSentinels.dialogOpen,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: tauriSentinels.fsExists,
  readFile: tauriSentinels.fsReadFile,
  writeFile: tauriSentinels.fsWriteFile,
}));

import { webAdapter } from "../../src/platform/webAdapter";
import {
  beginWebPlaybackIntent,
  isCurrentWebPlaybackIntent,
  rememberPreparedWebPlaybackUrl,
  shouldAcceptWebPlaybackRequest,
} from "../../src/features/playback/webPlaybackIntent";

describe("BeatGaler Web no-Tauri contract", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("runs Web platform flows without invoking any Tauri surface", async () => {
    await webAdapter.preferences.setIncompleteWarnings(false);
    expect((await webAdapter.preferences.load()).incomplete_warnings_enabled).toBe(false);

    const eventHandler = vi.fn();
    const unlisten = await webAdapter.events.listen("beatgaler:web-contract", eventHandler);
    window.dispatchEvent(new CustomEvent("beatgaler:web-contract", { detail: { ok: true } }));
    expect(eventHandler).toHaveBeenCalledWith({ ok: true });
    unlisten();

    expect(await webAdapter.playbackCache.status()).toEqual({ used_bytes: 0, limit_mb: 100 });
    expect(await webAdapter.system.getLogDirectory()).toBe("");
    expect(await webAdapter.system.getTemplatesDirectory()).toBe("");
    await expect(webAdapter.system.revealPath("ignored")).rejects.toThrow("not available in BeatGaler Web yet");
    await expect(webAdapter.system.checkForUpdate()).rejects.toThrow("not available in BeatGaler Web yet");
    await expect(webAdapter.system.installUpdate()).rejects.toThrow("not available in BeatGaler Web yet");
    await webAdapter.cloudAuth.syncSession("web-token", "https://galer-cloud.test");
    await webAdapter.diagnostics.audioEvent("test", null, null, "web contract");

    for (const sentinel of Object.values(tauriSentinels)) {
      expect(sentinel).not.toHaveBeenCalled();
    }
  });

  it("rejects a previously prepared browser playback URL after cloud data disconnects", async () => {
    const intent = beginWebPlaybackIntent("browser-beat");
    const url = "blob:https://beatgaler.test/track";
    rememberPreparedWebPlaybackUrl(url, intent);
    expect(isCurrentWebPlaybackIntent(intent)).toBe(true);
    expect(shouldAcceptWebPlaybackRequest(intent.beatId, [url])).toBe(true);

    await webAdapter.cloudData.disconnect();

    expect(isCurrentWebPlaybackIntent(intent)).toBe(false);
    expect(shouldAcceptWebPlaybackRequest(intent.beatId, [url])).toBe(false);
  });
});
