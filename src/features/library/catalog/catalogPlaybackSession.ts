// T14 / V06-B/C/E — Sesión musical por cuenta, independiente del grid (plan B §3; C12-r4 §2 I2 y §5; MATRIZ-V V06 §11).
//  - currentBeat, cola explícita (identidad/versión), repeat y Shuffle viven aquí, nunca en el store de ventana: la evicción de una
//    tarjeta o de un DTO no interrumpe el audio ni pierde IDs de cola. La fuente de audio se arrienda al media manager (refcount `player`).
//  - I2: cola explícita prioritaria en Next/ended; Previous con progress > 0,05 hace seek(0) y no consume cola; filtros/sort/columnas no
//    tocan los bytes actuales; el siguiente comando usa los resultados vigentes (vecino de orden en el conjunto o sorteo de la ronda);
//    currentBeat fuera del query: Next empieza por el primero y Previous por el último; query vacío no interrumpe la canción.
//  - Shuffle sin RNG en el cliente (RV2): los sorteos los hace el servidor (ronda persistida). Comandos con `sequence` CAS e
//    idempotencyKey: el retry tras un fallo de transporte repite el MISMO comando (mismo beat, sin consumir otro); un fallo de medios
//    conserva el target reintentable. Filtros nuevos → ronda nueva; revisión nueva → ronda reconstruida preservando consumidos; sort no
//    cambia la ronda. Play directo/cola consumen el miembro (sin doble descuento). Al completar la ronda: repeat-off detiene el avance por
//    ended; repeat-all abre otra ronda (excluyendo la actual si N > 1); Next manual permite nueva ronda; repeat-one repite tras la cola.
//  - Startup ≤14 referencias (prefetch acotado por el llamador). Teardown explícito en logout/cambio de cuenta.
import { useSyncExternalStore } from "react";
import { CatalogApiError, type CatalogQueryFilters, type CatalogSort } from "./catalogApi";
import type { MediaLease } from "./catalogMediaClient";

