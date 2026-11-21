// E75 — MAIN de prefijos de audio (Documento Maestro §7.3; decisiones del propietario 2026-11-18).
//  - Un único MAIN vigente por biblioteca. Lo CONSTRUYE Y SUBE EL NAVEGADOR por Direct B; el Cloud solo coordina metadatos en PostgreSQL
//    (manifiesto, ticket con la identidad del envío, publicación con compare-and-swap) y jamás ve bytes de audio ni del documento.
//  - Subidas normales: el prefijo se guarda en IndexedDB al preparar el archivo; no se publica nada por beat.
//  - Reconstrucción: cuando PostgreSQL cuenta ≥ umbral (5) MASTER MP3 vigentes que el MAIN no cubre y NO hay un lote de subidas en curso. Una por
//    lote; tras publicar, los cubiertos dejan de estar pendientes (contador a cero). Si falla, el MAIN anterior y los pendientes siguen intactos.
//  - Dispositivo con la caché vacía: una lectura del MAIN restaura los prefijos; lo que el MAIN no cubre se reproduce por streaming normal.
//    MAIN es una optimización: sin él, desactualizado o ilegible, la reproducción no cambia.
//  - Prioridad baja: lecturas secuenciales, cesión al bucle de eventos, cancelable; nunca bloquea Gallery, Playbar ni las subidas.
import { CatalogApiError } from "./catalogApi";
import { DirectSendError } from "./catalogDirectCore";
import type { DirectPort } from "./catalogDirectTypes";
import type { PrefixCache } from "./catalogPrefixCache";
import { Sha256 } from "./catalogTransfer";

export interface MainEntry { fileId: string; fileSha256: string; fileSize: number; prefixSha256: string; offset: number; length: number }
export interface MainPending { fileId: string; fileSha256: string; fileSize: number; prefixLength: number; direct?: { chatId: string; messageId: number; partSize: number } }
export interface MainManifest {
  generationId: string; prefixBytes: number; threshold: number;
  main: { packId: string; version: string; sizeBytes: number; sha256: string; direct?: { chatId: string; messageId: number } } | null;
  /** Prefijos vigentes cubiertos por el MAIN. */ entries: MainEntry[];
  /** MASTER MP3 vigentes que el MAIN no cubre: el contador de cambios (derivado en PostgreSQL). */ pending: MainPending[];
  current: number; pendingCount: number; rebuild: boolean; building: boolean;
}
export interface MainTicket { packId: string; attempt: number; randomId: string; caption: string; chatId: string; botId: string; filename: string; mime: string; size: number; baseVersion: string; expiresInMs: number }
/** Llamadas de METADATOS al Cloud (catalogMediaClient las implementa). */
export interface MainPackApi {
  manifest(signal?: AbortSignal): Promise<MainManifest>;
  begin(body: { packId: string; baseVersion: string; sizeBytes: number; sha256: string; entries: MainEntry[] }, signal?: AbortSignal): Promise<MainTicket>;
  publish(packId: string, receipt: { messageId: number }, signal?: AbortSignal): Promise<{ packId: string; version: string }>;
  cancel(packId: string, code: string | null, signal?: AbortSignal): Promise<unknown>;
}

export const MAIN_PACK_DEFAULTS = Object.freeze({ mergeGapBytes: 64 * 1024, maxSpanBytes: 16 * 1024 * 1024, idleMs: 3000, openDelayMs: 4000 });
const MAGIC = new TextEncoder().encode("BGPACK01");
const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));
const aborted = (signal?: AbortSignal) => signal?.aborted === true;

