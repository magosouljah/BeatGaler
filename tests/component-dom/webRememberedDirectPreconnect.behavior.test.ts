import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasRememberedWebSessionMarker: vi.fn(() => true),
  readWebCsrfToken: vi.fn((): string | null => "csrf-token"),
  start: vi.fn(() => Promise.resolve()),
  getWebStartupPlaybackCoordinator: vi.fn(),
  playTrace: vi.fn(),
}));

vi.mock("../../src/features/auth/webSessionBootstrap", () => ({
  hasRememberedWebSessionMarker: mocks.hasRememberedWebSessionMarker,
  readWebCsrfToken: mocks.readWebCsrfToken,
}));

vi.mock("../../src/features/playback/webStartupPlaybackCoordinator", () => ({
  getWebStartupPlaybackCoordinator: mocks.getWebStartupPlaybackCoordinator,
}));

vi.mock("../../src/features/playback/playTrace", () => ({
  playTrace: mocks.playTrace,
}));

import { preconnectRememberedWebDirect } from "../../src/features/playback/webRememberedDirectPreconnect";

describe("remembered Web Direct preconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasRememberedWebSessionMarker.mockReturnValue(true);
    mocks.readWebCsrfToken.mockReturnValue("csrf-token");
    mocks.start.mockReturnValue(Promise.resolve());
    mocks.getWebStartupPlaybackCoordinator.mockReturnValue({ start: mocks.start } as any);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("dispatches coordinator.start synchronously when remembered session and CSRF are already available", async () => {
    let resolveStart!: () => void;
    mocks.start.mockReturnValue(new Promise<void>(resolve => { resolveStart = resolve; }));

    preconnectRememberedWebDirect();

    expect(mocks.getWebStartupPlaybackCoordinator).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.playTrace).toHaveBeenCalledWith("DIRECT_REMEMBERED_PRECONNECT_BEGIN");
    expect(mocks.playTrace).not.toHaveBeenCalledWith("DIRECT_REMEMBERED_PRECONNECT_DISPATCHED");

    resolveStart();
    await Promise.resolve();
    expect(mocks.playTrace).toHaveBeenCalledWith("DIRECT_REMEMBERED_PRECONNECT_DISPATCHED");
  });

  it("does not construct Direct when CSRF is unavailable and leaves restore to recover it", () => {
    mocks.readWebCsrfToken.mockReturnValue(null);

    preconnectRememberedWebDirect();

    expect(mocks.getWebStartupPlaybackCoordinator).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.playTrace).toHaveBeenCalledWith(
      "DIRECT_REMEMBERED_PRECONNECT_DEFERRED",
      { reason: "csrf_unavailable" },
    );
  });

  it("never constructs the Web Direct transport from a Tauri/Desktop runtime", () => {
    (window as any).__TAURI_INTERNALS__ = {};

    preconnectRememberedWebDirect();

    expect(mocks.getWebStartupPlaybackCoordinator).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not dispatch without a remembered authenticated session or while offline", () => {
    mocks.hasRememberedWebSessionMarker.mockReturnValue(false);
    preconnectRememberedWebDirect();
    expect(mocks.start).not.toHaveBeenCalled();

    mocks.hasRememberedWebSessionMarker.mockReturnValue(true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    preconnectRememberedWebDirect();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
