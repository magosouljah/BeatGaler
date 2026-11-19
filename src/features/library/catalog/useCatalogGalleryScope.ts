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
import { replaceBeatAudio } from "./catalogAudioReplace";
import { enqueueReview, nextReview, pendingTransferNotice, saveDrawerChanges, summarizePendingTransfers, type DrawerSaveInput, type ReviewEntry } from "./catalogDrawerSave";
import { resolveImportPlan } from "./catalogImportPlan";
import { appAlert } from "../../../lib/dialog";
import { cleanTags } from "../../../lib/metadataValidation";
import { downloadBeatFiles, saveBlobWithBrowser, type DownloadKind } from "./catalogDownloads";
import type { CatalogBeatFile } from "./catalogCommandsApi";
import { normalizeArtworkFile, replaceBeatArtwork, resolveArtworkFile } from "./catalogArtworkReplace";
import type { ArtworkDropSource } from "../../dragdrop/browserArtwork";
import { setBeatCloudUpdateBusy } from "../../cloud/beatCloudUpdateBusy";
import { appConfirm } from "../../../lib/dialog";
import type { CatalogStoreSnapshot } from "./catalogQueryStore";
import { LEGACY_UNRESOLVABLE_COPY, createHistoryWriter, parseLegacyBgPage, readNavigationState } from "./catalogNavigation";
import { useAppShortcuts } from "../../../app/useAppShortcuts";
import { noticeTone } from "../../../components/FloatingNotice";
import { aggregateUploadPercent, uploadPercent } from "./catalogUploadProgress";

