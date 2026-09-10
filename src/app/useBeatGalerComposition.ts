import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Beat } from "../types";
import { logoutBeatGalerAccount } from "../components/AccountGate";
import { useAudio } from "../hooks/useAudio";
import { discardImportReviewBatch, isTauriAvailable } from "../lib/tauri";
import { platform } from "../platform";
import { useTagColors } from "../lib/tagColors";
import { cleanupOrphanedDropStaging } from "../features/dragdrop/dropStaging";
import { useBeatDownloads } from "../features/downloads/useBeatDownloads";
import { useArtworkHydration } from "../features/artwork/useArtworkHydration";
import { useCloudUploadQueue } from "../features/cloud/useCloudUploadQueue";
import { useImportSession } from "../features/import/useImportSession";
import { useImportReview } from "../features/import/useImportReview";
import { useImportDiscovery } from "../features/import/useImportDiscovery";
import { useImportSaveAll } from "../features/import/useImportSaveAll";
import { useBrowserImport } from "../features/import/useBrowserImport";
import { useHtmlLibraryDrop } from "../features/dragdrop/useHtmlLibraryDrop";
import { useNativeLibraryDrop } from "../features/dragdrop/useNativeLibraryDrop";
import { cloudBeatFingerprint, libraryViewFingerprint } from "../features/library/libraryFingerprints";
import { preserveLoadedArtwork } from "../features/library/libraryPresentationCache";
import { selectFilteredAndSortedBeats } from "../features/library/librarySelectors";
import { useLibraryViewState } from "../features/library/useLibraryViewState";
import { useLibraryReorder } from "../features/library/useLibraryReorder";
import { useBeatSelection } from "../features/selection/useBeatSelection";
import { selectAllTags, selectTagFrequency, selectTagSuggestions } from "../features/tags/tagSelectors";
import { useTagFilters } from "../features/tags/useTagFilters";
import { useTagRename } from "../features/tags/useTagRename";
import { useLibraryPresentationCache, useLibraryState } from "../features/library/useLibraryState";
import { useLibraryReload } from "../features/library/useLibraryReload";
import { useStartupBootstrap } from "../features/startup/useStartupBootstrap";
import { useLibraryReveal } from "../features/startup/useLibraryReveal";
import { dismissBeatGalerStartupLoader } from "../features/startup/startupLoader";
import { useWebPlaybackSortRouting } from "../features/playback/useWebPlaybackSortRouting";
import { usePlaybackController } from "../features/playback/usePlaybackController";
import { usePlaybackQueue } from "../features/playback/usePlaybackQueue";
import { useDrawerCloudPersistence } from "../features/edit/useDrawerCloudPersistence";
import { useBeatAssetUpdates } from "../features/edit/useBeatAssetUpdates";
import { useBeatProjects } from "../features/projects/useBeatProjects";
import { useOfflineAvailability } from "../features/offline/useOfflineAvailability";
import { useTrashActions } from "../features/trash/useTrashActions";
import { useWebLibraryReconciled } from "../features/library/useWebLibraryReconciled";
import { useBeatRuntimeRegistry } from "../features/state/useBeatRuntimeRegistry";
import { useSessionState } from "../features/session/useSessionState";
import { useSessionActions } from "../features/session/useSessionActions";
import { useCustomCursor } from "../features/session/useCustomCursor";
import { useConnectivity } from "../features/session/useConnectivity";
import { useCloudLibraryEvents } from "../features/cloud/useCloudLibraryEvents";
import { useAppShortcuts } from "./useAppShortcuts";
import { usePublishingActions } from "../features/publishing/usePublishingActions";
import { useMutationAvailability } from "../features/session/useMutationAvailability";
import { useCloudLibraryRecovery } from "../features/startup/useCloudLibraryRecovery";
import { useCloudBeatTransfer } from "../features/cloud/useCloudBeatTransfer";
import { useImportEntry } from "../features/import/useImportEntry";
import { useBeatEditing } from "../features/edit/useBeatEditing";
import { useBeatFileDropRouting } from "../features/dragdrop/useBeatFileDropRouting";
import { isBeatCloudUpdateBusy, setBeatCloudUpdateBusy } from "../features/cloud/beatCloudUpdateBusy";

