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

vi.mock("../../src/features/cloud/webGalerCloudTransport", () => ({
  WebGalerCloudTransport: class {
    getLibraryIndex = vi.fn(async () => ({
      messageId: null,
      manifest: { schema: "beatgaler.telegram.library", version: 2, beats: [], trash: [] },
    }));
    downloadFiles = vi.fn(async () => []);
    listTrashItems = vi.fn(async () => []);
    moveBeatsToTrash = vi.fn(async () => []);
    restoreBeatFromTrash = vi.fn();
    purgeTrash = vi.fn(async () => 0);
    upload = vi.fn();
    disconnect = vi.fn(async () => undefined);
  },
}));

import { webAdapter } from "../../src/platform/webAdapter";

describe("BeatGaler Web no-Tauri contract", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("runs Web platform flows without invoking any Tauri surface", async () => {
    const snapshot = await webAdapter.startup.loadAuthenticatedShell();
    expect(snapshot?.libraryVerified).toBe(true);
    expect(snapshot?.beats).toEqual([]);

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
});
