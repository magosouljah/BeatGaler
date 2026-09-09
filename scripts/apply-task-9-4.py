from pathlib import Path
from textwrap import dedent

root = Path(__file__).resolve().parents[1]
app_path = root / "src/App.tsx"
app = app_path.read_text(encoding="utf-8")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return source.replace(old, new, 1)

# Imports: App keeps only composition; the extracted owners receive network/SSE dependencies.
app = replace_once(
    app,
    'import AccountGate, { getBeatGalerAuthToken, getResolvedCloudApiBase, logoutBeatGalerAccount } from "./components/AccountGate";',
    'import AccountGate, { logoutBeatGalerAccount } from "./components/AccountGate";',
    "AccountGate import",
)
app = replace_once(
    app,
    'import { loadLibrary, flushOfflineTrashIntents, readBeatMeta, saveBeatMeta, discardImportReviewBatch, uploadBeatToTelegram, downloadBeatFromTelegram, prepareBeatForPlayback, warmBeatForPlayback, getDownloadCookingStatus, downloadCookingDiagnosticEvent, uploadProjectToTelegram, uploadDroppedFileToTelegram, downloadCloudFileToCache, downloadProjectToCache, revealInExplorer, syncBeatMetadataToTelegram, pollTelegramCloudStatus, getCloudClientId, copyExportFile, copyAudioMetadata, prepareUniqueExportFolder, type CloudFileType, isTauriAvailable } from "./lib/tauri";',
    'import { loadLibrary, readBeatMeta, saveBeatMeta, discardImportReviewBatch, uploadBeatToTelegram, downloadBeatFromTelegram, prepareBeatForPlayback, warmBeatForPlayback, getDownloadCookingStatus, downloadCookingDiagnosticEvent, uploadProjectToTelegram, uploadDroppedFileToTelegram, downloadCloudFileToCache, downloadProjectToCache, revealInExplorer, syncBeatMetadataToTelegram, copyExportFile, copyAudioMetadata, prepareUniqueExportFolder, type CloudFileType, isTauriAvailable } from "./lib/tauri";',
    "tauri import",
)
app = replace_once(
    app,
    'import { useCustomCursor } from "./features/session/useCustomCursor";\n',
    'import { useCustomCursor } from "./features/session/useCustomCursor";\nimport { useConnectivity } from "./features/session/useConnectivity";\nimport { useCloudLibraryEvents } from "./features/cloud/useCloudLibraryEvents";\n',
    "task 9.4 imports",
)

app = replace_once(app, '  const cloudPullInFlightRef = useRef(false);\n', '', "cloud pull ref")
app = replace_once(app, '  const networkReconnectRunRef = useRef(0);\n', '', "network reconnect ref")

reconnect_start = app.index('  useEffect(() => {\n    if (!setupDone) return;\n    let disposed = false;\n\n    const restoreOnlineLibrary = async')
reconnect_end_marker = '  useCustomCursor(settings?.custom_cursor_enabled ?? true);'
reconnect_end = app.index(reconnect_end_marker, reconnect_start)
reconnect_replacement = dedent('''
  useConnectivity({
    setupDone,
    setConnectionState,
    setCloudSessionVerified,
    setSettings,
    setBeats,
    cloudMetaSnapshotRef,
    cloudLibrarySnapshotRef,
    startupCookingResolvedRef,
    startupPipelineStartedRef,
    startupEnginePrimeReadyRef,
    progressiveRevealRunRef,
    clearReconciledTrashRuntimeStates,
    clearPlaybackPreparation,
    clearArtworkHydration,
    setStartupCookingGate,
  });

''')
app = app[:reconnect_start] + reconnect_replacement + app[reconnect_end:]

