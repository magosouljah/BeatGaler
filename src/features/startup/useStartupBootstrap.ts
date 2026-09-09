import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { AppSettings, Beat } from "../../types";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";
import { libraryStateManager } from "../../lib/libraryStateManager";
import {
  flushOfflineTrashIntents,
  getSettings,
  loadOfflineLibrary,
  pollTelegramCloudStatus,
  purgeInterruptedUploadLocal,
  repairStaleCloudLibraryRefs,
} from "../../lib/tauri";
import { readActiveCloudUploads, rollbackInterruptedCloudUploads } from "../cloud/interruptedUploadJournal";
import { cleanupOrphanedDropStaging } from "../dragdrop/dropStaging";
import { cloudBeatFingerprint } from "../library/libraryFingerprints";
import { preserveLoadedArtwork } from "../library/libraryPresentationCache";
import type { ConnectionState } from "../session/useSessionState";

export type StartupBootstrapOptions = {
  startupCachedBeatsRef: MutableRefObject<Beat[] | null>;
  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  startupCookingResolvedRef: MutableRefObject<boolean>;
  startupPipelineStartedRef: MutableRefObject<boolean>;
  startupEnginePrimeReadyRef: MutableRefObject<boolean>;
  progressiveRevealRunRef: MutableRefObject<number>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
  setSetupDone: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setCloudSessionVerified: Dispatch<SetStateAction<boolean>>;
  setStartupCookingGate: Dispatch<SetStateAction<boolean>>;
  setRevealedBeatIds: Dispatch<SetStateAction<Set<string>>>;
  clearReconciledTrashRuntimeStates: () => void;
  dismissStartupLoader: () => void;
};

export type StartupBootstrapController = {
  interruptedUploadNotices: string[];
  dismissInterruptedUploadNotices: () => void;
};

