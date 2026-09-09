import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Beat, AppSettings } from "./types";
import BeatCard from "./components/BeatCard";
import Drawer from "./components/Drawer";
import Player from "./components/Player";
import AddBeatModal from "./components/AddBeatModal";
import SettingsPanel from "./components/SettingsPanel";
import AccountGate, { getBeatGalerAuthToken, getResolvedCloudApiBase, logoutBeatGalerAccount } from "./components/AccountGate";
import UploadModal from "./components/UploadModal";
import JobStatusBar from "./components/JobStatusBar";
import { PlusIcon, Artwork } from "./components/ui";
import { useAudio } from "./hooks/useAudio";
import { loadLibrary, loadOfflineLibrary, flushOfflineTrashIntents, readBeatMeta, getSettings, saveBeatMeta, discardImportReviewBatch, uploadBeatToTelegram, downloadBeatFromTelegram, prepareBeatForPlayback, warmBeatForPlayback, getDownloadCookingStatus, downloadCookingDiagnosticEvent, uploadProjectToTelegram, uploadDroppedFileToTelegram, downloadCloudFileToCache, downloadProjectToCache, revealInExplorer, syncBeatMetadataToTelegram, repairStaleCloudLibraryRefs, pollTelegramCloudStatus, purgeInterruptedUploadLocal, getCloudClientId, copyExportFile, copyAudioMetadata, prepareUniqueExportFolder, type CloudFileType, isTauriAvailable } from "./lib/tauri";
import { libraryStateManager } from "./lib/libraryStateManager";
import { platform } from "./platform";
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { appAlert, appConfirm } from "./lib/dialog";
import { sanitizeUserVisibleText } from "./lib/userVisibleError";
import { useTagColors, setTagColor } from "./lib/tagColors";
import { registerJob, updateJob } from "./lib/jobStore";
import { cleanTags } from "./lib/metadataValidation";
import { cleanupOrphanedDropStaging, cleanupStagedDropPaths } from "./features/dragdrop/dropStaging";
import CloudFilesModal from "./features/downloads/components/CloudFilesModal";
import { useBeatDownloads } from "./features/downloads/useBeatDownloads";
import BeatFileDropModal, { type DroppedBeatFileRole } from "./features/dragdrop/components/BeatFileDropModal";
import SearchBar from "./features/library/components/SearchBar";
import SortMenu from "./features/library/components/SortMenu";
import TagColorMenu from "./features/tags/components/TagColorMenu";
import { useArtworkHydration } from "./features/artwork/useArtworkHydration";
import { readActiveCloudUploads, rollbackInterruptedCloudUploads } from "./features/cloud/interruptedUploadJournal";
import { useCloudUploadQueue } from "./features/cloud/useCloudUploadQueue";
import ImportReviewHost, { ImportResolutionHost } from "./features/import/components/ImportReviewHost";
import { useImportSession } from "./features/import/useImportSession";
import { useImportReview } from "./features/import/useImportReview";
import { useImportDiscovery } from "./features/import/useImportDiscovery";
import { useImportSaveAll } from "./features/import/useImportSaveAll";
import { useBrowserImport } from "./features/import/useBrowserImport";
import { extensionFromPath, fileNameFromPath, isBackupFolderPath } from "./features/dragdrop/pathHelpers";
import { useHtmlLibraryDrop } from "./features/dragdrop/useHtmlLibraryDrop";
import { useNativeLibraryDrop } from "./features/dragdrop/useNativeLibraryDrop";
import { cloudBeatFingerprint, drawerMetadataCommitFingerprint, libraryViewFingerprint } from "./features/library/libraryFingerprints";
import { clearCachedBeats, clearUploadPreviewCache, preserveLoadedArtwork } from "./features/library/libraryPresentationCache";
import { selectFilteredAndSortedBeats } from "./features/library/librarySelectors";
import { useLibraryViewState } from "./features/library/useLibraryViewState";
import { useLibraryReorder } from "./features/library/useLibraryReorder";
import { useBeatSelection } from "./features/selection/useBeatSelection";
import { selectAllTags, selectTagFrequency, selectTagSuggestions } from "./features/tags/tagSelectors";
import { useTagFilters } from "./features/tags/useTagFilters";
import { useTagRename } from "./features/tags/useTagRename";
import TagRenameDialog from "./features/tags/components/TagRenameDialog";
import { useLibraryPresentationCache, useLibraryState } from "./features/library/useLibraryState";
import { useWebPlaybackSortRouting } from "./features/playback/useWebPlaybackSortRouting";
import { usePlaybackController } from "./features/playback/usePlaybackController";
import { usePlaybackQueue } from "./features/playback/usePlaybackQueue";
import { useDrawerCloudPersistence } from "./features/edit/useDrawerCloudPersistence";
import { useBeatAssetUpdates } from "./features/edit/useBeatAssetUpdates";
import { useBeatProjects } from "./features/projects/useBeatProjects";
import { useOfflineAvailability } from "./features/offline/useOfflineAvailability";
import { useTrashActions } from "./features/trash/useTrashActions";
import { useWebLibraryReconciled } from "./features/library/useWebLibraryReconciled";
import { createBeatRuntimeState } from "./features/state/beatRuntimeState";
import { useBeatRuntimeRegistry } from "./features/state/useBeatRuntimeRegistry";

// Intentionally isolated: if real-world timings prove the skeleton unnecessary,
// flipping/removing this one constant deletes the visual layer without touching
// the staged Review architecture underneath it.
const REVIEW_SKELETON_ENABLED = true;

function dismissBeatGalerStartupLoader(): void {
  const loader = document.getElementById("beatgaler-startup-loader");
  if (!loader) return;
  loader.remove();
}

const beatCloudUpdateBusyIds = new Set<string>();

function setBeatCloudUpdateBusy(beatId: string, active: boolean, success = false) {
  if (active) beatCloudUpdateBusyIds.add(beatId);
  else beatCloudUpdateBusyIds.delete(beatId);
  window.dispatchEvent(new CustomEvent("beatgaler:beat-cloud-busy", {
    detail: { beatId, active, success }
  }));
}

function formatCloudBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeConflictError(error: unknown): boolean {
  const message = runtimeErrorMessage(error).toLowerCase();
  return message.includes("409") || message.includes("conflict") || message.includes("revision mismatch") || message.includes("version mismatch");
}

type ConnectionState = "checking" | "online" | "poor" | "offline";

