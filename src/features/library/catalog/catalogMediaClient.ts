// T14 — Cliente de medios por referencia SQL (NATIVO r2.1 §8.6; TAREAS §T14.1–3; MATRIZ-V V06-B/D).
//  - `access(fileId)`: POST /files/:id/access → concesiones opacas por parte (nunca chat/message/token de bot). Caché de concesiones por
//    `cacheKey = (user, epoch, beat, fileId, revision)`: se invalida por versión/época, no solo por id de beat.
//  - Media manager con refcount por consumidor (grid/player/editor): la URL de objeto solo se revoca cuando el refcount llega a 0; la
//    evicción de una tarjeta o de un DTO NUNCA revoca (el dueño del recurso es el consumidor, no la ventana).
//  - Descargas: todas las partes en orden, tamaño total y hash verificados cuando existen (sin comportamiento de "primera parte").
//  - Artwork perezoso: ≤4 descargas concurrentes, LRU por bytes (objetivo 32 MiB), nunca bloquea la Gallery. E79: la portada vigente se busca
//    primero en memoria y en la caché persistente (IndexedDB) por (cuenta, época, archivo, revisión) — sin petición al Cloud ni a Telegram —.
//  - Eventos autoritativos (reemplazo/trash/denegación) → `invalidate(beatId)`; cambio de cuenta/logout → `teardown()` libera todo.
import { CatalogApiError } from "./catalogApi";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../../components/AccountGate";
import { sha256Hex } from "./catalogTransfer";
import { DIRECT_UNAVAILABLE_MESSAGE, DIRECT_WAIT, type DirectPort } from "./catalogDirectTypes";
import type { PrefixCache } from "./catalogPrefixCache";
import type { ArtworkCache } from "./catalogArtworkCache";
import type { MainManifest, MainPackApi, MainTicket } from "./catalogMainPack";
import { createMseSink, feedStream, mseSupportsMp3, type FeedResult, type StreamSink } from "./catalogStreamSource";
import { mp3DeclaredDuration } from "../../audio/mp3PlayablePrefix";

export interface MediaPartGrant { partIndex: number; size: number; sha256: string | null; hashVerified: boolean; verificationLevel: "PROVIDER" | "BYTES" | null; /** El hash de los bytes recibidos de Telegram ya fue atestiguado. */ bytesVerified?: boolean; /** E77: referencia directa (chat y mensaje); el navegador lee los bytes de Telegram, el Cloud no los sirve. */ direct?: { chatId: string; messageId: number } }
export interface MediaAccess { fileId: string; beatId: string; role: string; slotKey: string; revision: string; filename: string | null; mime: string | null; sizeBytes: number; partsTotalBytes: number; sha256: string | null; declaredSha256: string | null; cacheKey: string; epoch: string; parts: MediaPartGrant[]; ttlMs: number }
export interface MediaLease { url: string; cacheKey: string; bytes: number; release(): void }
export interface MediaProgress { loadedBytes: number; totalBytes: number; part: number; parts: number }
export interface MediaClientMetrics { accesses: number; leasesActive: number; urlsAlive: number; urlsRevoked: number; artworkBytes: number; artworkEntries: number; artworkEvictions: number; /** Portadas servidas desde la caché persistente (sin red). */ artworkStored: number; /** Portadas leídas de Telegram. */ artworkDownloads: number; denied: number; hashMismatches: number; directReads: number; directBytes: number; directFailures: number; bytesConfirmed: number; streams: number; prefixHits: number; prefixMisses: number; recentHits: number }

export interface CatalogMediaClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: () => string;
  token?: () => string | null;
  csrf?: () => string | null;
  headers: () => { era: string; epoch: string };
  accountId: () => string;
  timeoutMs?: number;
  artworkBudgetBytes?: number;
  artworkConcurrency?: number;
  grantSkewMs?: number;
  now?: () => number;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** Direct B: lectura navegador ← Telegram. E77: única vía de lectura de bytes; sin él (o sin sesión) las lecturas fallan con DIRECT_UNAVAILABLE. */
  direct?: DirectPort | null;
  /** E71: caché local de prefijos (clave = cuenta + SHA-256 del archivo completo). */
  prefixCache?: PrefixCache | null;
  /** E79: caché persistente de portadas originales. */
  artworkCache?: ArtworkCache | null;
  mseSupported?: () => boolean;
  createSink?: () => StreamSink & { url: string; close(): void };
  /** Audios completos recientes en memoria (Anterior/repetir sin red). */
  recentBudgetBytes?: number;
}
export const MEDIA_DEFAULTS = Object.freeze({ artworkBudgetBytes: 32 * 1024 * 1024, artworkConcurrency: 4, grantSkewMs: 30_000, timeoutMs: 60_000 });