// ---------- documento BGPACK01: 8 bytes mágicos, u32 BE con la longitud de la cabecera JSON, cabecera y datos ----------
// La cabecera (ids, hashes, offsets) sirve para inspección/recuperación; no autoriza nada: decide el manifiesto de PostgreSQL.
export function encodeMainPack({ packId, generationId, prefixBytes, items }: { packId: string; generationId: string; prefixBytes: number; items: Array<{ fileId: string; fileSha256: string; fileSize: number; prefixSha256: string; bytes: Uint8Array }> }): { parts: Uint8Array[]; size: number; entries: MainEntry[] } {
  let headerLen = 0; let header = new Uint8Array(0); let entries: MainEntry[] = [];
  for (let pass = 0; pass < 4; pass++) { // punto fijo: los offsets absolutos dependen de la longitud de la propia cabecera
    let off = MAGIC.length + 4 + headerLen;
    entries = items.map((i) => { const e = { fileId: i.fileId, fileSha256: i.fileSha256, fileSize: i.fileSize, prefixSha256: i.prefixSha256, offset: off, length: i.bytes.byteLength }; off += i.bytes.byteLength; return e; });
    header = new TextEncoder().encode(JSON.stringify({ format: "beatgaler.prefix-pack", version: 1, packId, kind: "MAIN", generationId, prefixBytes, entries }));
    if (header.byteLength === headerLen) break;
    headerLen = header.byteLength;
  }
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, header.byteLength, false);
  const parts = [MAGIC, len, header, ...items.map((i) => i.bytes)];
  return { parts, size: parts.reduce((n, p) => n + p.byteLength, 0), entries };
}

// ---------- restaurar la caché local desde el MAIN (dispositivo nuevo o con huecos) ----------
export interface RestoreResult { status: "done" | "skipped" | "aborted" | "failed"; reason?: string; wanted: number; stored: number; rejected: number; requests: number; bytes: number; ms: number }
export async function restoreFromMain({ account, manifest, cache, direct, signal, mergeGapBytes = MAIN_PACK_DEFAULTS.mergeGapBytes, maxSpanBytes = MAIN_PACK_DEFAULTS.maxSpanBytes, yieldFn = yieldToLoop }: {
  account: string; manifest: MainManifest; cache: PrefixCache; direct: DirectPort | null; signal?: AbortSignal; mergeGapBytes?: number; maxSpanBytes?: number; yieldFn?: () => Promise<void>;
}): Promise<RestoreResult> {
  const t0 = Date.now(); const out: RestoreResult = { status: "done", wanted: 0, stored: 0, rejected: 0, requests: 0, bytes: 0, ms: 0 };
  const finish = (status: RestoreResult["status"], reason?: string) => ({ ...out, status, reason, ms: Date.now() - t0 });
  try {
    const pack = manifest.main;
    if (!pack?.direct) return finish("skipped", "NO_MAIN");
    const have = await cache.keys(account);
    const need = manifest.entries.filter((e) => !have.has(e.fileSha256)).sort((a, b) => a.offset - b.offset);
    out.wanted = need.length;
    if (!need.length) return finish("done");
    if (!direct || !(await direct.ready(signal))) return finish("skipped", "NO_DIRECT");
    // Solo lo que falta, agrupado en tramos contiguos: un dispositivo vacío hace ~1 lectura; uno con caché, ninguna.
    const runs: Array<{ start: number; end: number; items: MainEntry[] }> = [];
    for (const e of need) {
      const last = runs[runs.length - 1];
      if (last && e.offset - last.end <= mergeGapBytes && e.offset + e.length - last.start <= maxSpanBytes) { last.end = Math.max(last.end, e.offset + e.length); last.items.push(e); } else runs.push({ start: e.offset, end: e.offset + e.length, items: [e] });
    }
    for (const run of runs) {
      if (aborted(signal)) return finish("aborted");
      let body: Uint8Array;
      try {
        const r = await direct.read({ chatId: pack.direct.chatId, messageId: pack.direct.messageId, size: pack.sizeBytes }, { offset: run.start, length: run.end - run.start, signal });
        body = new Uint8Array(await r.blob.arrayBuffer()); out.requests++; out.bytes += body.byteLength;
      } catch { if (aborted(signal)) return finish("aborted"); continue; } // MAIN ilegible: esos beats siguen por streaming normal
      for (const e of run.items) {
        const bytes = body.subarray(e.offset - run.start, e.offset - run.start + e.length);
        const ok = await cache.put({ account, fileSha256: e.fileSha256, fileSize: e.fileSize, bytes, prefixSha256: e.prefixSha256, source: "pack" });
        if (ok) out.stored++; else out.rejected++;
      }
      await yieldFn();
    }
    return finish("done");
  } catch (error) {
    if (aborted(signal)) return finish("aborted");
    return finish("failed", error instanceof Error ? error.message : String(error));
  }
}

