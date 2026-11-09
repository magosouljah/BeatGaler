// T16 / V08-A — Scope POSTGRES para el AppShell aprobado: el mismo contrato de datos que `useBeatGalerComposition` entrega a
// GalleryChrome, BeatCard, Player y Drawer, pero alimentado por los servicios del catálogo (store acotado V04, InteractionStore
// V07-A, sesión musical V06/T14, medios T14, mutaciones T13/T12). Excluidos por contrato (MATRIZ-V V08 §11): selector local,
// cache global de beats, reload/reconcile INDEX y pager. El motor de audio es el mismo `useAudio` de la Gallery aprobada: la sesión
// del catálogo decide QUÉ suena (ronda Shuffle, vecino, cola) y el motor reproduce la URL arrendada al media manager.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Beat } from "../../../types";
import { useAudio } from "../../../hooks/useAudio";
import { useTagColors } from "../../../lib/tagColors";
import { platform } from "../../../platform";
import { logoutBeatGalerAccount } from "../../../components/AccountGate";
import type { CatalogBeatDto, CatalogQueryFilters, CatalogSort } from "./catalogApi";
import type { CatalogMetadataPatch } from "./catalogCommandsApi";
import type { CatalogServices } from "./catalogLibraryProvider";
import { useCatalogInteraction, type InteractionQuery } from "./catalogInteractionStore";
import { useCatalogPlayback } from "./catalogPlaybackSession";
import { beatFromCatalogDetail, metadataPatch } from "./catalogMutations";
import type { CatalogStoreSnapshot } from "./catalogQueryStore";
import { LEGACY_UNRESOLVABLE_COPY, createHistoryWriter, parseLegacyBgPage, readNavigationState } from "./catalogNavigation";
import { useAppShortcuts } from "../../../app/useAppShortcuts";

export const SEARCH_DEBOUNCE_MS = 250;
export const KNOWN_BEATS_MAX = 512; // tarjetas conocidas fuera de ventana (Playbar/cola): acotado, nunca la biblioteca entera
export const BULK_TAGS_MODE_NOTICE = "En el catálogo, «añadir» o «quitar» tags en lote aún no está disponible: usa «reemplazar».";
export const IMPORT_NO_FILE_NOTICE = "No se encontró el archivo del beat a importar.";

export interface CatalogGalleryScopeOptions {
  services: CatalogServices;
  accountId: string;
  context: { authority_era: string; authority_epoch: string; revision: string };
}
export interface CatalogTagRename { oldTag: string; newTag: string; stage: "name" | "confirm" }

function dataUrlToFile(dataUrl: string, name: string): File | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "image/png"; const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  try {
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return new File([bytes], `${name.replace(/[\\/:*?"<>|]+/g, "_") || "artwork"}.${ext}`, { type: mime });
  } catch { return null; }
}
const placeholderBeat = (id: string): Beat => beatFromCatalogDetail({ id, version: "", state: "ACTIVE", name: "…", bpm: "", key: "", tags: [], rating: 0, color: null, color2: null, artwork: null, playback: null, hasArtwork: false, hasWav: false, hasStems: false, hasProject: false, fileCount: 0 } as CatalogBeatDto);

