// Composición del AppShell PostgreSQL. La sesión del catálogo decide qué suena y useAudio reproduce la URL arrendada.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Beat } from "../../../types";
import { useAudio } from "../../../hooks/useAudio";
import { useTagColors } from "../../../lib/tagColors";
import { platform } from "../../../platform";
import { logoutBeatGalerAccount } from "../../../components/AccountGate";
import { createKnownGalleryCards } from "./catalogGalleryCards";
import type { CatalogServices } from "./catalogLibraryProvider";
import { createGallerySelection, useCatalogInteraction, type InteractionQuery } from "./catalogInteractionStore";
import { useCatalogPlayback } from "./catalogPlaybackSession";
import { createGalleryPlaybackCommands, linkPlayback, reportPlaybackFailure } from "./catalogPlaybackLink";
import { createGalleryBeatEditor } from "./catalogBeatEditor";
import { appAlert, appConfirm } from "../../../lib/dialog";
import { createGalleryDownloads, saveBlobWithBrowser, type DownloadKind, type GalleryDownloadFiles } from "./catalogDownloads";
import { setBeatCloudUpdateBusy } from "../../cloud/beatCloudUpdateBusy";
import type { CatalogStoreSnapshot } from "./catalogQueryStore";
import { createHistoryWriter } from "./catalogNavigation";
import { createCatalogQuerySession, playbackFiltersKey } from "./catalogQuerySession";
import { useAppShortcuts } from "../../../app/useAppShortcuts";

import { createImportSession, importFailureMessage, importLandsAtTop, projectPendingCards } from "./catalogImportSession";

export { IMPORT_NO_FILE_NOTICE, importFailureMessage } from "./catalogImportSession";

export { BULK_TAGS_MODE_NOTICE } from "./catalogInteractionStore";
export { SEARCH_DEBOUNCE_MS } from "./catalogQuerySession";
export { KNOWN_BEATS_MAX } from "./catalogGalleryCards";
export interface CatalogGalleryScopeOptions {
  services: CatalogServices;
  accountId: string;
  context: { authority_era: string; authority_epoch: string; revision: string };
}
export interface CatalogTagRename { oldTag: string; newTag: string; stage: "name" | "confirm" }

const handleWarm = () => {};
const updateBeat = async () => {}; // El guardado ya ocurrió en commitDrawerCloudMutation.

