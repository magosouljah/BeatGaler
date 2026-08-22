// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/components/AccountGate", () => ({
  beginMfaSetup: vi.fn(async () => ({ secret: "TEST" })),
  changeBeatGalerEmail: vi.fn(),
  changeBeatGalerPassword: vi.fn(),
  disableMfa: vi.fn(),
  disconnectOAuthProvider: vi.fn(),
  enableMfa: vi.fn(),
  getBeatGalerAccountInfo: vi.fn(async () => ({
    id: "web-user",
    username: "web#0001",
    email: "web@example.test",
    storage_ready: true,
    providers: {},
    plan: { label: "Free", quotas: {}, entitlements: {} },
  })),
  getBeatGalerPlanCatalog: vi.fn(async () => []),
  devSwitchBeatGalerPlan: vi.fn(),
  oauthBeatGalerAccount: vi.fn(),
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

import SettingsPanel from "../../src/components/SettingsPanel";
import { webAdapter } from "../../src/platform/webAdapter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BeatGaler Web platform shell", () => {
  beforeEach(() => localStorage.clear());

  it("loads an authenticated browser shell without Desktop bootstrap", async () => {
    const snapshot = await webAdapter.startup.loadAuthenticatedShell();

    expect(snapshot).not.toBeNull();
    expect(snapshot?.connectionState).toBe("online");
    expect(snapshot?.libraryVerified).toBe(true);
    expect(snapshot?.settings.telegram_cloud_connected).toBe(true);
    expect(snapshot?.settings.beatgaler_user_id).toMatch(/^beatgaler-web-/);
    expect(snapshot?.beats).toEqual([]);
  });

  it("persists shared browser preferences", async () => {
    await webAdapter.preferences.setIncompleteWarnings(false);
    await webAdapter.preferences.setCustomCursor(false);

    const settings = await webAdapter.preferences.load();
    expect(settings.incomplete_warnings_enabled).toBe(false);
    expect(settings.custom_cursor_enabled).toBe(false);
  });

  it("renders shared Settings and hides unfinished Desktop sections", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<SettingsPanel
        currentFolder={null}
        showIncompleteWarnings
        onIncompleteWarningsChanged={() => undefined}
        customCursorEnabled
        onCustomCursorChanged={() => undefined}
        telegramConnected
        networkOnline
        telegramUsername={null}
        onDisconnectTelegram={async () => undefined}
        onClose={() => undefined}
        onFolderChanged={() => undefined}
      />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain("Account");
    expect(host.textContent).toContain("trash");
    expect(host.textContent).not.toContain("Tools (Dev)");

    const preferences = Array.from(host.querySelectorAll("button"))
      .find(button => button.textContent?.trim().toLowerCase() === "preferences");
    expect(preferences).toBeTruthy();
    await act(async () => preferences?.click());

    expect(host.textContent).toContain("Incomplete file warnings");
    expect(host.textContent).toContain("Custom cursor");
    expect(host.textContent).not.toContain("Playback cache");

    const trash = Array.from(host.querySelectorAll("button"))
      .find(button => button.textContent?.trim().toLowerCase() === "trash");
    expect(trash).toBeTruthy();
    await act(async () => trash?.click());
    expect(host.textContent).toContain("Trash is empty");
    expect(host.textContent).not.toContain("Presets");

    await act(async () => root.unmount());
    host.remove();
  });
});