// Intentionally isolated: if real-world timings prove the skeleton unnecessary,
// flipping/removing this one constant deletes the visual layer without touching
// the staged Review architecture underneath it.
const REVIEW_SKELETON_ENABLED = true;

export function useBeatGalerComposition() {
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
    beatRuntimeStatesRef,
    transitionRuntime,
    forgetRuntimeState,
    clearReconciledTrashRuntimeStates,
  } = useBeatRuntimeRegistry(beats, beatsLatestRef);
  const stagedImportPathsRef = useRef<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(() => initialLoading);
  const startupCookingResolvedRef = useRef(false);
  const startupPipelineStartedRef = useRef(false);
  const startupEnginePrimeReadyRef = useRef(false);
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
  const filteredBeats = selectFilteredAndSortedBeats(
    beats,
    search,
    includedTags,
    excludedTags,
    sortBy,
  );

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
  const {
    settings,
    setSettings,
    setupDone,
    setSetupDone,
    connectionState,
    setConnectionState,
    cloudSessionVerified,
    setCloudSessionVerified,
  } = useSessionState();
  const {
    startupCookingGate,
    setStartupCookingGate,
    revealedBeatIds,
    setRevealedBeatIds,
    progressiveRevealRunRef,
  } = useLibraryReveal({
    initialCachedBeats: startupCachedBeatsRef.current ?? [],
    filteredBeats,
    loading,
    settings,
    cloudSessionVerified,
    connectionState,
    ensureArtworkReady,
    startupCookingResolvedRef,
    startupPipelineStartedRef,
    nativeParallelism: isTauriAvailable ? 6 : 1,
  });
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
    isBeatCloudUpdateBusy,
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
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);

  const { rejectOfflineMutation } = useMutationAvailability(connectionState);

  const { showUpload, setShowUpload, handleUpload, handleUploadBulk } = usePublishingActions({
    selectedIds,
    rejectOfflineMutation,
  });

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

  const { interruptedUploadNotices, dismissInterruptedUploadNotices } = useStartupBootstrap({
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
    dismissStartupLoader: dismissBeatGalerStartupLoader,
  });


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

  useCustomCursor(settings?.custom_cursor_enabled ?? true);



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

  useLibraryPresentationCache(
    beats,
    cloudSessionVerified,
    settings,
  );

  useEffect(() => {
    visibleLibraryFingerprintRef.current = libraryViewFingerprint(beats);
    beatsLatestRef.current = beats;
  }, [beats]);



  useCloudLibraryRecovery({ beatsLength: beats.length, setBeats, setSettings });

  const { handleUploadTelegram, handleDownloadTelegram } = useCloudBeatTransfer({
    rejectOfflineMutation,
    transitionRuntime,
    setBeats,
  });

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

  const { addBeatsAndReview } = useImportEntry({
    connectionState,
    setShowAdd,
    startReview,
    beatsLatestRef,
  });

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

  const {
    handleIncompleteWarningsChanged,
    handleCustomCursorChanged,
    handleFolderChanged,
    handleDisconnectTelegramAccount,
  } = useSessionActions({
    setSettings,
    setCloudSessionVerified,
    logoutAccount: logoutBeatGalerAccount,
    releaseFile,
    progressiveRevealRunRef,
    clearPlaybackPreparation,
    clearArtworkHydration,
    setRevealedBeatIds,
    setBeats,
    clearSelection,
  });

  const { handleEditBulk, updateBeat, handleDropArtwork, applyBulkUpdate } = useBeatEditing({
    beats,
    selectedIds,
    clearSelection,
    drawer,
    setDrawer,
    rejectOfflineMutation,
    connectionState,
    beatRuntimeStatesRef,
    transitionRuntime,
    setBeats,
    beatsLatestRef,
    cloudLibraryTimerRef,
    cloudLibrarySnapshotRef,
    cloudMetaSnapshotRef,
  });

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

  const { handleDroppedBeatFileRole } = useBeatFileDropRouting({
    beatFileDrop,
    setBeatFileDrop,
    hasStoredProject,
    startMasterAssetUpdate,
    startWavAssetUpdate,
    startProjectAssetUpdate,
  });

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

  const tagColors = useTagColors();