export function useCatalogGalleryScope({ services, accountId, context }: CatalogGalleryScopeOptions) {
  const { store, interaction: interactionStore, playback: session, media, mutations } = services;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) as CatalogStoreSnapshot;
  const interaction = useCatalogInteraction(interactionStore);
  const playback = useCatalogPlayback(session);
  const { state: audio, play, togglePause, seek, setVolume, releaseFile } = useAudio();
  const tagColors = useTagColors();

  const [knownCards] = useState(createKnownGalleryCards);
  const [artworkUrls, setArtworkUrls] = useState<Record<string, string>>({});
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const history = useMemo(() => createHistoryWriter(), []);
  const querySession = useMemo(() => createCatalogQuerySession({
    store,
    interaction: interactionStore,
    playback: session,
    history,
    schedule(callback, ms) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  }), [store, interactionStore, session, history]);
  const { refreshAfterMutation, reloadLibrary } = querySession;
  const importPorts = useRef({ mutations, refreshLibrary: refreshAfterMutation });
  importPorts.current = { mutations, refreshLibrary: refreshAfterMutation };
  const [importSession] = useState(() => createImportSession({
    get mutations() { return importPorts.current.mutations; },
    get refreshLibrary() { return importPorts.current.refreshLibrary; },
    importer: platform.importer,
    clock: { setTimeout: (callback, ms) => { window.setTimeout(callback, ms); } },
    landsProbe: () => importLandsAtTop(snapshotRef.current,
      typeof document === "undefined" ? null : document.querySelector<HTMLElement>('[data-library-scroll="true"]')?.scrollTop),
    setBusy: setBeatCloudUpdateBusy,
    alert: appAlert,
  }));
  const { setNotice } = importSession;
  const { notice, uploadNotice, review, uploads, pendingCards: pendingImports, batchOpen } =
    useSyncExternalStore(importSession.subscribe, importSession.getSnapshot, importSession.getSnapshot);

  const { knownDto, ordinalOf, noteOrdinal, onUnmountCard } = knownCards;
  const { firstBlockCache } = services;
  const { toBeat, beatById } = useMemo(() => knownCards.forRender({
    artworkUrls, playingId: audio.playingId, getSeededArtwork: importSession.getSeededArtwork,
  }), [knownCards, artworkUrls, audio.playingId, importSession]);
  const onMountCard = useMemo(() => knownCards.bindArtworkLoader(media, setArtworkUrls), [knownCards, media]);

  // ---- query global (búsqueda, tags, orden) → store / selección / sesión ----
  const [search, setSearchState] = useState(snapshot.filters.q);
  const setSearch: (value: string) => void = setSearchState;
  const [includedTags, setIncluded] = useState<Set<string>>(() => new Set(snapshot.filters.includeTags));
  const [excludedTags, setExcluded] = useState<Set<string>>(() => new Set(snapshot.filters.excludeTags));
  const sortBy = snapshot.sort;
  const revision = snapshot.revision ?? context.revision;
  const query = useMemo<InteractionQuery>(() => ({ filters: snapshot.filters, sort: snapshot.sort, revision }), [snapshot.filters, snapshot.sort, revision]);
  const filtersKey = playbackFiltersKey(snapshot.filters);
  const navInit = useRef(false);
  useEffect(() => {
    if (navInit.current) return;
    navInit.current = true;
    querySession.start({
      snapshot,
      readSearch: () => typeof window !== "undefined" ? window.location.search : "",
      readHistoryState: () => typeof window !== "undefined" ? window.history.state : null,
      setDraft(filters) {
        setSearchState(filters.q);
        setIncluded(new Set(filters.includeTags));
        setExcluded(new Set(filters.excludeTags));
      },
      setNotice,
    });
  }, [querySession, snapshot, setNotice]);
  const queryRender = useRef({ querySession, snapshot, query });
  // Las claves de cada efecto siguen siendo las del trigger original. Sus datos vienen del render confirmado.
  useLayoutEffect(() => { queryRender.current = { querySession, snapshot, query }; });
  const lastQueryKey = useRef<string | null>(null);
  useEffect(() => {
    const current = queryRender.current;
    lastQueryKey.current = current.querySession.syncQueryHistory(current.snapshot, lastQueryKey.current);
  }, [snapshot.queryKey, snapshot.status]);
  useEffect(() => {
    const current = queryRender.current;
    current.querySession.syncAnchor(current.snapshot);
  }, [snapshot.resumeCursor, snapshot.status]);
  useEffect(() => () => history.cancelPending(), [history]);
  useEffect(() => querySession.deferFilters({ search, includedTags, excludedTags }, context.revision),
    [search, includedTags, excludedTags, querySession, context.revision]);
  useEffect(() => { queryRender.current.querySession.syncPlayback(queryRender.current.query); }, [filtersKey, snapshot.sort, revision]);
  useEffect(() => { querySession.syncRevision(snapshot.revision); }, [snapshot.revision, querySession]);
  const handleTagClick = useCallback((tag: string, e: { altKey?: boolean }) => {
    if (e?.altKey) { setExcluded((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; }); setIncluded((s) => { if (!s.has(tag)) return s; const n = new Set(s); n.delete(tag); return n; }); }
    else { setIncluded((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; }); setExcluded((s) => { if (!s.has(tag)) return s; const n = new Set(s); n.delete(tag); return n; }); }
  }, []);
  const clearTagFilters = useCallback(() => { setIncluded(new Set()); setExcluded(new Set()); }, []);

  // ---- facetas globales (T06) → Tag Bar ----
  const [facets, setFacets] = useState<{ revision: string; tags: string[]; freq: Map<string, number> }>({ revision: "", tags: [], freq: new Map() });
  useEffect(() => querySession.loadFacets(queryRender.current.snapshot, setFacets),
    [snapshot.revision, snapshot.status, snapshot.provisional, querySession]);

  // ---- selección global (servidor) ----
  const [selectMode, setSelectMode] = useState(false);
  const { toggleSelection, toggleSelectAll, clearSelection, finishSelection, applyBulkUpdate, handleRemoveBulk, confirmTagRename } =
    useMemo(() => createGallerySelection({
      store: interactionStore, query, ordinalOf,
      setSelectMode, setNotice, refreshAfterMutation,
    }), [interactionStore, query, ordinalOf, setNotice, refreshAfterMutation]);
  const residentKey = `${snapshot.firstOrdinal}:${snapshot.endOrdinal}:${snapshot.queryGeneration}`;
  useEffect(() => {
    querySession.syncResidentFlags(queryRender.current.snapshot.blocks);
  }, [residentKey, querySession]);
  const isSelected = useMemo(() => interactionStore.isSelected.bind(null), [interactionStore, interaction.selection]);

  // ---- reproducción: la sesión decide, el motor aprobado suena ----
  const playbackLink = useRef<ReturnType<typeof linkPlayback> | null>(null);
  const playbackEngine = useRef({ state: audio, play, seek, togglePause });
  useEffect(() => () => {
    playbackLink.current?.dispose();
    playbackLink.current = null;
  }, []);
  useEffect(() => {
    playbackEngine.current = { state: audio, play, seek, togglePause };
    const link = playbackLink.current ??= linkPlayback(session, () => playbackEngine.current, {
      audioPaused: () => document.querySelector("audio")?.paused ?? null,
    });
    link.setSession(session);
    link.onEngineState(audio, (error) => reportPlaybackFailure(setNotice, "No se pudo continuar con el siguiente beat", error));
  });
  const { handlePlay, addToQueue, handleNext, handlePrev, toggleShuffle, cycleRepeat, playQueueIndex } = useMemo(() => createGalleryPlaybackCommands({
    session, knownDto, playingId: audio.playingId, togglePause, setNotice,
  }), [session, knownDto, audio.playingId, togglePause, setNotice]);
  const [showQueue, setShowQueue] = useState(false);
  const toggleQueue = useCallback(() => setShowQueue((v) => !v), []);
  const closeQueue = useCallback(() => setShowQueue(false), []);
  const queuedBeats = useMemo(() => playback.queue.map((t) => beatById(t.beatId)), [playback.queue, beatById]);
  const currentBeat = audio.playingId ? beatById(audio.playingId) : undefined;
  useEffect(() => { if (playback.queue.length === 0) setShowQueue(false); }, [playback.queue.length]);

  // ---- Drawer, edición, papelera, lote ----
  const [drawer, setDrawer] = useState<{ beat: Beat; mode: "detail" | "edit" } | null>(null);
  const { commitDrawerCloudMutation, saveDrawerToCatalog, deleteBeat, replaceAudioByDrop, replaceArtworkByDrop } =
    useMemo(() => createGalleryBeatEditor({
      mutations, media, knownDto, errorMessage: importFailureMessage,
      refreshAfterMutation, setNotice, confirm: appConfirm, setBusy: setBeatCloudUpdateBusy,
      playingId: audio.playingId, releaseFile,
      forgetArtworkOf: (id) => knownCards.forgetArtworkOf(id, media, firstBlockCache, accountId, setArtworkUrls),
    }), [mutations, media, knownDto, refreshAfterMutation, setNotice, audio.playingId, releaseFile, knownCards, firstBlockCache, accountId]);

  const residentSelectedBeats = useCallback((): Beat[] => { const out: Beat[] = []; for (const b of snapshot.blocks) for (const it of b.items) if (interactionStore.isSelected(it.id)) out.push(toBeat(it)); return out; }, [snapshot.blocks, interactionStore, toBeat]);
  const selectedBeats = useMemo(() => (interaction.selection.count > 0 ? residentSelectedBeats() : []), [interaction.selection, residentSelectedBeats]);
  const handleEditBulk = useCallback(() => {
    const first = residentSelectedBeats()[0]; if (!first) return;
    setDrawer({ beat: first, mode: "edit" });
  }, [residentSelectedBeats]);
  // ---- rename global de tag (T07 preview → confirmación → operación durable) ----
  const rename = interaction.rename;
  const tagRename: CatalogTagRename | null = rename ? { oldTag: rename.from, newTag: rename.to, stage: rename.stage === "name" ? "name" : "confirm" } : null;
  const { openRename: openTagRename, setRenameTarget: setTagRenameNewTag, backRename: backTagRename, closeRename: cancelTagRename } = interactionStore;
  const continueTagRename = useCallback(() => { void interactionStore.previewRename(); }, [interactionStore]);

  // ---- importación (T12) desde «Add beat» del navegador ----
  const [showAdd, setShowAdd] = useState(false);
  const { open: addBeatsAndReview, cancelReview, save: saveReview } = importSession;
  useEffect(() => { importSession.advanceReview(); }, [importSession, review]);
  const { residentIds, pendingCards } = useMemo(() => projectPendingCards(pendingImports, snapshot.blocks),
    [pendingImports, snapshot.blocks]);
  useEffect(() => { importSession.noteResident(residentIds); }, [importSession, residentIds]);
  useEffect(() => { services.mainPack?.setBatchOpen(batchOpen); }, [services.mainPack, batchOpen, review, uploads.length]);
  useEffect(() => { if (!snapshot.provisional) void importSession.resumePending(); }, [importSession, snapshot.provisional]);

  // ---- sesión / ajustes ----
  const [showSettings, setShowSettings] = useState(false);
  // Atajos aprobados (Escape cierra Drawer/menús/selección, Space pausa): el mismo hook que el AppShell legacy.
  const togglePauseRef = useRef(togglePause);
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);
  useAppShortcuts({ togglePauseRef, clearSelection: () => { clearSelection(); setSelectMode(false); }, setDrawer: () => setDrawer(null), setShowAdd: (v) => setShowAdd(v), setShowSettings: (v) => setShowSettings(v), closeQueue, setShowUpload: () => {} });
  const handleDisconnectTelegramAccount = useCallback(async () => { releaseFile(); await services.teardown(); await logoutBeatGalerAccount(); }, [releaseFile, services]);
  const connectionState: "online" | "offline" | "poor" = snapshot.status === "offline" ? "offline" : "online";
  const cloudSessionVerified = !["idle", "resolving", "loading", "unauthenticated", "unavailable"].includes(snapshot.status);
  const loading = snapshot.status === "loading" || snapshot.status === "resolving";
  const rejectOfflineMutation = useCallback((_action: string) => { if (connectionState !== "online") { setNotice("Reconnect to verify your Galer Cloud library."); return true; } return false; }, [connectionState, setNotice]);
  // ---- «Download» de una BeatCard: MP3 / WAV / PROJECT / todo, por el cliente de medios del catálogo (verifica tamaño y hash) ----
  const [cloudFiles, setCloudFiles] = useState<GalleryDownloadFiles | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<DownloadKind | null>(null);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const { openDownloads, downloadKind } = useMemo(() => createGalleryDownloads({
    mutations, media, cloudFiles, downloadBusy, setCloudFiles, setDownloadBusy, setDownloaded,
    rejectOfflineMutation, setNotice, save: saveBlobWithBrowser,
  }), [mutations, media, cloudFiles, downloadBusy, rejectOfflineMutation, setNotice]);
  const closeDownloads = useCallback(() => { setCloudFiles(null); setDownloadBusy(null); }, []);
  const dismissNotice = useCallback(() => { setNotice(null); interactionStore.dismissNotice(); }, [interactionStore, setNotice]);

  return {
    snapshot, interaction, playback, audio, query, revision,
    toBeat, beatById, noteOrdinal, onMountCard, onUnmountCard, isSelected,
    search, setSearch, sortBy, setSortBy: querySession.setSort, includedTags, excludedTags, handleTagClick, clearTagFilters,
    allTags: facets.tags, tagFrequency: facets.freq as ReadonlyMap<string, number>, tagSuggestions: facets.tags, tagColors,
    selectMode, selectedCount: interaction.selection.count, selectionStatus: interaction.selection.status, selectedBeats, toggleSelection, toggleSelectAll, finishSelection, clearSelection,
    handlePlay, handleWarm, addToQueue, handleNext, handlePrev, toggleShuffle, cycleRepeat, showQueue, toggleQueue, closeQueue, playQueueIndex, queuedBeats, currentBeat,
    shuffleEnabled: playback.shuffle, repeatMode: playback.repeat, togglePause, seek, setVolume, releaseFile,
    drawer, setDrawer, updateBeat, commitDrawerCloudMutation, saveDrawerToCatalog, deleteBeat, handleEditBulk, applyBulkUpdate, handleRemoveBulk,
    tagRename, tagRenameBusy: rename?.stage === "running", tagRenameError: rename?.error ?? null, tagRenameAffectedCount: (rename?.preview?.countActive ?? 0) + (rename?.preview?.countTrash ?? 0),
    openTagRename, setTagRenameNewTag, continueTagRename, backTagRename, cancelTagRename, confirmTagRename,
    showAdd, setShowAdd, addBeatsAndReview, review, cancelReview, saveReview, uploads, pendingCards, replaceAudioByDrop, replaceArtworkByDrop, cloudFiles, downloadBusy, downloaded, openDownloads, closeDownloads, downloadKind, showSettings, setShowSettings, handleDisconnectTelegramAccount, reloadLibrary,
    connectionState, cloudSessionVerified, loading, libraryRefreshing: false, rejectOfflineMutation,
    notice: notice ?? uploadNotice ?? interaction.selection.notice ?? playback.error ?? null, dismissNotice,
    accountId, context,
  };
}
export type CatalogGalleryScope = ReturnType<typeof useCatalogGalleryScope>;
export type { React };
