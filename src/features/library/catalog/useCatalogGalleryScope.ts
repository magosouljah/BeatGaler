// Composición del AppShell PostgreSQL. La sesión del catálogo decide qué suena y useAudio reproduce la URL arrendada.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Beat } from "../../../types";
import type { WebDrawerSave } from "../../../components/Drawer";
import { useGalleryAudio } from "./useGalleryAudio";
import { useTagColors } from "../../../lib/tagColors";
import { platform } from "../../../platform";
import { logoutBeatGalerAccount } from "../../auth/webSession";
import { createKnownGalleryCards } from "./catalogGalleryCards";
import type { CatalogServices } from "./catalogLibraryProvider";
import { createGallerySelection, useCatalogInteraction, type InteractionQuery } from "./catalogInteractionStore";
import { useCatalogPlayback } from "./catalogPlaybackSession";
import { createGalleryPlaybackCommands, linkPlayback, reportPlaybackFailure } from "./catalogPlaybackLink";
import { createGalleryBeatEditor, dispatchWebDrawerSave } from "./catalogBeatEditor";
import { appAlert, appConfirm } from "../../../lib/dialog";
import { createGalleryDownloadsStore, saveBlobWithBrowser, type GalleryDownloadsPorts } from "./catalogDownloads";
import { setBeatCloudUpdateBusy } from "../../cloud/beatCloudUpdateBusy";
import { createGalleryQuerySession } from "./catalogQuerySession";
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

