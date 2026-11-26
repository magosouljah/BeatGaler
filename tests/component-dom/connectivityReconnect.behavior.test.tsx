// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poll = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/tauri")>()),
  pollTelegramCloudStatus: poll,
  flushOfflineTrashIntents: vi.fn(async () => 0),
}));

import { useConnectivity } from "../../src/features/session/useConnectivity";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const setConnectionState = vi.fn();
const setCloudSessionVerified = vi.fn();
const setSettings = vi.fn();
const setBeats = vi.fn();

function Harness() {
  const ref = <T,>(value: T) => React.useRef(value);
  const noop = () => undefined;
  useConnectivity({
    setupDone: true,
    setConnectionState, setCloudSessionVerified, setSettings, setBeats,
    getActiveUploadIds: () => new Set<string>(),
    getUploadRevision: () => 0,
    cloudMetaSnapshotRef: ref<Map<string, string> | null>(null),
    cloudLibrarySnapshotRef: ref<string | null>(null),
    startupCookingResolvedRef: ref(false),
    startupPipelineStartedRef: ref(false),
    startupEnginePrimeReadyRef: ref(false),
    progressiveRevealRunRef: ref(0),
    clearReconciledTrashRuntimeStates: noop,
    clearPlaybackPreparation: noop,
    clearArtworkHydration: noop,
    setStartupCookingGate: noop,
  });
  return null;
}

async function mountAndGoOnline() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
  await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0); });
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("reconnect after the browser comes back online (behavior)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of [poll, setConnectionState, setCloudSessionVerified, setSettings, setBeats]) fn.mockReset();
  });
  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove(); host = null; root = null;
    vi.useRealTimers();
  });

  it("retries the Telegram status with the bounded 0/1/2/5/10/30/60 s backoff and then settles as poor", async () => {
    poll.mockResolvedValue({ reachable: false, connected: false, username: null });
    await mountAndGoOnline();
    expect(poll).toHaveBeenCalledTimes(1);
    const steps = [1000, 2000, 5000, 10000, 30000, 60000];
    let expected = 1;
    for (const delay of steps) {
      await advance(delay - 1);
      expect(poll).toHaveBeenCalledTimes(expected);
      await advance(1);
      expected += 1;
      expect(poll).toHaveBeenCalledTimes(expected);
    }
    await advance(10 * 60_000);
    expect(poll).toHaveBeenCalledTimes(7);
    expect(setConnectionState).toHaveBeenLastCalledWith("poor");
  });

  it("treats an unreachable transport as poor connectivity, not as a logout, and logs out only when reachable but disconnected", async () => {
    poll
      .mockResolvedValueOnce({ reachable: false, connected: false, username: null })
      .mockResolvedValueOnce({ reachable: true, connected: false, username: null });
    await mountAndGoOnline();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(setConnectionState).toHaveBeenLastCalledWith("poor");
    expect(setBeats).not.toHaveBeenCalled();
    expect(setSettings).not.toHaveBeenCalled();
    expect(setCloudSessionVerified).not.toHaveBeenCalled();
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(setBeats).toHaveBeenCalledWith([]);
    expect(setCloudSessionVerified).toHaveBeenCalledWith(false);
    await advance(5 * 60_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});
