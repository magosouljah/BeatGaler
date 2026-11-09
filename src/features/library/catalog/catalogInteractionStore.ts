// T13 / V07-A — InteractionStore por cuenta (plan B §3; r4 §4 y §6; MATRIZ-V V07 §11–§12; RV4).
// Selección GLOBAL server-side: el navegador guarda solo token (selectionId), selectionVersion (CAS), count y flags de los DTO residentes;
// nunca un Set creciente de IDs. Select All = conjunto READY del query/revisión + defaultSelected=true; individual = default=false +
// INCLUDE/EXCLUDE_IDS; Shift = INCLUDE_RANGE por extremos beatId (jamás índices de ventana). Cambiar filtros borra la selección con aviso
// condicional; cambiar sort la conserva y reinicia solo el ancla; una revisión externa deja la selección en CONFLICT y deshabilita comandos.
// Editor: un draft con versión de origen; 409 conserva el texto y no reintenta PATCH automáticamente; retry reutiliza la misma operación.
// Bulk desde Drawer: operación durable sobre la selección congelada, reporte por lote (total/confirmados/no ejecutados/conflicto/cancelados);
// COMPLETED solo si todo confirmado; cancel no revierte lo confirmado; resume exige revisión explícita. Drop: identidad (beatId/version)
// capturada al inicio y cancelada si el target se desmonta. Facetas: cache acotada por scope/q/revisión. Rename: preview (ACTIVE/TRASH) →
// confirmación → operación durable → progreso; un resultado parcial nunca se presenta como éxito total. Sin reorden manual Web.
import { useSyncExternalStore } from "react";
import { CatalogApiError, type CatalogApi, type CatalogFacetsPage, type CatalogQueryFilters, type CatalogSort, type CatalogState } from "./catalogApi";
import { type CatalogBulkKind, type CatalogBulkOperation, type CatalogBulkStatus, type CatalogCommandsApi, type CatalogMetadataPatch, type CatalogRenamePreview, type CatalogSelection, normalizeTagKey } from "./catalogCommandsApi";
import { metadataPatch } from "./catalogMutations";

export interface InteractionQuery { filters: CatalogQueryFilters; sort: CatalogSort; revision: string }
export type SelectionStatus = "none" | "preparing" | "active" | "pending" | "conflict" | "frozen";
export interface SelectionState {
  status: SelectionStatus;
  selectionId: string | null;
  selectionVersion: string | null;
  setId: string | null;
  sort: CatalogSort | null;
  defaultSelected: boolean;
  count: number;
  baseRevision: string | null;
  flags: Record<string, boolean>;
  anchor: { beatId: string; ordinal: number | null } | null;
  notice: string | null;
  error: string | null;
}
export interface EditorDraft { name: string; bpm: string; key: string; tags: string[]; rating: number; color: string; color2: string }
export type EditorStatus = "editing" | "saving" | "saved" | "conflict" | "error";
export interface EditorState {
  beatId: string;
  originVersion: string;
  etag: string | null;
  original: EditorDraft;
  draft: EditorDraft;
  dirty: boolean;
  status: EditorStatus;
  conflict: { currentVersion: string | null } | null;
  error: string | null;
  idempotencyKey: string | null;
  savedVersion: string | null;
  returnAnchor: { beatId: string; ordinal: number | null } | null;
  /** Campos editados por el usuario en esta sesión del editor; los demás siguen al origen al recargar. */
  touched: Array<keyof EditorDraft>;
}
export interface BulkReport { total: number; confirmed: number; notExecuted: number; cancelled: number; conflictBatchSeq: string | number | null; completed: boolean }
export interface BulkState { operationId: string; kind: CatalogBulkKind; status: CatalogBulkStatus; report: BulkReport; expectedRevision: string | null; error: string | null }
export type RenameStage = "name" | "preview" | "running" | "done" | "partial" | "error";
export interface RenameState { from: string; to: string; stage: RenameStage; preview: CatalogRenamePreview | null; operation: BulkState | null; error: string | null }
export interface DropCapture { token: string; beatId: string; version: string; startedAt: number }
export interface InteractionSnapshot { selection: SelectionState; editor: EditorState | null; bulk: BulkState | null; rename: RenameState | null; drops: number; facetsCacheSize: number; accountId: string }