sse_start = app.index('  // Telegram/BeatGaler synchronization is push-based.\n  // There is no timer and no focus-triggered full library scan.\n  useEffect(() => {')
sse_end_marker = '  useLibraryPresentationCache('
sse_end = app.index(sse_end_marker, sse_start)
sse_replacement = dedent('''
  // BeatGaler synchronization remains push-based. SSE only notifies the app;
  // the extracted owner verifies authority before hydrating library state.
  useCloudLibraryEvents({
    setupDone,
    beatgalerUserId: settings?.beatgaler_user_id ?? null,
    setConnectionState,
    setCloudSessionVerified,
    setSettings,
    setBeats,
    cloudMetaSnapshotRef,
    cloudLibrarySnapshotRef,
    visibleLibraryFingerprintRef,
    startupCookingResolvedRef,
    startupPipelineStartedRef,
    startupEnginePrimeReadyRef,
    progressiveRevealRunRef,
    clearReconciledTrashRuntimeStates,
    clearArtworkHydration,
    clearPlaybackPreparation,
    setStartupCookingGate,
  });

''')
app = app[:sse_start] + sse_replacement + app[sse_end:]
app_path.write_text(app, encoding="utf-8")

connectivity = dedent(r'''
import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppSettings, Beat } from "../../types";
import { flushOfflineTrashIntents, pollTelegramCloudStatus } from "../../lib/tauri";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { cloudBeatFingerprint } from "../library/libraryFingerprints";
import { preserveLoadedArtwork } from "../library/libraryPresentationCache";
import type { ConnectionState } from "./useSessionState";

interface UseConnectivityOptions {
  setupDone: boolean;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setCloudSessionVerified: Dispatch<SetStateAction<boolean>>;
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  startupCookingResolvedRef: MutableRefObject<boolean>;
  startupPipelineStartedRef: MutableRefObject<boolean>;
  startupEnginePrimeReadyRef: MutableRefObject<boolean>;
  progressiveRevealRunRef: MutableRefObject<number>;
  clearReconciledTrashRuntimeStates: () => void;
  clearPlaybackPreparation: () => void;
  clearArtworkHydration: () => void;
  setStartupCookingGate: Dispatch<SetStateAction<boolean>>;
}

export function useConnectivity({
  setupDone,
  setConnectionState,
  setCloudSessionVerified,
  setSettings,
  setBeats,
  cloudMetaSnapshotRef,
  cloudLibrarySnapshotRef,
  startupCookingResolvedRef,
  startupPipelineStartedRef,
  startupEnginePrimeReadyRef,
  progressiveRevealRunRef,
  clearReconciledTrashRuntimeStates,
  clearPlaybackPreparation,
  clearArtworkHydration,
  setStartupCookingGate,
}: UseConnectivityOptions): void {
  const networkReconnectRunRef = useRef(0);

  useEffect(() => {
    if (!setupDone) return;
    let disposed = false;

    const restoreOnlineLibrary = async (username: string | null) => {
      const flushedTrashCount = await flushOfflineTrashIntents();
      if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates();
      const restored = await libraryStateManager.reloadAuthoritative();
      if (disposed) return;
      cloudMetaSnapshotRef.current = new Map(
        restored.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
      );
      cloudLibrarySnapshotRef.current = restored
        .filter(beat => !!beat.telegram_file_id)
        .map(cloudBeatFingerprint)
        .join("\u001c");
      setBeats(current => preserveLoadedArtwork(restored, current));
      setCloudSessionVerified(true);
      setSettings(current => current ? {
        ...current, telegram_cloud_connected: true, telegram_cloud_username: username
      } : current);

      // A cold offline start bypasses Download Cooking. Reset the reveal pipeline
      // so the full online library gets the normal readiness guarantees again.
      startupCookingResolvedRef.current = false;
      startupPipelineStartedRef.current = false;
      startupEnginePrimeReadyRef.current = false;
      progressiveRevealRunRef.current += 1;
      clearPlaybackPreparation();
      clearArtworkHydration();
      setStartupCookingGate(false);
    };

    const reconnect = async () => {
      const run = ++networkReconnectRunRef.current;
      const delays = [0, 1000, 2000, 5000, 10000, 30000, 60000];
      for (const delay of delays) {
        if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay));
        if (disposed || run !== networkReconnectRunRef.current) return;
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          setConnectionState("offline");
          return;
        }
        try {
          const status = await pollTelegramCloudStatus();
          if (disposed || run !== networkReconnectRunRef.current) return;
          if (!status.reachable) {
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            continue;
          }
          if (!status.connected) {
            setCloudSessionVerified(false);
            setBeats([]);
            setSettings(current => current ? {
              ...current, telegram_cloud_connected: false, telegram_cloud_username: null
            } : current);
            return;
          }
          setConnectionState("online");
          await restoreOnlineLibrary(status.username);
          return;
        } catch (error) {
          console.warn(`Reconnect attempt after ${delay}ms failed:`, error);
          setConnectionState("poor");
        }
      }
      // Stop active retry work after the 60s backoff attempt. The browser's
      // next online event or the existing SSE reconnect can wake us again.
      if (!disposed && run === networkReconnectRunRef.current) {
        setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
      }
    };

    const onOffline = () => {
      networkReconnectRunRef.current += 1;
      setConnectionState("offline");
      setCloudSessionVerified(false);
      // Intentionally keep the already-rendered session in memory. Cached audio
      // may continue playing until the app closes; a cold restart filters it out.
    };
    const onOnline = () => { void reconnect(); };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      disposed = true;
      networkReconnectRunRef.current += 1;
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [setupDone]);
}
''').lstrip()
(root / "src/features/session/useConnectivity.ts").write_text(connectivity, encoding="utf-8")