export function useCatalogGalleryScope({ services, accountId, context }: CatalogGalleryScopeOptions) {
  const { store, interaction: interactionStore, playback: session, media, mutations } = services;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) as CatalogStoreSnapshot;
  const interaction = useCatalogInteraction(interactionStore);
  const playback = useCatalogPlayback(session);
  const { state: audio, play, togglePause, seek, setVolume, releaseFile } = useAudio();
  const tagColors = useTagColors();

  // ---- DTOs conocidos (resident + reproducidos/encolados), acotados ----
  const dtoById = useRef(new Map<string, CatalogBeatDto>());
  const ordinalById = useRef(new Map<string, number>());
  const [artworkUrls, setArtworkUrls] = useState<Record<string, string>>({});
  const remember = useCallback((dto: CatalogBeatDto) => {
    const m = dtoById.current; m.delete(dto.id); m.set(dto.id, dto);
    while (m.size > KNOWN_BEATS_MAX) { const first = m.keys().next().value as string; if (first === audio.playingId) { const second = [...m.keys()][1]; if (second) m.delete(second); else break; } else m.delete(first); }
  }, [audio.playingId]);
  const toBeat = useCallback((dto: CatalogBeatDto): Beat => {
    remember(dto);
    const url = dto.artwork ? artworkUrls[dto.artwork.fileId] ?? null : null;
    return beatFromCatalogDetail(dto, url);
  }, [artworkUrls, remember]);
  const beatById = useCallback((id: string): Beat => { const dto = dtoById.current.get(id); return dto ? toBeat(dto) : placeholderBeat(id); }, [toBeat]);
  const noteOrdinal = useCallback((id: string, ordinal: number) => { ordinalById.current.set(id, ordinal); }, []);
  // Artwork perezoso al montar la tarjeta (media manager con LRU; la concesión se reutiliza mientras no caduque).
  const onMountCard = useCallback((id: string) => {
    const dto = dtoById.current.get(id); const ref = dto?.artwork; if (!ref) return;
    void media.loadArtwork(ref.fileId).then((url) => { setArtworkUrls((prev) => (prev[ref.fileId] === url ? prev : { ...prev, [ref.fileId]: url })); }).catch(() => {});
  }, [media]);
  const onUnmountCard = useCallback((id: string) => { ordinalById.current.delete(id); }, []);

  // ---- query global (búsqueda, tags, orden) → store / selección / sesión ----
  const [search, setSearchState] = useState(snapshot.filters.q);
  const [includedTags, setIncluded] = useState<Set<string>>(() => new Set(snapshot.filters.includeTags));
  const [excludedTags, setExcluded] = useState<Set<string>>(() => new Set(snapshot.filters.excludeTags));
  const sortBy = snapshot.sort;
  const revision = snapshot.revision ?? context.revision;
  const query = useMemo<InteractionQuery>(() => ({ filters: snapshot.filters, sort: snapshot.sort, revision }), [snapshot.filters, snapshot.sort, revision]);
  const filtersKey = `${snapshot.filters.q}|${[...snapshot.filters.includeTags].join(",")}|${[...snapshot.filters.excludeTags].join(",")}|${snapshot.filters.state}`;
  // Arranque por URL (plan B §5.2, r4 §2 B-legacy): `bgPage` legacy → resolver del servidor (ancla + copy B-legacy); `bgAnchor` → reapertura por
  // cursor; filtros/orden de la URL → query inicial. Sin parámetros → primer bloque. El historial se escribe acotado (replace con debounce).
  const history = useMemo(() => createHistoryWriter(), []);
  const navInit = useRef(false);
  useEffect(() => {
    if (navInit.current) return; navInit.current = true;
    const search = typeof window !== "undefined" ? window.location.search : "";
    const legacy = parseLegacyBgPage(search);
    if (legacy.kind === "offset") { void store.loadLegacy(legacy.offset); return; }
    if (legacy.kind === "invalid") { setNotice(LEGACY_UNRESOLVABLE_COPY); void store.loadFirst(); return; }
    const nav = readNavigationState(search);
    if (nav.filters.q || nav.filters.includeTags.length || nav.filters.excludeTags.length || nav.sort !== snapshot.sort || nav.filters.state !== snapshot.filters.state) {
      setSearchState(nav.filters.q); setIncluded(new Set(nav.filters.includeTags)); setExcluded(new Set(nav.filters.excludeTags));
      void store.setQuery(nav.filters, nav.sort);
      return;
    }
    if (nav.anchor) { void store.loadResume(nav.anchor); return; }
    void store.loadFirst();
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastQueryKey = useRef<string | null>(null);
  useEffect(() => {
    if (snapshot.status === "idle" || snapshot.status === "resolving") return;
    const key = snapshot.queryKey;
    if (lastQueryKey.current !== null && lastQueryKey.current !== key) history.pushQuery({ filters: snapshot.filters, sort: snapshot.sort, anchor: null });
    lastQueryKey.current = key;
  }, [snapshot.queryKey, snapshot.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!snapshot.resumeCursor || snapshot.status !== "ready" || snapshot.legacy) return;
    history.replaceAnchor({ filters: snapshot.filters, sort: snapshot.sort, anchor: snapshot.resumeCursor });
  }, [snapshot.resumeCursor, snapshot.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => history.cancelPending(), [history]);
  useEffect(() => {
    const q = search.trim();
    const t = setTimeout(() => {
      const filters: CatalogQueryFilters = { ...snapshot.filters, q, includeTags: [...includedTags].sort(), excludeTags: [...excludedTags].sort() };
      const same = filters.q === snapshot.filters.q && filters.includeTags.join(",") === [...snapshot.filters.includeTags].join(",") && filters.excludeTags.join(",") === [...snapshot.filters.excludeTags].join(",");
      if (same) return;
      void interactionStore.onFiltersChanged({ filters, sort: snapshot.sort, revision });
      void store.setQuery(filters, snapshot.sort);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search, includedTags, excludedTags]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void session.setQuery(query); }, [filtersKey, snapshot.sort, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (snapshot.revision) interactionStore.onRevisionChanged(snapshot.revision); }, [snapshot.revision, interactionStore]);
  const setSearch = useCallback((value: string) => setSearchState(value), []);
  const setSortBy = useCallback((sort: CatalogSort) => { interactionStore.onSortChanged(sort); void store.setSort(sort); }, [interactionStore, store]);
  const handleTagClick = useCallback((tag: string, e: { altKey?: boolean }) => {
    if (e?.altKey) { setExcluded((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; }); setIncluded((s) => { if (!s.has(tag)) return s; const n = new Set(s); n.delete(tag); return n; }); }
    else { setIncluded((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; }); setExcluded((s) => { if (!s.has(tag)) return s; const n = new Set(s); n.delete(tag); return n; }); }
  }, []);
  const clearTagFilters = useCallback(() => { setIncluded(new Set()); setExcluded(new Set()); }, []);

  // ---- facetas globales (T06) → Tag Bar ----
  const [facets, setFacets] = useState<{ revision: string; tags: string[]; freq: Map<string, number> }>({ revision: "", tags: [], freq: new Map() });
  useEffect(() => {
    if (!snapshot.revision || !["ready", "empty", "no-results"].includes(snapshot.status)) return;
    let cancelled = false;
    void interactionStore.loadFacets({ scope: "ACTIVE", q: "", revision: snapshot.revision, limit: 240 }).then((page) => {
      if (cancelled) return;
      setFacets({ revision: snapshot.revision!, tags: page.items.map((f) => f.label || f.key), freq: new Map(page.items.map((f) => [f.label || f.key, f.count])) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [snapshot.revision, snapshot.status, interactionStore]);

  // ---- selección global (servidor) ----
  const [selectMode, setSelectMode] = useState(false);
  const toggleSelection = useCallback((beat: Beat | null, shiftKey: boolean) => {
    if (!beat) { setSelectMode(true); return; }
    void interactionStore.toggle(beat.id, { shiftKey, ordinal: ordinalById.current.get(beat.id) ?? null, query }).catch(() => {});
  }, [interactionStore, query]);
  const toggleSelectAll = useCallback(() => {
    const s = interactionStore.getSnapshot().selection;
    if (s.status === "active" && s.defaultSelected) void interactionStore.clearSelection();
    else void interactionStore.selectAll(query).catch(() => {});
  }, [interactionStore, query]);
  const clearSelection = useCallback(() => { void interactionStore.clearSelection(); }, [interactionStore]);
  const finishSelection = useCallback(() => { setSelectMode(false); void interactionStore.clearSelection(); }, [interactionStore]);
  const residentKey = `${snapshot.firstOrdinal}:${snapshot.endOrdinal}:${snapshot.queryGeneration}`;
  useEffect(() => {
    const s = interactionStore.getSnapshot().selection;
    if (s.status !== "active" && s.status !== "conflict") return;
    const ids: string[] = []; for (const b of snapshot.blocks) for (const it of b.items) ids.push(it.id);
    void interactionStore.refreshFlags(ids).catch(() => {});
  }, [residentKey, interactionStore]); // eslint-disable-line react-hooks/exhaustive-deps
  const isSelected = useCallback((id: string) => interactionStore.isSelected(id), [interactionStore, interaction.selection]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- reproducción: la sesión decide, el motor aprobado suena ----
  const lastEnded = useRef(audio.endedSeq);
  useEffect(() => session.onEvent((e) => {
    const snap = session.getSnapshot();
    if (e.kind === "play" && e.beatId && snap.source) play(e.beatId, [snap.source.url]);
    else if (e.kind === "seek0") seek(0);
    else if (e.kind === "replay") { seek(0); const a = document.querySelector("audio"); if (a && a.paused) togglePause(); }
  }), [session, play, seek, togglePause]);
  useEffect(() => { if (audio.endedSeq !== lastEnded.current) { lastEnded.current = audio.endedSeq; void session.ended().catch(() => {}); } }, [audio.endedSeq, session]);
  const lastProgress = useRef(0);
  useEffect(() => { if (Math.abs(audio.progress - lastProgress.current) >= 0.01 || audio.progress === 0) { lastProgress.current = audio.progress; session.setProgress(audio.progress); } }, [audio.progress, session]);
  const targetOf = useCallback((beat: Beat) => { const dto = dtoById.current.get(beat.id); return { beatId: beat.id, version: dto?.version ?? null, fileId: dto?.playback?.fileId ?? null }; }, []);
  const handlePlay = useCallback((beat: Beat) => {
    if (audio.playingId === beat.id) { togglePause(); return; }
    void session.play(targetOf(beat)).catch(() => {});
  }, [audio.playingId, togglePause, session, targetOf]);
  const handleWarm = useCallback(() => {}, []);
  const addToQueue = useCallback((beat: Beat) => { session.enqueue(targetOf(beat)); }, [session, targetOf]);
  const handleNext = useCallback(() => { void session.next().catch(() => {}); }, [session]);
  const handlePrev = useCallback(() => { void session.previous().catch(() => {}); }, [session]);
  const toggleShuffle = useCallback(() => { void session.setShuffle(!session.getSnapshot().shuffle); }, [session]);
  const cycleRepeat = useCallback(() => { const m = session.getSnapshot().repeat; session.setRepeat(m === "off" ? "all" : m === "all" ? "one" : "off"); }, [session]);
  const [showQueue, setShowQueue] = useState(false);
  const toggleQueue = useCallback(() => setShowQueue((v) => !v), []);
  const closeQueue = useCallback(() => setShowQueue(false), []);
  const playQueueIndex = useCallback((index: number) => { const t = session.getSnapshot().queue[index]; if (!t) return; session.dequeue(t.beatId); void session.play(t).catch(() => {}); }, [session]);
  const queuedBeats = useMemo(() => playback.queue.map((t) => beatById(t.beatId)), [playback.queue, beatById]);
  const currentBeat = audio.playingId ? beatById(audio.playingId) : undefined;
  useEffect(() => { if (playback.queue.length === 0) setShowQueue(false); }, [playback.queue.length]);

  // ---- Drawer, edición, papelera, lote ----
  const [drawer, setDrawer] = useState<{ beat: Beat; mode: "detail" | "edit" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshAfterMutation = useCallback(() => { store.notifyLibraryChanged(); interactionStore.invalidateFacets(); }, [store, interactionStore]);
  const commitDrawerCloudMutation = useCallback(async (updated: Beat) => {
    const dto = dtoById.current.get(updated.id);
    if (!dto) throw new Error("Este beat ya no está disponible en la ventana actual; vuelve a abrirlo.");
    const original = beatFromCatalogDetail(dto, null);
    const artworkChanged = Boolean(updated.image_base64) && updated.image_base64 !== original.image_base64 && String(updated.image_base64).startsWith("data:");
    const outcome = artworkChanged
      ? await mutations.replaceBeat({ beatId: dto.id, expectedVersion: dto.version, original, updated, files: { artwork: dataUrlToFile(String(updated.image_base64), updated.name) } })
      : await mutations.patchBeat({ beatId: dto.id, expectedVersion: dto.version, patch: metadataPatch(original, updated) });
    if (outcome.status === "conflict") throw new Error("Este beat cambió en otro dispositivo. Tus cambios siguen aquí: revisa y vuelve a guardar.");
    if (outcome.status === "error") throw outcome.error;
    if (outcome.status === "blocked" || outcome.status === "failed" || outcome.status === "canceled" || outcome.status === "timeout" || outcome.status === "uncertain") throw new Error(`La operación quedó en estado ${outcome.status}; el servidor conserva el resultado.`);
    refreshAfterMutation();
  }, [mutations, refreshAfterMutation]);
  const updateBeat = useCallback(async () => { /* el commit ya ocurrió en commitDrawerCloudMutation; el store se recarga desde el servidor */ }, []);
  const deleteBeat = useCallback((beat: Beat) => {
    const dto = dtoById.current.get(beat.id); if (!dto) return;
    if (audio.playingId === beat.id) releaseFile();
    void mutations.trashBeats([{ beatId: dto.id, expectedVersion: dto.version }]).then((r) => { if (r.status === "CONFLICT") setNotice("La biblioteca cambió en otro dispositivo; revisa antes de borrar."); refreshAfterMutation(); }).catch((e) => setNotice(String(e?.message ?? e)));
  }, [mutations, refreshAfterMutation, audio.playingId, releaseFile]);
  const residentSelectedBeats = useCallback((): Beat[] => { const out: Beat[] = []; for (const b of snapshot.blocks) for (const it of b.items) if (interactionStore.isSelected(it.id)) out.push(toBeat(it)); return out; }, [snapshot.blocks, interactionStore, toBeat]);
  const selectedBeats = useMemo(() => (interaction.selection.count > 0 ? residentSelectedBeats() : []), [interaction.selection, residentSelectedBeats]);
  const handleEditBulk = useCallback(() => {
    const first = residentSelectedBeats()[0]; if (!first) return;
    setDrawer({ beat: first, mode: "edit" });
  }, [residentSelectedBeats]);
  const applyBulkUpdate = useCallback((updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => {
    if (updates.tags && options?.tagsMode && options.tagsMode !== "replace") { setNotice(BULK_TAGS_MODE_NOTICE); return; }
    const patch: CatalogMetadataPatch = {};
    if (updates.bpm !== undefined) patch.bpm = updates.bpm; if (updates.key !== undefined) patch.key = updates.key; if (updates.rating !== undefined) patch.rating = updates.rating;
    if (updates.color !== undefined) patch.color = updates.color; if (updates.color2 !== undefined) patch.color2 = updates.color2; if (updates.tags) patch.tags = [...updates.tags];
    void interactionStore.startBulk("BULK_PATCH", patch).then((r) => { setNotice(`Edición en lote: ${r.report.confirmed}/${r.report.total} confirmados${r.report.completed ? "" : ` (${r.status.toLowerCase()})`}.`); setSelectMode(false); refreshAfterMutation(); }).catch((e) => setNotice(String(e?.message ?? e)));
  }, [interactionStore, refreshAfterMutation]);
  const handleRemoveBulk = useCallback(() => {
    void interactionStore.startBulk("BULK_TRASH").then((r) => { setNotice(`Papelera en lote: ${r.report.confirmed}/${r.report.total} confirmados${r.report.completed ? "" : ` (${r.status.toLowerCase()})`}.`); setSelectMode(false); refreshAfterMutation(); }).catch((e) => setNotice(String(e?.message ?? e)));
  }, [interactionStore, refreshAfterMutation]);

  // ---- rename global de tag (T07 preview → confirmación → operación durable) ----
  const rename = interaction.rename;
  const tagRename: CatalogTagRename | null = rename ? { oldTag: rename.from, newTag: rename.to, stage: rename.stage === "name" ? "name" : "confirm" } : null;
  const openTagRename = useCallback((tag: string) => interactionStore.openRename(tag), [interactionStore]);
  const setTagRenameNewTag = useCallback((value: string) => interactionStore.setRenameTarget(value), [interactionStore]);
  const continueTagRename = useCallback(() => { void interactionStore.previewRename(); }, [interactionStore]);
  const backTagRename = useCallback(() => interactionStore.backRename(), [interactionStore]);
  const cancelTagRename = useCallback(() => interactionStore.closeRename(), [interactionStore]);
  const confirmTagRename = useCallback(() => {
    void interactionStore.confirmRename().then((final) => {
      if (final) { setNotice(final.report.completed ? `Tag renombrado: ${final.report.confirmed} beats.` : interactionStore.getSnapshot().rename?.error ?? null); if (final.report.completed) interactionStore.closeRename(); }
      refreshAfterMutation();
    });
  }, [interactionStore, refreshAfterMutation]);

  // ---- importación (T12) desde «Add beat» del navegador ----
  const [showAdd, setShowAdd] = useState(false);
  const addBeatsAndReview = useCallback((beats: Beat[]) => {
    for (const beat of beats) {
      const file = platform.importer.fileForBeat(beat.id);
      if (!file) { setNotice(IMPORT_NO_FILE_NOTICE); continue; }
      setNotice(`Importando «${beat.name}»…`);
      void mutations.importBeat({ beat, files: { master: file }, onProgress: (p) => setNotice(`Importando «${beat.name}»: ${p.stage} ${Math.round((p.uploadedBytes / Math.max(1, p.totalBytes)) * 100)}%`) })
        .then((o) => { setNotice(o.status === "committed" ? `«${beat.name}» importado.` : `Importación de «${beat.name}»: ${o.status}.`); refreshAfterMutation(); })
        .catch((e) => setNotice(`No se pudo importar «${beat.name}»: ${String(e?.message ?? e)}`));
    }
  }, [mutations, refreshAfterMutation]);

  // ---- sesión / ajustes ----
  const [showSettings, setShowSettings] = useState(false);
  // Atajos aprobados (Escape cierra Drawer/menús/selección, Space pausa): el mismo hook que el AppShell legacy.
  const togglePauseRef = useRef(togglePause);
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);
  useAppShortcuts({ togglePauseRef, clearSelection: () => { void interactionStore.clearSelection(); setSelectMode(false); }, setDrawer: () => setDrawer(null), setShowAdd: (v) => setShowAdd(v), setShowSettings: (v) => setShowSettings(v), closeQueue, setShowUpload: () => {} });
  const handleDisconnectTelegramAccount = useCallback(async () => { releaseFile(); await services.teardown(); await logoutBeatGalerAccount(); }, [releaseFile, services]);
  const reloadLibrary = useCallback(async () => { await store.loadFirst(); interactionStore.invalidateFacets(); }, [store, interactionStore]);
  const connectionState: "online" | "offline" | "poor" = snapshot.status === "offline" ? "offline" : "online";
  const cloudSessionVerified = !["idle", "resolving", "loading", "unauthenticated", "unavailable"].includes(snapshot.status);
  const loading = snapshot.status === "loading" || snapshot.status === "resolving";
  const rejectOfflineMutation = useCallback((_action: string) => { if (connectionState !== "online") { setNotice("Reconnect to verify your Galer Cloud library."); return true; } return false; }, [connectionState]);
  const dismissNotice = useCallback(() => { setNotice(null); interactionStore.dismissNotice(); }, [interactionStore]);

  return {
    snapshot, interaction, playback, audio, query, revision,
    toBeat, beatById, noteOrdinal, onMountCard, onUnmountCard, isSelected,
    search, setSearch, sortBy, setSortBy, includedTags, excludedTags, handleTagClick, clearTagFilters,
    allTags: facets.tags, tagFrequency: facets.freq as ReadonlyMap<string, number>, tagSuggestions: facets.tags, tagColors,
    selectMode, selectedCount: interaction.selection.count, selectionStatus: interaction.selection.status, selectedBeats, toggleSelection, toggleSelectAll, finishSelection, clearSelection,
    handlePlay, handleWarm, addToQueue, handleNext, handlePrev, toggleShuffle, cycleRepeat, showQueue, toggleQueue, closeQueue, playQueueIndex, queuedBeats, currentBeat,
    shuffleEnabled: playback.shuffle, repeatMode: playback.repeat, togglePause, seek, setVolume, releaseFile,
    drawer, setDrawer, updateBeat, commitDrawerCloudMutation, deleteBeat, handleEditBulk, applyBulkUpdate, handleRemoveBulk,
    tagRename, tagRenameBusy: rename?.stage === "running", tagRenameError: rename?.error ?? null, tagRenameAffectedCount: (rename?.preview?.countActive ?? 0) + (rename?.preview?.countTrash ?? 0),
    openTagRename, setTagRenameNewTag, continueTagRename, backTagRename, cancelTagRename, confirmTagRename,
    showAdd, setShowAdd, addBeatsAndReview, showSettings, setShowSettings, handleDisconnectTelegramAccount, reloadLibrary,
    connectionState, cloudSessionVerified, loading, libraryRefreshing: false, rejectOfflineMutation,
    notice: notice ?? interaction.selection.notice ?? playback.error ?? null, dismissNotice,
    accountId, context,
  };
}
export type CatalogGalleryScope = ReturnType<typeof useCatalogGalleryScope>;
export type { React };