export interface InteractionStoreOptions {
  commands: CatalogCommandsApi;
  api: Pick<CatalogApi, "facets">;
  accountId: () => string;
  consumerId?: string;
  idempotencyKey?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollMs?: number;
  setReadyTimeoutMs?: number;
  facetsCacheMax?: number;
}

export const SELECTION_CLEARED_NOTICE = "Selección borrada al cambiar los filtros";
const TERMINAL: ReadonlySet<CatalogBulkStatus> = new Set(["COMPLETED", "PARTIAL", "CONFLICT", "CANCELLED", "FAILED"]);
const defaultKey = (): string => (globalThis.crypto && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const emptySelection = (): SelectionState => ({ status: "none", selectionId: null, selectionVersion: null, setId: null, sort: null, defaultSelected: false, count: 0, baseRevision: null, flags: {}, anchor: null, notice: null, error: null });
const reportOf = (op: CatalogBulkOperation): BulkReport => ({ total: op.progress.total, confirmed: op.progress.confirmed, notExecuted: op.progress.notExecuted, cancelled: op.progress.cancelled, conflictBatchSeq: op.progress.conflictBatchSeq, completed: op.status === "COMPLETED" && op.progress.confirmed === op.progress.total });
const bulkOf = (op: CatalogBulkOperation, error: string | null = null): BulkState => ({ operationId: op.operationId, kind: op.kind, status: op.status, report: reportOf(op), expectedRevision: op.expectedRevision, error });
const messageOf = (error: unknown): string => (error instanceof CatalogApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));

