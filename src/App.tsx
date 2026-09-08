import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import uploadCompleteWav from "./assets/status/upload-complete.wav";
import downloadCompleteWav from "./assets/status/download-complete.wav";
import type { Beat, AppSettings } from "./types";
import BeatCard from "./components/BeatCard";
import Drawer from "./components/Drawer";
import Player from "./components/Player";
import AddBeatModal from "./components/AddBeatModal";
import ImportDecisionsModal from "./components/ImportDecisionsModal";
import ImportAudioConflictsModal from "./components/ImportAudioConflictsModal";
import ReviewBeatSkeleton from "./components/ReviewBeatSkeleton";
import SettingsPanel from "./components/SettingsPanel";
import AccountGate, { getBeatGalerAuthToken, getResolvedCloudApiBase, logoutBeatGalerAccount } from "./components/AccountGate";
import UploadModal from "./components/UploadModal";
import JobStatusBar from "./components/JobStatusBar";
import { PlusIcon, Artwork } from "./components/ui";
import { useAudio } from "./hooks/useAudio";
import { loadLibrary, loadOfflineLibrary, makeBeatAvailableOffline, removeBeatOfflineAvailability, recordOfflineTrashIntent, flushOfflineTrashIntents, removeBeatFromLibrary, readBeatMeta, getSettings, saveBeatMeta, renameTagEverywhere, startImportReviewStream, getImportReviewBatchSummary, prepareNextImportReviewBeat, discardImportReviewBatch, resolveImportDecisions, uploadBeatToTelegram, downloadBeatFromTelegram, prepareBeatForPlayback, warmBeatForPlayback, getDownloadCookingStatus, downloadCookingDiagnosticEvent, uploadProjectToTelegram, getProjectCloudStatus, openBeatProject, updateProjectArchiveFromSource, inspectProjectDropSource, uploadDroppedFileToTelegram, listCloudFilesForBeat, downloadCloudFileToCache, downloadProjectToCache, startBackgroundDownload, revealInExplorer, syncBeatMetadataToTelegram, repairStaleCloudLibraryRefs, pollTelegramCloudStatus, detachLocalSourcesAfterCloudUpload, purgeInterruptedUploadLocal, getCloudClientId, chooseExportFilePath, chooseExportFolder, copyExportFile, copyAudioMetadata, prepareUniqueExportFolder, readImagePathAsDataUrl, isDirectoryPath, diagnosticLog, type CloudFileType, type CloudFileRecord, type BackgroundDownloadEvent, type ImportBatchPreview, isTauriAvailable } from "./lib/tauri";
import { libraryStateManager } from "./lib/libraryStateManager";
import { platform } from "./platform";
import { listen } from "@tauri-apps/api/event";
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import ReactDOM from "react-dom";
import { appAlert, appConfirm } from "./lib/dialog";
import { sanitizeUserVisibleText } from "./lib/userVisibleError";
import { useTagColors, setTagColor, renameTagColor } from "./lib/tagColors";
import { registerJob, updateJob } from "./lib/jobStore";
import { cleanTags, validateBpm, validateMusicKey } from "./lib/metadataValidation";
import { fetchInternetArtworkDataUrl } from "./features/artwork/internetArtwork";
import { artworkFileToDataUrl } from "./features/dragdrop/browserArtwork";
import { nativeExternalImageSignalFromPaths } from "./features/dragdrop/nativeExternalImage";
import { claimNativeLibraryDrop } from "./features/dragdrop/nativeDropArbiter";
import { installHtmlDropController } from "./features/dragdrop/htmlDropController";
import { cleanupOrphanedDropStaging, cleanupStagedDropPaths } from "./features/dragdrop/dropStaging";
import CloudFilesModal, { type BeatDownloadKind } from "./features/downloads/components/CloudFilesModal";
import BeatFileDropModal, { type DroppedBeatFileRole } from "./features/dragdrop/components/BeatFileDropModal";
import SearchBar from "./features/library/components/SearchBar";
import SortMenu from "./features/library/components/SortMenu";
import TagColorMenu from "./features/tags/components/TagColorMenu";
import { useArtworkHydration } from "./features/artwork/useArtworkHydration";
import { clearCloudUploadActive, markCloudUploadActive, readActiveCloudUploads, writeActiveCloudUploads, type ActiveCloudUpload } from "./features/cloud/interruptedUploadJournal";
import { extensionFromPath, fileNameFromPath, isBackupFolderPath } from "./features/dragdrop/pathHelpers";
import { cloudBeatFingerprint, drawerMetadataCommitFingerprint, libraryViewFingerprint } from "./features/library/libraryFingerprints";
import { clearCachedBeats, clearUploadPreviewCache, preserveLoadedArtwork } from "./features/library/libraryPresentationCache";
import { selectFilteredAndSortedBeats } from "./features/library/librarySelectors";
import { useLibraryViewState } from "./features/library/useLibraryViewState";
import { useLibraryReorder } from "./features/library/useLibraryReorder";
import { useBeatSelection } from "./features/selection/useBeatSelection";
import { selectAllTags, selectTagFrequency, selectTagSuggestions } from "./features/tags/tagSelectors";
import { useTagFilters } from "./features/tags/useTagFilters";
import { useLibraryPresentationCache, useLibraryState } from "./features/library/useLibraryState";
import { useWebPlaybackSortRouting } from "./features/playback/useWebPlaybackSortRouting";
import { usePlaybackController } from "./features/playback/usePlaybackController";
import { usePlaybackQueue } from "./features/playback/usePlaybackQueue";
import { useDrawerCloudPersistence } from "./features/edit/useDrawerCloudPersistence";
import { useWebLibraryReconciled } from "./features/library/useWebLibraryReconciled";
import { createBeatRuntimeState } from "./features/state/beatRuntimeState";
import { useBeatRuntimeRegistry } from "./features/state/useBeatRuntimeRegistry";
import { reviewPerfMark } from "./features/perf/reviewPerf";

type AutoProjectDropResult = "not-project" | "handled" | "started";

type ReviewQueueState = {
  beats: Beat[];
  index: number;
  // Streaming discovery intentionally does not know N when Beat 1 appears.
  total: number | null;
  batchId: string | null;
  preparing: boolean;
};

// Intentionally isolated: if real-world timings prove the skeleton unnecessary,
// flipping/removing this one constant deletes the visual layer without touching
// the staged Review architecture underneath it.
const REVIEW_SKELETON_ENABLED = true;
// Safety cap for one Explorer drag gesture. A parent folder still counts as one
// root and is discovered lazily, so this never forces a full-tree scan.
const MAX_NATIVE_DROP_ITEMS = 50;

function dismissBeatGalerStartupLoader(): void {
  const loader = document.getElementById("beatgaler-startup-loader");
  if (!loader) return;
  loader.remove();
}

function reviewSourceKey(beat: Beat): string {
  return (beat.mp3_path || beat.wav_path || beat.playback_path || "")
    .replace(/\\/g, "/")
    .trim()
    .toLocaleLowerCase();
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

async function rollbackInterruptedCloudUploads(beatgalerUserId: string, authoritativeBeatIds: Set<string> | null): Promise<string[]> {
  const pending = readActiveCloudUploads();
  if (pending.length === 0) return [];

  const rolledBack: string[] = [];
  const remaining: ActiveCloudUpload[] = [];
  const base = getResolvedCloudApiBase();
  const token = getBeatGalerAuthToken();

  for (const item of pending) {
    // A recovery marker is only evidence that the process died mid-flow.
    // Telegram INDEX is authoritative: if the beat is already present there,
    // the upload was durable and MUST NOT be rolled back. Clear only the stale
    // local marker and keep the beat/media intact.
    if (authoritativeBeatIds?.has(item.beatId)) {
      console.info(`[upload-recovery] marker cleared for durable beat ${item.beatId}`);
      continue;
    }

    // If we could not verify the authoritative INDEX, fail closed: keep the
    // marker for a later launch instead of guessing and deleting anything.
    if (authoritativeBeatIds === null) {
      remaining.push(item);
      continue;
    }

    try {
      const response = await fetch(`${base}/beats/delete-topic`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ beatgalerUserId, beatId: item.beatId }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `HTTP ${response.status}`);
      }

      await purgeInterruptedUploadLocal(item.beatId, item.stagingPaths);
      rolledBack.push(item.beatName);
    } catch (error) {
      console.warn(`Could not roll back interrupted upload ${item.beatName}:`, error);
      remaining.push(item);
    }
  }

  writeActiveCloudUploads(remaining);
  return rolledBack;
}

