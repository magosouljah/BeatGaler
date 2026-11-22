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
import type { CatalogBeatDto } from "./catalogApi";
import type { CatalogMetadataPatch } from "./catalogCommandsApi";
import type { CatalogServices } from "./catalogLibraryProvider";
import { useCatalogInteraction, type InteractionQuery } from "./catalogInteractionStore";
import { useCatalogPlayback } from "./catalogPlaybackSession";
import { linkPlayback } from "./catalogPlaybackLink";
import { beatFromCatalogDetail } from "./catalogMutations";
import { createBeatEditor, drawerEditError, type DrawerSaveInput, type EditResult } from "./catalogBeatEditor";
import { appAlert } from "../../../lib/dialog";
import { readBlobAsArrayBuffer } from "../../audio/mp3Metadata";
import { downloadBeatFiles, saveBlobWithBrowser, type DownloadKind } from "./catalogDownloads";
import type { CatalogBeatFile } from "./catalogCommandsApi";
import type { ArtworkDropSource } from "../../dragdrop/browserArtwork";
import { setBeatCloudUpdateBusy } from "../../cloud/beatCloudUpdateBusy";
import { appConfirm } from "../../../lib/dialog";
import type { CatalogStoreSnapshot } from "./catalogQueryStore";
import { createHistoryWriter } from "./catalogNavigation";
import { createCatalogQuerySession, playbackFiltersKey } from "./catalogQuerySession";
import { useAppShortcuts } from "../../../app/useAppShortcuts";

import { createImportSession, importFailureMessage } from "./catalogImportSession";

export { IMPORT_NO_FILE_NOTICE, importFailureMessage } from "./catalogImportSession";

export { SEARCH_DEBOUNCE_MS } from "./catalogQuerySession";
export const KNOWN_BEATS_MAX = 512; // tarjetas conocidas fuera de ventana (Playbar/cola): acotado, nunca la biblioteca entera
export const BULK_TAGS_MODE_NOTICE = "En el catálogo, «añadir» o «quitar» tags en lote aún no está disponible: usa «reemplazar».";
export interface CatalogGalleryScopeOptions {
  services: CatalogServices;
  accountId: string;
  context: { authority_era: string; authority_epoch: string; revision: string };
}
export interface CatalogTagRename { oldTag: string; newTag: string; stage: "name" | "confirm" }

type EditEffects = { refresh?: boolean; finishBusy?: boolean; complete?: boolean; forgetArtwork?: boolean; throw?: boolean };
const editEffects = {
  audio: {
    success: { finishBusy: true, complete: true, refresh: true },
    pending: { finishBusy: true },
    rejected: { finishBusy: true },
    "not-started": {},
  },
  artwork: {
    success: { finishBusy: true, complete: true, refresh: true },
    pending: { finishBusy: true },
    rejected: { finishBusy: true },
    "not-started": { finishBusy: true },
  },
  drawer: {
    success: { refresh: true, forgetArtwork: true },
    pending: { refresh: true, throw: true },
    rejected: { throw: true },
    "not-started": { throw: true },
  },
  manual: {
    success: { refresh: true },
    pending: { throw: true },
    rejected: { throw: true },
    "not-started": { throw: true },
  },
  trash: {
    success: { refresh: true },
    pending: {},
    rejected: {},
    "not-started": {},
  },
} satisfies Record<string, Record<EditResult["reading"], EditEffects>>;