export function createCatalogInteractionStore(options: InteractionStoreOptions) {
  const { commands, api } = options;
  const newKey = options.idempotencyKey ?? defaultKey;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxPollMs = options.maxPollMs ?? 10 * 60_000;
  const setReadyTimeoutMs = options.setReadyTimeoutMs ?? 60_000;
  const facetsCacheMax = options.facetsCacheMax ?? 8;
  const consumerId = options.consumerId ?? `web-${Math.random().toString(36).slice(2, 10)}`;

  let snapshot: InteractionSnapshot = { selection: emptySelection(), editor: null, bulk: null, rename: null, drops: 0, facetsCacheSize: 0, accountId: options.accountId() };
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of listeners) l(); };
  const set = (patch: Partial<InteractionSnapshot>) => { snapshot = { ...snapshot, ...patch }; emit(); };
  const setSelection = (patch: Partial<SelectionState>) => set({ selection: { ...snapshot.selection, ...patch } });
  let generation = 0; // invalida respuestas tardías tras teardown/limpieza
  const drops = new Map<string, DropCapture & { cancelled: boolean }>();
  const facets = new Map<string, { page: CatalogFacetsPage; at: number }>();
  let currentQuery: InteractionQuery | null = null;

  const assertAccount = (gen: number) => { if (gen !== generation || snapshot.accountId !== options.accountId()) throw Object.assign(new Error("interaction store was torn down"), { code: "STORE_TORN_DOWN" }); };
  const requireCommandsEnabled = () => {
    const s = snapshot.selection;
    if (s.status === "conflict") throw new CatalogApiError(409, "SELECTION_CONFLICT", "La biblioteca cambió: revisa la selección antes de ejecutar un comando.", { base_revision: s.baseRevision });
    if (s.status !== "active" || !s.selectionId || !s.selectionVersion) throw new CatalogApiError(409, "SELECTION_INVALID", "No hay una selección confirmada.", { status: s.status });
    return { selectionId: s.selectionId, selectionVersion: s.selectionVersion };
  };

  // ---- conjuntos READY (preparación visible; una por cuenta) ----
  async function ensureReadySet(query: InteractionQuery, gen: number): Promise<{ setId: string; memberCount: number }> {
    const created = await commands.createQuerySet({ state: query.filters.state, q: query.filters.q, includeTags: [...query.filters.includeTags], excludeTags: [...query.filters.excludeTags], includeMode: query.filters.includeMode, sort: query.sort }, { id: consumerId, kind: "SELECTION" });
    assertAccount(gen);
    let setState = created; const started = now();
    while (setState.status === "BUILDING") {
      if (now() - started > setReadyTimeoutMs) throw new CatalogApiError(503, "QUERY_SET_BUILDING_BUSY", "La preparación de la selección tarda demasiado; inténtalo de nuevo.", { setId: setState.setId });
      await sleep(pollIntervalMs); assertAccount(gen);
      setState = await commands.getQuerySet(setState.setId); assertAccount(gen);
    }
    if (setState.status !== "READY") throw new CatalogApiError(409, "CURSOR_STALE", `El conjunto de la selección quedó ${setState.status}; repite la selección.`, { status: setState.status, setId: setState.setId });
    return { setId: setState.setId, memberCount: setState.memberCount };
  }
  function adoptSelection(sel: CatalogSelection, extra: Partial<SelectionState> = {}) {
    setSelection({ status: sel.status === "CONFLICT" ? "conflict" : sel.status === "FROZEN" ? "frozen" : "active", selectionId: sel.selectionId, selectionVersion: sel.selectionVersion, setId: sel.setId, sort: sel.sort, defaultSelected: sel.defaultSelected, count: sel.count, baseRevision: sel.baseRevision, error: null, ...(sel.flags ? { flags: { ...snapshot.selection.flags, ...sel.flags } } : {}), ...extra });
  }
  async function applyOp(op: Parameters<CatalogCommandsApi["applySelectionOp"]>[1]["op"], gen: number) {
    const { selectionId, selectionVersion } = requireCommandsEnabled();
    setSelection({ status: "pending" });
    try {
      const sel = await commands.applySelectionOp(selectionId, { selectionVersion, op, idempotencyKey: newKey() });
      assertAccount(gen); adoptSelection(sel);
    } catch (error) {
      if ((error as { code?: string }).code === "STORE_TORN_DOWN") return;
      if (error instanceof CatalogApiError && error.code === "SELECTION_CONFLICT") { setSelection({ status: "conflict", error: error.message }); return; }
      setSelection({ status: "active", error: messageOf(error) });
      throw error;
    }
  }

  async function selectAll(query: InteractionQuery): Promise<void> {
    const gen = generation; currentQuery = query;
    if (snapshot.selection.selectionId) await releaseQuietly(snapshot.selection.selectionId);
    setSelection({ ...emptySelection(), status: "preparing", notice: null });
    try {
      const { setId } = await ensureReadySet(query, gen);
      const sel = await commands.createSelection({ setId, sort: query.sort, defaultSelected: true, consumerId }); assertAccount(gen);
      adoptSelection(sel, { anchor: null });
    } catch (error) {
      if ((error as { code?: string }).code === "STORE_TORN_DOWN") return;
      setSelection({ ...emptySelection(), error: messageOf(error) }); throw error;
    }
  }
  async function toggle(beatId: string, { shiftKey = false, ordinal = null, query }: { shiftKey?: boolean; ordinal?: number | null; query: InteractionQuery }): Promise<void> {
    const gen = generation; currentQuery = query;
    const s = snapshot.selection;
    if (s.status === "none" || !s.selectionId) {
      setSelection({ status: "preparing", notice: null });
      try {
        const { setId } = await ensureReadySet(query, gen);
        const sel = await commands.createSelection({ setId, sort: query.sort, defaultSelected: false, consumerId }); assertAccount(gen);
        adoptSelection(sel, { anchor: null });
      } catch (error) { if ((error as { code?: string }).code === "STORE_TORN_DOWN") return; setSelection({ ...emptySelection(), error: messageOf(error) }); throw error; }
    }
    const anchor = snapshot.selection.anchor;
    if (shiftKey && anchor && anchor.beatId !== beatId) {
      await applyOp({ kind: "INCLUDE_RANGE", fromBeatId: anchor.beatId, toBeatId: beatId }, gen);
      return; // el ancla permanece fija hasta un clic sin Shift (semántica Windows conservada)
    }
    const selected = snapshot.selection.flags[beatId] ?? snapshot.selection.defaultSelected;
    await applyOp(selected ? { kind: "EXCLUDE_IDS", beatIds: [beatId] } : { kind: "INCLUDE_IDS", beatIds: [beatId] }, gen);
    if (snapshot.selection.status !== "conflict") setSelection({ anchor: { beatId, ordinal }, flags: { ...snapshot.selection.flags, [beatId]: !selected } });
  }
  async function releaseQuietly(selectionId: string) { try { await commands.releaseSelection(selectionId); } catch { /* ya liberada / congelada */ } }
  async function clearSelection(): Promise<void> {
    const s = snapshot.selection;
    setSelection({ ...emptySelection() }); // count 0 inmediato, sin enumerar IDs
    if (s.selectionId && s.status !== "frozen") await releaseQuietly(s.selectionId);
  }
  /** Cambiar búsqueda/include/exclude borra la selección; aviso solo si había count > 0. */
  async function onFiltersChanged(query: InteractionQuery): Promise<void> {
    currentQuery = query;
    const had = snapshot.selection.count > 0 && snapshot.selection.status !== "none";
    const prev = snapshot.selection.selectionId;
    generation++; // cancela preparaciones en vuelo
    setSelection({ ...emptySelection(), notice: had ? SELECTION_CLEARED_NOTICE : null });
    if (prev) await releaseQuietly(prev);
  }
  /** Cambiar sort conserva la membresía y reinicia solo el ancla Shift. */
  function onSortChanged(sort: CatalogSort): void { if (currentQuery) currentQuery = { ...currentQuery, sort }; setSelection({ anchor: null, sort }); }
  /** Revisión externa: la selección queda en conflicto visible; comandos deshabilitados hasta revisar/reseleccionar. */
  function onRevisionChanged(revision: string): void {
    if (currentQuery) currentQuery = { ...currentQuery, revision };
    const s = snapshot.selection;
    if (s.status === "active" && s.baseRevision !== null && s.baseRevision !== revision) setSelection({ status: "conflict", error: "La biblioteca cambió en otro dispositivo; revisa la selección." });
  }
  function dismissNotice(): void { setSelection({ notice: null }); }
  /** Flags para los DTO residentes (RV4): el store de ventana solo transporta `selected` de solo lectura; aquí viven token/count. */
  async function refreshFlags(residentIds: string[]): Promise<void> {
    const gen = generation; const s = snapshot.selection;
    if (!s.selectionId || s.status === "none" || s.status === "preparing") return;
    const sel = await commands.getSelection(s.selectionId, residentIds.slice(0, 240)); assertAccount(gen);
    const flags: Record<string, boolean> = {};
    for (const id of residentIds) flags[id] = sel.flags?.[id] ?? sel.defaultSelected; // acotado a residentes: un seleccionado evictado sigue seleccionado en el servidor
    setSelection({ flags, count: sel.count, status: sel.stale || sel.status === "CONFLICT" ? "conflict" : s.status === "frozen" ? "frozen" : "active", selectionVersion: sel.selectionVersion });
  }
  const isSelected = (beatId: string): boolean => (snapshot.selection.status === "none" ? false : snapshot.selection.flags[beatId] ?? snapshot.selection.defaultSelected);

  // ---- editor (un draft dirty con versión de origen; 409 conserva el texto) ----
  function openEditor(beat: { id: string; version: string; etag?: string | null } & EditorDraft, returnAnchor: { beatId: string; ordinal: number | null } | null = null): void {
    const original: EditorDraft = { name: beat.name, bpm: beat.bpm, key: beat.key, tags: [...beat.tags], rating: beat.rating, color: beat.color, color2: beat.color2 };
    set({ editor: { beatId: beat.id, originVersion: beat.version, etag: beat.etag ?? null, original, draft: { ...original, tags: [...original.tags] }, dirty: false, status: "editing", conflict: null, error: null, idempotencyKey: null, savedVersion: null, returnAnchor, touched: [] } });
  }
  function setDraft(patch: Partial<EditorDraft>): void {
    const e = snapshot.editor; if (!e) return;
    const draft = { ...e.draft, ...patch };
    const touched = [...new Set([...e.touched, ...(Object.keys(patch) as Array<keyof EditorDraft>)])];
    set({ editor: { ...e, draft, touched, dirty: Object.keys(metadataPatch(e.original, draft)).length > 0, status: e.status === "saved" ? "editing" : e.status } });
  }
  async function saveEditor({ retry = false }: { retry?: boolean } = {}): Promise<EditorState | null> {
    const e = snapshot.editor; if (!e) return null;
    const patch: CatalogMetadataPatch = metadataPatch(e.original, e.draft);
    if (Object.keys(patch).length === 0) { set({ editor: { ...e, status: "saved", dirty: false } }); return snapshot.editor; }
    const key = retry && e.idempotencyKey ? e.idempotencyKey : newKey(); // retry = misma operación (misma clave y versión de origen)
    set({ editor: { ...e, status: "saving", idempotencyKey: key, error: null } });
    try {
      const r = await commands.patchBeat(e.beatId, { expectedVersion: e.originVersion, patch, idempotencyKey: key, ifMatch: e.etag });
      const version = r.beat?.version ?? null;
      set({ editor: { ...snapshot.editor!, status: "saved", dirty: false, conflict: null, savedVersion: version, originVersion: version ?? e.originVersion, original: { ...e.draft, tags: [...e.draft.tags] }, etag: version ? `W/"${e.beatId.length}-${version}"` : e.etag } });
    } catch (error) {
      if (error instanceof CatalogApiError && error.code === "VERSION_CONFLICT") {
        set({ editor: { ...snapshot.editor!, status: "conflict", conflict: { currentVersion: typeof error.detail.current_version === "string" ? error.detail.current_version : null }, error: "Este beat cambió en otro dispositivo. Tus cambios siguen aquí: revisa y vuelve a guardar." } });
      } else set({ editor: { ...snapshot.editor!, status: "error", error: messageOf(error) } });
    }
    return snapshot.editor;
  }
  /** Tras un conflicto, el usuario decide: recargar la versión actual (el draft se conserva) y guardar explícitamente. */
  async function reloadEditorOrigin(): Promise<void> {
    const e = snapshot.editor; if (!e) return;
    const current = await commands.getBeat(e.beatId);
    const original: EditorDraft = { name: current.name, bpm: current.bpm, key: current.key, tags: [...current.tags], rating: current.rating, color: current.color ?? "", color2: current.color2 ?? "" };
    // Solo los campos tocados conservan el texto del usuario; el resto adopta el origen fresco (nunca se "re-escribe" lo que otro cambió).
    const prev = snapshot.editor!;
    const draft: EditorDraft = { ...original, tags: [...original.tags] };
    for (const k of prev.touched) (draft as unknown as Record<string, unknown>)[k] = k === "tags" ? [...prev.draft.tags] : prev.draft[k];
    set({ editor: { ...prev, originVersion: current.version, etag: current.etag, original, draft, dirty: Object.keys(metadataPatch(original, draft)).length > 0, status: "editing", conflict: null, error: null, idempotencyKey: null } });
  }
  function closeEditor(): { returnAnchor: EditorState["returnAnchor"] } { const e = snapshot.editor; set({ editor: null }); return { returnAnchor: e?.returnAnchor ?? null }; }

  // ---- bulk desde Drawer (operación durable sobre la selección congelada) ----
  async function pollBulk(operationId: string, gen: number): Promise<BulkState> {
    const started = now();
    for (;;) {
      const op = await commands.getOperation(operationId); assertAccount(gen);
      const state = bulkOf(op);
      set({ bulk: state, rename: snapshot.rename && snapshot.rename.operation?.operationId === operationId ? { ...snapshot.rename, operation: state } : snapshot.rename });
      if (TERMINAL.has(op.status)) return state;
      if (now() - started > maxPollMs) return { ...state, error: "La operación sigue en curso en el servidor; vuelve a consultar más tarde." };
      await sleep(pollIntervalMs); assertAccount(gen);
    }
  }
  async function startBulk(kind: Exclude<CatalogBulkKind, "TAG_RENAME">, patch?: CatalogMetadataPatch): Promise<BulkState> {
    const gen = generation;
    const { selectionId, selectionVersion } = requireCommandsEnabled();
    if (kind === "BULK_PATCH" && (!patch || Object.keys(patch).length === 0)) throw new CatalogApiError(400, "INPUT_INVALID", "No hay cambios que aplicar.", { reason: "EMPTY_PATCH" });
    const op = await commands.createBulkOperation({ kind, selectionId, selectionVersion, patch, idempotencyKey: newKey() }); assertAccount(gen);
    setSelection({ status: "frozen" });
    set({ bulk: bulkOf(op) });
    const final = await pollBulk(op.operationId, gen);
    // la selección fue consumida por la operación: el servidor la dejó FROZEN; la UI vuelve a «sin selección» tras el reporte
    setSelection({ ...emptySelection() });
    return final;
  }
  async function cancelBulk(): Promise<BulkState | null> { const b = snapshot.bulk; if (!b) return null; const gen = generation; await commands.cancelOperation(b.operationId); assertAccount(gen); return pollBulk(b.operationId, gen); }
  async function resumeBulk(revision: string): Promise<BulkState | null> { const b = snapshot.bulk; if (!b) return null; const gen = generation; const op = await commands.resumeOperation(b.operationId, revision); assertAccount(gen); set({ bulk: bulkOf(op) }); return pollBulk(b.operationId, gen); }
  function dismissBulk(): void { set({ bulk: null }); }

  // ---- drop por identidad estable ----
  function beginDrop(beatId: string, version: string): DropCapture {
    const capture = { token: newKey(), beatId, version, startedAt: now(), cancelled: false };
    drops.set(capture.token, capture); set({ drops: drops.size });
    return { token: capture.token, beatId, version, startedAt: capture.startedAt };
  }
  function cancelDrop(token: string): void { const d = drops.get(token); if (d) d.cancelled = true; drops.delete(token); set({ drops: drops.size }); }
  /** Devuelve la identidad capturada al inicio o null si el target se desmontó / la captura se canceló. */
  function completeDrop(token: string, { targetMounted }: { targetMounted: () => boolean }): { beatId: string; version: string } | null {
    const d = drops.get(token); drops.delete(token); set({ drops: drops.size });
    if (!d || d.cancelled || !targetMounted()) return null;
    return { beatId: d.beatId, version: d.version };
  }

  // ---- facetas globales (T06) con cache acotado por scope/q/revisión ----
  async function loadFacets({ scope = "ACTIVE", q = "", revision, limit }: { scope?: CatalogState; q?: string; revision: string; limit?: number }): Promise<CatalogFacetsPage> {
    const key = `${scope}|${q.trim().toLowerCase()}|${revision}|${limit ?? ""}`;
    const hit = facets.get(key);
    if (hit) { facets.delete(key); facets.set(key, hit); return hit.page; }
    const gen = generation;
    const page = await api.facets({ scope, q: q || undefined, limit }); assertAccount(gen);
    facets.set(key, { page, at: now() });
    while (facets.size > facetsCacheMax) facets.delete(facets.keys().next().value as string);
    set({ facetsCacheSize: facets.size });
    return page;
  }
  function invalidateFacets(): void { facets.clear(); set({ facetsCacheSize: 0 }); }

  // ---- rename global (ACTIVE + TRASH): preview → confirmación → operación durable → progreso ----
  function openRename(from: string): void { const key = normalizeTagKey(from); set({ rename: { from: key, to: key, stage: "name", preview: null, operation: null, error: null } }); }
  function setRenameTarget(to: string): void { const r = snapshot.rename; if (r && r.stage === "name") set({ rename: { ...r, to } }); }
  async function previewRename(): Promise<CatalogRenamePreview | null> {
    const r = snapshot.rename; if (!r) return null; const gen = generation;
    const to = normalizeTagKey(r.to);
    if (!to || to === r.from) { set({ rename: { ...r, error: "Escribe un nombre distinto." } }); return null; }
    try { const preview = await commands.renamePreview(r.from, to); assertAccount(gen); set({ rename: { ...snapshot.rename!, to, stage: "preview", preview, error: null } }); return preview; } catch (error) { if ((error as { code?: string }).code === "STORE_TORN_DOWN") return null; set({ rename: { ...snapshot.rename!, error: messageOf(error) } }); return null; }
  }
  async function confirmRename(): Promise<BulkState | null> {
    const r = snapshot.rename; if (!r || r.stage !== "preview" || !r.preview) return null; const gen = generation;
    try {
      const op = await commands.renameTag(r.from, r.to, newKey()); assertAccount(gen);
      set({ rename: { ...snapshot.rename!, stage: "running", operation: bulkOf(op) } });
      const final = await pollBulk(op.operationId, gen);
      set({ rename: { ...snapshot.rename!, operation: final, stage: final.report.completed ? "done" : final.status === "FAILED" ? "error" : "partial", error: final.report.completed ? null : `Renombrado ${final.status === "CONFLICT" ? "detenido por un cambio externo" : final.status.toLowerCase()}: ${final.report.confirmed}/${final.report.total} confirmados.` } });
      invalidateFacets();
      return final;
    } catch (error) { if ((error as { code?: string }).code === "STORE_TORN_DOWN") return null; set({ rename: { ...snapshot.rename!, stage: "error", error: messageOf(error) } }); return null; }
  }
  function backRename(): void { const r = snapshot.rename; if (r && r.stage === "preview") set({ rename: { ...r, stage: "name", preview: null } }); }
  function closeRename(): void { set({ rename: null }); }

  // ---- ciclo de vida por cuenta ----
  async function teardown(): Promise<void> {
    generation++;
    const sel = snapshot.selection.selectionId;
    drops.clear(); facets.clear();
    snapshot = { selection: emptySelection(), editor: null, bulk: null, rename: null, drops: 0, facetsCacheSize: 0, accountId: options.accountId() };
    emit();
    if (sel) await releaseQuietly(sel);
  }

  return Object.freeze({
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    selectAll, toggle, clearSelection, onFiltersChanged, onSortChanged, onRevisionChanged, dismissNotice, refreshFlags, isSelected,
    openEditor, setDraft, saveEditor, reloadEditorOrigin, closeEditor,
    startBulk, cancelBulk, resumeBulk, dismissBulk,
    beginDrop, cancelDrop, completeDrop,
    loadFacets, invalidateFacets,
    openRename, setRenameTarget, previewRename, confirmRename, backRename, closeRename,
    teardown, consumerId,
  });
}
export type CatalogInteractionStore = ReturnType<typeof createCatalogInteractionStore>;
export function useCatalogInteraction(store: CatalogInteractionStore): InteractionSnapshot { return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot); }