const handleTagClick = useCallback((tag: string, e: React.MouseEvent) => {
  toggleTagFilter(tag, e.altKey ? "exclude" : "include");
}, [toggleTagFilter]);

  const tagFrequency = useMemo(() => selectTagFrequency(beats), [beats]);
  const allTags = useMemo(() => selectAllTags(beats, tagFrequency), [beats, tagFrequency]);
  const tagSuggestions = useMemo(() => selectTagSuggestions(beats), [beats]);
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

  useAppShortcuts({
    togglePauseRef,
    clearSelection,
    setDrawer,
    setShowAdd,
    setShowSettings,
    closeQueue,
    setShowUpload,
  });



  const currentBeat = beats.find(b => b.id === audio.playingId);
  const selectedBeats = beats.filter(b => selectedIds.has(b.id));
  const activeDragBeat = activeDragId ? beats.find(b => b.id === activeDragId) ?? null : null;

  return { hydrateReviewCandidate: (beat: Beat) => setReviewQueue(queue => queue ? { ...queue, beats: queue.beats.map(current => current.id === beat.id ? beat : current) } : null), REVIEW_SKELETON_ENABLED, activeDragBeat, addBeatsAndReview, addToQueue, allTags, applyBulkUpdate, audio, audioConflictBatch, backTagRename, backgroundUploadErrors, beatFileDrop, beats, cancelAudioConflicts, cancelReview, cancelTagRename, clearSelection, clearTagFilters, closeCloudFiles, closeImportDecisions, cloudDownloadNotice, cloudFiles, cloudFilesBeat, cloudFilesBusyId, cloudFilesDownloadError, cloudFilesDownloadedIds, cloudSessionVerified, commitDrawerCloudMutation, confirmTagRename, connectionState, continueTagRename, currentBeat, cycleRepeat, deferredLibraryReloadRef, deleteBeat, dismissDownloadError, dismissInterruptedUploadNotices, dismissProjectUpdateNotice, displayedBeats, drawer, dropActive, dropImportBatch, dropImporting, excludedTags, filteredBeats, finishSelection, handleBeatRestored, handleCloudFiles, handleCustomCursorChanged, handleDisconnectTelegramAccount, handleDownloadTelegram, handleDragCancel, handleDragEnd, handleDragStart, handleDroppedBeatFileRole, handleEditBulk, handleFolderChanged, handleGetCloudFile, handleIncompleteWarningsChanged, handleNext, handleOpenProject, handlePlay, handlePrev, handleRemoveBulk, handleReviewedBeatSaved, handleReviewedSaveAll, handleTagClick, handleToggleOffline, handleUpdateProject, handleUpload, handleUploadBulk, handleUploadProjectTelegram, handleUploadTelegram, handleWarm, importResolvedDecisions, includedTags, interruptedUploadNotices, libraryDropStaging, libraryRefreshing, loading, offlineBusyIds, openTagRename, openableCloudProjectIds, playQueueIndex, projectUpdateNotice, queuedBeats, rejectOfflineMutation, releaseFile, reloadLibrary, repeatMode, resolveAudioConflicts, retryBackgroundUpload, revealedBeatIds, reviewBootstrap, reviewQueue, search, seek, selectMode, selectedBeats, selectedIds, sensors, setBeatFileDrop, setDrawer, setSearch, setShowAdd, setShowSettings, setShowUpload, setSortBy, setTagColorMenu, setTagRenameNewTag, setVolume, settings, showAdd, showQueue, showSettings, showUpload, shuffleEnabled, skipCurrentReviewBeat, sortBy, startupCookingGate, tagColorMenu, tagColors, tagFrequency, tagRename, tagRenameAffectedCount, tagRenameBusy, tagRenameError, tagRenameMp3Count, tagRenameWavCount, tagSuggestions, togglePause, toggleQueue, toggleSelectAll, toggleSelection, toggleShuffle, updateBeat };
}
