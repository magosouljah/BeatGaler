// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

const mocks = vi.hoisted(() => ({
  loadOfflineLibrary: vi.fn(),
  repairStaleCloudLibraryRefs: vi.fn(),
  reloadAuthoritative: vi.fn(),
  clearCachedBeats: vi.fn(),
  preserveLoadedArtwork: vi.fn(),
  deferLibraryReloadIfUploading: vi.fn(),
}));

vi.mock("../../src/lib/tauri", () => ({
  loadOfflineLibrary: mocks.loadOfflineLibrary,
  repairStaleCloudLibraryRefs: mocks.repairStaleCloudLibraryRefs,
}));

vi.mock("../../src/lib/libraryStateManager", () => ({
  libraryStateManager: {
    reloadAuthoritative: mocks.reloadAuthoritative,
  },
}));

vi.mock("../../src/features/library/libraryPresentationCache", () => ({
  clearCachedBeats: mocks.clearCachedBeats,
  preserveLoadedArtwork: mocks.preserveLoadedArtwork,
}));

vi.mock("../../src/features/library/libraryFingerprints", () => ({
  cloudBeatFingerprint: (beat: Beat) => `fp:${beat.id}`,
}));

import {
  useLibraryReload,
  type LibraryReloadController,
} from "../../src/features/library/useLibraryReload";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let controller: LibraryReloadController | null = null;
let latestBeats: Beat[] = [];
let latestConnectionState: "checking" | "online" | "poor" | "offline" = "checking";
let latestCloudSessionVerified = false;
let latestLoading = true;
let latestRevealed = new Set<string>();

function beat(id: string, cloud = true): Beat {
  return {
    id,
    name: id,
    tags: [],
    other_files: [],
    telegram_file_id: cloud ? `cloud-${id}` : undefined,
  } as unknown as Beat;
}

const cachedBeat = beat("cached");
const remoteBeat = beat("remote");

function Harness({ connected = true }: { connected?: boolean }) {
  const [beats, setBeats] = useState<Beat[]>([cachedBeat]);
  const beatsLatestRef = useRef<Beat[]>([cachedBeat]);
  const [connectionState, setConnectionState] =
    useState<"checking" | "online" | "poor" | "offline">("online");
  const [cloudSessionVerified, setCloudSessionVerified] = useState(true);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealedBeatIds] = useState<Set<string>>(
    () => new Set([cachedBeat.id])
  );
  const [startupCookingGate, setStartupCookingGate] = useState(true);
  const cloudMetaSnapshotRef = useRef<Map<string, string> | null>(null);
  const cloudLibrarySnapshotRef = useRef<string | null>(null);
  const startupCookingResolvedRef = useRef(false);
  const startupPipelineStartedRef = useRef(true);
  const progressiveRevealRunRef = useRef(0);

  controller = useLibraryReload({
    telegramCloudConnected: connected,
    beatsLatestRef,
    setBeats,
    setConnectionState,
    setCloudSessionVerified,
    cloudMetaSnapshotRef,
    cloudLibrarySnapshotRef,
    startupCookingResolvedRef,
    startupPipelineStartedRef,
    progressiveRevealRunRef,
    setRevealedBeatIds,
    setStartupCookingGate,
    setLoading,
    deferLibraryReloadIfUploading: mocks.deferLibraryReloadIfUploading,
  });

  latestBeats = beats;
  latestConnectionState = connectionState;
  latestCloudSessionVerified = cloudSessionVerified;
  latestLoading = loading;
  latestRevealed = revealed;
  void startupCookingGate;

  return (
    <div data-refreshing={controller.libraryRefreshing ? "yes" : "no"}>
      {beats.map(item => item.id).join(",")}
    </div>
  );
}

async function renderHarness(connected = true) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness connected={connected} />);
  });
}

async function startReload(): Promise<Promise<void>> {
  let pending!: Promise<void>;
  await act(async () => {
    pending = controller!.reloadLibrary();
    await Promise.resolve();
    await Promise.resolve();
  });
  return pending;
}

beforeEach(() => {
  mocks.loadOfflineLibrary.mockReset().mockResolvedValue([]);
  mocks.repairStaleCloudLibraryRefs.mockReset().mockResolvedValue(0);
  mocks.reloadAuthoritative.mockReset().mockResolvedValue([remoteBeat]);
  mocks.clearCachedBeats.mockReset();
  mocks.preserveLoadedArtwork
    .mockReset()
    .mockImplementation((incoming: Beat[]) => incoming);
  mocks.deferLibraryReloadIfUploading.mockReset().mockReturnValue(false);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  host?.remove();
  host = null;
  controller = null;
});

describe("useLibraryReload", () => {
  it("applies authoritative Reload and keeps the minimum refresh feedback", async () => {
    await renderHarness();

    const pending = await startReload();
    expect(controller!.libraryRefreshing).toBe(true);
    expect(mocks.reloadAuthoritative).toHaveBeenCalledTimes(1);

    await act(async () => {
      await pending;
    });

    expect(controller!.libraryRefreshing).toBe(false);
    expect(mocks.clearCachedBeats).toHaveBeenCalledTimes(1);
    expect(latestBeats.map(item => item.id)).toEqual(["remote"]);
    expect(latestConnectionState).toBe("online");
    expect(latestCloudSessionVerified).toBe(true);
    expect(latestLoading).toBe(false);
    expect(Array.from(latestRevealed).sort()).toEqual(["cached", "remote"]);
  });

  it("defers while uploads are active and consumes the queue event after drain", async () => {
    mocks.deferLibraryReloadIfUploading
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    await renderHarness();

    const deferredAttempt = await startReload();
    expect(controller!.libraryRefreshing).toBe(true);
    expect(mocks.reloadAuthoritative).not.toHaveBeenCalled();
    expect(mocks.clearCachedBeats).not.toHaveBeenCalled();

    await act(async () => {
      await deferredAttempt;
    });
    expect(controller!.libraryRefreshing).toBe(false);

    await act(async () => {
      window.dispatchEvent(new Event("beatgaler:deferred-library-reload"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.reloadAuthoritative).toHaveBeenCalledTimes(1);
    expect(controller!.libraryRefreshing).toBe(true);

    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 360));
    });

    expect(controller!.libraryRefreshing).toBe(false);
    expect(mocks.deferLibraryReloadIfUploading).toHaveBeenCalledTimes(2);
    expect(mocks.clearCachedBeats).toHaveBeenCalledTimes(1);
    expect(latestBeats.map(item => item.id)).toEqual(["remote"]);
  });

  it("retries authority four times and preserves the visible gallery on failure", async () => {
    mocks.reloadAuthoritative.mockRejectedValue(new Error("authority unavailable"));
    await renderHarness();

    const pending = await startReload();
    await act(async () => {
      await pending;
    });

    expect(mocks.reloadAuthoritative).toHaveBeenCalledTimes(4);
    expect(latestBeats.map(item => item.id)).toEqual(["cached"]);
    expect(latestConnectionState).toBe("poor");
    expect(latestCloudSessionVerified).toBe(false);
    expect(controller!.libraryRefreshing).toBe(false);
  });
});