export interface PlaybackQuery { filters: CatalogQueryFilters; sort: CatalogSort; revision: string }
export interface PlaybackTarget { beatId: string; version: string | null; fileId: string | null }
export type RepeatMode = "off" | "all" | "one";
export interface RoundState { roundId: string; setId: string; remaining: number; sequence: string; complete: boolean; stale: boolean }
export interface PlaybackSnapshot {
  accountId: string;
  current: PlaybackTarget | null;
  source: { url: string; cacheKey: string } | null;
  queue: PlaybackTarget[];
  repeat: RepeatMode;
  shuffle: boolean;
  round: RoundState | null;
  query: PlaybackQuery | null;
  progress: number;
  status: "idle" | "loading" | "playing" | "paused" | "ended" | "error";
  lastCommand: { kind: string; key: string; retryable: boolean } | null;
  error: string | null;
  startupRefs: number;
}
export interface PlaybackApi {
  startRound(input: { setId: string; currentBeatId: string | null; consumerId: string; fromRoundId?: string | null }): Promise<{ roundId: string; status: string; remaining: number; sequence: string; setId: string }>;
  nextInRound(input: { roundId: string; sequence: string; idempotencyKey: string }): Promise<{ beatId: string | null; version: string | null; remaining: number; sequence: string; roundComplete: boolean; replay?: boolean }>;
  consumeInRound(input: { roundId: string; beatId: string; sequence: string; idempotencyKey: string }): Promise<{ consumed: boolean; remaining: number; sequence: string; roundComplete: boolean }>;
  releaseRound(roundId: string): Promise<unknown>;
  neighbor(input: { setId: string; beatId: string | null; direction: "next" | "previous"; sort: CatalogSort }): Promise<{ beatId: string | null; version: string | null; member: boolean; total: number; edge?: string }>;
}
export interface PlaybackSessionOptions {
  api: PlaybackApi;
  /** Conjunto READY para el query vigente (preparación visible; compartido con la selección). */
  resolveSet: (query: PlaybackQuery) => Promise<{ setId: string; memberCount: number }>;
  /** Referencia de audio de un beat (detalle SQL / DTO residente); null si no hay MASTER. */
  resolveFile: (beatId: string) => Promise<{ fileId: string; version: string } | null>;
  /** Media manager (T14 cliente): arrienda la URL de la fuente para el consumidor `player`. */
  acquireSource: (fileId: string) => Promise<MediaLease>;
  accountId: () => string;
  consumerId?: string;
  idempotencyKey?: () => string;
  startupRefLimit?: number;
}
export const PREVIOUS_SEEK_THRESHOLD = 0.05;
export const STARTUP_REF_LIMIT = 14;
const defaultKey = (): string => (globalThis.crypto && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function createCatalogPlaybackSession(options: PlaybackSessionOptions) {
  const { api } = options;
  const newKey = options.idempotencyKey ?? defaultKey;
  const consumerId = options.consumerId ?? `player-${Math.random().toString(36).slice(2, 10)}`;
  const startupLimit = options.startupRefLimit ?? STARTUP_REF_LIMIT;
  let snapshot: PlaybackSnapshot = { accountId: options.accountId(), current: null, source: null, queue: [], repeat: "off", shuffle: false, round: null, query: null, progress: 0, status: "idle", lastCommand: null, error: null, startupRefs: 0 };
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of listeners) l(); };
  const set = (patch: Partial<PlaybackSnapshot>) => { snapshot = { ...snapshot, ...patch }; emit(); };
  let lease: MediaLease | null = null;
  let generation = 0;
  let pendingNext: { key: string; roundId: string; sequence: string } | null = null; // mismo comando en el retry
  const assertGen = (g: number) => { if (g !== generation) throw Object.assign(new Error("playback session was torn down"), { code: "SESSION_TORN_DOWN" }); };
  const events: Array<(e: { kind: string; beatId: string | null }) => void> = [];

  // ---- fuente de audio: arrendada al media manager; un fallo de medios conserva el target ----
  async function loadSource(target: PlaybackTarget, g: number): Promise<void> {
    set({ status: "loading", error: null });
    try {
      const file = target.fileId ? { fileId: target.fileId, version: target.version ?? "" } : await options.resolveFile(target.beatId);
      assertGen(g);
      if (!file) { set({ status: "error", error: "Este beat no tiene audio disponible." }); return; }
      const next = await options.acquireSource(file.fileId); assertGen(g);
      const prev = lease; lease = next; prev?.release(); // la fuente anterior se libera solo tras tener la nueva (sin huecos ni revocación por evicción)
      set({ current: { ...target, fileId: file.fileId, version: target.version ?? file.version }, source: { url: next.url, cacheKey: next.cacheKey }, status: "playing", progress: 0 });
      for (const fn of events) fn({ kind: "play", beatId: target.beatId });
    } catch (error) {
      if ((error as { code?: string }).code === "SESSION_TORN_DOWN") return;
      // target reintentable: el estado conserva `current` para reintentar la misma fuente
      set({ current: target, status: "error", error: error instanceof CatalogApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error) });
    }
  }
  // ---- ronda Shuffle (servidor) ----
  async function ensureRound(g: number, { excludeCurrent = true } = {}): Promise<RoundState | null> {
    const q = snapshot.query; if (!q) return null;
    const r = snapshot.round;
    if (r && !r.stale) return r; // completa incluida: el servidor responde beatId null y el comando decide si abre otra ronda
    const setInfo = await options.resolveSet(q); assertGen(g);
    if (setInfo.memberCount === 0) { set({ round: null }); return null; }
    const started = await api.startRound({ setId: setInfo.setId, currentBeatId: excludeCurrent ? snapshot.current?.beatId ?? null : null, consumerId, fromRoundId: r && r.stale ? r.roundId : null }); assertGen(g);
    const round: RoundState = { roundId: started.roundId, setId: started.setId ?? setInfo.setId, remaining: started.remaining, sequence: started.sequence, complete: started.remaining === 0, stale: false };
    set({ round });
    return round;
  }
  async function drawFromRound(g: number): Promise<PlaybackTarget | null | "complete"> {
    const round = await ensureRound(g); if (!round) return null;
    const cmd = pendingNext && pendingNext.roundId === round.roundId ? pendingNext : { key: newKey(), roundId: round.roundId, sequence: round.sequence };
    pendingNext = cmd; set({ lastCommand: { kind: "next", key: cmd.key, retryable: true } });
    let r;
    try { r = await api.nextInRound({ roundId: cmd.roundId, sequence: cmd.sequence, idempotencyKey: cmd.key }); } catch (error) {
      if (error instanceof CatalogApiError && ["ROUND_STALE", "ROUND_RELEASED", "ROUND_BUILDING"].includes(error.code)) { set({ round: { ...round, stale: error.code === "ROUND_STALE" } }); pendingNext = null; if (error.code === "ROUND_STALE") return drawFromRound(g); }
      if (error instanceof CatalogApiError && error.code === "SEQUENCE_MISMATCH") { set({ round: { ...round, sequence: String(error.detail.current_sequence ?? round.sequence) } }); pendingNext = null; return drawFromRound(g); }
      throw error; // transporte: el comando pendiente se conserva para repetir el MISMO sorteo
    }
    assertGen(g); pendingNext = null;
    set({ round: { ...round, remaining: r.remaining, sequence: r.sequence, complete: r.roundComplete }, lastCommand: { kind: "next", key: cmd.key, retryable: false } });
    if (r.beatId === null) return "complete";
    return { beatId: r.beatId, version: r.version, fileId: null };
  }
  async function consumeInRound(beatId: string, g: number): Promise<void> {
    const round = snapshot.round; if (!snapshot.shuffle || !round || round.stale || round.complete) return;
    try { const r = await api.consumeInRound({ roundId: round.roundId, beatId, sequence: round.sequence, idempotencyKey: newKey() }); assertGen(g); set({ round: { ...round, remaining: r.remaining, sequence: r.sequence, complete: r.roundComplete } }); } catch (error) {
      if (error instanceof CatalogApiError && error.code === "SEQUENCE_MISMATCH") set({ round: { ...round, sequence: String(error.detail.current_sequence ?? round.sequence) } });
      else if (error instanceof CatalogApiError && error.code === "ROUND_STALE") set({ round: { ...round, stale: true } });
      else if ((error as { code?: string }).code !== "SESSION_TORN_DOWN") throw error;
    }
  }
  // ---- vecino secuencial sobre el conjunto del query vigente ----
  async function neighbor(direction: "next" | "previous", g: number): Promise<PlaybackTarget | null> {
    const q = snapshot.query; if (!q) return null;
    const setInfo = await options.resolveSet(q); assertGen(g);
    if (setInfo.memberCount === 0) return null; // query vacío: no inventa resultados ni interrumpe la canción
    const n = await api.neighbor({ setId: setInfo.setId, beatId: snapshot.current?.beatId ?? null, direction, sort: q.sort }); assertGen(g);
    if (n.beatId === null) {
      if (snapshot.repeat === "all") { const wrap = await api.neighbor({ setId: setInfo.setId, beatId: null, direction, sort: q.sort }); assertGen(g); return wrap.beatId ? { beatId: wrap.beatId, version: wrap.version, fileId: null } : null; }
      return null;
    }
    return { beatId: n.beatId, version: n.version, fileId: null };
  }

  // ---- comandos ----
  async function play(target: PlaybackTarget): Promise<void> {
    const g = generation;
    await loadSource(target, g); if (g !== generation) return;
    await consumeInRound(target.beatId, g); // intención explícita: puede repetir un ID ya escuchado; se retira de los candidatos
  }
  function enqueue(target: PlaybackTarget): void { set({ queue: [...snapshot.queue, target] }); }
  function dequeue(beatId: string): void { set({ queue: snapshot.queue.filter((t) => t.beatId !== beatId) }); }
  async function next({ reason = "manual" }: { reason?: "manual" | "ended" } = {}): Promise<PlaybackTarget | null> {
    const g = generation;
    if (snapshot.queue.length) { const [head, ...rest] = snapshot.queue; set({ queue: rest }); await play(head); return head; }
    if (snapshot.shuffle) {
      let drawn = await drawFromRound(g); if (g !== generation) return null;
      if (drawn === "complete") {
        if (reason === "ended" && snapshot.repeat !== "all") { set({ status: "ended" }); return null; } // repeat-off: la ronda termina
        // repeat-all o Next manual: nueva ronda (excluye la actual si hay más de un miembro)
        set({ round: null });
        drawn = await drawFromRound(g); if (g !== generation) return null;
        if (drawn === "complete" || drawn === null) { set({ status: "ended" }); return null; }
      }
      if (drawn === null) { if (reason === "ended") set({ status: "ended" }); return null; }
      await loadSource(drawn, g); return drawn;
    }
    const n = await neighbor("next", g); if (g !== generation) return null;
    if (!n) { if (reason === "ended") set({ status: "ended" }); return null; }
    await loadSource(n, g); return n;
  }
  async function previous(): Promise<PlaybackTarget | null> {
    const g = generation;
    if (snapshot.current && snapshot.progress > PREVIOUS_SEEK_THRESHOLD) { set({ progress: 0 }); for (const fn of events) fn({ kind: "seek0", beatId: snapshot.current.beatId }); return snapshot.current; } // no consume cola ni ronda
    if (snapshot.shuffle) { const drawn = await drawFromRound(g); if (g !== generation || drawn === null || drawn === "complete") return null; await loadSource(drawn, g); return drawn; }
    const n = await neighbor("previous", g); if (g !== generation || !n) return null;
    await loadSource(n, g); return n;
  }
  async function ended(): Promise<PlaybackTarget | null> {
    if (snapshot.queue.length) return next({ reason: "ended" }); // la cola tiene prioridad incluso sobre repeat-one
    if (snapshot.repeat === "one" && snapshot.current) { set({ progress: 0 }); for (const fn of events) fn({ kind: "replay", beatId: snapshot.current.beatId }); return snapshot.current; } // explícito: no reinicia ronda
    return next({ reason: "ended" });
  }
  function setProgress(p: number): void { set({ progress: Math.max(0, Math.min(1, p)) }); }
  function setRepeat(mode: RepeatMode): void { set({ repeat: mode }); }
  async function setShuffle(on: boolean): Promise<void> {
    if (on === snapshot.shuffle) return;
    set({ shuffle: on });
    if (!on && snapshot.round) { const r = snapshot.round; set({ round: null }); pendingNext = null; await api.releaseRound(r.roundId).catch(() => {}); }
  }
  /** Filtros nuevos → ronda nueva (el audio actual sigue). Sort → misma ronda (Shuffle no depende del orden). Revisión → ronda stale (reconstruida al siguiente sorteo). */
  async function setQuery(query: PlaybackQuery): Promise<void> {
    const prev = snapshot.query;
    const filtersChanged = !prev || JSON.stringify(prev.filters) !== JSON.stringify(query.filters);
    const revisionChanged = prev !== null && prev.revision !== query.revision;
    set({ query });
    if (filtersChanged && snapshot.round) { const r = snapshot.round; set({ round: null }); pendingNext = null; await api.releaseRound(r.roundId).catch(() => {}); }
    else if (revisionChanged && snapshot.round) set({ round: { ...snapshot.round, stale: true } });
  }
  function onAuthoritativeEvent(e: { kind: "REPLACED" | "TRASHED" | "DENIED" | "PURGED"; beatId: string }): void {
    // nunca por evicción: solo eventos del servidor. La cola pierde el beat; el actual se marca para reintento (no se corta el audio en curso).
    set({ queue: snapshot.queue.filter((t) => t.beatId !== e.beatId) });
    if (snapshot.current?.beatId === e.beatId && e.kind !== "REPLACED") set({ error: e.kind === "TRASHED" ? "Este beat se movió a la papelera." : "El acceso a este beat fue denegado." });
  }
  function noteStartupRef(): boolean { if (snapshot.startupRefs >= startupLimit) return false; set({ startupRefs: snapshot.startupRefs + 1 }); return true; }
  async function teardown(): Promise<void> {
    generation++;
    const r = snapshot.round; const l = lease; lease = null; pendingNext = null;
    snapshot = { accountId: options.accountId(), current: null, source: null, queue: [], repeat: "off", shuffle: false, round: null, query: null, progress: 0, status: "idle", lastCommand: null, error: null, startupRefs: 0 };
    emit(); l?.release();
    if (r) await api.releaseRound(r.roundId).catch(() => {});
  }

  return Object.freeze({
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    onEvent(fn: (e: { kind: string; beatId: string | null }) => void) { events.push(fn); return () => { const i = events.indexOf(fn); if (i >= 0) events.splice(i, 1); }; },
    play, enqueue, dequeue, next, previous, ended, setProgress, setRepeat, setShuffle, setQuery, onAuthoritativeEvent, noteStartupRef, teardown, consumerId,
  });
}
export type CatalogPlaybackSession = ReturnType<typeof createCatalogPlaybackSession>;
export function useCatalogPlayback(session: CatalogPlaybackSession): PlaybackSnapshot { return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot); }