// ---------- reconstruir y publicar el MAIN desde este navegador ----------
export interface RebuildResult { status: "published" | "skipped" | "conflict" | "failed" | "uncertain" | "aborted"; reason?: string; version?: string; entries: number; sizeBytes: number; fetched: number; requests: number; ms: number }
const newPackId = () => { const b = new Uint8Array(12); crypto.getRandomValues(b); return `pk-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`; };

export async function rebuildMain({ account, api, cache, direct, signal, manifest: given, packId = newPackId, yieldFn = yieldToLoop }: {
  account: string; api: MainPackApi; cache: PrefixCache; direct: DirectPort | null; signal?: AbortSignal; manifest?: MainManifest; packId?: () => string; yieldFn?: () => Promise<void>;
}): Promise<RebuildResult> {
  const t0 = Date.now(); const out: RebuildResult = { status: "skipped", entries: 0, sizeBytes: 0, fetched: 0, requests: 0, ms: 0 };
  const finish = (status: RebuildResult["status"], reason?: string, extra: Partial<RebuildResult> = {}) => ({ ...out, ...extra, status, reason, ms: Date.now() - t0 });
  let staged: string | null = null;
  try {
    if (!direct || !(await direct.ready(signal))) return finish("skipped", "NO_DIRECT");
    const m = given ?? await api.manifest(signal);
    if (m.building) return finish("skipped", "BUILD_IN_PROGRESS");
    if (!m.entries.length && !m.pending.length) return finish("skipped", "EMPTY");
    // 1) prefijos que ya cubre el MAIN vigente y faltan aquí → del propio MAIN (1 lectura); 2) pendientes que faltan → primeros bytes de su archivo.
    const restored = await restoreFromMain({ account, manifest: m, cache, direct, signal, yieldFn }); out.requests += restored.requests;
    if (restored.status === "aborted") return finish("aborted");
    const have = await cache.keys(account);
    for (const p of m.pending) {
      if (have.has(p.fileSha256) || !p.direct) continue;
      if (aborted(signal)) return finish("aborted");
      try {
        const r = await direct.read({ chatId: p.direct.chatId, messageId: p.direct.messageId, size: p.direct.partSize }, { offset: 0, length: p.prefixLength, signal });
        out.requests++;
        if (await cache.put({ account, fileSha256: p.fileSha256, fileSize: p.fileSize, bytes: new Uint8Array(await r.blob.arrayBuffer()), source: "stream" })) out.fetched++;
      } catch { if (aborted(signal)) return finish("aborted"); } // ese beat queda fuera de este MAIN y sigue pendiente
      await yieldFn();
    }
    // 3) documento: todos los prefijos vigentes disponibles (cubiertos + pendientes), validados por la caché (hash propio de cada prefijo).
    const items: Array<{ fileId: string; fileSha256: string; fileSize: number; prefixSha256: string; bytes: Uint8Array }> = [];
    const wanted: Array<{ fileId: string; fileSha256: string; fileSize: number; length: number }> = [...m.entries.map((e) => ({ fileId: e.fileId, fileSha256: e.fileSha256, fileSize: e.fileSize, length: e.length })), ...m.pending.map((p) => ({ fileId: p.fileId, fileSha256: p.fileSha256, fileSize: p.fileSize, length: p.prefixLength }))];
    for (let i = 0; i < wanted.length; i++) {
      const w = wanted[i]; const e = await cache.get(account, w.fileSha256);
      if (e && e.fileSize === w.fileSize && e.bytes.byteLength === w.length) items.push({ fileId: w.fileId, fileSha256: w.fileSha256, fileSize: w.fileSize, prefixSha256: e.prefixSha256, bytes: e.bytes });
      if (i % 16 === 15) { await yieldFn(); if (aborted(signal)) return finish("aborted"); }
    }
    if (!items.length) return finish("skipped", "NO_PREFIXES");
    const id = packId();
    const doc = encodeMainPack({ packId: id, generationId: m.generationId, prefixBytes: m.prefixBytes, items });
    const hasher = new Sha256();
    for (let i = 0; i < doc.parts.length; i++) { hasher.update(doc.parts[i]); if (i % 8 === 7) { await yieldFn(); if (aborted(signal)) return finish("aborted"); } }
    out.entries = doc.entries.length; out.sizeBytes = doc.size;
    // 4) ticket: el servidor persiste la identidad del envío ANTES del efecto y rechaza una base obsoleta u otra construcción en curso.
    let ticket: MainTicket;
    try { ticket = await api.begin({ packId: id, baseVersion: m.main?.version ?? "0", sizeBytes: doc.size, sha256: hasher.digestHex(), entries: doc.entries }, signal); } catch (error) {
      if (aborted(signal)) return finish("aborted");
      if (error instanceof CatalogApiError && error.status === 409) return finish("conflict", error.code);
      return finish("failed", error instanceof CatalogApiError ? error.code : "BEGIN_FAILED");
    }
    staged = ticket.packId;
    // 5) envío directo navegador → Telegram. Sin efecto demostrado → se libera el ticket; incierto → no se reenvía ni se cancela (caduca solo).
    let sent: { messageId: number };
    try {
      sent = await direct.send({ blob: new Blob(doc.parts as BlobPart[], { type: ticket.mime }), filename: ticket.filename, mime: ticket.mime, caption: ticket.caption, randomId: ticket.randomId, chatId: ticket.chatId, size: doc.size }, { signal });
    } catch (error) {
      const failure = error instanceof DirectSendError ? error.failure : null;
      if (failure?.kind === "UNCERTAIN") return finish("uncertain", failure.code);
      if (failure || (error as { name?: string } | null)?.name === "DirectUnavailableError") { await api.cancel(ticket.packId, failure?.code ?? "NO_SESSION").catch(() => {}); return finish("failed", failure?.code ?? "NO_SESSION"); }
      return finish("uncertain", "SEND_UNKNOWN"); // error desconocido tras iniciar el envío: fail-closed
    }
    // 6) publicación: comprobación en el proveedor + compare-and-swap en PostgreSQL. Un fallo de red se reintenta (idempotente por mensaje).
    for (let attempt = 1; ; attempt++) {
      try { const r = await api.publish(ticket.packId, { messageId: sent.messageId }, signal); return finish("published", undefined, { version: r.version }); } catch (error) {
        if (aborted(signal)) return finish("aborted");
        if (error instanceof CatalogApiError && error.status === 409) return finish("conflict", error.code);
        if (attempt >= 3) return finish("failed", error instanceof CatalogApiError ? error.code : "PUBLISH_FAILED");
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  } catch (error) {
    if (aborted(signal)) return finish("aborted");
    if (staged) return finish("uncertain", "UNEXPECTED");
    return finish("failed", error instanceof Error ? error.message : String(error));
  }
}

// ---------- coordinador: cuándo restaurar y cuándo reconstruir ----------
export interface MainPackCoordinator {
  /** Una transferencia (importación o reemplazo) empieza/termina; `committedMasterMp3` = quedó confirmada en PostgreSQL con un MASTER MP3. */
  transferStarted(): void;
  transferFinished(committedMasterMp3: boolean): void;
  /** La interfaz tiene un lote abierto (revisiones en cola o tarjetas subiendo): no se reconstruye hasta que termine. */
  setBatchOpen(open: boolean): void;
  /** Al abrir la Gallery: restaura desde el MAIN; solo reconstruye si este dispositivo ya tiene todos los pendientes (fue quien los subió). */
  open(): Promise<void>;
  /** Para pruebas y diagnóstico. */
  readonly state: { inflight: number; batchOpen: boolean; dirty: boolean; rebuilding: boolean; rebuilds: number; last: RebuildResult | null; lastRestore: RestoreResult | null };
  teardown(): void;
}
export function createMainPackCoordinator({ account, api, cache, direct, idleMs = MAIN_PACK_DEFAULTS.idleMs, rebuild = rebuildMain, restore = restoreFromMain, knownVersion, rememberVersion }: {
  account: string; api: MainPackApi; cache: PrefixCache; direct: DirectPort; idleMs?: number; rebuild?: typeof rebuildMain; restore?: typeof restoreFromMain;
  /** Versión de MAIN que este navegador ya restauró o publicó (persistida localmente). */ knownVersion?: () => string | null; rememberVersion?: (version: string | null) => void;
}): MainPackCoordinator {
  const abort = new AbortController(); const signal = abort.signal;
  const state: MainPackCoordinator["state"] = { inflight: 0, batchOpen: false, dirty: false, rebuilding: false, rebuilds: 0, last: null, lastRestore: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const quiet = () => state.inflight === 0 && !state.batchOpen && !state.rebuilding;

  async function runRebuild(m: MainManifest): Promise<void> {
    state.rebuilding = true;
    try {
      state.last = await rebuild({ account, api, cache, direct, signal, manifest: m }); state.rebuilds++;
      if (state.last.status === "published") rememberVersion?.(state.last.version ?? null);
    } catch { /* optimización: nunca propaga */ } finally { state.rebuilding = false; schedule(); }
  }
  // Se evalúa solo en reposo: sin transferencias, sin lote abierto y tras `idleMs` de calma (una subida múltiple reconstruye UNA vez al final).
  async function check(): Promise<void> {
    if (signal.aborted || !quiet() || !state.dirty) return;
    state.dirty = false;
    let m: MainManifest;
    try { m = await api.manifest(signal); } catch { return; }
    if (signal.aborted || !quiet() || state.dirty) { state.dirty = true; schedule(); return; } // llegó actividad mientras se consultaba: se reevalúa al final del lote
    if (m.rebuild && !m.building) await runRebuild(m);
  }
  function schedule(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (signal.aborted || !state.dirty || !quiet()) return;
    timer = setTimeout(() => { timer = null; void check(); }, Math.max(0, idleMs));
  }
  return {
    transferStarted() { state.inflight++; schedule(); },
    transferFinished(committedMasterMp3: boolean) { state.inflight = Math.max(0, state.inflight - 1); if (committedMasterMp3) state.dirty = true; schedule(); },
    setBatchOpen(open: boolean) { if (state.batchOpen === open) return; state.batchOpen = open; schedule(); },
    async open() {
      if (signal.aborted) return;
      try {
        const m = await api.manifest(signal);
        // Ya restaurado desde ESTE MAIN: lo que falte fue expulsado o rechazado y volverá a guardarse al reproducirlo; no se repite la descarga.
        if (m.main && knownVersion?.() === m.main.version) state.lastRestore = { status: "skipped", reason: "KNOWN_VERSION", wanted: 0, stored: 0, rejected: 0, requests: 0, bytes: 0, ms: 0 };
        else { state.lastRestore = await restore({ account, manifest: m, cache, direct, signal }); if (m.main && state.lastRestore.status === "done") rememberVersion?.(m.main.version); }
        // Un dispositivo que entra no está obligado a reconstruir: solo lo hace si ya tiene localmente TODOS los pendientes (los subió él).
        if (!m.rebuild || m.building || !quiet() || signal.aborted) return;
        const have = await cache.keys(account);
        if (m.pending.every((p) => have.has(p.fileSha256))) await runRebuild(m);
      } catch { /* sin MAIN o sin red: reproducción normal */ }
    },
    state,
    teardown() { abort.abort(); if (timer) { clearTimeout(timer); timer = null; } },
  };
}