function BeatGalerApp() {
  const {
    beats,
    setBeats,
    beatsLatestRef,
    startupCachedBeatsRef,
    initialLoading,
  } = useLibraryState();
  const cloudMetaSnapshotRef = useRef<Map<string, string> | null>(null);
  const cloudLibraryTimerRef = useRef<number | null>(null);
  const cloudLibrarySnapshotRef = useRef<string | null>(null);
  const visibleLibraryFingerprintRef = useRef<string>("");
  const {
    beatRuntimeStates,
    beatRuntimeStatesRef,
    transitionRuntime,
    forgetRuntimeState,
    clearReconciledTrashRuntimeStates,
  } = useBeatRuntimeRegistry(beats, beatsLatestRef);
  const cloudPullInFlightRef = useRef(false);
  const stagedImportPathsRef = useRef<Map<string, string[]>>(new Map());
  const [interruptedUploadNotices, setInterruptedUploadNotices] = useState<string[]>([]);

  useEffect(() => {
    if (interruptedUploadNotices.length === 0) return;
    const timer = window.setTimeout(() => setInterruptedUploadNotices([]), 15_000);
    return () => window.clearTimeout(timer);
  }, [interruptedUploadNotices]);

  const [loading, setLoading] = useState(() => initialLoading);
  const [libraryRefreshing, setLibraryRefreshing] = useState(false);
  const [startupCookingGate, setStartupCookingGate] = useState(() => (startupCachedBeatsRef.current ?? []).length === 0);
  const [revealedBeatIds, setRevealedBeatIds] = useState<Set<string>>(() => new Set(
    (startupCachedBeatsRef.current ?? [])
      .filter(beat => Boolean(beat.image_preview_base64 || beat.image_base64))
      .map(beat => beat.id)
  ));
  const startupCookingResolvedRef = useRef(false);
  const startupPipelineStartedRef = useRef(false);
  const startupEnginePrimeReadyRef = useRef(false);
  const progressiveRevealRunRef = useRef(0);
  const handleArtworkHydratedFromNetwork = useCallback((next: Beat[], beatId: string) => {
    const hydrated = next.find(item => item.id === beatId);
    if (hydrated && cloudMetaSnapshotRef.current) {
      cloudMetaSnapshotRef.current.set(beatId, cloudBeatFingerprint(hydrated));
    }
    if (cloudLibrarySnapshotRef.current !== null) {
      cloudLibrarySnapshotRef.current = next
        .filter(item => !!item.telegram_file_id)
        .map(cloudBeatFingerprint)
        .join("\u001c");
    }
  }, []);
  const { ensureArtworkReady, clearArtworkHydration, invalidateArtworkHydration } = useArtworkHydration({
    setBeats,
    onNetworkHydrated: handleArtworkHydratedFromNetwork,
  });
  const { search, setSearch, sortBy, setSortBy } = useLibraryViewState();
  const {
    includedTags,
    excludedTags,
    clearTagFilters,
    toggleTagFilter,
    replaceTagFilter,
  } = useTagFilters();
  const [tagColorMenu, setTagColorMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  const {
    tagRename, tagRenameBusy, tagRenameError, affectedCount: tagRenameAffectedCount,
    affectedMp3Count: tagRenameMp3Count, affectedWavCount: tagRenameWavCount,
    openTagRename, setNewTag: setTagRenameNewTag, continueTagRename, backTagRename,
    cancelTagRename, confirmTagRename,
  } = useTagRename({ beats, setBeats, replaceTagFilter });
  useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web");
  const onWebLibraryReconciled = useCallback((incoming: Beat[]) => {
    setBeats(current => {
      const next = preserveLoadedArtwork(incoming, current);
      beatsLatestRef.current = next;
      return next;
    });
  }, []);
  useWebLibraryReconciled(platform.kind === "web", onWebLibraryReconciled);
  const [drawer, setDrawer] = useState<{ beat: Beat; mode: "detail" | "edit" } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropImporting, setDropImporting] = useState(false);
  // Covers the WebView2 staging window that happens BEFORE importDroppedPaths
  // receives native paths. Without this state, the app can look frozen while
  // large dropped files are being copied into drop-staging.
  const [libraryDropStaging, setLibraryDropStaging] = useState(false);
  const [beatFileDrop, setBeatFileDrop] = useState<{ beat: Beat; filePath: string; kind: "file" | "directory" } | null>(null);
  const {
    reviewQueue,
    setReviewQueue,
    reviewQueueLatestRef,
    skippedReviewSourceKeysRef,
    startReview,
  } = useImportSession();
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Prevent cached/local state from being pushed back to Telegram before this
  // app session has first verified and pulled the authoritative pinned index.
  const [cloudSessionVerified, setCloudSessionVerified] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
    typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "checking"
  );
  const {
    cloudFilesBeat,
    cloudFiles,
    cloudFilesBusyId,
    cloudFilesDownloadedIds,
    cloudFilesDownloadError,
    cloudDownloadNotice,
    handleCloudFiles,
    handleGetCloudFile,
    closeCloudFiles,
    dismissDownloadError,
  } = useBeatDownloads({ connectionState, beatRuntimeStatesRef, transitionRuntime });
  const [setupDone, setSetupDone] = useState(false);
  const [showUpload, setShowUpload] = useState<{ initialBeat: Beat | null; selectedIds?: string[] } | null>(null);

  const {
    selectedIds,
    selectMode,
    toggleSelection,
    toggleSelectAll,
    finishSelection,
    clearSelection,
  } = useBeatSelection(beats);
  const {
    sensors,
    activeDragId,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useLibraryReorder({ sortBy, setSortBy, setBeats });
  const { state: audio, play, togglePause, seek, setVolume, releaseFile } = useAudio();
  const { clearPlaybackPreparation, ensureWarmPlaybackUrl, handlePlay, handleWarm, invalidatePlaybackPreparation, waitForUploadedBeatPlaybackReady } = usePlaybackController({
    audio,
    play,
    beatsLatestRef,
    beatRuntimeStatesRef,
    transitionRuntime,
    setBeats,
    cloudSessionVerified,
    connectionState,
    isBeatCloudUpdateBusy: beatId => beatCloudUpdateBusyIds.has(beatId),
  });
  const { offlineBusyIds, handleToggleOffline } = useOfflineAvailability({
    connectionState,
    audioPlayingId: audio.playingId,
    releaseFile,
    invalidatePlaybackPreparation,
    ensureWarmPlaybackUrl,
    beatRuntimeStatesRef,
    transitionRuntime,
    setBeats,
    setDrawer,
    setRevealedBeatIds,
  });

  // Keep a ref to togglePause so the keydown handler never goes stale
  const togglePauseRef = useRef(togglePause);
  const networkReconnectRunRef = useRef(0);
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);

  const rejectOfflineMutation = useCallback((action: string): boolean => {
    if (connectionState === "online") return false;
    void appAlert({
      title: connectionState === "offline" ? "Offline" : "Connection unavailable",
      message: `${action} requires an internet connection. Offline mode is read-only except for moving beats to Trash.`,
    });
    return true;
  }, [connectionState]);

  const {
    reviewBootstrap,
    reviewPreparationDone,
    reviewPreparationPromiseRef,
    deferredImportBatch,
    setDeferredImportBatch,
    importDroppedPaths,
    cancelPendingReviewWork,
    completeImmediateReviewPreparation,
  } = useImportDiscovery({
    dropImporting,
    setDropImporting,
    rejectOfflineMutation,
    setDropActive,
    setShowAdd,
    setReviewQueue,
    skippedReviewSourceKeysRef,
    stagedImportPathsRef,
    skeletonEnabled: REVIEW_SKELETON_ENABLED,
  });

  const {
    backgroundUploadErrors,
    cloudifyImportedBeats,
    retryBackgroundUpload,
    getQueuedBeatsSnapshot,
    deferLibraryReloadIfUploading,
    deferredLibraryReloadRef,
  } = useCloudUploadQueue({
    settings,
    setSettings,
    setConnectionState,
    setBeats,
    beatsLatestRef,
    beatRuntimeStatesRef,
    transitionRuntime,
    cloudLibrarySnapshotRef,
    waitForUploadedBeatPlaybackReady,
    rejectOfflineMutation,
    isReviewActive: () => reviewQueueLatestRef.current !== null,
    hasProtectedStaging: () => stagedImportPathsRef.current.size > 0,
  });

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
        dismissBeatGalerStartupLoader();
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
            dismissBeatGalerStartupLoader();
          }
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

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

  useEffect(() => {
    const styleId = "beatgaler-custom-cursor-style";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;

    if (settings?.custom_cursor_enabled ?? true) {
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          html, body, body * {
            cursor: url('/beatgaler-custom-cursor.cur'), url('/beatgaler-custom-cursor.png') 0 0, auto !important;
          }
          input[type="text"],
          input[type="email"],
          input[type="password"],
          input[type="search"],
          input[type="url"],
          input[type="tel"],
          input[type="number"],
          textarea,
          [contenteditable="true"] {
            cursor: text !important;
          }
        `;
        document.head.appendChild(style);
      }
    } else {
      style?.remove();
    }

    return () => {
      // Keep the current setting active across React re-renders.
    };
  }, [settings?.custom_cursor_enabled]);


  // Telegram/BeatGaler synchronization is push-based.
  // There is no timer and no focus-triggered full library scan.
  useEffect(() => {
    const userId = settings?.beatgaler_user_id;
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
        } catch (error) {
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
  }, [setupDone, settings?.beatgaler_user_id]);

  useLibraryPresentationCache(
    beats,
    cloudSessionVerified,
    settings,
  );

  useEffect(() => {
    visibleLibraryFingerprintRef.current = libraryViewFingerprint(beats);
    beatsLatestRef.current = beats;
  }, [beats]);



  // One-time recovery for a cloud-only library after Telegram login/startup.
  // No timer, no permanent synchronization.
  const beatGalerCloudRecoveryAttemptedRef = useRef(false);

  const recoverTelegramLibraryOnceIfEmpty = useCallback(async () => {
    if (beatGalerCloudRecoveryAttemptedRef.current) return;
    if (beats.length !== 0) return;

    beatGalerCloudRecoveryAttemptedRef.current = true;
    try {
      const restored = await libraryStateManager.reloadAuthoritative();
      if (restored.length > 0) {
        setBeats(current => current.length === 0 ? restored : current);
      }
    } catch (error) {
      console.warn("Telegram library one-time recovery skipped:", error);
    }
  }, [beats.length]);

  // IMPORTANT: an empty library is a valid, authoritative state (for example
  // immediately after Remove All). Never infer "Telegram recovery" merely from
  // beats.length === 0; doing so races the pending trash/index commit and can
  // resurrect the just-removed cards with their artwork unloaded. Recovery is
  // only allowed from explicit Telegram connection/startup flows below.

  useEffect(() => {
    const onTelegramConnected = (event: Event) => {
      const detail = (event as CustomEvent<{ connected?: boolean; username?: string | null }>).detail;
      if (!detail?.connected) return;

      setSettings(current => current ? {
        ...current,
        telegram_cloud_connected: true,
        telegram_cloud_username: detail.username ?? current.telegram_cloud_username ?? null,
      } : current);

      void recoverTelegramLibraryOnceIfEmpty();
    };

    window.addEventListener("beatgaler:telegram-connected", onTelegramConnected);
    return () => window.removeEventListener("beatgaler:telegram-connected", onTelegramConnected);
  }, [recoverTelegramLibraryOnceIfEmpty]);

  // Global keyboard shortcuts — stable handler via ref
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") {
        // Prevent Escape from leaving a focus ring or text selection behind
        // on whatever element/button was last interacted with.
        (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.removeAllRanges();
        clearSelection();
        setDrawer(null);
        setShowAdd(false);
        setShowSettings(false);
        closeQueue();
        setShowUpload(null);
      }
      if (e.key === " " && !isTyping) { e.preventDefault(); togglePauseRef.current(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // empty deps — safe because we use ref

  const handleUpload = useCallback((beat: Beat) => {
    if (rejectOfflineMutation("Uploading to YouTube")) return;
    setShowUpload({ initialBeat: beat, selectedIds: undefined });
  }, [rejectOfflineMutation]);

  const handleUploadTelegram = useCallback(async (beat: Beat) => {
    if (rejectOfflineMutation("Uploading a beat")) return;
    const existingCloudBeat = Boolean(beat.telegram_file_id);
    transitionRuntime(beat.id, { type: existingCloudBeat ? "SYNC_QUEUE_UPDATE" : "SYNC_QUEUE_UPLOAD" }, beat);
    transitionRuntime(beat.id, { type: existingCloudBeat ? "SYNC_UPDATE_STARTED" : "SYNC_UPLOAD_STARTED" }, beat);
    try {
      const updated = await uploadBeatToTelegram(beat);
      await syncBeatMetadataToTelegram(updated);
      transitionRuntime(updated.id, { type: existingCloudBeat ? "SYNC_UPDATE_SUCCEEDED" : "SYNC_UPLOAD_SUCCEEDED" }, updated);
      setBeats(bs => bs.map(b => b.id === updated.id ? updated : b));
    } catch (e: any) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(e), "Cloud operation failed.");
      if (existingCloudBeat && isRuntimeConflictError(e)) {
        transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      } else {
        transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "TELEGRAM_UPLOAD_FAILED", message, retryable: true }, beat);
      }
      await appAlert({
        title: "Cloud upload failed",
        message,
        danger: true,
      });
    }
  }, [rejectOfflineMutation, transitionRuntime]);

  const handleDownloadTelegram = useCallback(async (_beat: Beat) => {
    await appAlert({
      title: "Cloud-only library",
      message: "Files are fetched into temporary storage automatically when needed.",
    });
  }, []);

  const handleUploadBulk = useCallback(() => {
    if (rejectOfflineMutation("Bulk upload")) return;
    setShowUpload({ initialBeat: null, selectedIds: Array.from(selectedIds) });
  }, [selectedIds, rejectOfflineMutation]);

  const handleEditBulk = useCallback(() => {
    if (rejectOfflineMutation("Editing metadata")) return;
    const firstSelected = beats.find(b => selectedIds.has(b.id));
    if (firstSelected) setDrawer({ beat: firstSelected, mode: "edit" });
  }, [beats, selectedIds, rejectOfflineMutation]);

  const { deleteBeat, handleRemoveBulk, handleBeatRestored } = useTrashActions({
    beats,
    setBeats,
    beatsLatestRef,
    selectedIds,
    clearSelection,
    connectionState,
    audioPlayingId: audio.playingId,
    releaseFile,
    beatRuntimeStatesRef,
    transitionRuntime,
    forgetRuntimeState,
    cloudMetaSnapshotRef,
    cloudLibrarySnapshotRef,
    invalidateArtworkHydration,
    ensureArtworkReady,
  });

  const addBeats = useCallback((newBeats: Beat[]) => {
    setBeats(bs => {
      const existing = new Set(bs.map(b => b.mp3_path));
      const next = [...newBeats.filter(b => !existing.has(b.mp3_path)), ...bs];
      beatsLatestRef.current = next;
      return next;
    });
  }, []);

  const addBeatsAndReview = useCallback((newBeats: Beat[]) => {
    if (newBeats.length === 0) return;
    if (connectionState !== "online") {
      void appAlert({
        title: "Internet connection required",
        message: "BeatGaler does not import new beats while offline. Reconnect and import them again.",
      });
      void cleanupOrphanedDropStaging(beatsLatestRef.current);
      return;
    }
    const sanitized = newBeats.map(beat => ({ ...beat, tags: cleanTags(beat.tags || []).tags }));

    // Review candidates are NOT library beats yet.
    // Keeping them out of `beats` means:
    // 1) Cancel leaves absolutely nothing behind.
    // 2) duplicate-name checks compare only against committed library items.
    // 3) a re-dropped folder can never masquerade as an edit of the existing beat.
    setShowAdd(false);
    startReview(sanitized);
    // Upload begins only after Review → Save.
  }, [connectionState, startReview]);

const {
  skipCurrentReviewBeat,
  cancelReview,
  handleReviewedBeatSaved,
} = useImportReview({
  setBeats,
  beatsLatestRef,
  setReviewQueue,
  skippedReviewSourceKeysRef,
  cloudifyImportedBeats,
  getQueuedBeatsSnapshot,
  onCancelPendingWork: cancelPendingReviewWork,
  releaseBeat: platform.capabilities.reviewBeatCloudCommit
    ? beatId => platform.importer.releaseBeat(beatId)
    : undefined,
  discardBatch: batchId => discardImportReviewBatch(batchId),
  cleanupStaging: protectedBeats => cleanupOrphanedDropStaging(protectedBeats),
});

  const {
    audioConflictBatch,
    dropImportBatch,
    resetImportResolutionState,
    handleReviewedSaveAll,
    cancelAudioConflicts,
    resolveAudioConflicts,
    closeImportDecisions,
    importResolvedDecisions,
  } = useImportSaveAll({
    setBeats,
    beatsLatestRef,
    reviewQueue,
    setReviewQueue,
    reviewQueueLatestRef,
    reviewBootstrap,
    reviewPreparationDone,
    reviewPreparationPromiseRef,
    deferredImportBatch,
    setDeferredImportBatch,
    stagedImportPathsRef,
    setDropImporting,
    cloudifyImportedBeats,
    addBeatsAndReview,
  });

  const { importDroppedBrowserFiles } = useBrowserImport({
    dropImporting,
    setDropImporting,
    rejectOfflineMutation,
    setDropActive,
    setShowAdd,
    setReviewQueue,
    completeImmediateReviewPreparation,
    resetImportResolutionState,
  });

  const updateExistingBeatFromFolder = useCallback(async (beat: Beat, folderPath: string): Promise<boolean> => {
    if (rejectOfflineMutation("Updating beat files")) return true;
    if (isBackupFolderPath(folderPath)) {
      await appAlert({
        title: "Backup folder skipped",
        message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
      });
      return true;
    }

    const t = await import("./lib/tauri");

    let preview;
    try {
      preview = await t.inspectBeatUpdateFolder(folderPath);
    } catch {
      return false;
    }

    let replaceMaster = false;
    if (preview.has_mp3) {
      const alreadyHasMaster = Boolean(beat.telegram_file_id) || Boolean(beat.mp3_path?.trim());
      if (alreadyHasMaster) {
        const incoming = preview.mp3_filename || "the incoming MP3";
        const confirmed = window.confirm(
          `Replace current MASTER for "${beat.name}"?\n\n` +
          `${incoming} will become the new MASTER.\n` +
          `Its BPM, key, tags, rating and artwork will replace the current metadata.\n\n` +
          `WAV and project files from this folder will also be added or updated.`
        );
        if (!confirmed) return true;
      }
      replaceMaster = true;
    }

    setBeatCloudUpdateBusy(beat.id, true);
    const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
    if (runtime.sync_state === "synced") transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      let updated = await t.mergeFolderIntoExistingBeat(beat, folderPath, replaceMaster);
      setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));

      if (replaceMaster) {
        updated = await t.uploadBeatToTelegram(updated);
        setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));
      }

      if (preview.has_wav && updated.wav_path) {
        await t.uploadDroppedFileToTelegram(updated, updated.wav_path, "WAV");
      }

      if (preview.has_project_assets) {
        await t.uploadProjectToTelegram(updated);
      }

      if (replaceMaster && updated.telegram_file_id) {
        await t.syncBeatMetadataToTelegram(updated);
      }

      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await libraryStateManager.commitSnapshot(beatsLatestRef.current.map(item => item.id === beat.id ? updated : item), "metadata-update");
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, updated);
      setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));
      return true;
    } catch (error) {
      console.error(error);
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      if (isRuntimeConflictError(error)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "FOLDER_UPDATE_FAILED", message, retryable: true }, beat);
      alert(`Could not update "${beat.name}" from the dropped folder: ${message}`);
      return true;
    } finally {
      setBeatCloudUpdateBusy(beat.id, false);
    }
  }, [rejectOfflineMutation, transitionRuntime]);

  const { commitDrawerCloudMutation } = useDrawerCloudPersistence({
  beats,
  browserCloudEditing: platform.capabilities.browserCloudEditing,
  connectionState,
  cloudSessionVerified,
  beatsLatestRef,
  beatRuntimeStatesRef,
  transitionRuntime,
  cloudMetaSnapshotRef,
  cloudLibraryTimerRef,
  cloudLibrarySnapshotRef,
});

  // V7: INDEX writes are explicit transactions only.
  // There is deliberately no generic "beats changed => rewrite Telegram" observer.
  // Upload, metadata, Trash/Restore and project/file operations commit through
  // libraryStateManager at their actual logical commit boundary. This prevents
  // render/cache hydration from becoming an accidental cloud mutation.

  const handleDisconnectTelegramAccount = useCallback(async () => {
    await logoutBeatGalerAccount().catch(() => {});
    releaseFile();
    progressiveRevealRunRef.current += 1;
    clearPlaybackPreparation();
    clearArtworkHydration();
    setRevealedBeatIds(new Set());
    setCloudSessionVerified(false);
    setBeats([]);
    clearSelection();
    setSettings(current => current ? { ...current, telegram_cloud_connected: false, telegram_cloud_username: null } : current);
  }, [releaseFile]);

  const updateBeat = useCallback((updated: Beat) => {
    if (updated.telegram_file_id && connectionState === "online") {
      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);
      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);
    }
    setBeats(bs => bs.map(b => b.id === updated.id ? updated : b));
    if (drawer?.beat.id === updated.id) setDrawer(d => d ? { ...d, beat: updated } : null);
  }, [connectionState, drawer, transitionRuntime]);



  const handleDropArtwork = useCallback(async (beat: Beat, imageBase64: string) => {
    if (rejectOfflineMutation("Changing artwork")) return;

    const updated = { ...beat, image_base64: imageBase64, image_preview_base64: null };

    if (platform.capabilities.browserCloudEditing) {
      // Publish the browser-decoded artwork immediately, then commit it through
      // the Web editor/Direct transport. No Tauri metadata path participates.
      updateBeat(updated);
      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);
      try {
        const committed = await platform.editor.commit(beat, updated, {});
        setBeats(current => {
          const next = current.map(item => item.id === committed.id ? committed : item);
          beatsLatestRef.current = next;
          return next;
        });
        setDrawer(current => current?.beat.id === committed.id ? { ...current, beat: committed } : current);
        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, committed);
      } catch (error) {
        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);
        throw error;
      }
      return;
    }

    // Desktop keeps its existing native metadata/artwork transaction.
    await saveBeatMeta({
      mp3_path: beat.mp3_path,
      wav_path: beat.wav_path,
      bpm: beat.bpm,
      key: beat.key,
      tags: beat.tags,
      rating: beat.rating,
      image_base64: imageBase64,
      update_filename: false,
    });

    updateBeat(updated);

    if (updated.telegram_file_id && connectionState === "online") {
      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);
      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);
      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);
      try {
        await syncBeatMetadataToTelegram(updated);
        const indexSnapshot = beatsLatestRef.current.map(item => item.id === updated.id ? updated : item);
        await libraryStateManager.commitSnapshot(indexSnapshot, "upload-batch");
        if (cloudLibraryTimerRef.current) {
          window.clearTimeout(cloudLibraryTimerRef.current);
          cloudLibraryTimerRef.current = null;
        }
        cloudLibrarySnapshotRef.current = indexSnapshot
          .filter(item => !!item.telegram_file_id)
          .map(cloudBeatFingerprint)
          .join("\u001c");
        cloudMetaSnapshotRef.current?.set(updated.id, cloudBeatFingerprint(updated));
        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, updated);
      } catch (error) {
        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);
        throw error;
      }
    }
  }, [updateBeat, rejectOfflineMutation, connectionState, transitionRuntime]);


  const {
    runBeatCloudUpdate,
    startMasterAssetUpdate,
    startWavAssetUpdate,
    handleBrowserBeatAssetDrop,
  } = useBeatAssetUpdates({
    rejectOfflineMutation,
    setBeatFileDrop,
    setBeatCloudUpdateBusy,
    beatRuntimeStatesRef,
    transitionRuntime,
    beatsLatestRef,
    cloudLibrarySnapshotRef,
    setBeats,
    setDrawer,
    waitForUploadedBeatPlaybackReady,
  });

  const {
    openableCloudProjectIds,
    projectUpdateNotice,
    dismissProjectUpdateNotice,
    hasStoredProject,
    startProjectAssetUpdate,
    handleAutoProjectDrop,
    handleBrowserProjectDrop,
    handleUploadProjectTelegram,
    handleOpenProject,
    handleUpdateProject,
  } = useBeatProjects({
    beats,
    connectionState,
    rejectOfflineMutation,
    transitionRuntime,
    beatsLatestRef,
    setBeats,
    setDrawer,
    runBeatCloudUpdate,
    setBeatCloudUpdateBusy,
  });

  const handleDroppedBeatFileRole = useCallback(async (role: DroppedBeatFileRole) => {
    if (!beatFileDrop) return;
    const { beat, filePath } = beatFileDrop;
    const ext = extensionFromPath(filePath);

    if (role === "loop" || role === "stems") return;

    if (role === "main") {
      if (ext !== "mp3") return;
      startMasterAssetUpdate(beat, filePath);
      return;
    }

    if (role === "wav") {
      if (ext !== "wav") return;
      startWavAssetUpdate(beat, filePath);
      return;
    }

    if (role === "projectFolder") {
      const existing = await hasStoredProject(beat).catch(() => false);
      if (!existing) {
        await cleanupStagedDropPaths([filePath]).catch(() => {});
        setBeatFileDrop(null);
        await appAlert({
          title: "Project file required",
          message: "Add a .flp, .als, .logicx, .ptx/.ptf file or a valid PROJECT ZIP first. Then folders can be added to that PROJECT.zip using their original folder name.",
        });
        return;
      }
      startProjectAssetUpdate(beat, filePath, "projectFolder");
    }
  }, [beatFileDrop, hasStoredProject, startMasterAssetUpdate, startProjectAssetUpdate, startWavAssetUpdate]);


  useHtmlLibraryDrop({
    nativeDropAvailable: isTauriAvailable,
    browserFileImport: platform.capabilities.browserFileImport,
    reviewSkeletonEnabled: REVIEW_SKELETON_ENABLED,
    beatsLatestRef,
    setDropActive,
    setBeatCloudUpdateBusy,
    setBeatFileDrop,
    setLibraryDropStaging,
    handleDropArtwork,
    handleAutoProjectDrop,
    handleBrowserBeatAssetDrop,
    handleBrowserProjectDrop,
    importDroppedBrowserFiles,
    importDroppedPaths,
  });

  useNativeLibraryDrop({
    nativeDropAvailable: isTauriAvailable,
    reviewSkeletonEnabled: REVIEW_SKELETON_ENABLED,
    beatsLatestRef,
    setDropActive,
    setBeatCloudUpdateBusy,
    setBeatFileDrop,
    setLibraryDropStaging,
    handleDropArtwork,
    handleAutoProjectDrop,
    importDroppedPaths,
  });

  const reloadLibrary = useCallback(async () => {
    // Pre-Direct BeatGaler reload used a full loading state and then replaced the
    // rendered library from the durable source. Keep that authoritative behavior,
    // but never let Reload race an active import: until the batch INDEX commit
    // finishes, Telegram intentionally does not contain those optimistic beats.
    const refreshStarted = performance.now();
    setLibraryRefreshing(true);

    const finishRefreshAnimation = async () => {
      const elapsed = performance.now() - refreshStarted;
      if (elapsed < 320) await new Promise(resolve => window.setTimeout(resolve, 320 - elapsed));
      setLibraryRefreshing(false);
    };

    try {
      // Queue ownership includes active IDs and the pending Reload marker.
      if (deferLibraryReloadIfUploading()) return;

      clearCachedBeats();
      const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;

      if (settings?.telegram_cloud_connected && !browserOffline) {
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            // Reload is also an integrity pass: if an INDEX entry points at a
            // MASTER message Telegram definitively says no longer exists, repair
            // the INDEX first and then apply the repaired authority to SQLite/UI.
            const repaired = await repairStaleCloudLibraryRefs().catch(error => {
              console.warn("Reload integrity probe deferred safely:", error);
              return 0;
            });
            if (repaired > 0) console.warn(`[library-refresh] stale_refs_repaired=${repaired}`);
            const restored = await libraryStateManager.reloadAuthoritative();
            cloudMetaSnapshotRef.current = new Map(
              restored.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
            );
            cloudLibrarySnapshotRef.current = restored
              .filter(beat => !!beat.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
            setConnectionState("online");

            // Reload replaces committed library state, just like the functional
            // pre-Direct version, while preserving already-decoded artwork.
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
            console.info(`[library-refresh] APPLIED beats=${visible.length} attempt=${attempt}`);
            return;
          } catch (error) {
            lastError = error;
            if (attempt < 4) await new Promise(resolve => window.setTimeout(resolve, 450 * attempt));
          }
        }
        console.warn("Telegram library refresh failed after retries; preserving verified gallery:", lastError);
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

      if (!settings?.telegram_cloud_connected) {
        setCloudSessionVerified(false);
        beatsLatestRef.current = offline;
        setBeats(offline);
      }
    } catch (err) {
      console.error(err);
      setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
      setCloudSessionVerified(false);
    } finally {
      await finishRefreshAnimation();
      setLoading(false);
    }
  }, [settings?.telegram_cloud_connected]);

  useEffect(() => {
    const runDeferredReload = () => { void reloadLibrary(); };
    window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload);
    return () => window.removeEventListener("beatgaler:deferred-library-reload", runDeferredReload);
  }, [reloadLibrary]);


  const applyBulkUpdate = useCallback((updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => {
    setBeats(bs => bs.map(b => {
      if (!selectedIds.has(b.id)) return b;
      if (!updates.tags) return { ...b, ...updates };

      const normalizedInput = Array.from(new Set(
        updates.tags.map(t => t.trim().toLowerCase()).filter(Boolean)
      ));

      if (options?.tagsMode === "replace") {
        return { ...b, ...updates, tags: normalizedInput };
      }

      if (options?.tagsMode === "remove") {
        const removeSet = new Set(normalizedInput);
        const remainingTags = b.tags.filter(tag => !removeSet.has(tag.trim().toLowerCase()));
        return { ...b, ...updates, tags: remainingTags };
      }

      const mergedTags = Array.from(new Set(
        [...b.tags, ...normalizedInput].map(t => t.trim().toLowerCase()).filter(Boolean)
      ));
      return { ...b, ...updates, tags: mergedTags };
    }));
    clearSelection();
  }, [selectedIds]);


  const tagColors = useTagColors();

const handleTagClick = useCallback((tag: string, e: React.MouseEvent) => {
  toggleTagFilter(tag, e.altKey ? "exclude" : "include");
}, [toggleTagFilter]);

  const tagFrequency = useMemo(() => selectTagFrequency(beats), [beats]);
  const allTags = useMemo(() => selectAllTags(beats, tagFrequency), [beats, tagFrequency]);
  const tagSuggestions = useMemo(() => selectTagSuggestions(beats), [beats]);
  const filteredBeats = selectFilteredAndSortedBeats(
    beats,
    search,
    includedTags,
    excludedTags,
    sortBy,
  );

  const filteredBeatIdsKey = filteredBeats.map(beat => beat.id).join("|");
  const displayedBeats = filteredBeats.filter(beat => revealedBeatIds.has(beat.id));

  const {
    shuffleEnabled,
    repeatMode,
    showQueue,
    queuedBeats,
    addToQueue,
    handleNext,
    handlePrev,
    closeQueue,
    toggleQueue,
    toggleShuffle,
    cycleRepeat,
    playQueueIndex,
  } = usePlaybackQueue({
    beats,
    displayedBeats,
    playingId: audio.playingId,
    progress: audio.progress,
    endedSeq: audio.endedSeq,
    handlePlay,
    seek,
    releaseFile,
  });

  const revealBeat = useCallback((beatId: string) => {
    setRevealedBeatIds(current => {
      if (current.has(beatId)) return current;
      const next = new Set(current);
      next.add(beatId);
      return next;
    });
  }, []);

  // Instant-paint pass: use only local presentation cache while cloud authority
  // is still resolving. This never mutates the source of truth and never starts
  // an audio download. Every BeatCard is already mounted invisibly in its final
  // slot, so cards can appear independently without reflowing the grid.
  useEffect(() => {
    if (filteredBeats.length === 0) return;
    let cancelled = false;
    const queue = filteredBeats.filter(beat => !revealedBeatIds.has(beat.id));

    void Promise.all(queue.map(async beat => {
      const ready = await ensureArtworkReady(beat, false);
      if (!cancelled && ready) revealBeat(beat.id);
    })).then(() => {
      if (!cancelled) {
        setStartupCookingGate(false);
        dismissBeatGalerStartupLoader();
      }
    });

    return () => { cancelled = true; };
    // revealedBeatIds intentionally stays out of deps: one cache sweep per library shape.
  }, [filteredBeatIdsKey, ensureArtworkReady, revealBeat]);

  // Authority/reveal pass: title + artwork are enough to show a beat. Audio is
  // deliberately NOT part of this gate. Once a visible card enters the viewport,
  // BeatCard's existing IntersectionObserver calls onWarm and the progressive
  // audio/chunk path continues exactly as before.
  useEffect(() => {
    if (loading || settings === null) return;

    if (connectionState === "checking") {
      if (filteredBeats.length === 0) setStartupCookingGate(true);
      return;
    }

    if (connectionState !== "online" || !settings.telegram_cloud_connected) {
      setRevealedBeatIds(new Set(filteredBeats.map(beat => beat.id)));
      startupCookingResolvedRef.current = true;
      startupPipelineStartedRef.current = false;
      setStartupCookingGate(false);
      dismissBeatGalerStartupLoader();
      return;
    }

    // Cached cards may stay visible while this is false, but confirmed-empty UI
    // remains forbidden until the authoritative INDEX resolves.
    if (!cloudSessionVerified) {
      setStartupCookingGate(filteredBeats.length === 0);
      return;
    }

    startupCookingResolvedRef.current = true;
    startupPipelineStartedRef.current = false;
    setStartupCookingGate(false);
    dismissBeatGalerStartupLoader();

    if (filteredBeats.length === 0) return;

    const runId = ++progressiveRevealRunRef.current;
    // The Desktop restore model deliberately omits image_base64 and keeps the
    // durable artwork reference in Rust cloud_metadata (not Beat.assets). A
    // cache-only pass may already have revealed the card with its gradient, but
    // the online pass must still hydrate every beat whose artwork is not loaded.
    const queue = filteredBeats.filter(beat =>
      !beat.image_base64 && !beat.image_preview_base64
    );
    let cursor = 0;
    const workerCount = Math.min(isTauriAvailable ? 6 : 1, queue.length);

    const worker = async () => {
      while (cursor < queue.length) {
        const index = cursor++;
        const beat = queue[index];
        if (!beat || progressiveRevealRunRef.current !== runId) return;

        let ready = false;
        for (let attempt = 0; attempt < 4 && !ready; attempt += 1) {
          ready = await ensureArtworkReady(beat, true);
          if (ready || progressiveRevealRunRef.current !== runId) break;
          const delay = [350, 900, 1800, 3200][attempt] ?? 3200;
          await new Promise(resolve => window.setTimeout(resolve, delay));
        }

        if (progressiveRevealRunRef.current !== runId) return;
        if (ready) revealBeat(beat.id);
      }
    };

    void Promise.all(Array.from({ length: workerCount }, () => worker()));

    return () => {
      if (progressiveRevealRunRef.current === runId) progressiveRevealRunRef.current += 1;
    };
    // revealedBeatIds intentionally stays out of deps so each reveal does not restart workers.
  }, [
    loading, settings, cloudSessionVerified, connectionState, filteredBeatIdsKey,
    ensureArtworkReady, revealBeat,
  ]);


  const currentBeat = beats.find(b => b.id === audio.playingId);
  const selectedBeats = beats.filter(b => selectedIds.has(b.id));
  const activeDragBeat = activeDragId ? beats.find(b => b.id === activeDragId) ?? null : null;

  return (
    <div
      style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0c0c0c", overflow: "hidden" }}
    >
      {(connectionState === "poor" || connectionState === "offline") && (
        <div style={{
          position: "fixed", top: 62, left: "50%", transform: "translateX(-50%)", zIndex: 20200,
          maxWidth: "min(620px, calc(100vw - 36px))", padding: "10px 14px", borderRadius: 10,
          border: "1px solid #7a6525", background: "#302913", color: "#f0d77d",
          boxShadow: "0 12px 34px rgba(0,0,0,.4)", fontSize: 11.5, lineHeight: 1.4, textAlign: "center",
        }}>
          {connectionState === "offline"
            ? "You're offline. This session can keep using already prepared audio; after restart only beats with the green Offline check are shown."
            : "Poor connection. BeatGaler is retrying automatically; cloud actions may take longer."}
        </div>
      )}
      {cloudFilesDownloadError && (
        <div style={{
          position: "fixed", top: 62, right: 18, zIndex: 20140, width: 360, maxWidth: "calc(100vw - 36px)",
          padding: "12px 42px 12px 14px", borderRadius: 10, border: "1px solid #7a2525",
          background: "#351414", color: "#ffd7d7", boxShadow: "0 14px 44px rgba(0,0,0,.65)",
          fontSize: 12, lineHeight: 1.5,
        }}>
          <button
            type="button"
            aria-label="Close download error"
            onClick={dismissDownloadError}
            style={{
              position: "absolute", top: 8, right: 8, width: 24, height: 24, border: "none",
              borderRadius: 6, background: "transparent", color: "#ff9d9d", cursor: "pointer",
              fontSize: 16, lineHeight: "24px", padding: 0, textAlign: "center",
            }}
          >×</button>
          <div style={{ fontWeight: 700, marginBottom: 3 }}>Download failed</div>
          <div>{cloudFilesDownloadError}</div>
        </div>
      )}
      {projectUpdateNotice && (
        <div style={{
          position: "fixed", top: cloudDownloadNotice ? 116 : 62, right: 18, zIndex: 20130,
          width: 360, maxWidth: "calc(100vw - 36px)", padding: "11px 38px 11px 14px",
          borderRadius: 10, border: "1px solid #66521f", background: "#2d2714",
          color: "#f1d783", boxShadow: "0 14px 44px rgba(0,0,0,.45)", fontSize: 12, lineHeight: 1.45,
        }}>
          <button
            type="button"
            aria-label="Close project notice"
            onClick={dismissProjectUpdateNotice}
            style={{
              position: "absolute", top: 7, right: 8, width: 24, height: 24, border: "none",
              borderRadius: 6, background: "transparent", color: "#d8bd67", cursor: "pointer",
              fontSize: 16, lineHeight: "24px", padding: 0, textAlign: "center",
            }}
          >×</button>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Project notice</div>
          <div>{projectUpdateNotice}</div>
        </div>
      )}
      {cloudDownloadNotice && (
        <div style={{
          position: "fixed", top: 62, right: 18, zIndex: 20120, width: 340, maxWidth: "calc(100vw - 36px)",
          padding: "11px 14px", borderRadius: 10,
          border: cloudDownloadNotice.status === "completed" ? "1px solid #257a3d" : "1px solid #303030",
          background: cloudDownloadNotice.status === "completed" ? "#12351d" : "#171717",
          color: cloudDownloadNotice.status === "completed" ? "#8ff0aa" : "#e8e8e8",
          boxShadow: "0 14px 44px rgba(0,0,0,.45)", fontSize: 12, lineHeight: 1.45,
        }}>
          {cloudDownloadNotice.status === "downloading" ? (
            cloudDownloadNotice.kind === "ALL"
              ? <>Downloading everything from &quot;{cloudDownloadNotice.beatName}&quot;...</>
              : cloudDownloadNotice.kind === "PROJECT"
                ? <>Downloading Full Project from &quot;{cloudDownloadNotice.beatName}&quot;...</>
                : <>Downloading {cloudDownloadNotice.kind} from &quot;{cloudDownloadNotice.beatName}&quot;...</>
          ) : (
            cloudDownloadNotice.kind === "ALL"
              ? <>Downloaded everything from &quot;{cloudDownloadNotice.beatName}&quot;.</>
              : cloudDownloadNotice.kind === "PROJECT"
                ? <>Downloaded Full Project from &quot;{cloudDownloadNotice.beatName}&quot;.</>
                : <>Downloaded {cloudDownloadNotice.kind} from &quot;{cloudDownloadNotice.beatName}&quot;.</>
          )}
        </div>
      )}
      {interruptedUploadNotices.length > 0 && (
        <div style={{
          position: "fixed", top: 62, right: 18, zIndex: 20000, width: 360, maxWidth: "calc(100vw - 36px)",
          padding: "12px 42px 12px 14px", borderRadius: 10, border: "1px solid #7a2525",
          background: "#351414", color: "#ffd7d7", boxShadow: "0 14px 44px rgba(0,0,0,.55)",
          fontSize: 12, lineHeight: 1.5,
        }}>
          <button
            type="button"
            aria-label="Close notification"
            title="Close"
            onClick={() => setInterruptedUploadNotices([])}
            style={{
              position: "absolute", top: 8, right: 8, width: 24, height: 24, border: "none",
              borderRadius: 6, background: "transparent", color: "#ff9d9d", cursor: "pointer",
              fontSize: 16, lineHeight: "24px", padding: 0, textAlign: "center",
            }}
          >
            ×
          </button>
          {interruptedUploadNotices.map(name => (
            <div key={name}>Your last upload of &quot;{name}&quot; was interrupted. The incomplete upload was removed.</div>
          ))}
        </div>
      )}
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px", height: 50, flexShrink: 0, borderBottom: "1px solid #111" }}>
        <span style={{ fontWeight: 400, fontSize: 14, color: "#aaa", letterSpacing: 0.3 }}>beat galer</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <SearchBar value={search} onChange={setSearch} />
          <SortMenu value={sortBy} onChange={setSortBy} />
          {/* Settings gear */}
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: "#444", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#aaa")}
            onMouseLeave={e => (e.currentTarget.style.color = "#444")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1a1.7 1.7 0 0 0 1.1 1.6 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.1.38.3.72.6 1 .3.27.68.4 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.7.6Z"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg></button>
          <button
            onClick={() => { clearUploadPreviewCache(); void reloadLibrary(); }}
            title={deferredLibraryReloadRef.current ? "Reload queued until uploads finish" : "Reload Library"}
            disabled={loading || libraryRefreshing}
            style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: (loading || libraryRefreshing) ? "#666" : "#444", cursor: (loading || libraryRefreshing) ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            onMouseEnter={e => { if (!loading && !libraryRefreshing) e.currentTarget.style.color = "#aaa"; }}
            onMouseLeave={e => { e.currentTarget.style.color = (loading || libraryRefreshing) ? "#666" : "#444"; }}
          ><span style={{ display: "inline-block", animation: libraryRefreshing ? "beatgaler-refresh-spin .62s linear infinite" : "none" }}>↻</span></button>
          {/* Apple-style Select / Select All / Done */}
          {selectMode ? (
            <>
              <button
                onClick={() => toggleSelectAll(displayedBeats)}
                style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #2a2a2a", color: "#888", fontSize: 12, cursor: "pointer" }}>
                {displayedBeats.length > 0 && displayedBeats.every(b => selectedIds.has(b.id)) ? "Deselect All" : "Select All"}
              </button>
              <button
                onClick={finishSelection}
                style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #2a2a2a", color: "#ccc", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
                Done
              </button>
            </>
          ) : (
            <button
              onClick={() => toggleSelection(null, false, displayedBeats)}
              style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #1e1e1e", color: "#555", fontSize: 12, cursor: "pointer" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#aaa"; (e.currentTarget as HTMLElement).style.borderColor = "#2a2a2a"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "#555"; (e.currentTarget as HTMLElement).style.borderColor = "#1e1e1e"; }}>
              Select
            </button>
          )}
        </div>
      </div>

      {/* Selection toolbar */}
      {selectedIds.size > 0 && (
        <div style={{ padding: "0 24px", height: 40, display: "flex", alignItems: "center", gap: 12, background: "#111", borderBottom: "1px solid #1a1a1a", flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: "#888" }}>{selectedIds.size} selected</span>
          <button onClick={handleEditBulk}
            style={{ padding: "5px 14px", background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: 6, color: "#ccc", fontSize: 12, cursor: "pointer" }}>
            Edit all
          </button>
          <button onClick={handleUploadBulk}
            style={{ padding: "5px 14px", background: "#202020", border: "1px solid #2e2e2e", borderRadius: 6, color: "#e0e0e0", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
            Upload to YouTube
          </button>
          <button onClick={handleRemoveBulk}
            style={{ padding: "5px 14px", background: "transparent", border: "1px solid #3d0000", borderRadius: 6, color: "#f87171", fontSize: 12, cursor: "pointer" }}>
            Remove all
          </button>
          <button onClick={finishSelection}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "#444", fontSize: 12, cursor: "pointer" }}>
            Cancel
          </button>
        </div>
      )}

      {/* Tag filter */}
<div style={{ padding: "7px 24px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid #111", flexShrink: 0 }}>
  <button
    onClick={clearTagFilters}
    style={{
      padding: "4px 12px", borderRadius: 20,
      background: (!includedTags.size && !excludedTags.size) ? "#e5e5e5" : "transparent",
      border: `1px solid ${(!includedTags.size && !excludedTags.size) ? "#e5e5e5" : "#1e1e1e"}`,
      color: (!includedTags.size && !excludedTags.size) ? "#000" : "#444", fontSize: 12, cursor: "pointer",
    }}>All</button>
  {allTags.map(t => {
    const color = tagColors[t.trim().toLowerCase()];
    const included = includedTags.has(t);
    const excluded = excludedTags.has(t);
    const bg = excluded ? "rgba(248,113,113,0.14)" : included ? (color ?? "#e5e5e5") : (color ? `${color}22` : "transparent");
    const border = excluded ? "#7f1d1d" : included ? (color ?? "#e5e5e5") : (color ? `${color}55` : "#1e1e1e");
    const text = excluded ? "#f87171" : included ? (color ? "#fff" : "#000") : (color ?? "#444");
    return (
      <button key={t}
        onClick={(e) => handleTagClick(t, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          window.dispatchEvent(new Event("beatcard:close-menus"));
          setTagColorMenu({ tag: t, x: e.clientX, y: e.clientY });
        }}
        style={{
          padding: "4px 12px", borderRadius: 20, background: bg,
          border: `1px solid ${border}`, color: text, fontSize: 12, cursor: "pointer",
          textDecoration: excluded ? "line-through" : "none",
          display: "inline-flex", alignItems: "center", gap: 5,
        }}>
        {t}
      </button>
    );
  })}
</div>

{tagColorMenu && (
  <TagColorMenu
    x={tagColorMenu.x}
    y={tagColorMenu.y}
    current={tagColors[tagColorMenu.tag.trim().toLowerCase()] ?? null}
    onSelect={(hex) => { setTagColor(tagColorMenu.tag, hex); setTagColorMenu(null); }}
    onRename={() => {
      openTagRename(tagColorMenu.tag);
      setTagColorMenu(null);
    }}
    onClose={() => setTagColorMenu(null)}
  />
)}


{tagRename && (
  <TagRenameDialog
    rename={tagRename}
    busy={tagRenameBusy}
    error={tagRenameError}
    affectedCount={tagRenameAffectedCount}
    mp3Count={tagRenameMp3Count}
    wavCount={tagRenameWavCount}
    onNewTagChange={setTagRenameNewTag}
    onContinue={continueTagRename}
    onBack={backTagRename}
    onCancel={cancelTagRename}
    onConfirm={confirmTagRename}
  />
)}

      {/* Grid — OS file drag-drop */}
      <div
        data-library-scroll="true"
        aria-busy={startupCookingGate || (connectionState === "online" && !cloudSessionVerified)}
        style={{ flex: 1, position: "relative", overflowY: "auto", padding: "28px 24px", paddingBottom: currentBeat ? 90 : 28, opacity: libraryRefreshing ? 0.82 : 1, transform: libraryRefreshing ? "scale(0.997)" : "scale(1)", transition: "opacity 150ms ease, transform 150ms ease" }}

      >
        {libraryRefreshing && (
          <div aria-hidden="true" style={{ position: "sticky", top: -28, left: 0, right: 0, height: 2, zIndex: 20, overflow: "hidden", pointerEvents: "none" }}>
            <div style={{ width: "28%", height: "100%", background: "rgba(255,255,255,.38)", animation: "beatgaler-refresh-line .72s ease-in-out infinite" }} />
          </div>
        )}
        {filteredBeats.length === 0 ? (
          <div style={{ textAlign: "center", paddingTop: 92, color: "#383838" }}>
            {beats.length === 0 ? (
              cloudSessionVerified && connectionState === "online" ? (
                <div>
                  <div style={{ fontSize: 15, color: "#555", fontWeight: 500 }}>Empty Gallery</div>
                  <div style={{ marginTop: 7, fontSize: 12, color: "#2f2f2f" }}>Add a beat to start your library.</div>
                </div>
              ) : connectionState === "offline" || connectionState === "poor" ? (
                <div>
                  <div style={{ fontSize: 15, color: "#555", fontWeight: 500 }}>No offline beats available</div>
                  <div style={{ marginTop: 7, fontSize: 12, color: "#2f2f2f" }}>Reconnect to verify your Galer Cloud library.</div>
                </div>
              ) : (
                <div aria-label="Loading beat library" style={{ minHeight: 1 }} />
              )
            ) : <div style={{ fontSize: 13 }}>No beats match your search</div>}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={filteredBeats.map((b) => b.id)} strategy={rectSortingStrategy}>
              <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "28px 22px", alignContent: "flex-start", maxWidth: 1300 }}>
                {filteredBeats.map((beat, i) => (
                  <BeatCard
                    key={beat.id}
                    beat={beat}
                    visible={revealedBeatIds.has(beat.id)}
                    interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}
                    playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}
                    openableProject={platform.capabilities.openProjectInDaw && (openableCloudProjectIds.has(beat.id) || Boolean(beat.offline_available && (beat.has_flp || beat.has_als) && (beat.flp_path || beat.als_path)))}
                    cloudUploadErrorDetail={backgroundUploadErrors[beat.id]}
                    tagFrequency={tagFrequency}
                    showIncompleteWarnings={settings?.incomplete_warnings_enabled ?? true}
                    playing={audio.playingId === beat.id && audio.isPlaying}
                    selected={selectedIds.has(beat.id)}
                    selectedCount={selectedIds.size}
                    selectMode={selectMode}
                    dragEnabled={!selectMode && platform.capabilities.manualLibraryReorder}
                    networkOnline={connectionState === "online"}
                    offlineBusy={offlineBusyIds.has(beat.id)}
                    canUseOfflinePackage={platform.capabilities.offlinePackage}
                    canUseLocalHelper={platform.capabilities.localHelper}
                    canInspectNativeProject={platform.capabilities.openProjectInDaw}
                    onToggleOffline={handleToggleOffline}
                    onRetryUpload={retryBackgroundUpload}
                    onBulkEdit={handleEditBulk}
                    onBulkUpload={handleUploadBulk}
                    onBulkDelete={handleRemoveBulk}
                    onPlay={handlePlay}
                    onWarm={handleWarm}
                    onDetail={b => setDrawer({ beat: b, mode: "detail" })}
                    onEdit={b => { if (!rejectOfflineMutation("Editing metadata")) setDrawer({ beat: b, mode: "edit" }); }}
                    onDelete={deleteBeat}
                    onAddToQueue={addToQueue}
                    onUpload={handleUpload}
                    onUploadTelegram={handleUploadTelegram}
                    onDownloadTelegram={handleDownloadTelegram}
                    onUploadProjectTelegram={handleUploadProjectTelegram}
                    onOpenProject={handleOpenProject}
                    onUpdateProject={handleUpdateProject}
                    onCloudFiles={handleCloudFiles}
                    onToggleSelect={(b, e) => toggleSelection(b, e.shiftKey, filteredBeats)}
                    animDelay={0}
                  />
                ))}
                </div>
              </div>
            </SortableContext>
            <DragOverlay>
              {activeDragBeat ? (
                <div style={{ width: 160, borderRadius: 12, transform: "scale(1.02)", boxShadow: "0 20px 40px rgba(0,0,0,0.6)" }}>
                  <Artwork beat={activeDragBeat} size={160} playing={false} />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* + Add beat */}
      {!currentBeat && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 45 }}>
          <button onClick={() => { if (!rejectOfflineMutation("Adding a beat")) setShowAdd(true); }}
            style={{ padding: "9px 20px", borderRadius: 40, background: "#161616", border: "1px solid #242424", color: "#777", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 24px rgba(0,0,0,0.6)" }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#202020"; (e.currentTarget as HTMLElement).style.color = "#ccc"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#161616"; (e.currentTarget as HTMLElement).style.color = "#777"; }}>
            <PlusIcon size={11} /> Add beat
          </button>
        </div>
      )}

      {cloudFilesBeat && (
        <CloudFilesModal
          beat={cloudFilesBeat}
          files={cloudFiles}
          busyId={cloudFilesBusyId}
          downloadedIds={cloudFilesDownloadedIds}
          onDownload={handleGetCloudFile}
          onClose={closeCloudFiles}
        />
      )}

      {showAdd && <AddBeatModal onClose={() => setShowAdd(false)} onAdd={addBeatsAndReview} existingBeats={beats} />}

      {showSettings && (
        <SettingsPanel
          currentFolder={settings?.beats_folder ?? null}
          showIncompleteWarnings={settings?.incomplete_warnings_enabled ?? true}
          onIncompleteWarningsChanged={(enabled: boolean) => setSettings(current => current
            ? { ...current, incomplete_warnings_enabled: enabled }
            : { beats_folder: null, incomplete_warnings_enabled: enabled, custom_cursor_enabled: true })}
          customCursorEnabled={settings?.custom_cursor_enabled ?? true}
          onCustomCursorChanged={(enabled: boolean) => setSettings(current => current
            ? { ...current, custom_cursor_enabled: enabled }
            : { beats_folder: null, incomplete_warnings_enabled: true, custom_cursor_enabled: enabled })}
          telegramConnected={settings?.telegram_cloud_connected ?? false}
          networkOnline={connectionState === "online"}
          telegramUsername={settings?.telegram_cloud_username ?? null}
          onDisconnectTelegram={handleDisconnectTelegramAccount}
          onClose={() => setShowSettings(false)}
          onFolderChanged={folder => setSettings(s => s ? { ...s, beats_folder: folder } : { beats_folder: folder, incomplete_warnings_enabled: true, custom_cursor_enabled: true })}
          onBeatRestored={handleBeatRestored}
        />
      )}

      {drawer && !reviewQueue && !reviewBootstrap && (
        <Drawer
          beat={drawer.beat}
          mode={drawer.mode}
          tagSuggestions={tagSuggestions}
          onClose={() => { setDrawer(null); clearSelection(); }}
          onSaved={updateBeat}
          onReleaseAudio={() => { if (audio.playingId === drawer.beat.id) releaseFile(); }}
          selectedBeats={selectedBeats.length > 1 ? selectedBeats : undefined}
          onBulkSaved={applyBulkUpdate}
          mutationAllowed={connectionState === "online"}
          onCloudMutationCommit={platform.capabilities.browserCloudEditing ? undefined : commitDrawerCloudMutation}
        />
      )}

      <ImportReviewHost
  libraryDropStaging={libraryDropStaging}
  reviewBootstrap={reviewBootstrap}
  reviewQueue={reviewQueue}
  skeletonEnabled={REVIEW_SKELETON_ENABLED}
  tagSuggestions={tagSuggestions}
  mutationAllowed={connectionState === "online"}
  onSkipCurrent={skipCurrentReviewBeat}
  onCancel={cancelReview}
  onSaveAll={platform.capabilities.reviewBeatCloudCommit ? undefined : handleReviewedSaveAll}
  isReviewNameTaken={(candidateName) => {
    const normalized = candidateName.trim().toLocaleLowerCase();
    if (!normalized) return false;
    return beats.some(existing =>
      existing.name.trim().toLocaleLowerCase() === normalized
    );
  }}
  onCloudMutationCommit={platform.capabilities.browserCloudEditing ? undefined : commitDrawerCloudMutation}
  onSaved={handleReviewedBeatSaved}
  onReleaseAudio={beat => {
    if (audio.playingId === beat.id) releaseFile();
  }}
/>

      {beatFileDrop && (
        <BeatFileDropModal
          beat={beatFileDrop.beat}
          filePath={beatFileDrop.filePath}
          fileName={fileNameFromPath(beatFileDrop.filePath)}
          fileExtension={extensionFromPath(beatFileDrop.filePath)}
          isDirectory={beatFileDrop.kind === "directory"}
          onChoose={handleDroppedBeatFileRole}
          onClose={() => {
            void cleanupStagedDropPaths([beatFileDrop.filePath]);
            setBeatFileDrop(null);
          }}
        />
      )}

      <ImportResolutionHost
        audioConflictBatch={audioConflictBatch}
        dropImportBatch={dropImportBatch}
        onAudioConflictsCancel={cancelAudioConflicts}
        onAudioConflictsResolved={resolveAudioConflicts}
        onImportDecisionsClose={closeImportDecisions}
        onImportDecisionsImported={importResolvedDecisions}
      />

      {(dropActive || dropImporting) && !libraryDropStaging && !reviewBootstrap && !reviewQueue && (
        <div style={{
          position: "fixed",
          left: "50%",
          bottom: currentBeat ? 86 : 24,
          transform: "translateX(-50%)",
          zIndex: 10000,
          pointerEvents: "none",
          width: "min(620px, calc(100vw - 48px))",
        }}>
          <div style={{
            padding: "13px 18px",
            borderRadius: 12,
            border: "2px dashed #f5a623",
            background: "rgba(17,17,17,0.94)",
            textAlign: "center",
            boxShadow: "0 10px 32px rgba(0,0,0,0.42)",
          }}>
            <div style={{ fontSize: 13, color: "#eee", fontWeight: 600 }}>
              {dropImporting ? "Importando…" : "Suelta aquí para agregar como beat aparte"}
            </div>
            {!dropImporting && (
              <div style={{ fontSize: 10, color: "#777", marginTop: 4, lineHeight: 1.45 }}>
                O arrástralo encima de un beat para agregarlo a ese beat.
              </div>
            )}
          </div>
        </div>
      )}

      {currentBeat && (
        <Player
          beat={currentBeat}
          playing={audio.isPlaying}
          progress={audio.progress}
          duration={audio.duration}
          volume={audio.volume}
          queue={queuedBeats}
          currentIndex={-1}
          showQueue={showQueue}
          shuffleEnabled={shuffleEnabled}
          repeatMode={repeatMode}
          canShowQueue={queuedBeats.length > 0}
          onToggle={togglePause}
          onSeek={seek}
          onPrev={handlePrev}
          onNext={() => handleNext(false)}
          onVolumeChange={setVolume}
          onToggleShuffle={toggleShuffle}
          onCycleRepeat={cycleRepeat}
          onToggleQueue={toggleQueue}
          onPlayQueueIndex={playQueueIndex}
          canAddBeat={platform.capabilities.browserFileImport || platform.capabilities.nativeFilesystemDrop}
          onAddBeat={() => { if (!rejectOfflineMutation("Adding a beat")) setShowAdd(true); }}
          onDetail={(b) => setDrawer({ beat: b, mode: "detail" })}
          onEdit={(b) => { if (!rejectOfflineMutation("Editing metadata")) setDrawer({ beat: b, mode: "edit" }); }}
          onDelete={deleteBeat}
          onAddToQueue={addToQueue}
        />
      )}

      {showUpload && (
        <UploadModal
          initialBeat={showUpload.initialBeat}
          allBeats={beats}
          initialSelectedIds={showUpload.selectedIds}
          onClose={() => setShowUpload(null)}
        />
      )}

      <JobStatusBar />
    </div>
  );
}


export default function App() {
  return platform.kind === "web"
    ? <BeatGalerApp />
    : <AccountGate><BeatGalerApp /></AccountGate>;
}
