from pathlib import Path

ROOT = Path(".")
APP = ROOT / "src/App.tsx"
HOOK = ROOT / "src/features/library/useLibraryReload.ts"
COMPONENT_TEST = ROOT / "tests/component-dom/libraryReload.test.tsx"
INTEGRATION_TEST = ROOT / "tests/integration/appLibraryReloadExtraction.test.ts"
CHARACTERIZATION = ROOT / "tests/integration/appMigrationCharacterization.test.ts"
QUEUE_TEST = ROOT / "tests/integration/appCloudUploadQueueExtraction.test.ts"

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

app = APP.read_text()

app = replace_once(
    app,
    'import { loadLibrary, loadOfflineLibrary, flushOfflineTrashIntents, readBeatMeta, getSettings, saveBeatMeta, discardImportReviewBatch, uploadBeatToTelegram, downloadBeatFromTelegram, prepareBeatForPlayback, warmBeatForPlayback, getDownloadCookingStatus, downloadCookingDiagnosticEvent, uploadProjectToTelegram, uploadDroppedFileToTelegram, downloadCloudFileToCache, downloadProjectToCache, revealInExplorer, syncBeatMetadataToTelegram, repairStaleCloudLibraryRefs, pollTelegramCloudStatus, purgeInterruptedUploadLocal, getCloudClientId, copyExportFile, copyAudioMetadata, prepareUniqueExportFolder, type CloudFileType, isTauriAvailable } from "./lib/tauri";',
    'import { loadLibrary, loadOfflineLibrary, flushOfflineTrashIntents, readBeatMeta, getSettings, saveBeatMeta, discardImportReviewBatch, uploadBeatToTelegram, downloadBeatFromTelegram, prepareBeatForPlayback, warmBeatForPlayback, getDownloadCookingStatus, downloadCookingDiagnosticEvent, uploadProjectToTelegram, uploadDroppedFileToTelegram, downloadCloudFileToCache, downloadProjectToCache, revealInExplorer, syncBeatMetadataToTelegram, pollTelegramCloudStatus, purgeInterruptedUploadLocal, getCloudClientId, copyExportFile, copyAudioMetadata, prepareUniqueExportFolder, type CloudFileType, isTauriAvailable } from "./lib/tauri";',
    "App tauri import",
)
app = replace_once(
    app,
    'import { clearCachedBeats, clearUploadPreviewCache, preserveLoadedArtwork } from "./features/library/libraryPresentationCache";',
    'import { clearUploadPreviewCache, preserveLoadedArtwork } from "./features/library/libraryPresentationCache";',
    "App presentation-cache import",
)
app = replace_once(
    app,
    'import { useLibraryPresentationCache, useLibraryState } from "./features/library/useLibraryState";',
    'import { useLibraryPresentationCache, useLibraryState } from "./features/library/useLibraryState";\nimport { useLibraryReload } from "./features/library/useLibraryReload";',
    "App library reload import",
)
app = replace_once(
    app,
    '  const [libraryRefreshing, setLibraryRefreshing] = useState(false);\n',
    '',
    "App libraryRefreshing state",
)

queue_start = app.index("  } = useCloudUploadQueue({")
insert_marker = "\n\n  useEffect(() => {\n    let cancelled = false;"
insert_at = app.find(insert_marker, queue_start)
if insert_at < 0:
    raise SystemExit("Could not locate startup effect after useCloudUploadQueue")

reload_wiring = r'''
  const { libraryRefreshing, reloadLibrary } = useLibraryReload({
    telegramCloudConnected: Boolean(settings?.telegram_cloud_connected),
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
    deferLibraryReloadIfUploading,
  });
'''
app = app[:insert_at] + "\n\n" + reload_wiring.rstrip() + app[insert_at:]

reload_start = app.find("  const reloadLibrary = useCallback(async () => {")
bulk_start = app.find("  const applyBulkUpdate = useCallback", reload_start)
if reload_start < 0 or bulk_start < 0:
    raise SystemExit(f"Could not locate reload block: reload_start={reload_start}, bulk_start={bulk_start}")
app = app[:reload_start] + app[bulk_start:]

if "repairStaleCloudLibraryRefs" in app:
    raise SystemExit("App still contains repairStaleCloudLibraryRefs after extraction")
if "const reloadLibrary = useCallback" in app:
    raise SystemExit("App still owns reloadLibrary after extraction")
