import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { desktopAdapter } from "../../src/platform/desktopAdapter";

describe("Desktop account adapter", () => {
  beforeEach(() => invokeMock.mockReset());

  it("preserves the persistent Desktop installation id", async () => {
    invokeMock.mockResolvedValueOnce({ beatgaler_user_id: "desktop-installation-id" });

    await expect(desktopAdapter.account.getInstallationId()).resolves.toBe("desktop-installation-id");
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("get_settings");
  });

  it("asks Desktop Cloud initialization to create a missing installation id", async () => {
    invokeMock
      .mockResolvedValueOnce({ beatgaler_user_id: null })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ beatgaler_user_id: "created-desktop-installation-id" });

    await expect(desktopAdapter.account.getInstallationId()).resolves.toBe("created-desktop-installation-id");
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "get_settings",
      "poll_telegram_cloud_status",
      "get_settings",
    ]);
  });
});
