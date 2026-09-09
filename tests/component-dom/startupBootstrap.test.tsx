// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, Beat } from "../../src/types";
import type { ConnectionState } from "../../src/features/session/useSessionState";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  loadOfflineLibrary: vi.fn(),
  pollTelegramCloudStatus: vi.fn(),
  flushOfflineTrashIntents: vi.fn(),
  purgeInterruptedUploadLocal: vi.fn(),
  repairStaleCloudLibraryRefs: vi.fn(),
  reloadAuthoritative: vi.fn(),
  readActiveCloudUploads: vi.fn(),
  rollbackInterruptedCloudUploads: vi.fn(),
  cleanupOrphanedDropStaging: vi.fn(),
  preserveLoadedArtwork: vi.fn(),
}));

vi.mock("../../src/components/AccountGate", () => ({
  getBeatGalerAuthToken: () => "token",
  getResolvedCloudApiBase: () => "http://cloud.test",
}));
vi.mock("../../src/lib/tauri", () => ({
  getSettings: mocks.getSettings,
  loadOfflineLibrary: mocks.loadOfflineLibrary,
  pollTelegramCloudStatus: mocks.pollTelegramCloudStatus,
  flushOfflineTrashIntents: mocks.flushOfflineTrashIntents,
  purgeInterruptedUploadLocal: mocks.purgeInterruptedUploadLocal,
  repairStaleCloudLibraryRefs: mocks.repairStaleCloudLibraryRefs,
}));
vi.mock("../../src/lib/libraryStateManager", () => ({
  libraryStateManager: { reloadAuthoritative: mocks.reloadAuthoritative },
}));
vi.mock("../../src/features/cloud/interruptedUploadJournal", () => ({
  readActiveCloudUploads: mocks.readActiveCloudUploads,
  rollbackInterruptedCloudUploads: mocks.rollbackInterruptedCloudUploads,
}));
vi.mock("../../src/features/dragdrop/dropStaging", () => ({
  cleanupOrphanedDropStaging: mocks.cleanupOrphanedDropStaging,
}));
vi.mock("../../src/features/library/libraryFingerprints", () => ({
  cloudBeatFingerprint: (beat: Beat) => `fp:${beat.id}`,
}));
vi.mock("../../src/features/library/libraryPresentationCache", () => ({
  preserveLoadedArtwork: mocks.preserveLoadedArtwork,
}));

import { useStartupBootstrap } from "../../src/features/startup/useStartupBootstrap";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latestBeats: Beat[] = [];
let latestConnection: ConnectionState = "checking";
let latestVerified = false;
let latestSetupDone = false;
let latestLoading = true;
let latestRevealed = new Set<string>();

function beat(id: string, cloud = true): Beat {
  return { id, name: id, tags: [], other_files: [], telegram_file_id: cloud ? `cloud-${id}` : undefined } as unknown as Beat;
}
const cached = beat("cached");
const remote = beat("remote");
const offline = beat("offline", false);
const settings: AppSettings = {
  beats_folder: null,
  incomplete_warnings_enabled: true,
  custom_cursor_enabled: true,
  beatgaler_user_id: "user-1",
  telegram_cloud_connected: true,
  telegram_cloud_username: "user",
};