if 'window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)' in app:
    raise SystemExit("App still owns deferred reload listener after extraction")

APP.write_text(app)

HOOK.write_text(r'''import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Beat } from "../../types";
import { loadOfflineLibrary, repairStaleCloudLibraryRefs } from "../../lib/tauri";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { cloudBeatFingerprint } from "./libraryFingerprints";
import {
  clearCachedBeats,
  preserveLoadedArtwork,
} from "./libraryPresentationCache";

type ConnectionState = "checking" | "online" | "poor" | "offline";

type UseLibraryReloadInput = {
  telegramCloudConnected: boolean;
  beatsLatestRef: MutableRefObject<Beat[]>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setCloudSessionVerified: Dispatch<SetStateAction<boolean>>;
  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  startupCookingResolvedRef: MutableRefObject<boolean>;
  startupPipelineStartedRef: MutableRefObject<boolean>;
  progressiveRevealRunRef: MutableRefObject<number>;
  setRevealedBeatIds: Dispatch<SetStateAction<Set<string>>>;
  setStartupCookingGate: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  deferLibraryReloadIfUploading: () => boolean;
};

export type LibraryReloadController = {
  libraryRefreshing: boolean;
  reloadLibrary: () => Promise<void>;
};

export function useLibraryReload({
  telegramCloudConnected,
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
  deferLibraryReloadIfUploading,
}: UseLibraryReloadInput): LibraryReloadController {
  const [libraryRefreshing, setLibraryRefreshing] = useState(false);

  const reloadLibrary = useCallback(async () => {
    // Keep the existing visual feedback even when Reload must be deferred.
    const refreshStarted = performance.now();
    setLibraryRefreshing(true);

    const finishRefreshAnimation = async () => {
      const elapsed = performance.now() - refreshStarted;
      if (elapsed < 320) {
        await new Promise(resolve => window.setTimeout(resolve, 320 - elapsed));
      }
      setLibraryRefreshing(false);
    };

    try {
      // Queue ownership includes active IDs and the pending Reload marker.
      // The queue will emit beatgaler:deferred-library-reload after it drains.
      if (deferLibraryReloadIfUploading()) return;

      clearCachedBeats();
      const browserOffline =
        typeof navigator !== "undefined" && navigator.onLine === false;

      if (telegramCloudConnected && !browserOffline) {
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            // Reload remains an integrity pass: repair only references that the
            // authority definitively reports stale, then reload authoritative state.
            const repaired = await repairStaleCloudLibraryRefs().catch(error => {
              console.warn("Reload integrity probe deferred safely:", error);
              return 0;
            });
            if (repaired > 0) {
              console.warn(`[library-refresh] stale_refs_repaired=${repaired}`);
            }

            const restored = await libraryStateManager.reloadAuthoritative();
            cloudMetaSnapshotRef.current = new Map(
              restored
                .filter(beat => !!beat.telegram_file_id)
                .map(beat => [beat.id, cloudBeatFingerprint(beat)])
            );
            cloudLibrarySnapshotRef.current = restored
              .filter(beat => !!beat.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
            setConnectionState("online");

            // Replace committed state exactly as before while retaining decoded
            // artwork already visible in the presentation layer.
            const visible = preserveLoadedArtwork(restored, beatsLatestRef.current);
            beatsLatestRef.current = visible;
            setBeats(visible);

            startupCookingResolvedRef.current = true;
            startupPipelineStartedRef.current = false;
            progressiveRevealRunRef.current += 1;
            setRevealedBeatIds(current => {
              const next = new Set(current);
              for (const beat of visible) next.add(beat.id);
              return next;
            });
            setStartupCookingGate(false);
            setCloudSessionVerified(true);
            console.info(
              `[library-refresh] APPLIED beats=${visible.length} attempt=${attempt}`
            );
            return;
          } catch (error) {
            lastError = error;
            if (attempt < 4) {
              await new Promise(resolve =>
                window.setTimeout(resolve, 450 * attempt)
              );
            }
          }
        }

        // Authority is unknown, not empty. Preserve the gallery currently shown.
        console.warn(
          "Telegram library refresh failed after retries; preserving verified gallery:",
          lastError
        );
        setConnectionState("poor");
        setCloudSessionVerified(false);
        return;
      }

      const offline = await loadOfflineLibrary();
      if (browserOffline) {
        setConnectionState("offline");
        setCloudSessionVerified(false);
        if (beatsLatestRef.current.length === 0) {
          beatsLatestRef.current = offline;
          setBeats(offline);
        }
        return;
      }

      if (!telegramCloudConnected) {
        setCloudSessionVerified(false);
        beatsLatestRef.current = offline;
        setBeats(offline);
      }
    } catch (error) {
      console.error(error);
      setConnectionState(
        typeof navigator !== "undefined" && navigator.onLine === false
          ? "offline"
          : "poor"
      );
      setCloudSessionVerified(false);
    } finally {
      await finishRefreshAnimation();
      setLoading(false);
    }
  }, [
    beatsLatestRef,
    cloudLibrarySnapshotRef,
    cloudMetaSnapshotRef,
    deferLibraryReloadIfUploading,
    progressiveRevealRunRef,
    setBeats,
    setCloudSessionVerified,
    setConnectionState,
    setLoading,
    setRevealedBeatIds,
    setStartupCookingGate,
    startupCookingResolvedRef,
    startupPipelineStartedRef,
    telegramCloudConnected,
  ]);

  useEffect(() => {
    const runDeferredReload = () => {
      void reloadLibrary();
    };
    window.addEventListener(
      "beatgaler:deferred-library-reload",
      runDeferredReload
    );
    return () =>
      window.removeEventListener(
        "beatgaler:deferred-library-reload",
        runDeferredReload
      );
  }, [reloadLibrary]);

  return {
    libraryRefreshing,
    reloadLibrary,
  };
}
''')