export function createCatalogMediaClient(options: CatalogMediaClientOptions) {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const baseUrl = options.baseUrl ?? (() => getResolvedCloudApiBase());
  const token = options.token ?? (() => getBeatGalerAuthToken());
  const csrf = options.csrf ?? (() => { try { return sessionStorage.getItem("beatgaler:web-csrf:v1"); } catch { return null; } });
  const now = options.now ?? (() => Date.now());
  const budget = options.artworkBudgetBytes ?? MEDIA_DEFAULTS.artworkBudgetBytes;
  const concurrency = options.artworkConcurrency ?? MEDIA_DEFAULTS.artworkConcurrency;
  const skew = options.grantSkewMs ?? MEDIA_DEFAULTS.grantSkewMs;
  const timeoutMs = options.timeoutMs ?? MEDIA_DEFAULTS.timeoutMs;
  const direct = options.direct ?? null;
  const createURL = options.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeURL = options.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));

  const metrics: MediaClientMetrics = { accesses: 0, leasesActive: 0, urlsAlive: 0, urlsRevoked: 0, artworkBytes: 0, artworkEntries: 0, artworkEvictions: 0, artworkStored: 0, artworkDownloads: 0, denied: 0, hashMismatches: 0, directReads: 0, directBytes: 0, directFailures: 0, bytesConfirmed: 0, streams: 0, prefixHits: 0, prefixMisses: 0, recentHits: 0 };
  const prefixCache = options.prefixCache ?? null;
  const recentBudget = options.recentBudgetBytes ?? 48 * 1024 * 1024;
  let account = options.accountId();
  const accessCache = new Map<string, { access: MediaAccess; expiresAt: number }>(); // fileId → concesión vigente
  const objects = new Map<string, { url: string; bytes: number; refs: Map<string, number>; cacheKey: string; beatId: string }>(); // cacheKey → URL de objeto + refcount por consumidor
  const inflight = new Map<string, Promise<Blob>>(); // cacheKey → descarga en curso (compartida)
  const artwork = new Map<string, { url: string; bytes: number; beatId: string }>(); // LRU por clave de portada
  const artworkCache = options.artworkCache ?? null;
  const artworkLoading = new Map<string, Promise<string>>(); // clave de portada → carga en curso (compartida)
  let artworkRunning = 0; const artworkQueue: Array<() => void> = [];

  const assertAccount = () => { if (options.accountId() !== account) throw Object.assign(new Error("media client belongs to another account"), { code: "ACCOUNT_CHANGED" }); };
  // Solo METADATOS (JSON): el Cloud no sirve bytes de archivos.
  async function request<T>(method: "POST" | "GET", path: string, { signal, body }: { signal?: AbortSignal; body?: unknown } = {}): Promise<{ status: number; json: T | null }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const bearer = token(); if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (method === "POST") { const c = csrf(); if (c) headers["X-BeatGaler-CSRF"] = c; const h = options.headers(); headers["X-Catalog-Era"] = h.era; headers["X-Catalog-Epoch"] = h.epoch; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController(); const onAbort = () => controller.abort(); signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try { response = await fetchImpl(`${baseUrl()}${path}`, { method, headers, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal }); } catch (error) { if (signal?.aborted) throw error; throw Object.assign(new Error("Could not reach BeatGaler Cloud."), { name: "CatalogNetworkError", cause: error }); } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const code = typeof payload.code === "string" ? payload.code : response.status === 401 ? "UNAUTHENTICATED" : `HTTP_${response.status}`;
      if (response.status === 403) metrics.denied++;
      throw new CatalogApiError(response.status, code, typeof payload.error === "string" ? payload.error : `Galer Cloud HTTP ${response.status}`, (payload.detail as Record<string, unknown>) ?? {});
    }
    return { status: response.status, json: (await response.json()) as T };
  }

  /** Autorización y referencias de un archivo (una petición por archivo mientras no caduque; invalidada por versión/época en el servidor). */
  async function access(fileId: string, { signal, force = false }: { signal?: AbortSignal; force?: boolean } = {}): Promise<MediaAccess> {
    assertAccount();
    const hit = accessCache.get(fileId);
    if (!force && hit && hit.expiresAt - skew > now()) return hit.access;
    metrics.accesses++;
    const r = await request<MediaAccess>("POST", `/catalog/v1/files/${encodeURIComponent(fileId)}/access`, { signal });
    const a = r.json!;
    accessCache.set(fileId, { access: a, expiresAt: now() + a.ttlMs });
    return a;
  }
  /** `bytes=a-b` → desplazamiento y longitud (un solo rango). */
  function parseByteRange(range: string | null | undefined, size: number): { offset: number; length: number } {
    if (range == null) return { offset: 0, length: size };
    const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
    const start = m ? Number(m[1]) : NaN; const end = m ? (m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)) : NaN;
    if (!Number.isSafeInteger(start) || !(start <= end)) throw new CatalogApiError(416, "RANGE_NOT_SATISFIABLE", "byte range is not supported", { range });
    return { offset: start, length: end - start + 1 };
  }
  const unavailable = (reason: string) => new CatalogApiError(503, "DIRECT_UNAVAILABLE", DIRECT_UNAVAILABLE_MESSAGE, { reason });
  /**
   * E77 — ÚNICA vía de lectura de bytes: navegador ← Telegram (Direct B). Sin sesión directa en el plazo, o si la lectura falla, se devuelve un
   * error claro; el Cloud nunca sirve bytes. El SHA-256 se calcula sobre los bytes recibidos durante esta misma lectura.
   */
  async function readDirect(part: MediaPartGrant, offset: number, length: number, wantHash: boolean, signal?: AbortSignal): Promise<{ blob: Blob; sha256: string | null }> {
    if (!direct) throw unavailable("NO_DIRECT");
    if (!part.direct) throw unavailable("NO_REFERENCE");
    if (!(await direct.ready(signal, { maxWaitMs: DIRECT_WAIT.readMs }))) throw unavailable("SESSION_NOT_READY");
    try {
      const out = await direct.read({ chatId: part.direct.chatId, messageId: part.direct.messageId, size: part.size }, { offset, length, hash: wantHash, signal });
      metrics.directReads++; metrics.directBytes += out.blob.size;
      return out;
    } catch (error) {
      if (signal?.aborted) throw error;
      metrics.directFailures++;
      throw new CatalogApiError(502, "MEDIA_UNAVAILABLE", "No se pudo leer el archivo desde Telegram. Inténtalo de nuevo.", { reason: "DIRECT_READ_FAILED" });
    }
  }
  /** Bytes de una parte (opcionalmente un rango). */
  async function fetchPart(part: MediaPartGrant, { range = null, signal }: { range?: string | null; signal?: AbortSignal } = {}): Promise<Blob> {
    assertAccount();
    const r = parseByteRange(range, part.size);
    return (await readDirect(part, r.offset, r.length, false, signal)).blob;
  }
  /** E70 (D4): atestigua en PostgreSQL que los bytes recibidos de Telegram tienen el hash declarado (no bloquea la descarga). */
  function confirmBytes(fileId: string, part: MediaPartGrant, sha256: string): void {
    if (part.bytesVerified) return;
    void request<unknown>("POST", `/catalog/v1/files/${encodeURIComponent(fileId)}/parts/${part.partIndex}/bytes`, { body: { sha256, size: part.size } })
      .then(() => { metrics.bytesConfirmed++; part.bytesVerified = true; }).catch(() => { /* informativo: no afecta a la descarga */ });
  }
  /** Archivo completo: todas las partes en orden; verifica tamaño total y hash (archivo o por parte) cuando existe. */
  async function downloadFile(fileId: string, { onProgress, signal }: { onProgress?: (p: MediaProgress) => void; signal?: AbortSignal } = {}): Promise<{ blob: Blob; access: MediaAccess; verified: "BYTES" | "SIZE" }> {
    const a = await access(fileId, { signal });
    const parts = [...a.parts].sort((x, y) => x.partIndex - y.partIndex);
    const blobs: Blob[] = []; let loaded = 0; let partHashes = true;
    let hashedOnReceive = false;
    for (const p of parts) {
      // El hash se calcula SOBRE LOS BYTES QUE LLEGAN de Telegram (una sola pasada) y se atestigua en PostgreSQL.
      const d = await readDirect(p, 0, p.size, true, signal);
      const b = d.blob;
      if (b.size !== p.size) throw new CatalogApiError(502, "MEDIA_SIZE_MISMATCH", `part ${p.partIndex} returned ${b.size} bytes, expected ${p.size}`, { partIndex: p.partIndex, expected: p.size, received: b.size });
      if (p.sha256) { const h = d.sha256 ?? await sha256Hex(b); if (d.sha256) { hashedOnReceive = true; if (h === p.sha256) confirmBytes(fileId, p, h); } if (h !== p.sha256) { metrics.hashMismatches++; throw new CatalogApiError(502, "MEDIA_HASH_MISMATCH", `part ${p.partIndex} hash differs`, { partIndex: p.partIndex }); } } else partHashes = false;
      blobs.push(b); loaded += b.size; onProgress?.({ loadedBytes: loaded, totalBytes: a.partsTotalBytes, part: p.partIndex + 1, parts: parts.length });
    }
    const blob = new Blob(blobs, { type: a.mime ?? "application/octet-stream" });
    if (blob.size !== a.partsTotalBytes) throw new CatalogApiError(502, "MEDIA_SIZE_MISMATCH", "assembled size differs from the declared total", { expected: a.partsTotalBytes, received: blob.size });
    let verified: "BYTES" | "SIZE" = partHashes ? "BYTES" : "SIZE";
    // Un archivo de una sola parte con el mismo hash ya verificado durante la recepción no se vuelve a recorrer.
    if (a.sha256 && hashedOnReceive && parts.length === 1 && parts[0].sha256 === a.sha256) verified = "BYTES";
    else if (a.sha256) { const h = await sha256Hex(blob); if (h !== a.sha256) { metrics.hashMismatches++; throw new CatalogApiError(502, "MEDIA_HASH_MISMATCH", "file hash differs from the verified hash", {}); } verified = "BYTES"; }
    return { blob, access: a, verified };
  }

  // ---- media manager: URL de objeto con refcount por consumidor; liberación solo con refcount 0 ----
  async function acquire(fileId: string, consumer: string, { signal }: { signal?: AbortSignal } = {}): Promise<MediaLease> {
    const a = await access(fileId, { signal });
    let entry = objects.get(a.cacheKey);
    if (!entry) {
      let p = inflight.get(a.cacheKey);
      if (!p) { p = downloadFile(fileId, { signal }).then((r) => r.blob); inflight.set(a.cacheKey, p); }
      try {
        const blob = await p; assertAccount();
        entry = objects.get(a.cacheKey) ?? { url: createURL(blob), bytes: blob.size, refs: new Map(), cacheKey: a.cacheKey, beatId: a.beatId };
        if (!objects.has(a.cacheKey)) { objects.set(a.cacheKey, entry); metrics.urlsAlive++; }
      } finally { inflight.delete(a.cacheKey); }
    }
    const e = entry;
    e.refs.set(consumer, (e.refs.get(consumer) ?? 0) + 1); metrics.leasesActive++;
    let released = false;
    return { url: e.url, cacheKey: e.cacheKey, bytes: e.bytes, release() { if (released) return; released = true; metrics.leasesActive--; const n = (e.refs.get(consumer) ?? 1) - 1; if (n <= 0) e.refs.delete(consumer); else e.refs.set(consumer, n); maybeRevoke(e.cacheKey); } };
  }
  // ---- E71: streaming MSE + caché de prefijos ----
  // Rango [offset, offset+length) del archivo, leído de Telegram por Direct B.
  async function readFileRange(a: MediaAccess, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    return new Uint8Array(await (await readDirect(a.parts[0], offset, length, false, signal)).blob.arrayBuffer());
  }
  // Últimos audios completos y verificados de la sesión (Anterior / repetir sin red), acotados por bytes.
  const recent = new Map<string, { blob: Blob; at: number }>(); let recentBytes = 0;
  const rememberRecent = (key: string, blob: Blob) => {
    if (blob.size > recentBudget) return;
    const prev = recent.get(key); if (prev) { recentBytes -= prev.blob.size; recent.delete(key); }
    recent.set(key, { blob, at: now() }); recentBytes += blob.size;
    while (recentBytes > recentBudget && recent.size > 1) { const [k, v] = recent.entries().next().value as [string, { blob: Blob }]; recent.delete(k); recentBytes -= v.blob.size; }
  };
  /**
   * Fuente de audio para la Playbar: si el navegador admite MSE `audio/mpeg` y el archivo es un MP3 de una parte, devuelve una URL inmediata y
   * alimenta el SourceBuffer en segundo plano (prefijo local primero, luego el resto por rangos). Si no, la descarga completa de siempre.
   * La liberación del arriendo cancela la alimentación: una respuesta antigua nunca llega al audio nuevo (cada fuente tiene su propio MediaSource).
   */
  async function acquireStream(fileId: string, consumer: string, { signal }: { signal?: AbortSignal } = {}): Promise<MediaLease & { stream?: Promise<FeedResult> }> {
    const a = await access(fileId, { signal });
    const isMp3 = /^audio\/(mpeg|mp3)$/i.test(a.mime ?? "") || /\.mp3$/i.test(a.filename ?? "");
    const kept = recent.get(a.cacheKey);
    if (kept) { recent.delete(a.cacheKey); recent.set(a.cacheKey, kept); metrics.recentHits++; const url = createURL(kept.blob); let done = false; return { url, cacheKey: a.cacheKey, bytes: kept.blob.size, release() { if (done) return; done = true; revokeURL(url); } }; }
    if (!isMp3 || a.parts.length !== 1 || !(options.mseSupported ?? mseSupportsMp3)()) return acquire(fileId, consumer, { signal });
    const sha = a.declaredSha256 ?? a.sha256 ?? null;
    let prefix: Uint8Array | null = null;
    if (sha && prefixCache) { const hit = await prefixCache.get(account, sha).catch(() => null); if (hit && hit.fileSize === a.sizeBytes) prefix = hit.bytes; }
    const sink = (options.createSink ?? createMseSink)();
    const controller = new AbortController(); const stop = () => controller.abort(); signal?.addEventListener("abort", stop, { once: true });
    const parts: Uint8Array[] = []; const keep = a.sizeBytes <= recentBudget;
    const tracking: StreamSink = { append: async (b) => { if (keep) parts.push(b); await sink.append(b); }, end: () => sink.end(), fail: (e) => sink.fail(e), setDuration: (s) => sink.setDuration?.(s) };
    metrics.streams++; if (prefix) metrics.prefixHits++; else metrics.prefixMisses++;
    const stream = feedStream({
      size: a.sizeBytes, fileSha256: sha, prefix, sink: tracking, signal: controller.signal, read: (off, len, sg) => readFileRange(a, off, len, sg), durationOf: (head) => mp3DeclaredDuration(head),
      onPrefix: (head) => { if (sha && prefixCache) void prefixCache.put({ account, fileSha256: sha, fileSize: a.sizeBytes, bytes: head, source: "stream" }).catch(() => {}); },
      onIntegrity: (ok) => { if (!ok) { metrics.hashMismatches++; if (sha && prefixCache) void prefixCache.drop(account, sha).catch(() => {}); } else if (sha) confirmBytes(fileId, a.parts[0], sha); },
    }).then((r) => { if (keep && r.verified !== false) rememberRecent(a.cacheKey, new Blob(parts as BlobPart[], { type: a.mime ?? "audio/mpeg" })); parts.length = 0; return r; });
    stream.catch(() => { parts.length = 0; });
    let released = false;
    return { url: sink.url, cacheKey: a.cacheKey, bytes: a.sizeBytes, stream, release() { if (released) return; released = true; stop(); signal?.removeEventListener("abort", stop); sink.close(); } };
  }
  // E75 — MAIN de prefijos: llamadas de METADATOS (manifiesto, ticket, publicación, cancelación). Los bytes van navegador ↔ Telegram.
  const mainPack: MainPackApi = {
    manifest: async (signal) => (await request<MainManifest>("GET", "/catalog/v1/prefix-packs/manifest", { signal })).json!,
    begin: async (body, signal) => (await request<MainTicket>("POST", "/catalog/v1/prefix-packs/main", { body, signal })).json!,
    publish: async (packId, receipt, signal) => (await request<{ packId: string; version: string }>("POST", `/catalog/v1/prefix-packs/main/${encodeURIComponent(packId)}/publish`, { body: { receipt }, signal })).json!,
    cancel: async (packId, code, signal) => (await request<unknown>("POST", `/catalog/v1/prefix-packs/main/${encodeURIComponent(packId)}/cancel`, { body: { code }, signal })).json,
  };

  function maybeRevoke(cacheKey: string) {
    const e = objects.get(cacheKey); if (!e) return;
    const total = [...e.refs.values()].reduce((n, v) => n + v, 0);
    if (total > 0) return;
    objects.delete(cacheKey); revokeURL(e.url); metrics.urlsAlive--; metrics.urlsRevoked++;
  }
  const refcount = (cacheKey: string) => { const e = objects.get(cacheKey); return e ? [...e.refs.values()].reduce((n, v) => n + v, 0) : 0; };

  // ---- artwork perezoso: concurrencia 4 y LRU por bytes ----
  const slot = () => new Promise<void>((resolve) => { if (artworkRunning < concurrency) { artworkRunning++; resolve(); } else artworkQueue.push(() => { artworkRunning++; resolve(); }); });
  const freeSlot = () => { artworkRunning--; const next = artworkQueue.shift(); if (next) next(); };
  /**
   * Portada vigente de un beat (la referencia viene del DTO de PostgreSQL). Orden: memoria → caché persistente → Telegram. Las dos primeras no
   * hacen ninguna petición; la lectura de Telegram (verificada) se guarda para la próxima carga de la Gallery. Una portada reemplazada llega con
   * otra referencia (otra clave); una desvinculada no llega: nunca se sirve una versión anterior.
   */
  async function loadArtwork(ref: { fileId: string; revision: string }, beatId: string): Promise<string> {
    assertAccount();
    const key = `${account}|${options.headers().epoch}|${ref.fileId}|${ref.revision}`;
    const hit = artwork.get(key);
    if (hit) { artwork.delete(key); artwork.set(key, hit); return hit.url; }
    let loading = artworkLoading.get(key);
    if (!loading) { loading = fetchArtwork(key, ref, beatId).finally(() => artworkLoading.delete(key)); artworkLoading.set(key, loading); }
    return loading;
  }
  async function fetchArtwork(key: string, ref: { fileId: string; revision: string }, beatId: string): Promise<string> {
    const owner = account;
    let blob = artworkCache ? await artworkCache.get(key).catch(() => null) : null;
    if (blob) metrics.artworkStored++;
    else {
      await slot();
      try {
        if ((await access(ref.fileId)).revision !== ref.revision) await access(ref.fileId, { force: true }); // concesión en memoria de otra revisión: se renueva
        const r = await downloadFile(ref.fileId); blob = r.blob; metrics.artworkDownloads++;
        // Solo se conserva lo que corresponde exactamente a la referencia pedida (misma revisión que confirmó el servidor).
        if (artworkCache && r.access.revision === ref.revision && options.accountId() === owner) void artworkCache.put({ key, account: owner, beatId, blob }).catch(() => false);
      } finally { freeSlot(); }
    }
    assertAccount();
    const url = createURL(blob);
    artwork.set(key, { url, bytes: blob.size, beatId }); metrics.artworkBytes += blob.size;
    while (metrics.artworkBytes > budget && artwork.size > 1) { const [k, v] = artwork.entries().next().value as [string, { url: string; bytes: number; beatId: string }]; artwork.delete(k); revokeURL(v.url); metrics.artworkBytes -= v.bytes; metrics.artworkEvictions++; }
    metrics.artworkEntries = artwork.size;
    return url;
  }

  /** Evento autoritativo (reemplazo, trash, denegación, portada desvinculada): olvida concesiones y artwork del beat — también en disco —; las URLs arrendadas siguen hasta refcount 0. */
  function invalidate(beatId: string): void {
    for (const [k, v] of accessCache) if (v.access.beatId === beatId) accessCache.delete(k);
    for (const [k, v] of artwork) if (v.beatId === beatId) { artwork.delete(k); revokeURL(v.url); metrics.artworkBytes -= v.bytes; }
    metrics.artworkEntries = artwork.size;
    if (artworkCache) void artworkCache.dropBeat(account, beatId).catch(() => {});
  }
  /** Logout / cambio de cuenta: todo se libera; nada de otra cuenta sobrevive. */
  function teardown(): void {
    for (const e of objects.values()) { revokeURL(e.url); metrics.urlsRevoked++; }
    for (const v of artwork.values()) revokeURL(v.url);
    objects.clear(); artwork.clear(); artworkLoading.clear(); accessCache.clear(); inflight.clear(); artworkQueue.length = 0; artworkRunning = 0;
    metrics.urlsAlive = 0; metrics.leasesActive = 0; metrics.artworkBytes = 0; metrics.artworkEntries = 0;
    account = options.accountId();
  }

  return Object.freeze({ access, fetchPart, downloadFile, acquire, acquireStream, mainPack, refcount, loadArtwork, invalidate, teardown, metrics, limits: Object.freeze({ budget, concurrency, skew }) });
}
export type CatalogMediaClient = ReturnType<typeof createCatalogMediaClient>;
