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