COMPONENT_TEST.write_text(r'''// @vitest-environment jsdom
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
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

describe("useLibraryReload", () => {
  it("applies authoritative Reload and keeps the minimum refresh feedback", async () => {
    await renderHarness();

    const pending = await startReload();
    expect(controller!.libraryRefreshing).toBe(true);
    expect(mocks.reloadAuthoritative).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.runAllTimersAsync();
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
      await vi.runAllTimersAsync();
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
      await vi.runAllTimersAsync();
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
      await vi.runAllTimersAsync();
      await pending;
    });

    expect(mocks.reloadAuthoritative).toHaveBeenCalledTimes(4);
    expect(latestBeats.map(item => item.id)).toEqual(["cached"]);
    expect(latestConnectionState).toBe("poor");
    expect(latestCloudSessionVerified).toBe(false);
    expect(controller!.libraryRefreshing).toBe(false);
  });
});
''')

INTEGRATION_TEST.write_text(r'''import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const reload = readFileSync(
  resolve(process.cwd(), "src/features/library/useLibraryReload.ts"),
  "utf8"
);
const queue = readFileSync(
  resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"),
  "utf8"
);

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing Reload contract marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 9.2 library Reload extraction", () => {
  it("moves manual Reload, retries and deferred-event reception out of App", () => {
    expect(app).toContain('import { useLibraryReload } from "./features/library/useLibraryReload";');
    expect(app).toContain("const { libraryRefreshing, reloadLibrary } = useLibraryReload({");
    expect(app).not.toContain("const reloadLibrary = useCallback(async () => {");
    expect(app).not.toContain("repairStaleCloudLibraryRefs");
    expect(app).not.toContain(
      'window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)'
    );

    expect(reload).toContain("const reloadLibrary = useCallback(async () => {");
    expect(reload).toContain("for (let attempt = 1; attempt <= 4; attempt += 1)");
    expect(reload).toContain("window.setTimeout(resolve, 450 * attempt)");
    expect(reload).toContain(
      'window.addEventListener(\n      "beatgaler:deferred-library-reload",'
    );
  });

  it("keeps upload deferral before cache clearing and authoritative reload", () => {
    expectOrdered(reload, [
      "if (deferLibraryReloadIfUploading()) return",
      "clearCachedBeats();",
      "const restored = await libraryStateManager.reloadAuthoritative()",
    ]);
    expect(queue).toContain("deferLibraryReloadIfUploading");
    expect(queue).toContain(
      'window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))'
    );
  });

  it("preserves authority-failure gallery semantics instead of treating unknown as empty", () => {
    expect(reload).toContain(
      "Telegram library refresh failed after retries; preserving verified gallery:"
    );
    expectOrdered(reload, [
      "let lastError: unknown = null",
      "const restored = await libraryStateManager.reloadAuthoritative()",
      'setConnectionState("poor")',
      "setCloudSessionVerified(false)",
    ]);
    const failureStart = reload.indexOf(
      "Telegram library refresh failed after retries; preserving verified gallery:"
    );
    const failureEnd = reload.indexOf("const offline = await loadOfflineLibrary()", failureStart);
    const failureBlock = reload.slice(failureStart, failureEnd);
    expect(failureBlock).not.toContain("setBeats(");
  });

  it("keeps the existing refresh feedback and manual button behavior", () => {
    expect(reload).toContain("const [libraryRefreshing, setLibraryRefreshing] = useState(false)");
    expect(reload).toContain("if (elapsed < 320)");
    expect(app).toContain("disabled={loading || libraryRefreshing}");
    expect(app).toContain('animation: libraryRefreshing ? "beatgaler-refresh-spin .62s linear infinite" : "none"');
    expect(app).toContain("clearUploadPreviewCache(); void reloadLibrary();");
    expect(app).toContain(
      'title={deferredLibraryReloadRef.current ? "Reload queued until uploads finish" : "Reload Library"}'
    );
  });
});
''')