export const SEARCH_DEBOUNCE_MS = 250;
export const KNOWN_BEATS_MAX = 512; // tarjetas conocidas fuera de ventana (Playbar/cola): acotado, nunca la biblioteca entera
export const BULK_TAGS_MODE_NOTICE = "En el catálogo, «añadir» o «quitar» tags en lote aún no está disponible: usa «reemplazar».";
export const IMPORT_NO_FILE_NOTICE = "No se encontró el archivo del beat a importar.";
/** Mensaje al usuario cuando una importación falla: sin transporte configurado se dice claramente, no con texto técnico del servidor. */
/** Mensaje claro de un fallo de importación (cuota del plan, transporte no disponible, tamaño de PROJECT…); el resto conserva su texto. */
export function importFailureMessage(error: unknown): string {
  const e = error as { code?: unknown; detail?: { max?: unknown; used?: unknown; max_bytes?: unknown; name?: unknown }; message?: unknown } | null;
  if (e?.code === "NAME_TAKEN") return `Ya existe un beat llamado «${String(e.detail?.name ?? "")}». Cambia el nombre para continuar.`;
  if (e?.code === "QUOTA_EXCEEDED") return `Tu plan alcanzó el límite de beats${e.detail?.max != null ? ` (${String(e.detail.used ?? "?")} de ${String(e.detail.max)})` : ""}. Revisa Settings → Plan para ampliarlo.`;
  if (e?.code === "TRANSFER_UNAVAILABLE") return "El servicio de almacenamiento de archivos no está disponible en este entorno. El beat no se guardó.";
  if (e?.code === "PROJECT_TOO_LARGE") return "El PROJECT supera el tamaño máximo de tu plan.";
  return String(e?.message ?? error);
}
export function importFailureNotice(name: string, error: unknown): string {
  const e = error as { code?: unknown; detail?: { reason?: unknown }; message?: unknown } | null;
  if (e && e.code === "TRANSFER_UNAVAILABLE") return `No se pudo importar «${name}»: el servicio de almacenamiento de archivos no está disponible en este entorno. El beat no se guardó.`;
  return `No se pudo importar «${name}»: ${String(e?.message ?? error)}`;
}

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
    return beatFromCatalogDetail(dto, url || null, url === "");
  }, [artworkUrls, remember]);
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
  const filtersKey = `${snapshot.filters.q}|${[...snapshot.filters.includeTags].join(",")}|${[...snapshot.filters.excludeTags].join(",")}|${snapshot.filters.state}`;
  // Arranque por URL (plan B §5.2, r4 §2 B-legacy): `bgPage` legacy → resolver del servidor (ancla + copy B-legacy); `bgAnchor` → reapertura por
  // cursor; filtros/orden de la URL → query inicial. Sin parámetros → primer bloque. El historial se escribe acotado (replace con debounce).
  const history = useMemo(() => createHistoryWriter(), []);
  const navInit = useRef(false);
  useEffect(() => {
    if (navInit.current) return; navInit.current = true;
    // Bloque sembrado desde la copia local (misma consulta que la URL): se revalida sin vaciar la Gallery.
    if (store.startedFromSeed()) { void store.revalidate(); return; }
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
    if (!snapshot.revision || snapshot.provisional || !["ready", "empty", "no-results"].includes(snapshot.status)) return;
    let cancelled = false;
    void interactionStore.loadFacets({ scope: "ACTIVE", q: "", revision: snapshot.revision, limit: 240 }).then((page) => {
      if (cancelled) return;
      setFacets({ revision: snapshot.revision!, tags: page.items.map((f) => f.label || f.key), freq: new Map(page.items.map((f) => [f.label || f.key, f.count])) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [snapshot.revision, snapshot.status, snapshot.provisional, interactionStore]);

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

  const [notice, setNotice] = useState<string | null>(null);
  // Los fallos de Siguiente/Anterior se muestran (nunca se tragan): el aviso dice qué pasó y la sesión conserva el target para reintentar.
  const reportPlaybackFailure = useCallback((action: string, e: unknown) => { const code = (e as { code?: unknown })?.code; setNotice(`${action}: ${code ? `${String(code)} — ` : ""}${String((e as { message?: unknown })?.message ?? e)}`); }, []);
  // ---- reproducción: la sesión decide, el motor aprobado suena ----
  const lastEnded = useRef(audio.endedSeq);
  useEffect(() => session.onEvent((e) => {
    const snap = session.getSnapshot();
    if (e.kind === "play" && e.beatId && snap.source) play(e.beatId, [snap.source.url]);
    else if (e.kind === "seek0") seek(0);
    else if (e.kind === "replay") { seek(0); const a = document.querySelector("audio"); if (a && a.paused) togglePause(); }
  }), [session, play, seek, togglePause]);
  useEffect(() => { if (audio.endedSeq !== lastEnded.current) { lastEnded.current = audio.endedSeq; void session.ended().catch((e) => reportPlaybackFailure("No se pudo continuar con el siguiente beat", e)); } }, [audio.endedSeq, session, reportPlaybackFailure]);
  const lastProgress = useRef(0);
  useEffect(() => { if (Math.abs(audio.progress - lastProgress.current) >= 0.01 || audio.progress === 0) { lastProgress.current = audio.progress; session.setProgress(audio.progress); } }, [audio.progress, session]);
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
    if (outcome.status === "error") throw new Error(importFailureMessage(outcome.error));
    if ((outcome as { error?: { code?: string } | null }).error?.code === "NAME_TAKEN") throw new Error(importFailureMessage((outcome as { error?: unknown }).error));
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

  // PROJECT vigente del beat (para fusionar un archivo de DAW con su ZIP, como el flujo anterior).
  const loadProject = useCallback(async (beatId: string): Promise<File | null> => {
    const files = await mutations.listBeatFiles(beatId);
    const p = files.find((f) => f.role === "PROJECT" && f.current); if (!p) return null;
    const { blob } = await media.downloadFile(p.fileId);
    return new File([blob], p.filename || "project.zip", { type: "application/zip" });
  }, [mutations, media]);
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
    try {
      const r = await saveDrawerChanges({ mutations, knownDto: (id) => dtoById.current.get(id), loadProject, dataUrlToFile, errorMessage: importFailureMessage }, input);
      if (r.artworkRemoved) forgetArtworkOf(input.updated.id);
    } catch (e) {
      if ((e as { partial?: boolean }).partial) forgetArtworkOf(input.updated.id);
      if ((e as { pending?: boolean; partial?: boolean }).pending || (e as { partial?: boolean }).partial) refreshAfterMutation();
      throw e;
    }
    refreshAfterMutation();
  }, [mutations, refreshAfterMutation, loadProject, forgetArtworkOf]);

  // ---- reemplazo de audio por arrastre sobre una BeatCard (MP3 → MASTER, WAV → añadir/reemplazar WAV HQ), con confirmación ----
  const replaceAudioByDrop = useCallback(async (beatId: string, file: File) => {
    const r = await replaceBeatAudio({ mutations, confirm: appConfirm, beatId, file, onStart: () => setBeatCloudUpdateBusy(beatId, true), loadProject, onProgress: (t) => setNotice(`Reemplazando audio: ${t}`) });
    if (r.status !== "cancelled" && r.status !== "unsupported") setBeatCloudUpdateBusy(beatId, false, r.status === "committed"); // estado de la tarjeta: ocupada → completada
    if (r.status === "committed") { setNotice(r.kind === "MP3" ? "MP3 reemplazado." : r.kind === "PROJECT" ? (r.replacedExisting ? "Proyecto reemplazado." : "Proyecto añadido.") : r.replacedExisting ? "WAV reemplazado." : "WAV añadido."); refreshAfterMutation(); }
    else if (r.status === "failed") setNotice(`No se pudo reemplazar el audio: ${r.message}`);
    else if (r.status === "unsupported") setNotice("Solo se pueden soltar archivos MP3 o WAV.");
    else setNotice(null);
  }, [mutations, refreshAfterMutation, loadProject]);

  // ---- portada por arrastre de una imagen sobre cualquier zona de una BeatCard (servicio del Drawer: replaceBeat solo con el archivo de portada) ----
  const replaceArtworkByDrop = useCallback(async (beatId: string, sources: ArtworkDropSource[] | Promise<ArtworkDropSource[]>) => {
    setBeatCloudUpdateBusy(beatId, true);
    let ok = false;
    try {
      const file = await resolveArtworkFile(await sources);
      const r = await replaceBeatArtwork({ mutations, beatId, file });
      ok = r.status === "committed";
      if (r.status === "committed") { setNotice("Portada actualizada."); refreshAfterMutation(); } else setNotice(`No se pudo cambiar la portada: ${r.message}`);
    } catch (e) { setNotice(`No se pudo cambiar la portada: ${String((e as { message?: unknown })?.message ?? e)}`); }
    finally { setBeatCloudUpdateBusy(beatId, false, ok); }
  }, [mutations, refreshAfterMutation]);

  // ---- importación (T12) desde «Add beat» del navegador ----
  const [showAdd, setShowAdd] = useState(false);
  // «Add beat» → pantalla de revisión (el Drawer en modo edición con `reviewInfo`, como el flujo anterior): nombre, BPM, key, tags, rating, portada y
  // archivos (MASTER/WAV/PROJECT) se editan ANTES de importar. Cancelar/omitir libera el archivo y no importa ni modifica nada.
  const [review, setReview] = useState<{ beat: Beat; hydrated: Promise<Beat> | null } | null>(null);
  // §6.1-6: una sola revisión visible; las demás (otra importación o un fallo en segundo plano) esperan en cola y se abren al cerrar la actual.
  // Antes un fallo en segundo plano sustituía la revisión abierta: sus ediciones se perdían y su archivo quedaba retenido sin interfaz.
  const reviewQueue = useRef<ReviewEntry[]>([]);
  const showReview = useCallback((entry: ReviewEntry) => {
    setReview((r) => { const q = enqueueReview(r, reviewQueue.current, entry); reviewQueue.current = q.queue; return q.current; });
    // Metadatos ID3 / WAV→MP3 se hidratan en segundo plano (como antes): la revisión se abre al instante y se completa al terminar.
    void entry.hydrated?.then((hb) => {
      const next = { ...hb, tags: cleanTags(hb.tags || []).tags };
      reviewQueue.current = reviewQueue.current.map((x) => (x.beat.id === entry.beat.id ? { beat: next, hydrated: null } : x));
      setReview((r) => (r && r.beat.id === entry.beat.id ? { ...r, beat: next } : r));
    }).catch((error) => {
      if (platform.importer.fileForBeat(entry.beat.id)) void appAlert({ title: "Import failed", message: String(error), danger: true });
    });
  }, []);
  useEffect(() => {
    if (review || !reviewQueue.current.length) return;
    const q = nextReview(reviewQueue.current, (id) => Boolean(platform.importer.fileForBeat(id)));
    reviewQueue.current = q.queue; if (q.next) setReview(q.next);
  }, [review]);
  const addBeatsAndReview = useCallback((beats: Beat[], hydrated?: Array<Promise<Beat>>) => {
    const beat = beats[0]; if (!beat) return;
    if (!platform.importer.fileForBeat(beat.id)) { setNotice(IMPORT_NO_FILE_NOTICE); return; }
    showReview({ beat, hydrated: hydrated?.[0] ?? null });
  }, [showReview]);
  const cancelReview = useCallback(() => { setReview((r) => { if (r) platform.importer.releaseBeat(r.beat.id); return null; }); }, []);
  // «Save and finish» (comportamiento del BeatGaler anterior: «Save/next stays immediate; the extracted cloud queue owns upload work»):
  // la revisión se cierra en cuanto el servidor aceptó la operación (nombre libre, cuota, tamaño) y la subida a Telegram continúa en segundo plano.
  // E79 — una única representación: un beat nuevo NO tiene tarjeta mientras sube (antes aparecía una tarjeta provisional aparte, luego duplicada
  // junto a la real). Su avance se muestra en el aviso flotante y la tarjeta aparece una sola vez, cuando PostgreSQL lo confirma, ya en su
  // posición según el orden y los filtros vigentes. Fallo definitivo → la revisión se reabre con lo editado y el archivo intacto;
  // incierto → aviso persistente y NUNCA reenvío (E5).
  // E80: el avance es el de los BYTES enviados por Direct B (no por archivo terminado); con varias subidas, el total es bytes enviados / bytes
  // totales de todas (una subida grande pesa lo que pesa, no lo mismo que una pequeña). El estado solo cambia cuando cambia el % entero.
  const [uploads, setUploads] = useState<Array<{ id: string; name: string; percent: number; uploadedBytes: number; totalBytes: number }>>([]);
  const uploadNotice = uploads.length === 0 ? null
    : uploads.length === 1 ? `Subiendo «${uploads[0].name}»… ${uploads[0].percent} %`
    : `Subiendo ${uploads.length} beats… ${aggregateUploadPercent(uploads)} %`;
  // E75: mientras haya una revisión abierta o beats subiendo, el lote sigue en curso: el MAIN de prefijos se reconstruye UNA vez al terminar.
  useEffect(() => { services.mainPack?.setBatchOpen(Boolean(review) || uploads.length > 0); }, [services.mainPack, review, uploads.length]);
  const saveReview = useCallback(async (updated: Beat, onProgress?: (p: { stage: "preparing" | "master" | "wav" | "artwork" | "project" | "library"; uploadedBytes: number; totalBytes: number }) => void) => {
    const r = review; if (!r) return;
    const original = platform.importer.fileForBeat(r.beat.id);
    // Espera la conversión WAV→MP3 y la hidratación; `updated` es la versión editada por el usuario (no se re-añaden tags quitados).
    const plan = await resolveImportPlan({ beat: updated, hydrated: r.hydrated ? r.hydrated.then(() => updated) : null, slotFiles: () => platform.importer.slotFilesForBeat(r.beat.id), originalFile: original });
    let begun: () => void = () => {};
    const begunP = new Promise<"started">((res) => { begun = () => res("started"); });
    const uploadId = updated.id; let percent = 0; let bytes = { uploadedBytes: 0, totalBytes: 0 };
    const job = mutations.importBeat({ beat: plan.beat, files: plan.files, onProgress: (p) => {
      onProgress?.(p); if (p.stage === "preparing") { bytes = { uploadedBytes: 0, totalBytes: p.totalBytes }; return; }
      begun();
      bytes = { uploadedBytes: Math.min(p.uploadedBytes, p.totalBytes), totalBytes: p.totalBytes };
      const next = uploadPercent(bytes.uploadedBytes, bytes.totalBytes);
      if (next !== percent) { percent = next; const b = bytes; setUploads((list) => list.map((x) => (x.id === uploadId ? { ...x, percent: next, ...b } : x))); }
    } })
      .then((outcome) => ({ outcome, error: null as unknown }), (error: unknown) => ({ outcome: null, error }));
    const first = await Promise.race([begunP, job.then(() => "settled" as const)]);
    const uncertainNotice = (name: string) => `La subida de «${name}» no se pudo confirmar. No se reenvía ni se borra nada: el servidor lo revisará y el beat aparecerá si Telegram lo recibió.`;
    if (first === "settled") { // rechazado ANTES de subir (nombre repetido, cuota, tamaño…) o terminado sin fase de subida: el error se muestra en la revisión abierta
      const res = await job;
      if (res.error) throw new Error(importFailureMessage(res.error));
      const outcome = res.outcome!;
      if (outcome.status === "uncertain" || outcome.status === "blocked" || outcome.status === "timeout") { // retenida: puede confirmarse más tarde → nunca se reenvía
        platform.importer.releaseBeat(r.beat.id); setReview(null); setNotice(outcome.status === "uncertain" ? uncertainNotice(updated.name) : pendingTransferNotice(updated.name)); refreshAfterMutation();
        return;
      }
      if (outcome.status !== "committed") throw new Error((outcome as { error?: unknown }).error ? importFailureMessage((outcome as { error?: unknown }).error) : `La importación de «${updated.name}» quedó en estado ${outcome.status}; no se guardó el beat.`);
      platform.importer.releaseBeat(r.beat.id); setReview(null);
      setNotice(`«${updated.name}» importado.`); refreshAfterMutation();
      return;
    }
    setUploads((list) => [...list.filter((x) => x.id !== uploadId), { id: uploadId, name: updated.name, percent, ...bytes }]);
    setNotice((n) => (n && noticeTone(n) === "success" ? null : n)); // un «importado» anterior no tapa el avance de esta subida; errores e inciertos sí permanecen
    setReview(null); // cierra la revisión ya: el archivo sigue retenido hasta que termine la subida
    void job.then(({ outcome, error }) => {
      setUploads((list) => list.filter((x) => x.id !== uploadId));
      if (outcome && outcome.status === "committed") {
        platform.importer.releaseBeat(r.beat.id); refreshAfterMutation(); // PostgreSQL ya lo tiene: la Gallery se actualiza en el sitio con la tarjeta real
        setNotice((n) => (n && noticeTone(n) === "error" ? n : `«${updated.name}» importado.`));
        return;
      }
      // §6.1-7: RECONCILE («blocked») y tiempo agotado también pueden confirmarse después: como «uncertain», sin reabrir para reenviar.
      if (outcome && (outcome.status === "uncertain" || outcome.status === "blocked" || outcome.status === "timeout")) { platform.importer.releaseBeat(r.beat.id); setNotice(outcome.status === "uncertain" ? uncertainNotice(updated.name) : pendingTransferNotice(updated.name)); refreshAfterMutation(); return; }
      const reason = error ? importFailureMessage(error) : (outcome as { error?: unknown } | null)?.error ? importFailureMessage((outcome as { error?: unknown }).error) : `quedó en estado ${outcome ? outcome.status : "desconocido"}`;
      setNotice(`No se pudo importar «${updated.name}»: ${reason.replace(/[.s]+$/, "")}. Tus cambios siguen en la revisión.`);
      if (platform.importer.fileForBeat(r.beat.id)) showReview({ beat: updated, hydrated: null }); // reabre con lo editado (o en cola si hay otra revisión abierta)
    });
  }, [review, mutations, refreshAfterMutation, showReview]);

  // §6.1-5: al arrancar se consulta el resultado de las subidas que quedaron a medias (p. ej. al recargar la página). Las confirmadas aparecen
  // en la Gallery; las terminadas sin efecto se informan una vez; las que siguen abiertas se informan sin reenviar nada (los archivos no se
  // conservan tras recargar). Solo lectura: no cancela ni reintenta.
  const pendingChecked = useRef(false);
  useEffect(() => {
    if (pendingChecked.current || snapshot.provisional) return;
    pendingChecked.current = true;
    void mutations.resolvePendingTransfers().then((list) => {
      const r = summarizePendingTransfers(list);
      for (const id of r.forget) mutations.forgetOperation(id);
      if (r.notice) setNotice(r.notice);
      if (r.refresh) refreshAfterMutation();
    }).catch(() => {});
  }, [snapshot.provisional, mutations, refreshAfterMutation]);

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
    void downloadBeatFiles({ files: cloudFiles.files, kind, beatName: cloudFiles.beat.name, download: (id) => media.downloadFile(id), save: saveBlobWithBrowser }).then((r) => {
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
    showAdd, setShowAdd, addBeatsAndReview, review, cancelReview, saveReview, uploads, replaceAudioByDrop, replaceArtworkByDrop, cloudFiles, downloadBusy, downloaded, openDownloads, closeDownloads, downloadKind, showSettings, setShowSettings, handleDisconnectTelegramAccount, reloadLibrary,
    connectionState, cloudSessionVerified, loading, libraryRefreshing: false, rejectOfflineMutation,
    notice: notice ?? uploadNotice ?? interaction.selection.notice ?? playback.error ?? null, dismissNotice,
    accountId, context,
  };
}
export type CatalogGalleryScope = ReturnType<typeof useCatalogGalleryScope>;
export type { React };