cloud_events = dedent(r'''
import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppSettings, Beat } from "../../types";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";
import { flushOfflineTrashIntents, getCloudClientId, pollTelegramCloudStatus } from "../../lib/tauri";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { cloudBeatFingerprint, libraryViewFingerprint } from "../library/libraryFingerprints";
import { preserveLoadedArtwork } from "../library/libraryPresentationCache";
import type { ConnectionState } from "../session/useSessionState";

interface UseCloudLibraryEventsOptions {
  setupDone: boolean;
  beatgalerUserId: string | null;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setCloudSessionVerified: Dispatch<SetStateAction<boolean>>;
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  visibleLibraryFingerprintRef: MutableRefObject<string>;
  startupCookingResolvedRef: MutableRefObject<boolean>;
  startupPipelineStartedRef: MutableRefObject<boolean>;
  startupEnginePrimeReadyRef: MutableRefObject<boolean>;
  progressiveRevealRunRef: MutableRefObject<number>;
  clearReconciledTrashRuntimeStates: () => void;
  clearArtworkHydration: () => void;
  clearPlaybackPreparation: () => void;
  setStartupCookingGate: Dispatch<SetStateAction<boolean>>;
}

export function useCloudLibraryEvents({
  setupDone,
  beatgalerUserId,
  setConnectionState,
  setCloudSessionVerified,
  setSettings,
  setBeats,
  cloudMetaSnapshotRef,
  cloudLibrarySnapshotRef,
  visibleLibraryFingerprintRef,
  startupCookingResolvedRef,
  startupPipelineStartedRef,
  startupEnginePrimeReadyRef,
  progressiveRevealRunRef,
  clearReconciledTrashRuntimeStates,
  clearArtworkHydration,
  clearPlaybackPreparation,
  setStartupCookingGate,
}: UseCloudLibraryEventsOptions): void {
  const cloudPullInFlightRef = useRef(false);

  // BeatGaler synchronization is push-based. There is no timer and no
  // focus-triggered full library scan.
  useEffect(() => {
    const userId = beatgalerUserId;
    if (!setupDone || !userId) return;

    const sourceId = getCloudClientId();
    const cloudBase = getResolvedCloudApiBase();
    let events: EventSource | null = null;
    let eventReconnectTimer: number | null = null;
    let eventReconnectDelayMs = 1000;
    let cancelled = false;

    const applyRemoteLibraryChange = async () => {
      if (cancelled || cloudPullInFlightRef.current) return;
      cloudPullInFlightRef.current = true;
      try {
        const flushedTrashCount = await flushOfflineTrashIntents();
        if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates();
        const merged = await libraryStateManager.reloadAuthoritative();
        if (!cancelled) {
          const nextFingerprint = libraryViewFingerprint(merged);
          if (nextFingerprint !== visibleLibraryFingerprintRef.current) {
            visibleLibraryFingerprintRef.current = nextFingerprint;
            cloudMetaSnapshotRef.current = new Map(
              merged.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
            );
            cloudLibrarySnapshotRef.current = merged
              .filter(beat => !!beat.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
            setBeats(current => preserveLoadedArtwork(merged, current));
          }
        }
      } catch (error) {
        console.warn("Telegram event sync failed:", error);
      } finally {
        cloudPullInFlightRef.current = false;
      }
    };

    const onLibraryChanged = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled || !status.connected) return;
          if (!status.reachable) {
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          setConnectionState("online");
          await applyRemoteLibraryChange();
        } catch {
          if (!cancelled) setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
        }
      })();
    };
    const onReady = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled) return;
          if (!status.reachable) {
            setCloudSessionVerified(false);
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          if (!status.connected) {
            setCloudSessionVerified(false);
            setSettings(current => current ? { ...current, telegram_cloud_connected: false, telegram_cloud_username: null } : current);
            return;
          }
          setSettings(current => current ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username } : current);
          setConnectionState("online");
          await applyRemoteLibraryChange();
          if (!cancelled) setCloudSessionVerified(true);
        } catch {
          if (!cancelled) setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
        }
      })();
    };
    const onTelegramConnected = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled || !status.connected) return;
          if (!status.reachable) {
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          setConnectionState("online");
          startupCookingResolvedRef.current = false;
          startupPipelineStartedRef.current = false;
          startupEnginePrimeReadyRef.current = false;
          clearArtworkHydration();
          clearPlaybackPreparation();
          progressiveRevealRunRef.current += 1;
          setStartupCookingGate(false);
          setCloudSessionVerified(false);
          setSettings(current => current ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username } : current);
          await applyRemoteLibraryChange();
          if (!cancelled) setCloudSessionVerified(true);
        } catch (error) {
          console.warn("Could not activate Telegram vault:", error);
        }
      })();
    };

    const connectEvents = async () => {
      const token = getBeatGalerAuthToken();
      if (!token) return;
      try {
        const response = await fetch(`${cloudBase}/events/ticket`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ beatgalerUserId: userId }),
        });
        if (!response.ok) throw new Error(`Event authorization failed (${response.status}).`);
        const body = await response.json();
        if (cancelled || !body?.ticket) return;
        const url =
          `${cloudBase}/events?beatgalerUserId=${encodeURIComponent(userId)}` +
          `&sourceId=${encodeURIComponent(sourceId)}` +
          `&ticket=${encodeURIComponent(String(body.ticket))}`;
        events = new EventSource(url);
        events.onopen = () => { eventReconnectDelayMs = 1000; };
        events.addEventListener("ready", onReady);
        events.addEventListener("library_changed", onLibraryChanged);
        events.addEventListener("telegram_connected", onTelegramConnected);
        events.onerror = () => {
          // Event tickets are intentionally single-use. EventSource's built-in
          // reconnect would reuse the consumed ticket and receive 401 forever,
          // so close it and obtain a fresh ticket instead. SSE is only the push
          // notification channel; its failure is not evidence that Telegram or
          // the Cloud data plane is unreachable.
          events?.close();
          events = null;
          if (cancelled || eventReconnectTimer !== null) return;
          const delay = eventReconnectDelayMs;
          eventReconnectDelayMs = Math.min(eventReconnectDelayMs * 2, 30000);
          eventReconnectTimer = window.setTimeout(() => {
            eventReconnectTimer = null;
            void connectEvents();
          }, delay);
        };
      } catch (error) {
        console.warn("BeatGaler event authorization failed:", error);
        if (!cancelled && eventReconnectTimer === null) {
          const delay = eventReconnectDelayMs;
          eventReconnectDelayMs = Math.min(eventReconnectDelayMs * 2, 30000);
          eventReconnectTimer = window.setTimeout(() => {
            eventReconnectTimer = null;
            void connectEvents();
          }, delay);
        }
      }
    };

    void connectEvents();

    return () => {
      cancelled = true;
      if (eventReconnectTimer !== null) window.clearTimeout(eventReconnectTimer);
      events?.removeEventListener("ready", onReady);
      events?.removeEventListener("library_changed", onLibraryChanged);
      events?.removeEventListener("telegram_connected", onTelegramConnected);
      events?.close();
    };
  }, [setupDone, beatgalerUserId]);
}
''').lstrip()
(root / "src/features/cloud/useCloudLibraryEvents.ts").write_text(cloud_events, encoding="utf-8")

