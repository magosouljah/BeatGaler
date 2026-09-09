import {
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