char = CHARACTERIZATION.read_text()
char = replace_once(
    char,
    'const cloudUploadQueue = readFileSync(resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"), "utf8");',
    'const cloudUploadQueue = readFileSync(resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"), "utf8");\nconst libraryReload = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryReload.ts"), "utf8");',
    "characterization reload source",
)
old_start = '  it("defers manual Reload while uploads are active and consumes the deferred event after the queue drains", () => {'
old_end = '\n\n  it("keeps playback cache invalidation, real audio events and Web/Desktop preparation paths distinct", () => {'
s = char.find(old_start)
e = char.find(old_end, s)
if s < 0 or e < 0:
    raise SystemExit("Could not locate characterization Reload test block")
new_block = r'''  it("defers manual Reload while uploads are active and consumes the deferred event after the queue drains", () => {
    const reload = sourceSection(
      libraryReload,
      "const reloadLibrary = useCallback",
      "\n  return {\n",
      "useLibraryReload.ts"
    );
    expectOrdered(reload, [
      "if (deferLibraryReloadIfUploading()) return",
      "const restored = await libraryStateManager.reloadAuthoritative()",
    ]);
    expect(reload).toContain(
      '"beatgaler:deferred-library-reload"'
    );
    expect(app).toContain("useLibraryReload({");

    const desktopFinally = cloudUploadQueue.indexOf("backgroundUploadRunningRef.current = false");
    expect(desktopFinally).toBeGreaterThan(-1);
    expect(cloudUploadQueue.indexOf("finishDeferredReloadIfIdle();", desktopFinally)).toBeGreaterThan(desktopFinally);
    expect(cloudUploadQueue).toContain('window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))');
  });'''
char = char[:s] + new_block + char[e:]
CHARACTERIZATION.write_text(char)

queue_test = QUEUE_TEST.read_text()
queue_test = replace_once(
    queue_test,
    'const queue = readFileSync(resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"), "utf8");',
    'const queue = readFileSync(resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"), "utf8");\nconst reload = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryReload.ts"), "utf8");',
    "queue test reload source",
)
old_start = '  it("runs a deferred Reload only after every queued or active upload has drained", () => {'
old_end = '\n\n  it("preserves staging until the queue is empty and Review/import no longer protects it", () => {'
s = queue_test.find(old_start)
e = queue_test.find(old_end, s)
if s < 0 or e < 0:
    raise SystemExit("Could not locate queue deferred Reload test block")
new_block = r'''  it("runs a deferred Reload only after every queued or active upload has drained", () => {
    expect(queue).toContain("deferLibraryReloadIfUploading");
    expect(queue).toContain("finishDeferredReloadIfIdle");
    expect(queue).toContain('window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))');
    const desktopFinally = queue.indexOf("backgroundUploadRunningRef.current = false");
    expect(desktopFinally).toBeGreaterThan(-1);
    expect(queue.indexOf("finishDeferredReloadIfIdle();", desktopFinally)).toBeGreaterThan(desktopFinally);
    expect(reload).toContain("if (deferLibraryReloadIfUploading())");
    expect(reload).toContain('"beatgaler:deferred-library-reload"');
    expect(app).toContain("useLibraryReload({");
  });'''
queue_test = queue_test[:s] + new_block + queue_test[e:]
QUEUE_TEST.write_text(queue_test)

print("Task 9.2 extraction applied.")