extraction_test = dedent(r'''
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const connectivity = readFileSync("src/features/session/useConnectivity.ts", "utf8");
const events = readFileSync("src/features/cloud/useCloudLibraryEvents.ts", "utf8");

function count(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing task 9.4 marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 9.4 reconnect/cloud events extraction", () => {
  it("moves online/offline and SSE listener ownership out of App", () => {
    expect(app).toContain('import { useConnectivity } from "./features/session/useConnectivity";');
    expect(app).toContain('import { useCloudLibraryEvents } from "./features/cloud/useCloudLibraryEvents";');
    expect(app).toContain("useConnectivity({");
    expect(app).toContain("useCloudLibraryEvents({");
    expect(app).not.toContain('window.addEventListener("offline", onOffline)');
    expect(app).not.toContain('window.addEventListener("online", onOnline)');
    expect(app).not.toContain("new EventSource(url)");
    expect(app).not.toContain("const connectEvents = async () => {");
    expect(count(connectivity, 'window.addEventListener("offline", onOffline)')).toBe(1);
    expect(count(connectivity, 'window.addEventListener("online", onOnline)')).toBe(1);
    expect(count(events, "new EventSource(url)")).toBe(1);
  });

  it("preserves reconnect backoff, verification, offline Trash reconciliation and cleanup", () => {
    expect(connectivity).toContain("const delays = [0, 1000, 2000, 5000, 10000, 30000, 60000]");
    expectOrdered(connectivity, [
      "const status = await pollTelegramCloudStatus()",
      "if (!status.reachable)",
      "if (!status.connected)",
      'setConnectionState("online")',
      "await restoreOnlineLibrary(status.username)",
    ]);
    expectOrdered(connectivity, [
      "const flushedTrashCount = await flushOfflineTrashIntents()",
      "if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates()",
      "const restored = await libraryStateManager.reloadAuthoritative()",
      "setCloudSessionVerified(true)",
    ]);
    expect(connectivity).toContain("networkReconnectRunRef.current += 1");
    expect(connectivity).toContain('setConnectionState("offline")');
    expect(connectivity).toContain("setCloudSessionVerified(false)");
    expect(connectivity).toContain('window.removeEventListener("offline", onOffline)');
    expect(connectivity).toContain('window.removeEventListener("online", onOnline)');
  });

  it("keeps SSE as a verified notification channel with fresh tickets and no commit path", () => {
    expectOrdered(events, [
      "const response = await fetch(`${cloudBase}/events/ticket`",
      "const body = await response.json()",
      "events = new EventSource(url)",
      'events.addEventListener("ready", onReady)',
      'events.addEventListener("library_changed", onLibraryChanged)',
      'events.addEventListener("telegram_connected", onTelegramConnected)',
    ]);
    expect(events).toContain("events?.close();");
    expect(events).toContain("eventReconnectDelayMs = Math.min(eventReconnectDelayMs * 2, 30000)");
    expect(events).toContain("events.onopen = () => { eventReconnectDelayMs = 1000; };");
    expectOrdered(events, [
      "const flushedTrashCount = await flushOfflineTrashIntents()",
      "const merged = await libraryStateManager.reloadAuthoritative()",
      "const nextFingerprint = libraryViewFingerprint(merged)",
      "setBeats(current => preserveLoadedArtwork(merged, current))",
    ]);
    expect(events).toContain("if (cancelled || cloudPullInFlightRef.current) return");
    expect(events).not.toContain("commitSnapshot(");
    expect(events).not.toContain("syncBeatMetadataToTelegram");
    expect(events).not.toContain("uploadBeatToTelegram");
    expect(count(events, 'events.removeEventListener("ready", onReady)')).toBe(1);
    expect(count(events, 'events.removeEventListener("library_changed", onLibraryChanged)')).toBe(1);
    expect(count(events, 'events.removeEventListener("telegram_connected", onTelegramConnected)')).toBe(1);
  });
});
''').lstrip()
(root / "tests/integration/appConnectivityCloudEventsExtraction.test.ts").write_text(extraction_test, encoding="utf-8")