export function useStartupBootstrap({
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
  clearReconciledTrashRuntimeStates,
  dismissStartupLoader,
}: StartupBootstrapOptions): StartupBootstrapController {
  const [interruptedUploadNotices, setInterruptedUploadNotices] = useState<string[]>([]);

  useEffect(() => {
    if (interruptedUploadNotices.length === 0) return;
    const timer = window.setTimeout(() => setInterruptedUploadNotices([]), 15_000);
    return () => window.clearTimeout(timer);
  }, [interruptedUploadNotices]);

  useEffect(() => {
    let cancelled = false;

    const showOfflineLibrary = async (state: ConnectionState) => {
      // Keep the startup gate closed while native code validates durable Offline
      // packages. Changing connectionState first used to let the startup reveal
      // effect briefly expose every cached cloud card (and could resolve the
      // reveal pipeline while the Offline list was still empty).
      setCloudSessionVerified(false);
      const offline = await loadOfflineLibrary().catch(error => {
        console.warn("Could not load Offline library:", error);
        return [] as Beat[];
      });
      if (!cancelled) {
        // Offline packages are already complete local assets, so they do not
        // need Download Cooking. Resolve the startup reveal atomically with
        // the validated Offline library to prevent an empty/all-beats flash.
        startupCookingResolvedRef.current = true;
        startupPipelineStartedRef.current = false;
        progressiveRevealRunRef.current += 1;
        setRevealedBeatIds(new Set(offline.map(beat => beat.id)));
        setStartupCookingGate(false);
        setBeats(offline);
        setConnectionState(state);
        dismissStartupLoader();
      }
    };

    void (async () => {
      try {
        // Settings are local. Account linkage remains remembered even when the
        // network is down; connectivity is a separate runtime state.
        const local = await getSettings();
        if (cancelled) return;
        setSettings(local);
        setSetupDone(true);
        setLoading(false);

        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          await showOfflineLibrary("offline");
          return;
        }

        let status: Awaited<ReturnType<typeof pollTelegramCloudStatus>> = { connected: false, reachable: false, username: null };
        try {
          status = await pollTelegramCloudStatus();
          if (cancelled) return;

          // A hard Refresh restarts the Desktop helper. MASTER may need a few
          // seconds to admit the newly leased transport bot, so do not turn
          // that normal handoff into a fake empty/offline library.
          if (local.telegram_cloud_connected && !(status.connected && status.reachable)) {
            for (let attempt = 1; attempt <= 12; attempt += 1) {
              await new Promise(resolve => window.setTimeout(resolve, 500));
              if (cancelled) return;
              status = await pollTelegramCloudStatus().catch(() => status);
              if (status.connected && status.reachable) break;
              if (typeof navigator !== "undefined" && navigator.onLine === false) break;
            }
          }
        } catch (error) {
          console.warn("Telegram startup connectivity check failed:", error);
          await showOfflineLibrary(
            typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor"
          );
          return;
        }

        if (!status.reachable) {
          // Reachability is decided BEFORE account linkage. A local Cloud/Bot API
          // process can stay alive with Wi-Fi off, and that must never turn a cold
          // start into an online library or log the persisted account out.
          if (local.telegram_cloud_connected) {
            setSettings(current => current ? {
              ...current, telegram_cloud_connected: true,
              telegram_cloud_username: current.telegram_cloud_username ?? local.telegram_cloud_username,
            } : local);
          }
          await showOfflineLibrary(
            typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor"
          );
          return;
        }

        if (!status.connected) {
          // Telegram is actually reachable and the backend explicitly says this
          // installation is not linked. Only THIS case is a real logout/unlinked state.
          setCloudSessionVerified(false);
          setBeats([]);
          setSettings(current =>
            current
              ? { ...current, telegram_cloud_connected: false, telegram_cloud_username: null }
              : local
          );
          return;
        }
        setConnectionState("online");
        // A localhost EventSource can report before Telegram reachability is
        // known. Always give a verified online cold start a fresh cooking/reveal
        // pass even if an earlier transient state already resolved the gate.
        startupCookingResolvedRef.current = false;
        startupPipelineStartedRef.current = false;
        startupEnginePrimeReadyRef.current = false;
        progressiveRevealRunRef.current += 1;
        setStartupCookingGate((startupCachedBeatsRef.current ?? []).length === 0);

        // Recovery markers are only hints. Before deleting an interrupted upload,
        // verify it against the authoritative Telegram INDEX. A beat already in
        // the INDEX is durable even if an old local marker survived a crash.
        let recoveryAuthorityIds: Set<string> | null = null;
        if (local.beatgaler_user_id && readActiveCloudUploads().length > 0) {
          try {
            const authoritativeBeforeRecovery = await libraryStateManager.reloadAuthoritative();
            recoveryAuthorityIds = new Set(authoritativeBeforeRecovery.map(beat => beat.id));
          } catch (error) {
            console.warn("Could not verify Telegram INDEX before interrupted-upload cleanup; cleanup deferred safely:", error);
          }

          const rolledBackNames = await rollbackInterruptedCloudUploads({
            beatgalerUserId: local.beatgaler_user_id,
            authoritativeBeatIds: recoveryAuthorityIds,
            cloudApiBase: getResolvedCloudApiBase(),
            authToken: getBeatGalerAuthToken(),
            purgeLocal: purgeInterruptedUploadLocal,
          });
          if (!cancelled && rolledBackNames.length > 0) setInterruptedUploadNotices(rolledBackNames);
        }

        const flushedTrashCount = await flushOfflineTrashIntents();
        if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates();
        let restored: Beat[] | null = null;
        let restoreError: unknown = null;
        // A single Direct INDEX attempt can lose the initial socket handoff.
        for (let attempt = 0; attempt < 3 && restored === null; attempt += 1) {
          try {
            restored = await libraryStateManager.reloadAuthoritative();
          } catch (error) {
            restoreError = error;
            if (attempt < 2) {
              await new Promise(resolve => window.setTimeout(resolve, [500, 1500][attempt]));
              if (cancelled) return;
            }
          }
        }
        if (restored === null) throw restoreError;
        if (cancelled) return;

        // The INDEX can outlive media if an older interrupted-upload cleanup
        // physically deleted Telegram messages. Validate only MASTER references.
        // A beat is pruned only when Telegram explicitly confirms that message is
        // gone; transient/network errors preserve the entry. This repairs ghost
        // cards without touching the normal delete_messages cleanup model.
        try {
          const repaired = await repairStaleCloudLibraryRefs();
          if (repaired > 0) {
            console.warn(`[library-integrity] repaired_stale_master_refs=${repaired}`);
            restored = await libraryStateManager.reloadAuthoritative();
            if (cancelled) return;
          }
        } catch (error) {
          console.warn("Telegram library integrity repair deferred safely:", error);
        }

        cloudMetaSnapshotRef.current = new Map(
          restored.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
        );
        cloudLibrarySnapshotRef.current = restored
          .filter(beat => !!beat.telegram_file_id)
          .map(cloudBeatFingerprint)
          .join("\u001c");
        setBeats(current => preserveLoadedArtwork(
          restored,
          current.length > 0 ? current : (startupCachedBeatsRef.current ?? [])
        ));
        startupCachedBeatsRef.current = [];
        void cleanupOrphanedDropStaging(restored);
        setCloudSessionVerified(true);
        setSettings(current =>
          current
            ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username }
            : local
        );
      } catch (error) {
        console.warn("Telegram vault startup check failed:", error);
        if (!cancelled) {
          setSetupDone(true);
          setLoading(false);
          setCloudSessionVerified(false);
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            await showOfflineLibrary("offline");
          } else {
            // Authority is temporarily unknown, not empty. Keep the verified/cache
            // presentation already on screen, but make it read-only until a later
            // authoritative reload succeeds. This prevents 60 -> 0 -> 60 flashes.
            setConnectionState("poor");
            dismissStartupLoader();
          }
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const dismissInterruptedUploadNotices = useCallback(() => {
    setInterruptedUploadNotices([]);
  }, []);

  return { interruptedUploadNotices, dismissInterruptedUploadNotices };
}