function effectsFor(intent: keyof typeof editEffects, result: EditResult): EditEffects {
  const effects: EditEffects = editEffects[intent][result.reading];
  if (intent === "drawer" && (result.reading === "rejected" || result.reading === "pending") && result.partial) {
    return { ...effects, refresh: true, forgetArtwork: true };
  }
  if (intent === "trash" && result.reading === "rejected" && (result.why === "conflict" || result.partial)) {
    return { ...effects, refresh: true };
  }
  return effects;
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
    landsProbe: () => {
      const snap = snapshotRef.current;
      const scroller = typeof document !== "undefined" ? document.querySelector<HTMLElement>('[data-library-scroll="true"]') : null;
      return snap.filters.state === "ACTIVE" && !snap.filters.q.trim() && snap.filters.includeTags.length === 0
        && snap.filters.excludeTags.length === 0 && snap.firstOrdinal === 0 && (!scroller || scroller.scrollTop < 24);
    },
    setBusy: setBeatCloudUpdateBusy,
    alert: appAlert,
  }));
  const { setNotice } = importSession;
  const { notice, uploadNotice, review, uploads, pendingCards: pendingImports, batchOpen } =
    useSyncExternalStore(importSession.subscribe, importSession.getSnapshot, importSession.getSnapshot);

  const toBeat = useCallback((dto: CatalogBeatDto): Beat => {
    remember(dto);
    // E83: la tarjeta real que sustituye a la provisional nace con la portada de esta (sin fotograma negro hasta que cargue la de Telegram).
    const url = dto.artwork ? artworkUrls[dto.artwork.fileId] ?? importSession.getSeededArtwork(dto.id) ?? null : null;
    return beatFromCatalogDetail(dto, url || null, url === "");
  }, [artworkUrls, remember, importSession]);
  const beatById = useCallback((id: string): Beat => { const dto = dtoById.current.get(id); return dto ? toBeat(dto) : placeholderBeat(id); }, [toBeat]);
  const noteOrdinal = useCallback((id: string, ordinal: number) => { ordinalById.current.set(id, ordinal); }, []);
  // Artwork perezoso al montar la tarjeta: memoria → caché persistente de este dispositivo (E79) → Telegram. Solo las tarjetas montadas piden portada.
  // E80: las portadas que llegan en el mismo fotograma se aplican en UNA actualización (antes, una por portada: con 30 tarjetas, 30 renders
  // completos de la Gallery en el arranque). "" = la portada no pudo cargarse (la carátula vuelve al fondo de «sin portada»).
  const artworkBatch = useRef<Map<string, string> | null>(null);
  const applyArtwork = useCallback((fileId: string, url: string) => {
    if (artworkBatch.current) { artworkBatch.current.set(fileId, url); return; }
    artworkBatch.current = new Map([[fileId, url]]);
    const flush = () => {
      const batch = artworkBatch.current; artworkBatch.current = null; if (!batch) return;
      setArtworkUrls((prev) => { let next = prev; for (const [k, v] of batch) if (next[k] !== v) { if (next === prev) next = { ...prev }; next[k] = v; } return next; });
    };
    if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && document.visibilityState === "visible") requestAnimationFrame(flush); else setTimeout(flush, 0);
  }, []);
  const onMountCard = useCallback((id: string, ordinal?: number) => {
    if (ordinal !== undefined) ordinalById.current.set(id, ordinal);
    const dto = dtoById.current.get(id); const ref = dto?.artwork; if (!ref) return;
    void media.loadArtwork(ref, id).then((url) => applyArtwork(ref.fileId, url), () => applyArtwork(ref.fileId, ""));
  }, [media, applyArtwork]);
  const onUnmountCard = useCallback((id: string) => { ordinalById.current.delete(id); }, []);

  // ---- query global (búsqueda, tags, orden) → store / selección / sesión ----
  const [search, setSearchState] = useState(snapshot.filters.q);
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
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastQueryKey = useRef<string | null>(null);
  useEffect(() => {
    lastQueryKey.current = querySession.syncQueryHistory(snapshot, lastQueryKey.current);
  }, [snapshot.queryKey, snapshot.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    querySession.syncAnchor(snapshot);
  }, [snapshot.resumeCursor, snapshot.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => history.cancelPending(), [history]);
  useEffect(() => querySession.deferFilters({ search, includedTags, excludedTags }, context.revision),
    [search, includedTags, excludedTags, querySession, context.revision]);
  useEffect(() => { querySession.syncPlayback(query); }, [filtersKey, snapshot.sort, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { querySession.syncRevision(snapshot.revision); }, [snapshot.revision, querySession]);
  const setSearch = useCallback((value: string) => setSearchState(value), []);
  const setSortBy = querySession.setSort;
  const handleTagClick = useCallback((tag: string, e: { altKey?: boolean }) => {
    if (e?.altKey) { setExcluded((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; }); setIncluded((s) => { if (!s.has(tag)) return s; const n = new Set(s); n.delete(tag); return n; }); }
    else { setIncluded((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; }); setExcluded((s) => { if (!s.has(tag)) return s; const n = new Set(s); n.delete(tag); return n; }); }
  }, []);
  const clearTagFilters = useCallback(() => { setIncluded(new Set()); setExcluded(new Set()); }, []);

  // ---- facetas globales (T06) → Tag Bar ----
  const [facets, setFacets] = useState<{ revision: string; tags: string[]; freq: Map<string, number> }>({ revision: "", tags: [], freq: new Map() });
  useEffect(() => querySession.loadFacets(snapshot, setFacets),
    [snapshot.revision, snapshot.status, snapshot.provisional, querySession]);

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
    querySession.syncResidentFlags(snapshot.blocks);
  }, [residentKey, querySession]); // eslint-disable-line react-hooks/exhaustive-deps
  const isSelected = useCallback((id: string) => interactionStore.isSelected(id), [interactionStore, interaction.selection]); // eslint-disable-line react-hooks/exhaustive-deps

  // Los fallos de Siguiente/Anterior se muestran (nunca se tragan): el aviso dice qué pasó y la sesión conserva el target para reintentar.
  const reportPlaybackFailure = useCallback((action: string, e: unknown) => { const code = (e as { code?: unknown })?.code; setNotice(`${action}: ${code ? `${String(code)} — ` : ""}${String((e as { message?: unknown })?.message ?? e)}`); }, [setNotice]);
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
    link.onEngineState(audio, (error) => reportPlaybackFailure("No se pudo continuar con el siguiente beat", error));
  });
  const targetOf = useCallback((beat: Beat) => { const dto = dtoById.current.get(beat.id); return { beatId: beat.id, version: dto?.version ?? null, fileId: dto?.playback?.fileId ?? null }; }, []);
  const handlePlay = useCallback((beat: Beat) => {
    if (audio.playingId === beat.id) { togglePause(); return; }
    void session.play(targetOf(beat)).catch((e) => reportPlaybackFailure("No se pudo reproducir el beat", e));
  }, [audio.playingId, togglePause, session, targetOf, reportPlaybackFailure]);
  const handleWarm = useCallback(() => {}, []);
  const addToQueue = useCallback((beat: Beat) => { session.enqueue(targetOf(beat)); }, [session, targetOf]);
  const handleNext = useCallback(() => { void session.next().catch((e) => reportPlaybackFailure("No se pudo pasar al siguiente beat", e)); }, [session, reportPlaybackFailure]);
  const handlePrev = useCallback(() => { void session.previous().catch((e) => reportPlaybackFailure("No se pudo volver al beat anterior", e)); }, [session, reportPlaybackFailure]);
  const toggleShuffle = useCallback(() => { void session.setShuffle(!session.getSnapshot().shuffle); }, [session]);
  const cycleRepeat = useCallback(() => { const m = session.getSnapshot().repeat; session.setRepeat(m === "off" ? "all" : m === "all" ? "one" : "off"); }, [session]);
  const [showQueue, setShowQueue] = useState(false);
  const toggleQueue = useCallback(() => setShowQueue((v) => !v), []);
  const closeQueue = useCallback(() => setShowQueue(false), []);
  const playQueueIndex = useCallback((index: number) => { const t = session.getSnapshot().queue[index]; if (!t) return; session.dequeue(t.beatId); void session.play(t).catch((e) => reportPlaybackFailure("No se pudo reproducir el beat", e)); }, [session, reportPlaybackFailure]);
  const queuedBeats = useMemo(() => playback.queue.map((t) => beatById(t.beatId)), [playback.queue, beatById]);
  const currentBeat = audio.playingId ? beatById(audio.playingId) : undefined;
  useEffect(() => { if (playback.queue.length === 0) setShowQueue(false); }, [playback.queue.length]);

  // ---- Drawer, edición, papelera, lote ----
  const [drawer, setDrawer] = useState<{ beat: Beat; mode: "detail" | "edit" } | null>(null);
  // PROJECT vigente del beat (para fusionar un archivo de DAW con su ZIP, como el flujo anterior).
  const loadProject = useCallback(async (beatId: string): Promise<File | null> => {
    const files = await mutations.listBeatFiles(beatId);
    const p = files.find((f) => f.role === "PROJECT" && f.current); if (!p) return null;
    const { blob } = await media.downloadFile(p.fileId);
    return new File([blob], p.filename || "project.zip", { type: "application/zip" });
  }, [mutations, media]);
  const editor = useMemo(() => createBeatEditor({
    mutations, knownDto: (id) => dtoById.current.get(id), loadProject, errorMessage: importFailureMessage,
  }), [mutations, loadProject]);

  const commitDrawerCloudMutation = useCallback(async (updated: Beat) => {
    const result = await editor.saveDrawer({ mode: "manual", updated });
    const effects = effectsFor("manual", result);
    if (effects.throw && result.reading !== "success") throw drawerEditError(result, true);
    if (effects.refresh) refreshAfterMutation();
  }, [editor, refreshAfterMutation]);
  const updateBeat = useCallback(async () => { /* el commit ya ocurrió en commitDrawerCloudMutation; el store se recarga desde el servidor */ }, []);
  const deleteBeat = useCallback((beat: Beat) => {
    const dto = dtoById.current.get(beat.id); if (!dto) return;
    if (audio.playingId === beat.id) releaseFile();
    void editor.trash([{ beatId: dto.id, expectedVersion: dto.version }]).then((result) => {
      if (result.reading === "rejected" && !result.partial) setNotice(result.message);
      if (effectsFor("trash", result).refresh) refreshAfterMutation();
    }).catch((e) => setNotice(String(e?.message ?? e)));
  }, [editor, refreshAfterMutation, audio.playingId, releaseFile]);
  const residentSelectedBeats = useCallback((): Beat[] => { const out: Beat[] = []; for (const b of snapshot.blocks) for (const it of b.items) if (interactionStore.isSelected(it.id)) out.push(toBeat(it)); return out; }, [snapshot.blocks, interactionStore, toBeat]);
  const selectedBeats = useMemo(() => (interaction.selection.count > 0 ? residentSelectedBeats() : []), [interaction.selection, residentSelectedBeats]);
  const handleEditBulk = useCallback(() => {
    const first = residentSelectedBeats()[0]; if (!first) return;
    setDrawer({ beat: first, mode: "edit" });
  }, [residentSelectedBeats]);
  const applyBulkUpdate = useCallback((updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => {
    // r4 T16/V09: "añadir"/"quitar" tags en lote es BULK_PATCH con tagsOp (add/remove), nunca un reemplazo del set; "reemplazar"
    // sigue siendo un patch.tags normal (ya validado por el servidor, un solo lote con reporte).
    const tagsMode = updates.tags && options?.tagsMode ? options.tagsMode : null;
    if (tagsMode && tagsMode !== "add" && tagsMode !== "remove" && tagsMode !== "replace") { setNotice(BULK_TAGS_MODE_NOTICE); return; }
    const patch: CatalogMetadataPatch = {};
    if (updates.bpm !== undefined) patch.bpm = updates.bpm; if (updates.key !== undefined) patch.key = updates.key; if (updates.rating !== undefined) patch.rating = updates.rating;
    if (updates.color !== undefined) patch.color = updates.color; if (updates.color2 !== undefined) patch.color2 = updates.color2;
    if (updates.tags && tagsMode === "replace") patch.tags = [...updates.tags];
    const tagsOp = updates.tags && (tagsMode === "add" || tagsMode === "remove") ? { op: tagsMode, tags: [...updates.tags] } : undefined;
    void interactionStore.startBulk("BULK_PATCH", patch, tagsOp).then((r) => { setNotice(`Edición en lote: ${r.report.confirmed}/${r.report.total} confirmados${r.report.completed ? "" : ` (${r.status.toLowerCase()})`}.`); setSelectMode(false); refreshAfterMutation(); }).catch((e) => setNotice(String(e?.message ?? e)));
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

  // §6.1-1/2/3: guardado del Drawer en el catálogo: metadatos + portada nueva + archivos elegidos (MASTER/WAV/PROJECT) en UNA mutación (REPLACE o,
  // sin archivos, PATCH). Cualquier resultado que no sea un commit lanza un error: el Drawer conserva los cambios y archivos pendientes.
  // Portada quitada y confirmada: se olvidan la concesión/blob del beat (media), su URL en la Gallery y las copias locales de arranque
  // (E66) que lo contienen, para que la portada desvinculada no reaparezca; luego el bloque vigente se vuelve a pedir a PostgreSQL.
  const forgetArtworkOf = useCallback((beatId: string) => {
    const old = dtoById.current.get(beatId)?.artwork?.fileId;
    media.invalidate(beatId);
    if (old) setArtworkUrls((prev) => { if (!(old in prev)) return prev; const next = { ...prev }; delete next[old]; return next; });
    void services.firstBlockCache?.dropBeat(accountId, beatId);
  }, [media, services.firstBlockCache, accountId]);
  const saveDrawerToCatalog = useCallback(async (input: DrawerSaveInput) => {
    const result = await editor.saveDrawer(input);
    const effects = effectsFor("drawer", result);
    if (effects.forgetArtwork && (result.reading !== "success" || result.artworkRemoved)) forgetArtworkOf(input.updated.id);
    if (effects.refresh) refreshAfterMutation();
    if (effects.throw && result.reading !== "success") throw drawerEditError(result);
  }, [editor, refreshAfterMutation, forgetArtworkOf]);

  const replaceAudioByDrop = useCallback(async (beatId: string, file: File) => {
    const result = await editor.replaceAudio(beatId, file, {
      confirm: appConfirm, onStart: () => setBeatCloudUpdateBusy(beatId, true),
      onProgress: (t) => setNotice(`Reemplazando audio: ${t}`),
    });
    const effects = effectsFor("audio", result);
    if (effects.finishBusy) setBeatCloudUpdateBusy(beatId, false, effects.complete);
    if (result.reading === "success") setNotice(result.message ?? null);
    else if (result.reading === "not-started") setNotice(result.why === "unsupported" ? "Solo se pueden soltar archivos MP3 o WAV." : null);
    else setNotice(`No se pudo reemplazar el audio: ${result.message}`);
    if (effects.refresh) refreshAfterMutation();
  }, [editor, refreshAfterMutation]);

  const replaceArtworkByDrop = useCallback(async (beatId: string, sources: ArtworkDropSource[] | Promise<ArtworkDropSource[]>) => {
    setBeatCloudUpdateBusy(beatId, true);
    let effects: EditEffects = editEffects.artwork.rejected;
    try {
      const result = await editor.replaceArtwork(beatId, sources);
      effects = effectsFor("artwork", result);
      if (result.reading === "success") setNotice(result.message ?? null);
      else if (result.reading !== "not-started") setNotice(`No se pudo cambiar la portada: ${result.message}`);
      if (effects.refresh) refreshAfterMutation();
    } catch (e) { setNotice(`No se pudo cambiar la portada: ${String((e as { message?: unknown })?.message ?? e)}`); }
    finally { if (effects.finishBusy) setBeatCloudUpdateBusy(beatId, false, effects.complete === true); }
  }, [editor, refreshAfterMutation]);

  // ---- importación (T12) desde «Add beat» del navegador ----
  const [showAdd, setShowAdd] = useState(false);
  const { open: addBeatsAndReview, cancelReview, save: saveReview } = importSession;
  useEffect(() => { importSession.advanceReview(); }, [importSession, review]);
  const residentIds = useMemo(() => {
    const ids = new Set<string>();
    if (pendingImports.some((card) => card.realId)) for (const block of snapshot.blocks) for (const item of block.items) ids.add(item.id);
    return ids;
  }, [snapshot.blocks, pendingImports]);
  // La provisional sale de la rejilla en el mismo render en que llega la real.
  const pendingCards = useMemo(() => pendingImports
    .filter((card) => !(card.realId && residentIds.has(card.realId)))
    .map(({ id, beat }) => ({ id, beat })), [pendingImports, residentIds]);
  useEffect(() => { importSession.noteResident(residentIds); }, [importSession, residentIds]);
  useEffect(() => { services.mainPack?.setBatchOpen(batchOpen); }, [services.mainPack, batchOpen, review, uploads.length]);
  useEffect(() => { if (!snapshot.provisional) void importSession.resumePending(); }, [importSession, snapshot.provisional]);


  // ---- sesión / ajustes ----
  const [showSettings, setShowSettings] = useState(false);
  // Atajos aprobados (Escape cierra Drawer/menús/selección, Space pausa): el mismo hook que el AppShell legacy.
  const togglePauseRef = useRef(togglePause);
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);
  useAppShortcuts({ togglePauseRef, clearSelection: () => { void interactionStore.clearSelection(); setSelectMode(false); }, setDrawer: () => setDrawer(null), setShowAdd: (v) => setShowAdd(v), setShowSettings: (v) => setShowSettings(v), closeQueue, setShowUpload: () => {} });
  const handleDisconnectTelegramAccount = useCallback(async () => { releaseFile(); await services.teardown(); await logoutBeatGalerAccount(); }, [releaseFile, services]);
  const connectionState: "online" | "offline" | "poor" = snapshot.status === "offline" ? "offline" : "online";
  const cloudSessionVerified = !["idle", "resolving", "loading", "unauthenticated", "unavailable"].includes(snapshot.status);
  const loading = snapshot.status === "loading" || snapshot.status === "resolving";
  const rejectOfflineMutation = useCallback((_action: string) => { if (connectionState !== "online") { setNotice("Reconnect to verify your Galer Cloud library."); return true; } return false; }, [connectionState]);
  // ---- «Download» de una BeatCard: MP3 / WAV / PROJECT / todo, por el cliente de medios del catálogo (verifica tamaño y hash) ----
  const [cloudFiles, setCloudFiles] = useState<{ beat: Beat; files: CatalogBeatFile[] } | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<DownloadKind | null>(null);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const openDownloads = useCallback((beat: Beat) => {
    if (rejectOfflineMutation("Downloading")) return;
    setDownloaded(new Set());
    void mutations.listBeatFiles(beat.id).then((files) => setCloudFiles({ beat, files })).catch((e) => setNotice(`No se pudo leer los archivos del beat: ${String((e as { message?: unknown })?.message ?? e)}`));
  }, [mutations, rejectOfflineMutation]);
  const closeDownloads = useCallback(() => { setCloudFiles(null); setDownloadBusy(null); }, []);
  const downloadKind = useCallback((kind: DownloadKind) => {
    if (!cloudFiles || downloadBusy) return;
    setDownloadBusy(kind);
    const dlBeat = cloudFiles.beat; const artFile = cloudFiles.files.find((f) => f.role === "ARTWORK" && f.current && f.status !== "DELETED");
    const mp3Tags = { metadata: { name: dlBeat.name, bpm: dlBeat.bpm, key: dlBeat.key, tags: dlBeat.tags, rating: dlBeat.rating },
      artwork: artFile ? async () => { const { blob } = await media.downloadFile(artFile.fileId); return { mimeType: blob.type || artFile.mime || "image/png", bytes: await readBlobAsArrayBuffer(blob) }; } : undefined };
    void downloadBeatFiles({ files: cloudFiles.files, kind, beatName: dlBeat.name, download: (id) => media.downloadFile(id), save: saveBlobWithBrowser, mp3Tags }).then((r) => {
      if (r.status === "done") { setDownloaded((d) => new Set(d).add(kind)); setNotice(r.saved.length > 1 ? `${r.saved.length} archivos descargados.` : `«${r.saved[0]}» descargado.`); }
      else if (r.status === "empty") setNotice("Ese archivo no está disponible para este beat.");
      else setNotice(`No se pudo descargar: ${r.message}`);
    }).finally(() => setDownloadBusy(null));
  }, [cloudFiles, downloadBusy, media]);
  const dismissNotice = useCallback(() => { setNotice(null); interactionStore.dismissNotice(); }, [interactionStore]);

  return {
    snapshot, interaction, playback, audio, query, revision,
    toBeat, beatById, noteOrdinal, onMountCard, onUnmountCard, isSelected,
    search, setSearch, sortBy, setSortBy, includedTags, excludedTags, handleTagClick, clearTagFilters,
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