# Update older ownership guards so they follow the exact new owners instead of
# forcing 9.4 responsibilities to remain physically in App.tsx.
session_test_path = root / "tests/integration/appSessionExtraction.test.ts"
session_test = session_test_path.read_text(encoding="utf-8")
session_test = replace_once(
    session_test,
    'const cursor = fs.readFileSync(path.join(root, "src/features/session/useCustomCursor.ts"), "utf8");\n',
    'const cursor = fs.readFileSync(path.join(root, "src/features/session/useCustomCursor.ts"), "utf8");\nconst connectivity = fs.readFileSync(path.join(root, "src/features/session/useConnectivity.ts"), "utf8");\nconst cloudEvents = fs.readFileSync(path.join(root, "src/features/cloud/useCloudLibraryEvents.ts"), "utf8");\n',
    "session test owner reads",
)
session_test = replace_once(
    session_test,
    '''  it("does not pull forward startup, reconnect or SSE from their later roadmap tasks", () => {\n    expect(app).toContain("pollTelegramCloudStatus");\n    expect(app).toContain('window.addEventListener("offline", onOffline)');\n    expect(app).toContain("new EventSource(url)");\n    expect(app).toContain("libraryStateManager.reloadAuthoritative()");\n    expect(state).not.toContain("pollTelegramCloudStatus");\n    expect(actions).not.toContain("EventSource");\n  });''',
    '''  it("keeps startup separate while reconnect and SSE move to their task 9.4 owners", () => {\n    expect(app).toContain("useStartupBootstrap({");\n    expect(app).toContain("useConnectivity({");\n    expect(app).toContain("useCloudLibraryEvents({");\n    expect(connectivity).toContain("pollTelegramCloudStatus");\n    expect(connectivity).toContain('window.addEventListener("offline", onOffline)');\n    expect(cloudEvents).toContain("new EventSource(url)");\n    expect(cloudEvents).toContain("libraryStateManager.reloadAuthoritative()");\n    expect(state).not.toContain("pollTelegramCloudStatus");\n    expect(actions).not.toContain("EventSource");\n  });''',
    "session test 9.4 boundary",
)
session_test_path.write_text(session_test, encoding="utf-8")