export function useCatalogGalleryScope({ services, accountId, context }: CatalogGalleryScopeOptions) {
  const { store, interaction: interactionStore, playback: session, media, mutations } = services;
  const [galleryQuery] = useState(() => createGalleryQuerySession(store.getSnapshot().filters));
  const querySession = useMemo(() => galleryQuery.bind({ store, interaction: interactionStore, playback: session }),
    [galleryQuery, store, interactionStore, session]);
  const queryView = useSyncExternalStore(querySession.subscribe, querySession.getSnapshot, querySession.getSnapshot);
  const { catalog: snapshot, draft: { search, includedTags, excludedTags }, facets } = queryView;
  const interaction = useCatalogInteraction(interactionStore);
  const playback = useCatalogPlayback(session);
  const tagColors = useTagColors();

  const [knownCards] = useState(createKnownGalleryCards);
  const [artworkUrls, setArtworkUrls] = useState<Record<string, string>>({});
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
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
  const { state: audio, play, togglePause, toggleEnginePause, seek, setVolume, releaseFile, isAudioPaused } = useGalleryAudio(session, setNotice);

  const { knownDto, ordinalOf, noteOrdinal, onUnmountCard } = knownCards;
  const { firstBlockCache } = services;
  const { toBeat, beatById } = useMemo(() => knownCards.forRender({
    artworkUrls, playingId: audio.playingId, getSeededArtwork: importSession.getSeededArtwork,
  }), [knownCards, artworkUrls, audio.playingId, importSession]);
  const onMountCard = useMemo(() => knownCards.bindArtworkLoader(media, setArtworkUrls), [knownCards, media]);

  // ---- query global (búsqueda, tags, orden) → store / selección / sesión ----
  const sortBy = snapshot.sort;
  const revision = snapshot.revision ?? context.revision;
  const query = useMemo<InteractionQuery>(() => ({ filters: snapshot.filters, sort: snapshot.sort, revision }), [snapshot.filters, snapshot.sort, revision]);
  const { setSearch, handleTagClick, clearTagFilters } = galleryQuery;
  useEffect(() => galleryQuery.dispose, [galleryQuery]);
  useEffect(() => { querySession.commit(queryView, query, context.revision, setNotice); },
    [querySession, queryView, query, context.revision, setNotice]);

  // ---- selección global (servidor) ----
  const [selectMode, setSelectMode] = useState(false);
  const { toggleSelection, toggleSelectAll, clearSelection, finishSelection, applyBulkUpdate, handleRemoveBulk, confirmTagRename } =
    useMemo(() => createGallerySelection({
      store: interactionStore, query, ordinalOf,
      setSelectMode, setNotice, refreshAfterMutation,
    }), [interactionStore, query, ordinalOf, setNotice, refreshAfterMutation]);
  const isSelected = useMemo(() => interactionStore.isSelected.bind(null), [interactionStore, interaction.selection]);

  // ---- reproducción: la sesión decide, el motor aprobado suena ----
  const playbackLink = useRef<ReturnType<typeof linkPlayback> | null>(null);
  const playbackEngine = useRef({ state: audio, play, seek, togglePause: toggleEnginePause });
  useEffect(() => () => {
    playbackLink.current?.dispose();
    playbackLink.current = null;
  }, []);
  useEffect(() => {
    playbackEngine.current = { state: audio, play, seek, togglePause: toggleEnginePause };
    const link = playbackLink.current ??= linkPlayback(session, () => playbackEngine.current, {
      audioPaused: isAudioPaused,
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
      onTrashConfirmed: session.confirmTrash,
      forgetArtworkOf: (id) => knownCards.forgetArtworkOf(id, media, firstBlockCache, accountId, setArtworkUrls),
    }), [mutations, media, knownDto, refreshAfterMutation, setNotice, session, knownCards, firstBlockCache, accountId]);

  const residentSelectedBeats = useCallback((): Beat[] => { const out: Beat[] = []; for (const b of snapshot.blocks) for (const it of b.items) if (interactionStore.isSelected(it.id)) out.push(toBeat(it)); return out; }, [snapshot.blocks, interactionStore, toBeat]);
  const selectedBeats = useMemo(() => (interaction.selection.count > 0 ? residentSelectedBeats() : []), [interaction.selection, residentSelectedBeats]);
  const handleEditBulk = useCallback(() => {
    const first = residentSelectedBeats()[0] ?? (() => { for (const b of snapshot.blocks) for (const it of b.items) return toBeat(it); return undefined; })(); if (!first) return;
    setDrawer({ beat: first, mode: "edit" });
  }, [residentSelectedBeats, snapshot.blocks, toBeat]);
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
  const downloadPorts = useRef<GalleryDownloadsPorts>({ mutations, media, rejectOfflineMutation, setNotice, save: saveBlobWithBrowser });
  downloadPorts.current = { mutations, media, rejectOfflineMutation, setNotice, save: saveBlobWithBrowser };
  const [downloads] = useState(() => createGalleryDownloadsStore(() => downloadPorts.current));
  const { cloudFiles, downloadBusy, downloaded } = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot, downloads.getSnapshot);
  const { openDownloads, closeDownloads, downloadKind } = downloads;

  const dismissNotice = useCallback(() => { setNotice(null); interactionStore.dismissNotice(); }, [interactionStore, setNotice]);

  // ---- X4: grupos por responsabilidad. Son literales (sin hooks): ningún consumidor memoiza sobre el grupo, solo sobre sus miembros, que conservan su identidad. ----
  const selectedCount = interaction.selection.count;
  const saveWebDrawer = ((request) => dispatchWebDrawerSave(request, { review: saveReview, edit: saveDrawerToCatalog, bulk: applyBulkUpdate })) as WebDrawerSave;
  return {
    snapshot, interaction, playback, audio, toBeat, noteOrdinal, onMountCard, onUnmountCard, isSelected, currentBeat,
    filters: { query, search, setSearch, sortBy, setSortBy: querySession.setSort, includedTags, excludedTags, handleTagClick, clearTagFilters, allTags: facets.tags, tagFrequency: facets.freq as ReadonlyMap<string, number>, tagSuggestions: facets.tags, tagColors, },
    transport: { handlePlay, handleWarm, addToQueue, handleNext, handlePrev, toggleShuffle, cycleRepeat, shuffleEnabled: playback.shuffle, repeatMode: playback.repeat, togglePause, seek, setVolume, releaseFile, },
    queue: { showQueue, toggleQueue, playQueueIndex, queuedBeats },
    selection: { selectMode, selectedCount, selectedBeats, toggleSelection, toggleSelectAll, finishSelection, handleEditBulk, handleRemoveBulk, applyBulkUpdate },
    rename: { tagRename, busy: rename?.stage === "running", error: rename?.error ?? null, affectedCount: (rename?.preview?.countActive ?? 0) + (rename?.preview?.countTrash ?? 0), open: openTagRename, setNewTag: setTagRenameNewTag, onContinue: continueTagRename, back: backTagRename, cancel: cancelTagRename, confirm: confirmTagRename, },
    downloads: { cloudFiles, busyId: downloadBusy, downloaded, open: openDownloads, close: closeDownloads, download: downloadKind },
    imports: { showAdd, setShowAdd, addBeatsAndReview, review, cancelReview, saveReview, uploads, pendingCards },
    editor: { drawer, setDrawer, saveWebDrawer, saveDrawerToCatalog, commitDrawerCloudMutation, deleteBeat, replaceAudioByDrop, replaceArtworkByDrop },
    settings: { showSettings, setShowSettings, handleDisconnectTelegramAccount },
    connectionState, cloudSessionVerified, loading, rejectOfflineMutation, reloadLibrary, notice: notice ?? uploadNotice ?? interaction.selection.notice ?? null, dismissNotice,
  };
}
export type CatalogGalleryScope = ReturnType<typeof useCatalogGalleryScope>;
export type { React };