function BeatGalerApp() {
  const {
    beats,
    setBeats,
    beatsLatestRef,
    startupCachedBeatsRef,
    initialLoading,
  } = useLibraryState();
  const [openableCloudProjectIds, setOpenableCloudProjectIds] = useState<Set<string>>(new Set());
  const cloudMetaSnapshotRef = useRef<Map<string, string> | null>(null);
  const cloudLibraryTimerRef = useRef<number | null>(null);
  const cloudLibrarySnapshotRef = useRef<string | null>(null);
  const visibleLibraryFingerprintRef = useRef<string>("");
  const autoCloudUploadRef = useRef<Set<string>>(new Set());
  const backgroundUploadQueueRef = useRef<Beat[]>([]);
  const {
    beatRuntimeStates,
    beatRuntimeStatesRef,
    transitionRuntime,
    forgetRuntimeState,
    clearReconciledTrashRuntimeStates,
  } = useBeatRuntimeRegistry(beats, beatsLatestRef);
  const backgroundUploadRunningRef = useRef(false);
  // A manual Reload pressed during an import must never overwrite the optimistic
  // in-flight rows with the older committed Telegram INDEX. Queue the reload and
  // execute it after the batch commits instead.
  const deferredLibraryReloadRef = useRef(false);
  const uploadCompleteTimersRef = useRef<Map<string, number>>(new Map());
  const cloudPullInFlightRef = useRef(false);
  const stagedImportPathsRef = useRef<Map<string, string[]>>(new Map());
  const [backgroundUploadErrors, setBackgroundUploadErrors] = useState<Record<string, string>>({});
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
  const [tagRename, setTagRename] = useState<{ oldTag: string; newTag: string; stage: "name" | "confirm" } | null>(null);
  const [tagRenameBusy, setTagRenameBusy] = useState(false);
  const [tagRenameError, setTagRenameError] = useState<string | null>(null);
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
  const [dropImportBatch, setDropImportBatch] = useState<ImportBatchPreview | null>(null);
  const [deferredImportBatch, setDeferredImportBatch] = useState<ImportBatchPreview | null>(null);
  const [audioConflictBatch, setAudioConflictBatch] = useState<ImportBatchPreview | null>(null);
  const [reviewBootstrap, setReviewBootstrap] = useState<{ total: number | null } | null>(null);
  // Covers the WebView2 staging window that happens BEFORE importDroppedPaths
  // receives native paths. Without this state, the app can look frozen while
  // large dropped files are being copied into drop-staging.
  const [libraryDropStaging, setLibraryDropStaging] = useState(false);
  const [reviewPreparationDone, setReviewPreparationDone] = useState(true);
  const [bulkSaveAllBusy, setBulkSaveAllBusy] = useState(false);
  const [beatFileDrop, setBeatFileDrop] = useState<{ beat: Beat; filePath: string; kind: "file" | "directory" } | null>(null);
  const [cloudFilesBeat, setCloudFilesBeat] = useState<Beat | null>(null);
  const [cloudFiles, setCloudFiles] = useState<CloudFileRecord[]>([]);
  const [cloudFilesBusyId, setCloudFilesBusyId] = useState<string | null>(null);
  const [cloudFilesDownloadedIds, setCloudFilesDownloadedIds] = useState<Set<string>>(new Set());
  const [cloudFilesDownloadError, setCloudFilesDownloadError] = useState<string | null>(null);
  const [cloudDownloadNotice, setCloudDownloadNotice] = useState<{
    taskId: string;
    kind: BeatDownloadKind;
    beatName: string;
    status: "downloading" | "completed";
  } | null>(null);
  const backgroundDownloadRuntimeOwnersRef = useRef<Set<string>>(new Set());
  const [projectUpdateNotice, setProjectUpdateNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!projectUpdateNotice) return;
    const timer = window.setTimeout(() => setProjectUpdateNotice(null), 9000);
    return () => window.clearTimeout(timer);
  }, [projectUpdateNotice]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueState | null>(null);
  // Background uploads can finish while the user is still reviewing other beats
  // from the SAME drop-staging session. Keep a live ref so staging cleanup never
  // deletes the remaining Review sources after the first upload succeeds.
  const reviewQueueLatestRef = useRef<ReviewQueueState | null>(null);
  const reviewPreparationRunRef = useRef(0);
  const reviewPreparationPromiseRef = useRef<Promise<Beat[]> | null>(null);
  // Cancels stale async import bootstrap work when Review is cancelled/replaced.
  const importReviewRequestRunRef = useRef(0);
  const skippedReviewSourceKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => { reviewQueueLatestRef.current = reviewQueue; }, [reviewQueue]);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Prevent cached/local state from being pushed back to Telegram before this
  // app session has first verified and pulled the authoritative pinned index.
  const [cloudSessionVerified, setCloudSessionVerified] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
    typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "checking"
  );
  const [offlineBusyIds, setOfflineBusyIds] = useState<Set<string>>(new Set());
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

  // Keep a ref to togglePause so the keydown handler never goes stale
  const togglePauseRef = useRef(togglePause);
  const deleteInFlightRef = useRef(new Set<string>());
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

          const rolledBackNames = await rollbackInterruptedCloudUploads(
            local.beatgaler_user_id,
            recoveryAuthorityIds,
          );
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

  const handleUploadProjectTelegram = useCallback(async (beat: Beat) => {
    if (rejectOfflineMutation("Uploading a project")) return;
    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      await uploadProjectToTelegram(beat);
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, beat);
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await appAlert({
        title: "Project synced to Galer Cloud",
        message: `${beat.name}.zip is stored in Galer Cloud as one PROJECT file.`,
      });
    } catch (e: any) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(e), "Cloud operation failed.");
      if (isRuntimeConflictError(e)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "PROJECT_UPLOAD_FAILED", message, retryable: true }, beat);
      await appAlert({ title: "Project upload failed", message, danger: true });
    }
  }, [rejectOfflineMutation, transitionRuntime]);

  const handleOpenProject = useCallback(async (beat: Beat) => {
    if (connectionState !== "online" && !beat.offline_available) {
      await appAlert({
        title: "Project unavailable offline",
        message: "This project was not downloaded with Available Offline. Reconnect to open it.",
      });
      return;
    }
    try {
      await openBeatProject(beat);
      await appAlert({
        title: "Project opened",
        message: "Save normally in FL Studio. When you want those changes stored in Galer Cloud, return to BeatGaler and choose “Update Project”.",
      });
    } catch (e: any) {
      await appAlert({ title: "Project unavailable", message: String(e?.message || e), danger: true });
    }
  }, [connectionState]);

  const handleUpdateProject = useCallback(async (beat: Beat) => {
    if (rejectOfflineMutation("Updating a project")) return;
    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      await uploadProjectToTelegram(beat);
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, beat);
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await appAlert({
        title: "Project updated",
        message: "The current PROJECT.zip has been synced to Galer Cloud.",
      });
    } catch (e: any) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(e), "Cloud operation failed.");
      if (isRuntimeConflictError(e)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "PROJECT_UPDATE_FAILED", message, retryable: true }, beat);
      await appAlert({
        title: "Project update failed",
        message,
        danger: true,
      });
    }
  }, [rejectOfflineMutation, transitionRuntime]);

  const handleUploadBulk = useCallback(() => {
    if (rejectOfflineMutation("Bulk upload")) return;
    setShowUpload({ initialBeat: null, selectedIds: Array.from(selectedIds) });
  }, [selectedIds, rejectOfflineMutation]);

  const handleEditBulk = useCallback(() => {
    if (rejectOfflineMutation("Editing metadata")) return;
    const firstSelected = beats.find(b => selectedIds.has(b.id));
    if (firstSelected) setDrawer({ beat: firstSelected, mode: "edit" });
  }, [beats, selectedIds, rejectOfflineMutation]);

  const handleRemoveBulk = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const approved = await appConfirm({
      title: `Remove ${ids.length} beat${ids.length === 1 ? "" : "s"}?`,
      message: "Remove the selected beats from BeatGaler? Cloud-backed files remain stored; local-only files are moved to BeatGaler trash.",
      confirmLabel: ids.length === 1 ? "Remove beat" : "Remove beats",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!approved) return;

    const deleted = new Set<string>();
    for (const id of ids) {
      if (deleteInFlightRef.current.has(id)) continue;
      deleteInFlightRef.current.add(id);
      const beat = beats.find(item => item.id === id);
      if (beat?.telegram_file_id) {
        if (connectionState === "online") transitionRuntime(id, { type: "SYNC_DELETE_STARTED" }, beat);
        else transitionRuntime(id, { type: "SET_TRASH_SYNC_REQUIRED", required: true }, beat);
      }
      try {
        await removeBeatFromLibrary(id);
        deleted.add(id);
      } catch (err) {
        console.error(err);
        const runtime = beatRuntimeStatesRef.current[id];
        if (runtime?.sync_state === "deleting") {
          transitionRuntime(id, { type: "SYNC_FAILED", code: "DELETE_FAILED", message: sanitizeUserVisibleText(runtimeErrorMessage(err), "Cloud operation failed."), retryable: true }, beat);
        }
      } finally {
        deleteInFlightRef.current.delete(id);
      }
    }

    if (deleted.size > 0) {
      const next = beats.filter(b => !deleted.has(b.id));
      setBeats(next);

      // Offline Trash is a reversible local state, not a stale whole-index write.
      // On reconnect the server will move the CURRENT online beat objects by id.
      if (connectionState !== "online") {
        const deletedCloudIds = beats
          .filter(beat => deleted.has(beat.id) && !!beat.telegram_file_id)
          .map(beat => beat.id);
        const intentResults = await Promise.allSettled(deletedCloudIds.map(id => recordOfflineTrashIntent(id)));
        const failedIntentCount = intentResults.filter(result => result.status === "rejected").length;
        if (failedIntentCount > 0) {
          await appAlert({
            title: "Some Trash changes are local only",
            message: `${failedIntentCount} beat${failedIntentCount === 1 ? "" : "s"} could not be queued for reconnect. Restore those beats before closing BeatGaler, or reconnect and remove them again.`,
            danger: true,
          });
        }
      } else {
        const cloudBacked = next.filter(beat => !!beat.telegram_file_id);
        cloudLibrarySnapshotRef.current = cloudBacked.map(cloudBeatFingerprint).join("\u001c");
        try {
          await libraryStateManager.commitSnapshot(next, "bulk-remove");
          for (const id of deleted) forgetRuntimeState(id);
        } catch (error) {
          console.warn("Telegram library index refresh after Remove all failed:", error);
          const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
          for (const id of deleted) {
            const runtime = beatRuntimeStatesRef.current[id];
            if (runtime?.sync_state === "deleting") {
              transitionRuntime(id, { type: "SYNC_FAILED", code: "DELETE_INDEX_SYNC_FAILED", message, retryable: true });
            }
          }
        }
      }
    }
    if (deleted.size !== ids.length) {
      await appAlert({
        title: "Some beats were not removed",
        message: "One or more selected beats could not be removed from the library.",
        danger: true,
      });
    }
    clearSelection();
  }, [selectedIds, beats, connectionState, forgetRuntimeState, transitionRuntime]);

  const addBeats = useCallback((newBeats: Beat[]) => {
    setBeats(bs => {
      const existing = new Set(bs.map(b => b.mp3_path));
      const next = [...newBeats.filter(b => !existing.has(b.mp3_path)), ...bs];
      beatsLatestRef.current = next;
      return next;
    });
  }, []);

  const waitForCloudSessionWithBackoff = useCallback(async () => {
    const delays = [0, 1000, 2000, 5000, 10000, 30000, 60000];
    let lastError: unknown = null;

    for (const delay of delays) {
      if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay));
      try {
        const status = await pollTelegramCloudStatus();
        if (!status.reachable) {
          lastError = new Error("Galer Cloud is temporarily unreachable.");
          setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
          continue;
        }
        if (!status.connected) return { status, error: null as unknown };
        setConnectionState("online");
        return { status, error: null as unknown };
      } catch (error) {
        lastError = error;
        setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
      }
    }

    return { status: { connected: Boolean(settings?.telegram_cloud_connected), reachable: false, username: settings?.telegram_cloud_username ?? null }, error: lastError };
  }, [settings?.telegram_cloud_connected, settings?.telegram_cloud_username]);

  const cloudifyImportedBeats = useCallback((newBeats: Beat[]) => {
    if (newBeats.length === 0) return;

    if (platform.capabilities.reviewBeatCloudCommit) {
      for (const beat of newBeats) {
        if (autoCloudUploadRef.current.has(beat.id)) continue;
        autoCloudUploadRef.current.add(beat.id);
        transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPLOAD" }, beat);
        transitionRuntime(beat.id, { type: "SYNC_UPLOAD_STARTED" }, beat);
        setBackgroundUploadErrors(current => {
          if (!(beat.id in current)) return current;
          const next = { ...current };
          delete next[beat.id];
          return next;
        });
        setBeats(current => {
          const next = current.map(item => item.id === beat.id ? { ...item, cloud_status: "UPLOADING" } : item);
          beatsLatestRef.current = next;
          return next;
        });

        void platform.cloudData.commitImportedBeat(beat).then(committed => {
          transitionRuntime(committed.id, { type: "SYNC_UPLOAD_SUCCEEDED" }, committed);
          setBackgroundUploadErrors(current => {
            if (!(committed.id in current)) return current;
            const next = { ...current };
            delete next[committed.id];
            return next;
          });
          setBeats(current => {
            const next = current.map(item => item.id === committed.id ? committed : item);
            beatsLatestRef.current = next;
            return next;
          });
        }).catch(error => {
          const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
          transitionRuntime(beat.id, {
            type: "SYNC_FAILED",
            code: "WEB_IMPORT_FAILED",
            message,
            retryable: true,
          }, beat);
          setBackgroundUploadErrors(current => ({ ...current, [beat.id]: message }));
          setBeats(current => {
            const next = current.map(item => item.id === beat.id ? { ...item, cloud_status: "ERROR" } : item);
            beatsLatestRef.current = next;
            return next;
          });
        }).finally(() => {
          autoCloudUploadRef.current.delete(beat.id);
        });
      }
      return;
    }

    // Do not trust the React settings snapshot here. On macOS the Telegram
    // callback/SSE can complete before this closure receives the updated
    // settings value. The worker verifies the REAL backend session once.
    // Queue work immediately but never await it from the review/save UI.
    // One beat at a time keeps CPU/disk/network pressure predictable.
    for (const beat of newBeats) {
      const alreadyQueued = backgroundUploadQueueRef.current.some(item => item.id === beat.id);
      if (alreadyQueued || autoCloudUploadRef.current.has(beat.id)) continue;
      // Persist synchronously before network work begins. If the process exits
      // before full cloud finalization, startup will roll this beat back.
      markCloudUploadActive(beat);
      backgroundUploadQueueRef.current.push(beat);
      transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPLOAD" }, beat);
      setBackgroundUploadErrors(current => {
        if (!(beat.id in current)) return current;
        const next = { ...current };
        delete next[beat.id];
        return next;
      });
      setBeats(current => current.map(b =>
        b.id === beat.id ? { ...b, cloud_status: "UPLOADING" } : b
      ));
    }

    if (backgroundUploadRunningRef.current) return;
    backgroundUploadRunningRef.current = true;

    window.setTimeout(() => {
      void (async () => {
        try {
          // One explicit status check per background batch. This is NOT polling.
          // pollTelegramCloudStatus also reconciles the Rust-side settings cache,
          // which upload_beat_to_telegram validates before reading the local file.
          const verified = await waitForCloudSessionWithBackoff();
          const cloudSession = verified.status;
          const sessionCheckError = verified.error;
          if (sessionCheckError) {
            console.warn("Background upload could not verify Telegram session after backoff:", sessionCheckError);
          }

          if (!cloudSession.connected || !cloudSession.reachable) {
            const failed = backgroundUploadQueueRef.current.splice(0);
            const raw = sessionCheckError instanceof Error
              ? sessionCheckError.message
              : sessionCheckError != null
                ? String(sessionCheckError)
                : "BeatGaler could not verify cloud access for this installation.";

            const detail = [
              "UPLOAD FAILED",
              "Stage: Verify cloud session",
              "",
              raw,
              "",
              "Checks:",
              "• Confirm the Windows cloud-server and Tailscale Funnel are running.",
              "• Confirm this BeatGaler installation is signed in to the intended account.",
              "• Sign out and back in if this installation is attached to the wrong account.",
            ].join("\n");

            setBackgroundUploadErrors(current => {
              const next = { ...current };
              for (const item of failed) next[item.id] = detail;
              return next;
            });
            for (const item of failed) {
              transitionRuntime(item.id, {
                type: "SYNC_FAILED",
                code: "TELEGRAM_SESSION_UNAVAILABLE",
                message: raw,
                retryable: true,
              }, item);
            }
            setBeats(current => current.map(b =>
              failed.some(item => item.id === b.id)
                ? { ...b, cloud_status: "ERROR" }
                : b
            ));
            return;
          }

          setSettings(current =>
            current
              ? {
                  ...current,
                  telegram_cloud_connected: true,
                  telegram_cloud_username: cloudSession.username,
                }
              : current
          );

          while (backgroundUploadQueueRef.current.length > 0) {
            const original = backgroundUploadQueueRef.current.shift()!;
            if (autoCloudUploadRef.current.has(original.id)) continue;
            autoCloudUploadRef.current.add(original.id);

            let uploadStage = "Prepare upload";
            let remoteUploadCompleted = false;
            let syncCommitted = false;
            transitionRuntime(original.id, { type: "SYNC_UPLOAD_STARTED" }, original);
            try {
              let uploaded = original;

              // MASTER: only upload when the beat does not already own one.
              if (!uploaded.telegram_file_id) {
                uploadStage = "Upload MASTER audio";
                uploaded = await uploadBeatToTelegram(uploaded);
                setBeats(current => current.map(b =>
                  b.id === uploaded.id ? { ...uploaded, cloud_status: "UPLOADING" } : b
                ));
              }

              uploadStage = "Read existing cloud file slots";
              const existingFiles = await listCloudFilesForBeat(uploaded.id);
              const hasCloudWav = existingFiles.some(file => file.file_type === "WAV");

              if (uploaded.wav_path && !hasCloudWav) {
                uploadStage = "Upload WAV HQ";
                await uploadDroppedFileToTelegram(uploaded, uploaded.wav_path, "WAV");
              }

              const hasProjectSource =
                !!uploaded.flp_path || !!uploaded.als_path || uploaded.has_flp || uploaded.has_als;

              if (hasProjectSource) {
                uploadStage = "Check PROJECT cloud state";
                const currentProject = await getProjectCloudStatus(uploaded);
                if (!currentProject?.synced) {
                  uploadStage = "Build and upload PROJECT.zip";
                  await uploadProjectToTelegram(uploaded);
                }
              }

              // Every required Telegram slot is now durable. Anything that fails
              // below this point is local finalization and must not make the UI imply
              // that the remote upload itself is still pending.
              remoteUploadCompleted = true;

              // Only detach local import sources after every required cloud slot succeeds.
              uploadStage = "Finalize cloud copy and detach local sources";
              const detached = await detachLocalSourcesAfterCloudUpload(uploaded.id);

              setBackgroundUploadErrors(current => {
                if (!(detached.id in current)) return current;
                const next = { ...current };
                delete next[detached.id];
                return next;
              });

              // Upload completion and playback readiness are deliberately separate.
              // The Telegram send can finish a moment before its new MASTER can be
              // downloaded back. Keep the card blocked until Download Cooking has
              // enough real bytes for a reliable first Play.
              setBeats(current => {
                const next = current.map(b =>
                  b.id === detached.id ? { ...detached, cloud_status: "PLAYBACK_PREPARING" } : b
                );
                beatsLatestRef.current = next;
                return next;
              });

              // Artwork is part of the logical beat upload. Finish it BEFORE the
              // single authoritative index commit so MP3 + WAV + PROJECT + artwork
              // + metadata become visible in Telegram with one INDEX replacement.
              uploadStage = "Sync artwork and metadata";
              await syncBeatMetadataToTelegram(detached);

              // Durability boundary is PER BEAT, matching the proven pre-V7 behavior.
              // The LibraryStateManager still serializes all INDEX writes, so concurrent
              // imports cannot race; however, a finished beat never waits for the rest
              // of the batch before becoming authoritative.
              uploadStage = "Commit beat to authoritative INDEX";
              const indexSnapshot = beatsLatestRef.current.map(beat =>
                beat.id === detached.id
                  ? { ...detached, cloud_status: "CLOUD_ONLY" }
                  : beat
              );
              await libraryStateManager.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`);
              cloudLibrarySnapshotRef.current = indexSnapshot
                .filter(item => !!item.telegram_file_id)
                .map(cloudBeatFingerprint)
                .join("\u001c");
              syncCommitted = true;
              transitionRuntime(detached.id, { type: "SYNC_UPLOAD_SUCCEEDED" }, detached);

              // Critical: once Telegram media + INDEX are committed, this beat is no
              // longer interruptible. Clear its marker immediately, before playback
              // warming or before the next beat in the batch starts.
              clearCloudUploadActive(original.id);

              uploadStage = "Prepare uploaded MASTER for first Play";
              transitionRuntime(detached.id, { type: "PLAYBACK_PREPARING" }, detached);
              const playbackReady = await waitForUploadedBeatPlaybackReady(detached);
              if (!playbackReady) {
                const detail = [
                  "PLAYBACK PREPARATION FAILED",
                  `Beat: ${detached.name}`,
                  "",
                  "The media upload and Galer Library index are already committed, but BeatGaler could not warm the new MASTER for playback within 15 seconds.",
                  "The beat was left in Cloud safely; retrying later should not require re-uploading the file.",
                ].join("\n");
                setBackgroundUploadErrors(current => ({ ...current, [detached.id]: detail }));
                transitionRuntime(detached.id, {
                  type: "PLAYBACK_FAILED",
                  code: "MASTER_PREPARE_TIMEOUT",
                  message: detail,
                  retryable: true,
                }, detached);
                setBeats(current => {
                  const next = current.map(b => b.id === detached.id ? { ...detached, cloud_status: "ERROR" } : b);
                  beatsLatestRef.current = next;
                  return next;
                });
              } else {
                transitionRuntime(detached.id, { type: "PLAYBACK_IDLE" }, detached);
                // Green completion state is intentionally transient and UI-only,
                // and now means something precise: the MASTER is actually playable.
                setBeats(current => {
                  const next = current.map(b =>
                    b.id === detached.id ? { ...detached, cloud_status: "UPLOAD_COMPLETE" } : b
                  );
                  beatsLatestRef.current = next;
                  return next;
                });
              }

              // IMPORTANT: one HTML drop session can contain MANY beats. Never delete
              // the whole drop-staging/<session> just because one beat finished: that
              // would erase the source files of the remaining queued/review beats.
              // Clean orphan sessions only when this background batch is drained and
              // there is no active Review/import decision still depending on staging.
              if (
                backgroundUploadQueueRef.current.length === 0 &&
                reviewQueueLatestRef.current === null &&
                stagedImportPathsRef.current.size === 0
              ) {
                await cleanupOrphanedDropStaging(beatsLatestRef.current);
              }

              if (playbackReady) {
                try {
                  const audio = new Audio(uploadCompleteWav);
                  audio.volume = 0.22;
                  void audio.play().catch(() => {});
                } catch {}

                const oldTimer = uploadCompleteTimersRef.current.get(detached.id);
                if (oldTimer) window.clearTimeout(oldTimer);
                const timer = window.setTimeout(() => {
                  setBeats(current => {
                    const next = current.map(b =>
                      b.id === detached.id && b.cloud_status === "UPLOAD_COMPLETE"
                        ? { ...b, cloud_status: "CLOUD_ONLY" }
                        : b
                    );
                    beatsLatestRef.current = next;
                    return next;
                  });
                  uploadCompleteTimersRef.current.delete(detached.id);
                }, 1050);
                uploadCompleteTimersRef.current.set(detached.id, timer);
              }

            } catch (error) {
              console.warn(`Background Telegram upload failed for ${original.name} at ${uploadStage}:`, error);

              const raw = error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : (() => {
                      try { return JSON.stringify(error); }
                      catch { return String(error); }
                    })();

              const lower = raw.toLowerCase();
              let hint = "Unexpected failure. The exact raw error is included below.";
              if (lower.includes("encoder unavailable") || lower.includes("bundled ffmpeg") || lower.includes("could not start wav -> mp3")) {
                hint = "This WAV needs a MASTER MP3, but BeatGaler could not start its bundled MP3 encoder. The installer/build must include ffmpeg; the user should not need to install it manually.";
              } else if (lower.includes("wav -> mp3") || lower.includes("master generation") || lower.includes("conversion failed")) {
                hint = "BeatGaler found the WAV but could not create the temporary 320 kbps MASTER MP3. The raw converter error is shown below.";
              } else if (
                lower.includes("wav source could not be read") ||
                lower.includes("os error 3") ||
                lower.includes("file not found") ||
                lower.includes("no usable audio source") ||
                lower.includes("no longer exists")
              ) {
                hint = "The local source audio disappeared before BeatGaler could upload it. For drag/drop batches this means the temporary drop-staging source is missing; BeatGaler now keeps shared staging alive until every pending/review beat is finished.";
              } else if (lower.includes("temp") || lower.includes("prepare cloud audio copy") || lower.includes("metadata") || lower.includes("id3")) {
                hint = "BeatGaler failed while creating its temporary upload copy or embedding metadata. Check file permissions, free disk space, and whether the source audio is a valid MP3/WAV.";
              } else if (lower.includes("failed to start curl")) {
                hint = "BeatGaler could not start the system HTTP client. On macOS the app now explicitly uses /usr/bin/curl; if this still appears, the system curl executable is unavailable.";
              } else if (lower.includes("could not reach") || lower.includes("timed out") || lower.includes("couldn't connect") || lower.includes("connection")) {
                hint = "BeatGaler could not complete the request to the Cloud server. Check Internet connectivity and that the BeatGaler Cloud server is running.";
              } else if (lower.includes("http 400") || lower.includes("not connected for this beatgaler installation")) {
                hint = "The server received the request but could not verify cloud access for this BeatGaler installation. Sign out and back in, then retry.";
              } else if (lower.includes("413") || lower.includes("too large")) {
                hint = "The server rejected the file because it exceeded the configured upload limit.";
              } else if (lower.includes("invalid json") || lower.includes("<!doctype") || lower.includes("<html")) {
                hint = "The endpoint returned something other than BeatGaler JSON. This can indicate a tunnel/proxy error page or an unexpected server response.";
              } else if (lower.includes("telegram")) {
                hint = "The request reached the cloud portion of the flow. Read the server error below for the exact rejection.";
              }

              const detail = [
                "UPLOAD FAILED",
                `Beat: ${original.name}`,
                `Stage: ${uploadStage}`,
                `Platform: ${navigator.platform || "unknown"}`,
                "",
                hint,
                "",
                `Error detail: ${sanitizeUserVisibleText(raw, "Unknown error")}`,
              ].join("\n");

              if (!syncCommitted) {
                transitionRuntime(original.id, {
                  type: "SYNC_FAILED",
                  code: "UPLOAD_FAILED",
                  message: detail,
                  retryable: true,
                }, original);
              } else {
                const runtime = beatRuntimeStatesRef.current[original.id];
                if (runtime?.playback_state === "playback_preparing") {
                  transitionRuntime(original.id, {
                    type: "PLAYBACK_FAILED",
                    code: "PLAYBACK_PREPARATION_FAILED",
                    message: detail,
                    retryable: true,
                  }, original);
                }
              }
              setBackgroundUploadErrors(current => ({ ...current, [original.id]: detail }));
              setBeats(current => current.map(b =>
                b.id === original.id
                  ? {
                      ...b,
                      // If Telegram already has every required slot, expose the
                      // durable cloud state even when local cleanup/finalization failed.
                      cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR",
                    }
                  : b
              ));
            } finally {
              autoCloudUploadRef.current.delete(original.id);
            }

            // Yield between beats so React/WebView always gets a render opportunity.
            await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          }

        } finally {
          backgroundUploadRunningRef.current = false;
          if (deferredLibraryReloadRef.current) {
            deferredLibraryReloadRef.current = false;
            window.dispatchEvent(new Event("beatgaler:deferred-library-reload"));
          }
        }
      })();
    }, 0);
  }, [transitionRuntime, waitForUploadedBeatPlaybackReady, waitForCloudSessionWithBackoff]);

  const retryBackgroundUpload = useCallback((beat: Beat) => {
    if (rejectOfflineMutation("Retrying an upload")) return;
    setBackgroundUploadErrors(current => {
      if (!(beat.id in current)) return current;
      const next = { ...current };
      delete next[beat.id];
      return next;
    });
    // cloudifyImportedBeats is checkpoint-aware: an existing MASTER/WAV/PROJECT
    // is detected in Telegram and skipped, so retry resumes at the first missing
    // stage instead of uploading the whole beat again.
    cloudifyImportedBeats([{ ...beat, cloud_status: "UPLOADING" }]);
  }, [cloudifyImportedBeats, rejectOfflineMutation]);

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
    setReviewQueue({ beats: sanitized, index: 0, total: sanitized.length, batchId: null, preparing: false });
    // Upload begins only after Review → Save.
  }, [connectionState]);

  const skipCurrentReviewBeat = useCallback(() => {
    setReviewQueue(q => {
      if (!q) return null;
      const currentBeat = q.beats[q.index];
      const sourceKey = currentBeat ? reviewSourceKey(currentBeat) : "";
      if (sourceKey) skippedReviewSourceKeysRef.current.add(sourceKey);
      if (platform.capabilities.reviewBeatCloudCommit && currentBeat) platform.importer.releaseBeat(currentBeat.id);

      const knownLast = q.total !== null && q.index >= q.total - 1;
      if (knownLast && !q.preparing) {
        // Skip means ONLY this beat. The global Cancel Import action is separate.
        window.setTimeout(() => {
          void cleanupOrphanedDropStaging([
            ...beatsLatestRef.current,
            ...backgroundUploadQueueRef.current,
          ]);
        }, 0);
        return null;
      }
      // If discovery is still running, advance into a skeleton for Beat N+1.
      // The streaming worker will fill that exact slot as soon as it finds it.
      return { ...q, index: q.index + 1 };
    });
  }, []);

  const skipAllReviewQueue = useCallback(() => {
    importReviewRequestRunRef.current += 1;
    reviewPreparationRunRef.current += 1;
    reviewPreparationPromiseRef.current = null;
    skippedReviewSourceKeysRef.current.clear();
    setReviewPreparationDone(true);
    setReviewBootstrap(null);
    setAudioConflictBatch(null);
    setDeferredImportBatch(current => {
      if (current?.batch_id) void discardImportReviewBatch(current.batch_id);
      return null;
    });

    // Cancel means cancel the current review batch, not silently "skip" it.
    // Beats already saved before the current position stay in the library;
    // the current + remaining unsaved review candidates are removed.
    setReviewQueue(q => {
      if (!q) return null;
      if (platform.capabilities.reviewBeatCloudCommit) {
        for (const beat of q.beats.slice(q.index)) platform.importer.releaseBeat(beat.id);
      }
      if (q.batchId) void discardImportReviewBatch(q.batchId);
      window.setTimeout(() => {
        const protectedBeats = [
          ...beatsLatestRef.current,
          ...backgroundUploadQueueRef.current,
        ];
        void cleanupOrphanedDropStaging(protectedBeats);
      }, 0);
      return null;
    });
  }, []);

  const handleReviewedBeatSaved = useCallback((updated: Beat) => {
    setBeats(bs => {
      const exists = bs.some(b => b.id === updated.id);
      const next = exists
        ? bs.map(b => b.id === updated.id ? updated : b)
        : [updated, ...bs];
      beatsLatestRef.current = next;
      return next;
    });
    setReviewQueue(q => {
      if (!q) return null;
      const nextBeats = q.beats.map(b => b.id === updated.id ? updated : b);
      const knownLast = q.total !== null && q.index >= q.total - 1;
      if (knownLast && !q.preparing) return null;
      return { ...q, beats: nextBeats, index: q.index + 1 };
    });

    // Fire-and-forget. Save/next closes immediately; Telegram work is secondary.
    cloudifyImportedBeats([updated]);
  }, [cloudifyImportedBeats]);

  const handleReviewedSaveAll = useCallback(async (currentUpdated: Beat) => {
    const queue = reviewQueueLatestRef.current;
    if (!queue) return;
    const startIndex = queue.index;
    setBulkSaveAllBusy(true);

    // Save All is a UX command, not a request to wait for Review preparation.
    // Close Review immediately, commit the current beat, then let the same
    // sequential worker finish metadata for the remaining beats in background.
    setReviewQueue(null);
    setBeats(current => {
      const exists = current.some(item => item.id === currentUpdated.id);
      const next = exists
        ? current.map(item => item.id === currentUpdated.id ? currentUpdated : item)
        : [currentUpdated, ...current];
      beatsLatestRef.current = next;
      return next;
    });
    cloudifyImportedBeats([currentUpdated]);

    let allPrepared = queue.beats;
    if (reviewPreparationPromiseRef.current) {
      try {
        allPrepared = await reviewPreparationPromiseRef.current;
      } catch (error) {
        // The background preparer already surfaces the real error. Save All
        // must still keep already-prepared beats usable instead of rejecting
        // the whole batch promise.
        console.warn("Save All continued with already-prepared beats:", error);
        allPrepared = reviewQueueLatestRef.current?.beats ?? queue.beats;
      }
    }
    const remaining = allPrepared.slice(startIndex + 1);
    const committed: Beat[] = [];
    const nameConflicts: Beat[] = [];

    const queueIds = new Set(allPrepared.map(item => item.id));
    const reservedNames = new Set(
      beatsLatestRef.current
        .filter(item => !queueIds.has(item.id) && item.id !== currentUpdated.id)
        .map(item => item.name.trim().toLocaleLowerCase())
        .filter(Boolean)
    );
    const currentName = currentUpdated.name.trim().toLocaleLowerCase();
    if (currentName) reservedNames.add(currentName);

    for (const beat of remaining) {
      const nameKey = beat.name.trim().toLocaleLowerCase();
      if (nameKey && reservedNames.has(nameKey)) {
        // Duplicate review candidates are not auto-renamed. They are moved to
        // the end so Save All remains fast and the user can choose a real name.
        nameConflicts.push(beat);
        continue;
      }
      if (nameKey) reservedNames.add(nameKey);

      try {
        const bpmCheck = validateBpm(beat.bpm);
        const keyCheck = validateMusicKey(beat.key);
        if (bpmCheck.valid === false) throw new Error(`${beat.name}: ${bpmCheck.reason}`);
        if (keyCheck.valid === false) throw new Error(`${beat.name}: ${keyCheck.reason}`);

        const cleaned = cleanTags(beat.tags);
        const normalized: Beat = {
          ...beat,
          tags: cleaned.tags,
          bpm: bpmCheck.normalized,
          key: keyCheck.normalized,
        };

        const result = await saveBeatMeta({
          mp3_path: normalized.mp3_path,
          wav_path: normalized.wav_path,
          bpm: normalized.bpm,
          key: normalized.key,
          tags: normalized.tags,
          rating: normalized.rating,
          image_base64: normalized.image_base64,
          image_preview_base64: normalized.image_preview_base64 ?? null,
          image_crop: normalized.image_crop ?? null,
          update_filename: normalized.bpm !== beat.bpm || normalized.key !== beat.key,
        });

        committed.push({
          ...normalized,
          mp3_path: result.new_mp3_path || normalized.mp3_path,
          wav_path: result.new_wav_path ?? normalized.wav_path,
          playback_path: result.new_mp3_path || normalized.mp3_path || normalized.playback_path,
        });
      } catch (error) {
        console.warn(`Save All could not commit ${beat.name}:`, error);
        nameConflicts.push(beat);
      }

      // Keep WebView responsive even when hundreds of beats are selected.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }

    if (committed.length > 0) {
      const committedIds = new Set(committed.map(beat => beat.id));
      setBeats(current => {
        const next = [
          ...committed,
          ...current.filter(beat => !committedIds.has(beat.id)),
        ];
        beatsLatestRef.current = next;
        return next;
      });
      cloudifyImportedBeats(committed);
    }

    // Local duplicate/validation conflicts are intentionally last and reopen
    // Review instead of blocking the whole Save All batch.
    if (nameConflicts.length > 0) {
      setReviewQueue({ beats: nameConflicts, index: 0, total: nameConflicts.length, batchId: queue.batchId, preparing: false });
    }
    setBulkSaveAllBusy(false);
  }, [cloudifyImportedBeats]);

  const importDroppedPaths = useCallback(async (paths: string[]) => {
    if (rejectOfflineMutation("Importing beats")) return;
    const normalized = Array.from(new Set(paths.map(p => p.trim()).filter(Boolean)));
    if (normalized.length === 0 || dropImporting) return;

    const dropStarted = performance.now();
    const diagRun = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    reviewPerfMark(`run=${diagRun} IMPORT_BEGIN path_count=${normalized.length} names=${normalized.map(fileNameFromPath).slice(0, 12).join("|")}`);
    const requestRunId = ++importReviewRequestRunRef.current;
    setDropImporting(true);
    setReviewPreparationDone(false);
    setDeferredImportBatch(null);
    setAudioConflictBatch(null);
    setDropImportBatch(null);
    skippedReviewSourceKeysRef.current.clear();
    if (REVIEW_SKELETON_ENABLED) {
      setReviewBootstrap({ total: null });
      reviewPerfMark(`run=${diagRun} SKELETON_STATE_REQUESTED elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      requestAnimationFrame(() => reviewPerfMark(`run=${diagRun} SKELETON_FRAME elapsed_ms=${Math.round(performance.now() - dropStarted)}`));
    }
    console.info("[review-perf] DROP_RECEIVED 0 ms");

    try {
      // IMPORTANT: this creates only a cursor. It does not recursively scan the
      // batch, count every beat, or inspect projects. That work is streamed by
      // prepareNextImportReviewBeat one beat at a time.
      reviewPerfMark(`run=${diagRun} STREAM_INVOKE_START elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      const stream = await startImportReviewStream(normalized);
      reviewPerfMark(`run=${diagRun} STREAM_INVOKE_END elapsed_ms=${Math.round(performance.now() - dropStarted)} batch=${stream.batch_id}`);
      if (importReviewRequestRunRef.current !== requestRunId) {
        void discardImportReviewBatch(stream.batch_id);
        return;
      }
      stagedImportPathsRef.current.set(stream.batch_id, normalized);
      console.info(`[review-perf] STREAM_READY ${Math.round(performance.now() - dropStarted)} ms`);

      // Critical path: discover only until the FIRST normal playable audio is
      // found, read its metadata/artwork, and stop. N intentionally remains
      // unknown until the background worker reaches the end of the tree.
      reviewPerfMark(`run=${diagRun} FIRST_PREPARE_INVOKE_START elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      const firstStep = await prepareNextImportReviewBeat(stream.batch_id);
      reviewPerfMark(`run=${diagRun} FIRST_PREPARE_INVOKE_END elapsed_ms=${Math.round(performance.now() - dropStarted)} has_beat=${Boolean(firstStep.beat)} discovery_complete=${firstStep.discovery_complete}`);
      if (importReviewRequestRunRef.current !== requestRunId) {
        stagedImportPathsRef.current.delete(stream.batch_id);
        void discardImportReviewBatch(stream.batch_id);
        return;
      }

      const first = firstStep.beat
        ? { ...firstStep.beat, tags: cleanTags(firstStep.beat.tags || []).tags }
        : null;

      if (first) {
        setShowAdd(false);
        setReviewQueue({
          beats: [first],
          index: 0,
          total: firstStep.total_normal,
          batchId: stream.batch_id,
          preparing: !firstStep.discovery_complete,
        });
        reviewPerfMark(`run=${diagRun} FIRST_REVIEW_STATE_SET elapsed_ms=${Math.round(performance.now() - dropStarted)} beat=${first.name}`);

        // Diagnostic paint barrier: do not let Beat 2..N work begin until the
        // first Review drawer had a real browser frame. This both proves whether
        // background preparation was starving the first paint and guarantees the
        // skeleton hands off directly to the real drawer with no blank flash.
        await new Promise<void>(resolve => {
          requestAnimationFrame(() => {
            reviewPerfMark(`run=${diagRun} FIRST_REVIEW_FRAME elapsed_ms=${Math.round(performance.now() - dropStarted)} beat=${first.name}`);
            resolve();
          });
        });
        setReviewBootstrap(null);
        reviewPerfMark(`run=${diagRun} BACKGROUND_ALLOWED elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
        console.info(`[review-perf] FIRST_REVIEW_READY ${Math.round(performance.now() - dropStarted)} ms`);
      } else if (firstStep.discovery_complete) {
        const summary = await getImportReviewBatchSummary(stream.batch_id);
        setDeferredImportBatch(summary);
        setReviewBootstrap(null);
        setReviewPreparationDone(true);
        if (summary.audio_conflicts.length > 0) {
          setAudioConflictBatch(summary);
        } else if (summary.pending.length > 0) {
          setDropImportBatch(summary);
        } else {
          stagedImportPathsRef.current.delete(stream.batch_id);
          setDeferredImportBatch(null);
          await discardImportReviewBatch(stream.batch_id);
          await appAlert({ title: "Nothing to import", message: "No playable beats were found in the dropped files." });
        }
        return;
      }

      const runId = ++reviewPreparationRunRef.current;
      const preparation = (async () => {
        const prepared: Beat[] = first ? [first] : [];
        let step = firstStep;

        // Continue exactly where Rust stopped. Each invoke searches only until
        // the next normal beat, prepares that beat, then yields to the UI.
        while (!step.discovery_complete && reviewPreparationRunRef.current === runId && importReviewRequestRunRef.current === requestRunId) {
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          const bgIndex = prepared.length + 1;
          const bgStarted = performance.now();
          reviewPerfMark(`run=${diagRun} BACKGROUND_PREPARE_START n=${bgIndex} elapsed_ms=${Math.round(bgStarted - dropStarted)}`);
          step = await prepareNextImportReviewBeat(stream.batch_id);
          reviewPerfMark(`run=${diagRun} BACKGROUND_PREPARE_END n=${bgIndex} step_ms=${Math.round(performance.now() - bgStarted)} elapsed_ms=${Math.round(performance.now() - dropStarted)} has_beat=${Boolean(step.beat)} done=${step.discovery_complete}`);
          if (reviewPreparationRunRef.current !== runId || importReviewRequestRunRef.current !== requestRunId) break;

          if (step.beat) {
            const nextBeat = { ...step.beat, tags: cleanTags(step.beat.tags || []).tags };
            prepared.push(nextBeat);
            const sourceKey = reviewSourceKey(nextBeat);
            setReviewQueue(q => {
              if (!q || q.batchId !== stream.batch_id) return q;
              if (sourceKey && skippedReviewSourceKeysRef.current.has(sourceKey)) return {
                ...q,
                total: step.total_normal ?? q.total,
                preparing: !step.discovery_complete,
              };
              if (sourceKey && q.beats.some(item => reviewSourceKey(item) === sourceKey)) return q;
              return {
                ...q,
                beats: [...q.beats, nextBeat],
                total: step.total_normal ?? q.total,
                preparing: !step.discovery_complete,
              };
            });
          }
        }

        if (reviewPreparationRunRef.current !== runId || importReviewRequestRunRef.current !== requestRunId) {
          return prepared;
        }

        const summary = await getImportReviewBatchSummary(stream.batch_id);
        setDeferredImportBatch(summary);
        setReviewPreparationDone(true);
        console.info(`[review-perf] DISCOVERY_FINISHED ${Math.round(performance.now() - dropStarted)} ms (${summary.normal_count} normal, ${summary.audio_conflicts.length} conflict)`);
        reviewPerfMark(`run=${diagRun} DISCOVERY_FINISHED elapsed_ms=${Math.round(performance.now() - dropStarted)} normal=${summary.normal_count} conflicts=${summary.audio_conflicts.length}`);

        setReviewQueue(q => {
          if (!q || q.batchId !== stream.batch_id) return q;
          // The user may have already Saved/Skipped the last currently-known beat
          // while discovery was still running. Once N is known, close any cursor
          // that is already past the end instead of leaving an eternal skeleton.
          if (q.index >= summary.normal_count) return null;
          return { ...q, total: summary.normal_count, preparing: false };
        });
        return prepared;
      })();
      reviewPreparationPromiseRef.current = preparation;

      void preparation.catch(async error => {
        console.error("Background streaming Review preparation failed:", error);
        if (reviewPreparationRunRef.current === runId && importReviewRequestRunRef.current === requestRunId) {
          setReviewPreparationDone(true);
          setReviewQueue(q => q && q.batchId === stream.batch_id ? { ...q, preparing: false } : q);
          setReviewBootstrap(null);
          await appAlert({ title: "Review preparation failed", message: String(error), danger: true });
        }
      });

    } catch (error) {
      reviewPerfMark(`run=${diagRun} IMPORT_ERROR elapsed_ms=${Math.round(performance.now() - dropStarted)} error=${String(error)}`);
      console.error(error);
      setReviewBootstrap(null);
      setReviewPreparationDone(true);
      await appAlert({ title: "Import failed", message: `Could not import the dropped files: ${String(error)}`, danger: true });
    } finally {
      setDropImporting(false);
      setDropActive(false);
    }
  }, [dropImporting, rejectOfflineMutation]);

  useEffect(() => {
    if (!deferredImportBatch || !reviewPreparationDone || bulkSaveAllBusy) return;
    if (reviewBootstrap || reviewQueue || audioConflictBatch || dropImportBatch) return;

    if (deferredImportBatch.audio_conflicts.length > 0) {
      setAudioConflictBatch(deferredImportBatch);
      return;
    }
    if (deferredImportBatch.pending.length > 0) {
      setDropImportBatch(deferredImportBatch);
      return;
    }

    const batchId = deferredImportBatch.batch_id;
    stagedImportPathsRef.current.delete(batchId);
    setDeferredImportBatch(null);
    void discardImportReviewBatch(batchId);
  }, [deferredImportBatch, reviewPreparationDone, bulkSaveAllBusy, reviewBootstrap, reviewQueue, audioConflictBatch, dropImportBatch]);

  const refreshOpenableCloudProjects = useCallback(async () => {
    try {
      const t = await import("./lib/tauri");
      const ids = await t.listOpenableCloudProjectBeatIds();
      setOpenableCloudProjectIds(new Set(ids));
    } catch (error) {
      console.warn("Could not refresh Open Project indicators", error);
    }
  }, []);

  useEffect(() => {
    void refreshOpenableCloudProjects();
  }, [beats, refreshOpenableCloudProjects]);


  useEffect(() => {
    const refresh = () => { void refreshOpenableCloudProjects(); };
    window.addEventListener("beatgaler:project-cloud-changed", refresh);
    window.addEventListener("beatgaler:project-cloud-updated", refresh);
    return () => {
      window.removeEventListener("beatgaler:project-cloud-changed", refresh);
      window.removeEventListener("beatgaler:project-cloud-updated", refresh);
    };
  }, [refreshOpenableCloudProjects]);


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

      await refreshOpenableCloudProjects();
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
  }, [refreshOpenableCloudProjects, rejectOfflineMutation, transitionRuntime]);

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



  const handleToggleOffline = useCallback(async (beat: Beat) => {
    if (offlineBusyIds.has(beat.id)) return;
    if (!beat.offline_available && connectionState !== "online") {
      await appAlert({ title: "Internet required", message: "Connect to the internet once to download this beat for Offline mode." });
      return;
    }

    setOfflineBusyIds(current => new Set(current).add(beat.id));
    let offlineOwnsDownloadState = false;
    if (!beat.offline_available) {
      const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (runtime.download_state !== "downloading") {
        transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat);
        offlineOwnsDownloadState = true;
      }
    }
    try {
      if (beat.offline_available) {
        // The Offline fast path may have memoized the durable MASTER path under
        // the same telegram_file_id used by the cloud beat. Remove that memo
        // before deleting the package or the next Play would reuse a dead local
        // file and incorrectly report the Cloud MASTER as unavailable.
        if (audio.playingId === beat.id) releaseFile();
        invalidatePlaybackPreparation(beat.id);

        await removeBeatOfflineAvailability(beat.id);
        transitionRuntime(beat.id, { type: "SET_OFFLINE_AVAILABLE", available: false }, beat);

        if (connectionState !== "online") {
          // In an Offline-only library, removing the durable package means the
          // beat is no longer eligible to be shown at all. Remove the card in
          // the same transaction instead of leaving a visible but unusable beat.
          setBeats(current => current.filter(item => item.id !== beat.id));
          setRevealedBeatIds(current => {
            const next = new Set(current);
            next.delete(beat.id);
            return next;
          });
        } else {
          // Remove Offline is a local-storage operation only. Keep the live Beat
          // object as the metadata/artwork authority and clear only paths owned by
          // the durable Offline package. Re-loading SQLite here can replace newer
          // in-memory artwork/metadata with an older or incomplete materialized row.
          const withoutOfflinePaths = (item: Beat): Beat => ({
            ...item,
            offline_available: false,
            folder_path: "",
            mp3_path: "",
            wav_path: null,
            playback_path: "",
            stems_path: null,
            samples_path: null,
            flp_path: null,
            als_path: null,
            other_files: [],
            loop_path: null,
          });
          const cloudBeat = withoutOfflinePaths(beat);
          setBeats(current => current.map(item => item.id === beat.id ? withoutOfflinePaths(item) : item));
          setDrawer(current => current?.beat.id === beat.id
            ? { ...current, beat: withoutOfflinePaths(current.beat) }
            : current);

          // Re-enter Download Cooking immediately while online. This is only a
          // lightweight enqueue; it prevents the first post-Remove Play from
          // racing an old Offline source and restores the normal cloud fast path.
          if (cloudBeat.telegram_file_id) {
            void ensureWarmPlaybackUrl(cloudBeat);
          }
        }
      } else {
        const offline = await makeBeatAvailableOffline(beat);
        if (offlineOwnsDownloadState) transitionRuntime(beat.id, { type: "DOWNLOAD_SUCCEEDED" }, offline);
        transitionRuntime(beat.id, { type: "SET_OFFLINE_AVAILABLE", available: true }, offline);
        setBeats(current => current.map(item => item.id === beat.id ? {
          ...item,
          offline_available: true,
          image_base64: item.image_base64 || offline.image_base64,
          image_preview_base64: item.image_preview_base64 || offline.image_preview_base64,
        } : item));
        try {
          const audio = new Audio(downloadCompleteWav);
          audio.volume = 0.68;
          void audio.play().catch(() => {});
        } catch {}
      }
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      if (offlineOwnsDownloadState) {
        transitionRuntime(beat.id, { type: "DOWNLOAD_FAILED", code: "OFFLINE_DOWNLOAD_FAILED", message, retryable: true }, beat);
      }
      await appAlert({
        title: beat.offline_available ? "Could not remove offline copy" : "Offline download failed",
        message,
        danger: true,
      });
    } finally {
      setOfflineBusyIds(current => {
        const next = new Set(current);
        next.delete(beat.id);
        return next;
      });
    }
  }, [audio.playingId, connectionState, ensureWarmPlaybackUrl, offlineBusyIds, releaseFile, transitionRuntime]);

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


  const runBeatCloudUpdate = useCallback((beat: Beat, filePath: string, work: () => Promise<void>) => {
    if (rejectOfflineMutation("Updating beat files")) {
      setBeatFileDrop(null);
      void cleanupStagedDropPaths([filePath]);
      return;
    }
    // Once the user chose a destination, the chooser is done. The long Telegram/
    // ZIP task belongs to the beat card, not to a blocking modal.
    setBeatFileDrop(null);
    setBeatCloudUpdateBusy(beat.id, true);
    const before = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
    if (before.sync_state === "synced") transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);

    void (async () => {
      let succeeded = false;
      try {
        await work();
        transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, beat);
        succeeded = true;
        setBeatCloudUpdateBusy(beat.id, false, true);
        try {
          const audio = new Audio(uploadCompleteWav);
          audio.volume = 0.72;
          void audio.play().catch(() => {});
        } catch {}
      } catch (error) {
        console.error(error);
        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
        if (isRuntimeConflictError(error)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
        else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "BEAT_UPDATE_FAILED", message, retryable: true }, beat);
        setBeatCloudUpdateBusy(beat.id, false, false);
        await appAlert({ title: "Beat update failed", message, danger: true });
      } finally {
        // Drag/drop roots are private staging copies. The user can keep working
        // while the task runs, then the staging is reclaimed regardless of outcome.
        await cleanupStagedDropPaths([filePath]).catch(() => {});
        if (!succeeded) setBeatCloudUpdateBusy(beat.id, false, false);
      }
    })();
  }, [rejectOfflineMutation, transitionRuntime]);

  const hasStoredProject = useCallback(async (beat: Beat) => {
    const status = await getProjectCloudStatus(beat);
    return status.valid || status.part_count > 0 || status.local_exists || status.state !== "LOCAL";
  }, []);

  const startProjectAssetUpdate = useCallback((beat: Beat, filePath: string, kind: "projectFile" | "projectFolder") => {
    runBeatCloudUpdate(beat, filePath, async () => {
      // A normal project folder may contain old Backup/Backups directories. They
      // are filtered from PROJECT.zip, but tell the user after the successful
      // update instead of silently dropping those files.
      const inspection = kind === "projectFolder"
        ? await inspectProjectDropSource(filePath).catch(() => null)
        : null;
      if (inspection && !inspection.valid) {
        throw new Error(inspection.reason || "This project folder could not be inspected.");
      }
      if (inspection?.has_backups) {
        setProjectUpdateNotice(
          `Backup folders were found in “${fileNameFromPath(filePath)}”. BeatGaler will skip them and continue with the project update.`
        );
      }

      await updateProjectArchiveFromSource(beat, filePath, kind);
      await uploadProjectToTelegram(beat);
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");

      if (inspection?.has_backups) {
        setProjectUpdateNotice(
          `Backup folders were skipped from “${fileNameFromPath(filePath)}” and were not added to PROJECT.zip.`
        );
      }
    });
  }, [runBeatCloudUpdate]);

  const startProjectZipReplacement = useCallback((beat: Beat, filePath: string) => {
    runBeatCloudUpdate(beat, filePath, async () => {
      await uploadDroppedFileToTelegram(beat, filePath, "PROJECT");
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
    });
  }, [runBeatCloudUpdate]);

  const handleAutoProjectDrop = useCallback(async (beat: Beat, filePath: string): Promise<AutoProjectDropResult> => {
    const ext = extensionFromPath(filePath);
    const obviousProjectSource = ext === "zip" || ["flp", "als", "logicx", "ptx", "ptf"].includes(ext);
    if (!obviousProjectSource) return "not-project";

    let inspection;
    try {
      inspection = await inspectProjectDropSource(filePath);
    } catch (error) {
      setBeatCloudUpdateBusy(beat.id, false, false);
      await cleanupStagedDropPaths([filePath]).catch(() => {});
      await appAlert({ title: "Project check failed", message: String(error), danger: true });
      return "handled";
    }

    if (inspection.kind !== "zip" && inspection.kind !== "project_file") {
      return "not-project";
    }

    if (!inspection.valid) {
      setBeatCloudUpdateBusy(beat.id, false, false);
      await cleanupStagedDropPaths([filePath]).catch(() => {});
      await appAlert({
        title: inspection.kind === "zip" ? "Invalid PROJECT" : "Project check failed",
        message: inspection.reason || "The project could not be validated.",
        danger: true,
      });
      return "handled";
    }

    const existing = await hasStoredProject(beat).catch(() => false);
    if (existing) {
      // Inspection/staging has finished. Stop the card animation while the user is
      // making a Replace/Cancel choice; Replace starts the real update animation.
      setBeatCloudUpdateBusy(beat.id, false, false);
      const replace = await appConfirm({
        title: inspection.kind === "zip" ? "Replace PROJECT ZIP?" : "Replace project file?",
        message: inspection.kind === "zip"
          ? `"${beat.name}" already has a PROJECT ZIP. Replace it with ${fileNameFromPath(filePath)}?`
          : `"${beat.name}" already has a project file. Replace it with ${fileNameFromPath(filePath)}?`,
        confirmLabel: "Replace",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!replace) {
        await cleanupStagedDropPaths([filePath]).catch(() => {});
        return "handled";
      }
    }

    if (inspection.has_backups) {
      setProjectUpdateNotice(
        `Backup folders were found in “${fileNameFromPath(filePath)}”. BeatGaler will skip them and continue with the PROJECT ZIP.`
      );
    }

    if (inspection.kind === "zip") startProjectZipReplacement(beat, filePath);
    else startProjectAssetUpdate(beat, filePath, "projectFile");
    return "started";
  }, [hasStoredProject, startProjectAssetUpdate, startProjectZipReplacement]);

  const handleDroppedBeatFileRole = useCallback(async (role: DroppedBeatFileRole) => {
    if (!beatFileDrop) return;
    const { beat, filePath } = beatFileDrop;
    const ext = extensionFromPath(filePath);

    if (role === "loop" || role === "stems") return;

    if (role === "main") {
      if (ext !== "mp3") return;
      runBeatCloudUpdate(beat, filePath, async () => {
        await uploadDroppedFileToTelegram(beat, filePath, "MASTER");
        const refreshed = await loadLibrary();
        beatsLatestRef.current = refreshed;
        setBeats(refreshed);
        const cloudBacked = refreshed.filter(item => !!item.telegram_file_id);
        cloudLibrarySnapshotRef.current = cloudBacked.map(cloudBeatFingerprint).join("\u001c");
        await libraryStateManager.commitSnapshot(refreshed, "dropped-master");

        const updated = refreshed.find(item => item.id === beat.id);
        if (updated?.telegram_file_id) {
          const ready = await waitForUploadedBeatPlaybackReady(updated);
          if (!ready) throw new Error("The new MASTER uploaded, but did not become playback-ready in time.");
        }
      });
      return;
    }

    if (role === "wav") {
      if (ext !== "wav") return;
      runBeatCloudUpdate(beat, filePath, async () => {
        await uploadDroppedFileToTelegram(beat, filePath, "WAV");
        await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
      });
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
  }, [beatFileDrop, hasStoredProject, runBeatCloudUpdate, startProjectAssetUpdate, waitForUploadedBeatPlaybackReady]);


  const importDroppedBrowserFiles = useCallback(async (files: File[]) => {
    if (rejectOfflineMutation("Importing beats")) return;
    if (dropImporting) return;

    const supported = files.filter(file =>
      /\.(mp3|wav)$/i.test(file.name) ||
      file.type === "audio/mpeg" ||
      file.type === "audio/wav" ||
      file.type === "audio/x-wav"
    );
    if (supported.length === 0) {
      await appAlert({ title: "Nothing to import", message: "Drop an MP3 or WAV file to add a beat." });
      return;
    }
    if (supported.length > 1) {
      await appAlert({ title: "Drop one beat at a time", message: "BeatGaler Web imports one beat per drag action." });
      return;
    }

    setDropImporting(true);
    setDropActive(false);
    try {
      const candidate = platform.importer.fromFile(supported[0]);
      const hydrated = await candidate.hydrated.catch(() => candidate.beat);
      const beat = { ...hydrated, tags: cleanTags(hydrated.tags || []).tags };
      setShowAdd(false);
      setReviewPreparationDone(true);
      setReviewBootstrap(null);
      setDeferredImportBatch(null);
      setAudioConflictBatch(null);
      setDropImportBatch(null);
      setReviewQueue({ beats: [beat], index: 0, total: 1, batchId: null, preparing: false });
    } catch (error) {
      await appAlert({ title: "Import failed", message: String(error), danger: true });
    } finally {
      setDropImporting(false);
    }
  }, [dropImporting, rejectOfflineMutation]);

  const handleBrowserBeatFileDrop = useCallback(async (beatId: string, files: File[]): Promise<boolean> => {
    const beat = beatsLatestRef.current.find(item => item.id === beatId);
    if (!beat) throw new Error(`Dropped file target beat was not found: ${beatId}`);
    if (files.length !== 1) {
      await appAlert({ title: "Drop one file at a time", message: "Drop one MP3, WAV, or PROJECT ZIP on a beat." });
      return false;
    }

    const file = files[0];
    const name = file.name.toLowerCase();
    const kind = name.endsWith(".mp3") ? "MASTER" : name.endsWith(".wav") ? "WAV" : name.endsWith(".zip") ? "PROJECT" : null;
    if (!kind) {
      await appAlert({ title: "Unsupported file", message: "BeatGaler Web accepts MP3, WAV, or PROJECT ZIP files on an existing beat." });
      return false;
    }

    if (kind === "MASTER" && beat.telegram_file_id) {
      const replace = await appConfirm({
        title: "Replace MASTER?",
        message: `Replace the current MASTER for "${beat.name}" with ${file.name}?`,
        confirmLabel: "Replace",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!replace) return false;
    }

    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      const committed = await platform.editor.commit(beat, beat, { [kind]: file });
      setBeats(current => {
        const next = current.map(item => item.id === committed.id ? committed : item);
        beatsLatestRef.current = next;
        return next;
      });
      setDrawer(current => current?.beat.id === committed.id ? { ...current, beat: committed } : current);
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, committed);
      return false;
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "WEB_FILE_UPDATE_FAILED", message, retryable: true }, beat);
      throw error;
    }
  }, [transitionRuntime]);

  // Browser/Pinterest controller. Windows desktop keeps the existing single native
  // owner. macOS keeps HTML enabled for browser artwork while local Finder drops
  // are claimed by the native-path fast path before staging can begin.
  useEffect(() => {
    // On Windows desktop, WRY/Tauri owns the external drop. Explorer gives us
    // original paths with zero byte staging, while browser/Pinterest payloads
    // stay on that same native receiver. The HTML DataTransfer controller is
    // intentionally not installed there; otherwise the same local file drop
    // can fall back to File.arrayBuffer() and recreate the 20-40s staging delay.
    const windowsNativeDrop = isTauriAvailable && /Windows/i.test(navigator.userAgent);
    if (windowsNativeDrop) return;
    return installHtmlDropController({
      setGlobalDropActive: setDropActive,
      onArtworkDrop: async (beatId, sources) => {
        const beat = beatsLatestRef.current.find(item => item.id === beatId);
        if (!beat) throw new Error(`Dropped artwork target beat was not found: ${beatId}`);

        setBeatCloudUpdateBusy(beat.id, true);
        try {
          const conversionErrors: string[] = [];
          let imageData: string | null = null;

          // Browser drags are intentionally multi-source. Pinterest/Chromium may
          // provide a CDN URL AND a virtual File; whichever representation works
          // first wins. A failed cloud URL fetch therefore cannot kill a usable
          // virtual-file drop, and vice versa.
          for (const source of sources) {
            try {
              const candidate = source.kind === "remote"
                ? (/^data:image\//i.test(source.url) ? source.url : await fetchInternetArtworkDataUrl(source.url))
                : await artworkFileToDataUrl(source.file);
              if (!/^data:image\//i.test(candidate) || candidate.length < 32) {
                throw new Error("Artwork source returned an invalid/empty image payload.");
              }
              imageData = candidate;
              console.info(`[dragdrop/artwork] resolved via ${source.kind}`);
              break;
            } catch (error) {
              conversionErrors.push(`${source.kind}: ${String(error)}`);
              console.warn(`[dragdrop/artwork] ${source.kind} candidate failed; trying fallback`, error);
            }
          }

          if (!imageData) {
            throw new Error(`Pinterest/browser artwork could not be decoded. ${conversionErrors.join(" | ")}`);
          }

          await handleDropArtwork(beat, imageData);
        } finally {
          setBeatCloudUpdateBusy(beat.id, false);
        }
      },
      onBeatFileDrop: async (beatId, roots) => {
        const beat = beatsLatestRef.current.find(item => item.id === beatId);
        if (!beat) return;
        if (roots.length > 1) {
          await appAlert({
            title: "Drop one file at a time",
            message: "Drop a single file or folder on a beat so BeatGaler can assign it to the correct slot.",
          });
          return false;
        }
        const root = roots[0];
        if (isBackupFolderPath(root.path)) {
          await cleanupStagedDropPaths([root.path]).catch(() => {});
          await appAlert({
            title: "Backup folder skipped",
            message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
          });
          return false;
        }

        // Project files and PROJECT ZIPs have exactly one sensible destination,
        // so do not make the user answer a redundant "What are you adding?" page.
        // The card is already in its loading state while WebView2 stages/inspects
        // the drop, so large ZIPs never look like the app ignored them.
        const autoResult = await handleAutoProjectDrop(beat, root.path);
        if (autoResult === "started") return true;
        if (autoResult === "handled") return false;

        setBeatFileDrop({ beat, filePath: root.path, kind: root.kind });
        return false;
      },
      onBeatFileStagingChange: (beatId, active) => {
        setBeatCloudUpdateBusy(beatId, active, false);
      },
      onLibraryFileStagingChange: active => {
        if (!REVIEW_SKELETON_ENABLED) return;
        setLibraryDropStaging(active);
      },
      onBrowserBeatFileDrop: platform.capabilities.browserFileImport ? handleBrowserBeatFileDrop : undefined,
      onBrowserLibraryFileDrop: platform.capabilities.browserFileImport ? importDroppedBrowserFiles : undefined,
      onLibraryFileDrop: async roots => {
        await importDroppedPaths(roots.map(root => root.path));
      },
      onEmptyFileDrop: async () => {
        await appAlert({
          title: "Nothing to import",
          message: "The desktop drag source reported files, but the app could not access any usable file or folder paths.",
        });
      },
      onError: async error => {
        console.error("HTML5 drag & drop failed:", error);
        await appAlert({ title: "Drag & drop failed", message: String(error), danger: true });
      },
    });
  }, [handleAutoProjectDrop, handleBrowserBeatFileDrop, handleDropArtwork, importDroppedBrowserFiles, importDroppedPaths]);

  useEffect(() => {
    if (!isTauriAvailable) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let activePaths: string[] = [];
    let activeExternalImage = false;

    type NativeFsPayload = {
      paths: string[];
      position?: { x: number; y: number } | null;
    };

    type NativeExternalImageDropDetail = {
      x: number;
      y: number;
      url: string;
      source: "pinterest" | "browser";
    };

    const elementAtNativePosition = (position: { x?: number; y?: number } | null | undefined): HTMLElement | null => {
      if (!position || typeof position.x !== "number" || typeof position.y !== "number") return null;
      const scale = window.devicePixelRatio || 1;
      const candidates: Array<[number, number]> = [[position.x, position.y]];
      if (scale !== 1) candidates.push([position.x / scale, position.y / scale]);
      for (const [x, y] of candidates) {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (el) return el;
      }
      return null;
    };

    const isImagePath = (path: string) => {
      const ext = extensionFromPath(path);
      return ["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif"].includes(ext);
    };

    const clearNativeDragUi = () => {
      setDropActive(false);
      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-hover", { detail: { target: null, active: false } }));
    };

    const updateNativeExternalImageUi = (position: { x?: number; y?: number } | null | undefined) => {
      const target = elementAtNativePosition(position);
      const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
      const drawerArtwork = target?.closest?.("[data-artwork-drop]") as HTMLElement | null;
      const artworkBeatId = artwork?.dataset.beatArtworkId ?? null;
      setDropActive(false);
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", {
        detail: { beatId: artworkBeatId, active: Boolean(artworkBeatId) },
      }));
      window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-hover", {
        detail: { target: drawerArtwork ? "artwork" : null, active: Boolean(drawerArtwork) },
      }));
    };

    const updateNativeDragUi = (payload: NativeFsPayload) => {
      const target = elementAtNativePosition(payload.position);
      const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
      const card = target?.closest?.("[data-beat-card-id]") as HTMLElement | null;
      const library = target?.closest?.('[data-library-scroll="true"]') as HTMLElement | null;
      const drawerArtwork = target?.closest?.("[data-artwork-drop]") as HTMLElement | null;
      const drawerFileRow = target?.closest?.("[data-filerole]") as HTMLElement | null;
      const drawerTarget = drawerArtwork ? "artwork" : drawerFileRow?.dataset.filerole ?? null;
      const localImage = payload.paths.length === 1 && isImagePath(payload.paths[0]);
      const artworkBeatId = artwork?.dataset.beatArtworkId ?? null;
      const cardBeatId = card?.dataset.beatCardId ?? null;

      if (drawerTarget) {
        setDropActive(false);
        window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
        window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
        window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-hover", {
          detail: { target: drawerTarget, active: true },
        }));
        return;
      }

      window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-hover", { detail: { target: null, active: false } }));

      if (artworkBeatId && localImage) {
        setDropActive(false);
        window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: artworkBeatId, active: true } }));
        window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
        return;
      }

      if (payload.paths.length > 0 && cardBeatId) {
        setDropActive(false);
        window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
        window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: cardBeatId, active: true } }));
        return;
      }

      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
      setDropActive(Boolean(library && payload.paths.length > 0));
    };

    const resolveNativeArtwork = async (beatId: string, imagePath: string) => {
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) throw new Error(`Dropped artwork target beat was not found: ${beatId}`);
      const imageData = await readImagePathAsDataUrl(imagePath);
      if (!/^data:image\//i.test(imageData)) throw new Error("Dropped file is not a usable image.");
      setBeatCloudUpdateBusy(beat.id, true);
      try {
        await handleDropArtwork(beat, imageData);
      } finally {
        setBeatCloudUpdateBusy(beat.id, false);
      }
    };

    const resolveNativeExternalImage = async (detail: NativeExternalImageDropDetail) => {
      // Routing decision happens at the final drop coordinates. Pinterest/browser
      // URLs never enter Import Beat and are accepted only by an artwork target.
      const target = elementAtNativePosition(detail);
      const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
      const drawerArtwork = target?.closest?.("[data-artwork-drop]") as HTMLElement | null;
      const beatId = artwork?.dataset.beatArtworkId ?? null;
      if (drawerArtwork) {
        const imageData = await fetchInternetArtworkDataUrl(detail.url);
        if (!/^data:image\//i.test(imageData) || imageData.length < 32) {
          throw new Error("Pinterest/browser artwork returned an invalid image payload.");
        }
        window.dispatchEvent(new CustomEvent("beatgaler:drawer-artwork-data", { detail: { imageData } }));
        return;
      }
      if (!beatId) return;
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) return;

      setBeatCloudUpdateBusy(beat.id, true);
      try {
        const imageData = await fetchInternetArtworkDataUrl(detail.url);
        if (!/^data:image\//i.test(imageData) || imageData.length < 32) {
          throw new Error("Pinterest/browser artwork returned an invalid image payload.");
        }
        await handleDropArtwork(beat, imageData);
      } finally {
        setBeatCloudUpdateBusy(beat.id, false);
      }
    };

    const onNativeExternalImageDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeExternalImageDropDetail>).detail;
      if (!detail || typeof detail.x !== "number" || typeof detail.y !== "number" || typeof detail.url !== "string") return;
      void resolveNativeExternalImage(detail).catch(async error => {
        console.error("Native external artwork drop failed:", error);
        await appAlert({ title: "Artwork drop failed", message: String(error), danger: true });
      });
    };
    window.addEventListener("native-external-image-drop", onNativeExternalImageDrop);

    const handleNativeBeatDrop = async (beatId: string, paths: string[]) => {
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) return;
      if (paths.length !== 1) {
        await appAlert({
          title: "Drop one file at a time",
          message: "Drop a single file or folder on a beat so BeatGaler can assign it to the correct slot.",
        });
        return;
      }

      const filePath = paths[0];
      if (isBackupFolderPath(filePath)) {
        await appAlert({
          title: "Backup folder skipped",
          message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
        });
        return;
      }

      setBeatCloudUpdateBusy(beat.id, true, false);
      try {
        const autoResult = await handleAutoProjectDrop(beat, filePath);
        if (autoResult === "started") return;
        if (autoResult === "handled") {
          setBeatCloudUpdateBusy(beat.id, false, false);
          return;
        }
        const directory = await isDirectoryPath(filePath);
        setBeatCloudUpdateBusy(beat.id, false, false);
        setBeatFileDrop({ beat, filePath, kind: directory ? "directory" : "file" });
      } catch (error) {
        setBeatCloudUpdateBusy(beat.id, false, false);
        throw error;
      }
    };

    const handleNativeDrop = async (payload: NativeFsPayload) => {
      // Reserved external-image sentinels are intercepted in onDragDropEvent
      // before this local-filesystem router can ever be called.
      const target = elementAtNativePosition(payload.position);
      const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
      const card = target?.closest?.("[data-beat-card-id]") as HTMLElement | null;
      const library = target?.closest?.('[data-library-scroll="true"]') as HTMLElement | null;
      const drawerArtwork = target?.closest?.("[data-artwork-drop]") as HTMLElement | null;
      const drawerFileRow = target?.closest?.("[data-filerole]") as HTMLElement | null;
      const drawerTarget = drawerArtwork ? "artwork" : drawerFileRow?.dataset.filerole ?? null;
      const artworkBeatId = artwork?.dataset.beatArtworkId ?? null;
      const cardBeatId = card?.dataset.beatCardId ?? null;
      clearNativeDragUi();

      reviewPerfMark(`TAURI_NATIVE_DROP path_count=${payload.paths.length} target=${drawerTarget ?? (artworkBeatId ? "card-artwork" : cardBeatId ? "beat-card" : library ? "library" : "none")} names=${payload.paths.map(fileNameFromPath).slice(0, 12).join("|")}`);

      if (payload.paths.length === 0) {
        if (drawerTarget || artworkBeatId || cardBeatId || library) {
          await appAlert({
            title: "Drop could not be read",
            message: "The drop reached BeatGaler, but macOS supplied no filesystem path. Try selecting the file with the button instead.",
            danger: true,
          });
        }
        return;
      }
      if (drawerTarget) {
        if (payload.paths.length !== 1) {
          await appAlert({ title: "Drop one file", message: "Choose one file for this field." });
          return;
        }
        if (drawerTarget === "artwork" && !isImagePath(payload.paths[0])) {
          await appAlert({ title: "Artwork must be an image", message: "Choose a PNG, JPEG, WebP, GIF, BMP, or AVIF image." });
          return;
        }
        window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-path", {
          detail: { target: drawerTarget, path: payload.paths[0] },
        }));
        return;
      }
      if (cardBeatId || library) claimNativeLibraryDrop();
      if (payload.paths.length > MAX_NATIVE_DROP_ITEMS) {
        await appAlert({
          title: "Too many items",
          message: `Drop up to ${MAX_NATIVE_DROP_ITEMS} files/folders at a time. A parent folder still counts as one item.`,
        });
        return;
      }

      if (artworkBeatId && payload.paths.length === 1 && isImagePath(payload.paths[0])) {
        await resolveNativeArtwork(artworkBeatId, payload.paths[0]);
        return;
      }

      if (cardBeatId) {
        await handleNativeBeatDrop(cardBeatId, payload.paths);
        return;
      }

      if (!library) return;

      // Native fast path: Tauri gives us the original Finder/Explorer paths. No
      // DataTransfer File.arrayBuffer(), no drop-staging, and no pre-Review copy.
      if (REVIEW_SKELETON_ENABLED) setLibraryDropStaging(true);
      const started = performance.now();
      reviewPerfMark(`NATIVE_LIBRARY_IMPORT_START path_count=${payload.paths.length}`);
      try {
        await importDroppedPaths(payload.paths);
        reviewPerfMark(`NATIVE_LIBRARY_IMPORT_READY elapsed_ms=${Math.round(performance.now() - started)}`);
      } finally {
        if (REVIEW_SKELETON_ENABLED) setLibraryDropStaging(false);
      }
    };

    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent(event => {
          const payload = event.payload as any;
          if (!payload) return;
          const eventPaths = Array.isArray(payload.paths)
            ? payload.paths.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
            : [];
          const eventPosition = payload.position && typeof payload.position.x === "number" && typeof payload.position.y === "number"
            ? `${Math.round(payload.position.x)},${Math.round(payload.position.y)}`
            : "none";
          if (payload.type !== "over") {
            reviewPerfMark(
              `TAURI_NATIVE_EVENT type=${String(payload.type)} path_count=${eventPaths.length} active_path_count=${activePaths.length} position=${eventPosition} names=${eventPaths.map(fileNameFromPath).slice(0, 8).join("|")}`,
            );
          }

          if (payload.type === "leave") {
            activePaths = [];
            activeExternalImage = false;
            clearNativeDragUi();
            return;
          }

          if (payload.type === "enter") {
            const incomingPaths = eventPaths;
            const externalSignal = nativeExternalImageSignalFromPaths(incomingPaths);
            if (externalSignal?.kind === "pending") {
              activePaths = [];
              activeExternalImage = true;
              reviewPerfMark("NATIVE_EXTERNAL_IMAGE_ENTER");
              updateNativeExternalImageUi(payload.position);
              return;
            }

            activeExternalImage = false;
            activePaths = incomingPaths;
            reviewPerfMark(`TAURI_NATIVE_ENTER path_count=${activePaths.length}`);
            updateNativeDragUi({ paths: activePaths, position: payload.position });
            return;
          }

          if (payload.type === "over") {
            if (activeExternalImage) updateNativeExternalImageUi(payload.position);
            else updateNativeDragUi({ paths: activePaths, position: payload.position });
            return;
          }

          if (payload.type !== "drop") return;
          const incomingPaths = eventPaths.length > 0 ? eventPaths : activePaths;
          const externalSignal = nativeExternalImageSignalFromPaths(incomingPaths);
          const wasExternalImage = activeExternalImage;
          activePaths = [];
          activeExternalImage = false;

          if (externalSignal?.kind === "drop") {
            clearNativeDragUi();
            const position = payload.position;
            if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;
            reviewPerfMark(`NATIVE_EXTERNAL_IMAGE_DROP source=${externalSignal.source}`);
            window.dispatchEvent(new CustomEvent("native-external-image-drop", {
              detail: {
                x: position.x,
                y: position.y,
                url: externalSignal.url,
                source: externalSignal.source,
              } satisfies NativeExternalImageDropDetail,
            }));
            return;
          }

          // WRY recognized a browser payload on Enter but could not resolve a
          // direct image URL on Drop. Clear feedback and intentionally no-op;
          // never reinterpret it as a local beat import.
          if (wasExternalImage) {
            clearNativeDragUi();
            reviewPerfMark("NATIVE_EXTERNAL_IMAGE_DROP unresolved");
            void diagnosticLog(
              "native-drop",
              "EXTERNAL_IMAGE_UNRESOLVED",
              "macOS exposed a browser drag type but no usable http(s) image URL",
            );
            void appAlert({
              title: "Could not read the dragged browser image",
              message: "The browser did not expose an image URL to BeatGaler. Try opening the full-size image before dragging it, or use the artwork button to choose a downloaded file.",
            });
            return;
          }

          void handleNativeDrop({ paths: incomingPaths, position: payload.position }).catch(async error => {
            console.error("Tauri native file drop failed:", error);
            await appAlert({ title: "Drag & drop failed", message: String(error), danger: true });
          });
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch (error) {
        console.error("Tauri native drag/drop listener failed:", error);
        reviewPerfMark(`TAURI_NATIVE_LISTENER_ERROR error=${String(error)}`);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      activePaths = [];
      activeExternalImage = false;
      window.removeEventListener("native-external-image-drop", onNativeExternalImageDrop);
      clearNativeDragUi();
    };
  }, [handleAutoProjectDrop, handleDropArtwork, importDroppedPaths]);

  const handleCloudFiles = useCallback(async (beat: Beat) => {
    // Exporting/downloading is read-only. A durable Available Offline package
    // must remain fully usable without Telegram: MP3/WAV/PROJECT/Everything are
    // copied from its local protected files. Only cloud-only beats need network.
    if (connectionState !== "online" && !beat.offline_available) {
      await appAlert({
        title: "Files unavailable offline",
        message: "This beat was not made Available Offline. Reconnect to download its cloud files.",
      });
      return;
    }
    try {
      const files = await listCloudFilesForBeat(beat.id);
      setCloudFiles(files);
      setCloudFilesDownloadedIds(new Set());
      setCloudFilesDownloadError(null);
      setCloudFilesBeat(beat);
    } catch (error) {
      await appAlert({ title: "Cloud files", message: String(error), danger: true });
    }
  }, [connectionState]);

  const handleGetCloudFile = useCallback(async (kind: BeatDownloadKind) => {
    const beat = cloudFilesBeat;
    if (!beat || cloudFilesBusyId) return;

    const safeBase = (beat.name || "Beat")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim() || "Beat";

    const exportMeta = [String(beat.bpm || "").trim(), String(beat.key || "").trim()]
      .filter(Boolean)
      .join(" ");
    const audioSafeBase = exportMeta && !safeBase.endsWith(`[${exportMeta}]`)
      ? `${safeBase} [${exportMeta}]`
      : safeBase;

    let ownsRuntimeDownloadState = false;
    try {
      setCloudFilesDownloadError(null);

      let destination: string | null = null;
      if (kind === "MP3") destination = await chooseExportFilePath(`${audioSafeBase}.mp3`, "mp3");
      else if (kind === "WAV") destination = await chooseExportFilePath(`${audioSafeBase}.wav`, "wav");
      else if (kind === "PROJECT") destination = await chooseExportFilePath(`${safeBase}.zip`, "zip");
      else destination = await chooseExportFolder();

      if (!destination) return;

      // This invoke only STARTS a Rust worker thread and returns immediately.
      // All Telegram/network/ZIP/copy/metadata work happens after this point
      // outside the Tauri UI thread, so the Downloads modal can be closed and
      // the rest of BeatGaler stays interactive.
      const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (runtime.download_state !== "downloading") {
        transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat);
        ownsRuntimeDownloadState = true;
      }
      const taskId = await startBackgroundDownload(kind, beat, destination);
      if (ownsRuntimeDownloadState) backgroundDownloadRuntimeOwnersRef.current.add(taskId);
      setCloudFilesBusyId(kind);
      setCloudDownloadNotice({
        taskId,
        kind,
        beatName: beat.name || "Beat",
        status: "downloading",
      });
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      if (ownsRuntimeDownloadState) {
        transitionRuntime(beat.id, { type: "DOWNLOAD_FAILED", code: "DOWNLOAD_START_FAILED", message, retryable: true }, beat);
      }
      setCloudFilesBusyId(null);
      setCloudDownloadNotice(null);
      setCloudFilesDownloadError(message);
    }
  }, [cloudFilesBeat, cloudFilesBusyId, transitionRuntime]);

  useEffect(() => {
    if (!isTauriAvailable) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<BackgroundDownloadEvent>("beatgaler-download-event", event => {
      if (disposed) return;
      const payload = event.payload;
      const kind = payload.kind as BeatDownloadKind;

      const ownsRuntimeDownloadState = backgroundDownloadRuntimeOwnersRef.current.delete(payload.task_id);
      if (payload.status === "error") {
        const message = sanitizeUserVisibleText(payload.error || "Download failed.", "Download failed.");
        if (ownsRuntimeDownloadState) {
          transitionRuntime(payload.beat_id, { type: "DOWNLOAD_FAILED", code: "DOWNLOAD_FAILED", message, retryable: true });
        }
        setCloudFilesBusyId(current => current === kind ? null : current);
        setCloudDownloadNotice(current => current?.taskId === payload.task_id ? null : current);
        setCloudFilesDownloadError(message);
        return;
      }

      if (ownsRuntimeDownloadState) {
        transitionRuntime(payload.beat_id, { type: "DOWNLOAD_SUCCEEDED" });
      }

      setCloudFilesBusyId(current => current === kind ? null : current);
      setCloudFilesDownloadedIds(prev => {
        const next = new Set(prev);
        // Status reflects the action the user chose. Download Everything only
        // marks the Everything row; it must not make MP3/WAV/Project look like
        // they were individually downloaded.
        next.add(kind);
        return next;
      });

      try {
        const audio = new Audio(downloadCompleteWav);
        audio.volume = 0.68;
        void audio.play().catch(() => {});
      } catch {}

      setCloudDownloadNotice({
        taskId: payload.task_id,
        kind,
        beatName: payload.beat_name || "Beat",
        status: "completed",
      });
      window.setTimeout(() => {
        setCloudDownloadNotice(current =>
          current?.taskId === payload.task_id && current.status === "completed" ? null : current
        );
      }, 1000);
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => console.warn("Background download listener failed:", error));

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [transitionRuntime]);

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
      const uploadInFlight = backgroundUploadRunningRef.current || autoCloudUploadRef.current.size > 0;
      if (uploadInFlight) {
        // Critical safety rule: restoreLibraryFromTelegram reconciles SQLite to the
        // committed INDEX. During an import that INDEX is intentionally older, so
        // applying it would make the beats being uploaded disappear. Defer instead.
        deferredLibraryReloadRef.current = true;
        console.info(`[library-refresh] DEFERRED active_uploads=${autoCloudUploadRef.current.size}`);
        return;
      }

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

  const deleteBeat = useCallback(async (beat: Beat) => {
    const approved = await appConfirm({
      title: "Remove beat?",
      message: beat.telegram_file_id
        ? `Remove "${beat.name}" from BeatGaler?\n\nIts cloud files will stay stored. The active Galer Library index will stop listing this beat after the next sync.`
        : `Are you sure you want to remove "${beat.name}"?\n\nThis will move its local files to BeatGaler trash.`,
      confirmLabel: beat.telegram_file_id ? "Remove beat" : "Move to trash",
      cancelLabel: "Cancel",
      danger: true,
    });

    // Nothing destructive happens before this exact resolved decision.
    if (!approved) return;
    if (deleteInFlightRef.current.has(beat.id)) return;

    deleteInFlightRef.current.add(beat.id);
    if (beat.telegram_file_id) {
      if (connectionState === "online") transitionRuntime(beat.id, { type: "SYNC_DELETE_STARTED" }, beat);
      else transitionRuntime(beat.id, { type: "SET_TRASH_SYNC_REQUIRED", required: true }, beat);
    }
    try {
      if (audio.playingId === beat.id) {
        transitionRuntime(beat.id, { type: "PLAYBACK_IDLE" }, beat);
        releaseFile();
      }
      await removeBeatFromLibrary(beat.id);
      let trashIntentError: unknown = null;
      if (connectionState !== "online" && beat.telegram_file_id) {
        try {
          await recordOfflineTrashIntent(beat.id);
        } catch (error) {
          trashIntentError = error;
          console.error("Could not persist Offline Trash reconciliation intent:", error);
        }
      }
      const nextLibrary = beatsLatestRef.current.filter(item => item.id !== beat.id);
      beatsLatestRef.current = nextLibrary;
      setBeats(nextLibrary);

      if (connectionState === "online" && beat.telegram_file_id) {
        try {
          await libraryStateManager.commitSnapshot(nextLibrary, "move-to-trash");
          forgetRuntimeState(beat.id);
        } catch (error) {
          const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
          const runtime = beatRuntimeStatesRef.current[beat.id];
          if (runtime?.sync_state === "deleting") {
            transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "DELETE_INDEX_SYNC_FAILED", message, retryable: true }, beat);
          }
          console.warn("Telegram library index refresh after Remove failed:", error);
        }
      }

      if (trashIntentError) {
        await appAlert({
          title: "Moved to Trash locally",
          message: "BeatGaler could not save the reconnect instruction for this beat. Restore it from Trash before closing the app, or reconnect and try again.",
          danger: true,
        });
      }
    } catch (err) {
      console.error(err);
      const runtime = beatRuntimeStatesRef.current[beat.id];
      if (runtime?.sync_state === "deleting") {
        transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "DELETE_FAILED", message: sanitizeUserVisibleText(runtimeErrorMessage(err), "Cloud operation failed."), retryable: true }, beat);
      }
      await appAlert({
        title: "Could not remove beat",
        message: "The beat could not be removed from the library.",
        danger: true,
      });
    } finally {
      deleteInFlightRef.current.delete(beat.id);
    }
  }, [audio.playingId, releaseFile, connectionState, forgetRuntimeState, transitionRuntime]);

  const tagColors = useTagColors();

const confirmTagRename = useCallback(async () => {
  if (!tagRename) return;
  const oldTag = tagRename.oldTag.trim().toLowerCase();
  const newTag = tagRename.newTag.trim().toLowerCase();
  if (!oldTag || !newTag || oldTag === newTag) return;
  const jobId = `tag-rename-${Date.now()}`;
  setTagRenameBusy(true);
  setTagRenameError(null);
  registerJob(jobId, `Rename “${oldTag}” → “${newTag}”`, "tag-rename");
  updateJob(jobId, { status: "processing", progress: 0, message: "Preparing journal…" });
  try {
    await renameTagEverywhere(oldTag, newTag, jobId);
    setBeats(current => current.map(beat => {
      if (!beat.tags.some(t => t.trim().toLowerCase() === oldTag)) return beat;
      const renamed = beat.tags.map(t => t.trim().toLowerCase() === oldTag ? newTag : t);
      return { ...beat, tags: Array.from(new Set(renamed)) };
    }));
    replaceTagFilter(oldTag, newTag);
    renameTagColor(oldTag, newTag);
    setTagRename(null);
  } catch (e) {
    const message = sanitizeUserVisibleText(runtimeErrorMessage(e), "Could not rename tag.");
    setTagRenameError(message);
    updateJob(jobId, { status: "error", message });
  } finally {
    setTagRenameBusy(false);
  }
}, [tagRename, replaceTagFilter]);

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
            onClick={() => setCloudFilesDownloadError(null)}
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
            onClick={() => setProjectUpdateNotice(null)}
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
      const oldTag = tagColorMenu.tag.trim().toLowerCase();
      setTagColorMenu(null);
      setTagRename({ oldTag, newTag: oldTag, stage: "name" });
      setTagRenameError(null);
    }}
    onClose={() => setTagColorMenu(null)}
  />
)}


{tagRename && (() => {
  const normalizedOld = tagRename.oldTag.trim().toLowerCase();
  const affected = beats.filter(b => b.tags.some(t => t.trim().toLowerCase() === normalizedOld));
  const mp3Count = affected.filter(b => !!b.mp3_path).length;
  const wavCount = affected.filter(b => !!b.wav_path).length;
  return ReactDOM.createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 10020, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(5px)" }} />
      <div style={{ position: "fixed", zIndex: 10021, width: 430, maxWidth: "calc(100vw - 32px)", left: "50%", top: "50%", transform: "translate(-50%,-50%)", background: "#121212", border: "1px solid #292929", borderRadius: 14, padding: 22, boxShadow: "0 28px 90px rgba(0,0,0,.8)" }}>
        <div style={{ fontSize: 16, color: "#eee", fontWeight: 600 }}>Rename tag globally</div>
        {tagRename.stage === "name" ? (
          <>
            <div style={{ marginTop: 8, fontSize: 12, color: "#777" }}>The original metadata order will be preserved; only the matching tag name changes.</div>
            <input autoFocus value={tagRename.newTag} onChange={e => setTagRename({ ...tagRename, newTag: e.target.value })}
              onKeyDown={e => { if (e.key === "Enter" && tagRename.newTag.trim() && tagRename.newTag.trim().toLowerCase() !== normalizedOld) setTagRename({ ...tagRename, stage: "confirm" }); }}
              style={{ width: "100%", marginTop: 16, padding: "10px 12px", borderRadius: 8, border: "1px solid #333", background: "#191919", color: "#fff", outline: "none" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => setTagRename(null)} style={{ padding: "8px 13px", borderRadius: 7, border: "1px solid #333", background: "transparent", color: "#999", cursor: "pointer" }}>Cancel</button>
              <button disabled={!tagRename.newTag.trim() || tagRename.newTag.trim().toLowerCase() === normalizedOld} onClick={() => setTagRename({ ...tagRename, stage: "confirm" })} style={{ padding: "8px 13px", borderRadius: 7, border: 0, background: "#eee", color: "#111", cursor: "pointer" }}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 14, padding: 14, borderRadius: 9, background: "#191919", color: "#aaa", fontSize: 12, lineHeight: 1.7 }}>
              <div><b style={{ color: "#ddd" }}>{normalizedOld}</b> → <b style={{ color: "#ddd" }}>{tagRename.newTag.trim().toLowerCase()}</b></div>
              <div style={{ marginTop: 8 }}>This will rewrite metadata in:</div>
              <div> {affected.length} beats</div><div> {mp3Count} MP3 files</div><div> {wavCount} WAV files</div>
              <div style={{ marginTop: 8, color: "#fbbf24" }}>Do not close Beat Galer while it is running. A recovery journal will roll back an interrupted operation on the next start.</div>
            </div>
            {tagRenameError && <div style={{ marginTop: 10, color: "#f87171", fontSize: 11 }}>{tagRenameError}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button disabled={tagRenameBusy} onClick={() => setTagRename({ ...tagRename, stage: "name" })} style={{ padding: "8px 13px", borderRadius: 7, border: "1px solid #333", background: "transparent", color: "#999", cursor: "pointer" }}>Back</button>
              <button disabled={tagRenameBusy || affected.length === 0} onClick={confirmTagRename} style={{ padding: "8px 13px", borderRadius: 7, border: 0, background: "#ef4444", color: "#fff", cursor: "pointer" }}>{tagRenameBusy ? "Renaming…" : "Rename everywhere"}</button>
            </div>
          </>
        )}
      </div>
    </>, document.body
  );
})()}

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
          onClose={() => setCloudFilesBeat(null)}
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
          onBeatRestored={beat => {
            if (connectionState !== "online") {
              void loadOfflineLibrary().then(setBeats).catch(error => {
                console.warn("Could not refresh Offline library after Trash restore:", error);
              });
              return;
            }

            // Rust already committed the Cloud Trash -> active transition before
            // returning this beat. Do NOT publish a second renderer-built INDEX.
            // Also seed the observer snapshots before rendering the restored card:
            // otherwise the metadata observer interprets "absent -> present" as an
            // edit and re-uploads metadata/artwork, creating temporary duplicates.
            const current = beatsLatestRef.current;
            const next = current.some(b => b.id === beat.id)
              ? current.map(b => b.id === beat.id ? beat : b)
              : [...current, beat];

            if (beat.telegram_file_id) {
              if (cloudMetaSnapshotRef.current === null) cloudMetaSnapshotRef.current = new Map();
              cloudMetaSnapshotRef.current.set(beat.id, cloudBeatFingerprint(beat));
              cloudLibrarySnapshotRef.current = next
                .filter(item => !!item.telegram_file_id)
                .map(cloudBeatFingerprint)
                .join("\u001c");
            }

            beatsLatestRef.current = next;
            setBeats(next);

            // Trash stores the Cloud artwork reference, not decoded image bytes.
            // Force a fresh hydration even if this beat had a memoized artwork
            // promise earlier in the same app session before it was trashed.
            invalidateArtworkHydration(beat.id);
            void ensureArtworkReady(beat);
          }}
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

      {libraryDropStaging && !reviewBootstrap && !reviewQueue && REVIEW_SKELETON_ENABLED && (
        <ReviewBeatSkeleton current={1} total={null} />
      )}

      {reviewBootstrap && REVIEW_SKELETON_ENABLED && (
        <ReviewBeatSkeleton current={1} total={reviewBootstrap.total} onCancel={skipAllReviewQueue} />
      )}

      {reviewQueue && !reviewQueue.beats[reviewQueue.index] && REVIEW_SKELETON_ENABLED && (
        <ReviewBeatSkeleton current={reviewQueue.index + 1} total={reviewQueue.total} onCancel={skipAllReviewQueue} />
      )}

      {reviewQueue && reviewQueue.beats[reviewQueue.index] && (
        <Drawer
          beat={reviewQueue.beats[reviewQueue.index]}
          mode="edit"
          tagSuggestions={tagSuggestions}
          reviewInfo={{ current: reviewQueue.index + 1, total: reviewQueue.total }}
          closeAfterSave={false}
          onClose={skipCurrentReviewBeat}
          onSkipCurrent={skipCurrentReviewBeat}
          onSkipAll={skipAllReviewQueue}
          onSaveAll={platform.capabilities.reviewBeatCloudCommit ? undefined : handleReviewedSaveAll}
          mutationAllowed={connectionState === "online"}
          isReviewNameTaken={(candidateName, _currentBeatId) => {
            const normalized = candidateName.trim().toLocaleLowerCase();
            if (!normalized) return false;
            // Use the live React state. The previous implementation used
            // beatsLatestRef, which can lag behind immediately after adding a
            // Review candidate and allowed duplicate names through.
            return beats.some(existing =>
              existing.name.trim().toLocaleLowerCase() === normalized
            );
          }}
          onCloudMutationCommit={platform.capabilities.browserCloudEditing ? undefined : commitDrawerCloudMutation}
          onSaved={handleReviewedBeatSaved}
          onReleaseAudio={() => {
            if (audio.playingId === reviewQueue.beats[reviewQueue.index].id) releaseFile();
          }}
        />
      )}

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

      {audioConflictBatch && audioConflictBatch.audio_conflicts.length > 0 && (
        <ImportAudioConflictsModal
          batchId={audioConflictBatch.batch_id}
          conflicts={audioConflictBatch.audio_conflicts}
          onCancel={() => {
            const batchId = audioConflictBatch.batch_id;
            stagedImportPathsRef.current.delete(batchId);
            setAudioConflictBatch(null);
            setDeferredImportBatch(null);
            // Cancel only the unresolved tail. Already-saved normal beats/uploads
            // keep their staged files via the existing protected cleanup path.
            void discardImportReviewBatch(batchId);
          }}
          onResolved={(resolved) => {
            const batchId = audioConflictBatch.batch_id;
            setAudioConflictBatch(null);
            setDeferredImportBatch(current => current ? { ...current, audio_conflicts: [] } : current);
            if (resolved.length > 0) {
              setReviewQueue({ beats: resolved, index: 0, total: resolved.length, batchId, preparing: false });
            }
          }}
        />
      )}

      {dropImportBatch && (
        <ImportDecisionsModal
          batch={dropImportBatch}
          onClose={() => {
            const staged = stagedImportPathsRef.current.get(dropImportBatch.batch_id) ?? [];
            stagedImportPathsRef.current.delete(dropImportBatch.batch_id);
            void cleanupStagedDropPaths(staged);
            void discardImportReviewBatch(dropImportBatch.batch_id);
            setDeferredImportBatch(null);
            setDropImportBatch(null);
            setDropImporting(false);
          }}
          onImported={(imported) => {
            // Do not delete the captured files here. The imported BeatMeta records
            // still point at them and the Telegram upload may happen seconds later.
            stagedImportPathsRef.current.delete(dropImportBatch.batch_id);
            setDeferredImportBatch(null);
            setDropImportBatch(null);
            setDropImporting(false);
            addBeatsAndReview(imported);
          }}
        />
      )}

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