startup_test_path = root / "tests/integration/appStartupBootstrapExtraction.test.ts"
startup_test = startup_test_path.read_text(encoding="utf-8")
startup_test = replace_once(
    startup_test,
    'const startup = readFileSync("src/features/startup/useStartupBootstrap.ts", "utf8");\nconst main = readFileSync("src/main.tsx", "utf8");\n',
    'const startup = readFileSync("src/features/startup/useStartupBootstrap.ts", "utf8");\nconst connectivity = readFileSync("src/features/session/useConnectivity.ts", "utf8");\nconst cloudEvents = readFileSync("src/features/cloud/useCloudLibraryEvents.ts", "utf8");\nconst main = readFileSync("src/main.tsx", "utf8");\n',
    "startup test owner reads",
)
startup_test = replace_once(
    startup_test,
    '''  it("moves the initial bootstrap owner out of App without taking reconnect or SSE", () => {\n    expect(app).toContain('import { useStartupBootstrap } from "./features/startup/useStartupBootstrap";');\n    expect(app).toContain("useStartupBootstrap({");\n    expect(app).not.toContain("const showOfflineLibrary = async");\n    expect(app).not.toContain("Telegram vault startup check failed:");\n    expect(startup).toContain("const showOfflineLibrary = async");\n    expect(startup).toContain("Telegram vault startup check failed:");\n    expect(app).toContain("const reconnect = async () => {");\n    expect(app).toContain("const connectEvents = async () => {");\n  });''',
    '''  it("keeps bootstrap, reconnect and SSE as distinct owners after task 9.4", () => {\n    expect(app).toContain('import { useStartupBootstrap } from "./features/startup/useStartupBootstrap";');\n    expect(app).toContain("useStartupBootstrap({");\n    expect(app).toContain("useConnectivity({");\n    expect(app).toContain("useCloudLibraryEvents({");\n    expect(app).not.toContain("const showOfflineLibrary = async");\n    expect(app).not.toContain("const reconnect = async () => {");\n    expect(app).not.toContain("const connectEvents = async () => {");\n    expect(startup).toContain("const showOfflineLibrary = async");\n    expect(startup).toContain("Telegram vault startup check failed:");\n    expect(connectivity).toContain("const reconnect = async () => {");\n    expect(cloudEvents).toContain("const connectEvents = async () => {");\n  });''',
    "startup test 9.4 boundary",
)
startup_test_path.write_text(startup_test, encoding="utf-8")

print("Task 9.4 extraction applied")