function Harness({ initial }: { initial: Beat[] }) {
  const [beats, setBeats] = useState(initial);
  const [currentSettings, setSettings] = useState<AppSettings | null>(null);
  const [setupDone, setSetupDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connection, setConnectionState] = useState<ConnectionState>("checking");
  const [verified, setCloudSessionVerified] = useState(false);
  const [startupGate, setStartupCookingGate] = useState(initial.length === 0);
  const [revealed, setRevealedBeatIds] = useState<Set<string>>(() => new Set());
  const startupCachedBeatsRef = useRef<Beat[] | null>(initial);
  const cloudMetaSnapshotRef = useRef<Map<string, string> | null>(null);
  const cloudLibrarySnapshotRef = useRef<string | null>(null);
  const startupCookingResolvedRef = useRef(false);
  const startupPipelineStartedRef = useRef(false);
  const startupEnginePrimeReadyRef = useRef(false);
  const progressiveRevealRunRef = useRef(0);

  useStartupBootstrap({
    startupCachedBeatsRef,
    cloudMetaSnapshotRef,
    cloudLibrarySnapshotRef,
    startupCookingResolvedRef,
    startupPipelineStartedRef,
    startupEnginePrimeReadyRef,
    progressiveRevealRunRef,
    setBeats,
    setSettings,
    setSetupDone,
    setLoading,
    setConnectionState,
    setCloudSessionVerified,
    setStartupCookingGate,
    setRevealedBeatIds,
    clearReconciledTrashRuntimeStates: vi.fn(),
    dismissStartupLoader: () => document.getElementById("beatgaler-startup-loader")?.remove(),
  });

  latestBeats = beats;
  latestConnection = connection;
  latestVerified = verified;
  latestSetupDone = setupDone;
  latestLoading = loading;
  latestRevealed = revealed;
  void currentSettings;
  void startupGate;
  return <div>{beats.map(item => item.id).join(",")}</div>;
}

async function renderHarness(initial: Beat[], online = true) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness initial={initial} />); });
  await flushAsync();
}

async function flushAsync(rounds = 20) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.getSettings.mockReset().mockResolvedValue(settings);
  mocks.loadOfflineLibrary.mockReset().mockResolvedValue([]);
  mocks.pollTelegramCloudStatus.mockReset().mockResolvedValue({ connected: true, reachable: true, username: "user" });
  mocks.flushOfflineTrashIntents.mockReset().mockResolvedValue(0);
  mocks.purgeInterruptedUploadLocal.mockReset().mockResolvedValue(undefined);
  mocks.repairStaleCloudLibraryRefs.mockReset().mockResolvedValue(0);
  mocks.reloadAuthoritative.mockReset().mockResolvedValue([remote]);
  mocks.readActiveCloudUploads.mockReset().mockReturnValue([]);
  mocks.rollbackInterruptedCloudUploads.mockReset().mockResolvedValue([]);
  mocks.cleanupOrphanedDropStaging.mockReset().mockResolvedValue(undefined);
  mocks.preserveLoadedArtwork.mockReset().mockImplementation((incoming: Beat[]) => incoming);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.getElementById("beatgaler-startup-loader")?.remove();
});

describe("useStartupBootstrap", () => {
  it("loads authoritative beats on an online cold start without cache", async () => {
    await renderHarness([]);
    expect(latestBeats.map(item => item.id)).toEqual(["remote"]);
    expect(latestConnection).toBe("online");
    expect(latestVerified).toBe(true);
    expect(latestSetupDone).toBe(true);
    expect(latestLoading).toBe(false);
  });

  it("reveals only validated durable Offline beats on a cold offline start", async () => {
    mocks.loadOfflineLibrary.mockResolvedValue([offline]);
    await renderHarness([cached], false);
    expect(mocks.pollTelegramCloudStatus).not.toHaveBeenCalled();
    expect(latestBeats.map(item => item.id)).toEqual(["offline"]);
    expect(Array.from(latestRevealed)).toEqual(["offline"]);
    expect(latestConnection).toBe("offline");
    expect(latestVerified).toBe(false);
  });

  it("accepts an authoritative empty library instead of resurrecting cache", async () => {
    mocks.reloadAuthoritative.mockResolvedValue([]);
    await renderHarness([cached]);
    expect(latestBeats).toEqual([]);
    expect(latestVerified).toBe(true);
    expect(latestConnection).toBe("online");
  });

  it("preserves cached presentation when online authority stays temporarily unknown", async () => {
    mocks.reloadAuthoritative.mockRejectedValue(new Error("temporary authority failure"));
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 1;
    }) as typeof window.setTimeout);
    await renderHarness([cached]);
    await flushAsync();
    expect(mocks.reloadAuthoritative).toHaveBeenCalledTimes(3);
    expect(latestBeats.map(item => item.id)).toEqual(["cached"]);
    expect(latestConnection).toBe("poor");
    expect(latestVerified).toBe(false);
  });
});
