// T14 — Cliente de medios por referencia SQL (NATIVO r2.1 §8.6; TAREAS §T14.1–3; MATRIZ-V V06-B/D).
//  - `access(fileId)`: POST /files/:id/access → concesiones opacas por parte (nunca chat/message/token de bot). Caché de concesiones por
//    `cacheKey = (user, epoch, beat, fileId, revision)`: se invalida por versión/época, no solo por id de beat.
//  - Media manager con refcount por consumidor (grid/player/editor): la URL de objeto solo se revoca cuando el refcount llega a 0; la
//    evicción de una tarjeta o de un DTO NUNCA revoca (el dueño del recurso es el consumidor, no la ventana).
//  - Descargas: todas las partes en orden, tamaño total y hash verificados cuando existen (sin comportamiento de "primera parte").
//  - Artwork perezoso: ≤4 descargas concurrentes, LRU por bytes (objetivo 32 MiB), nunca bloquea la Gallery.
//  - Eventos autoritativos (reemplazo/trash/denegación) → `invalidate(beatId)`; cambio de cuenta/logout → `teardown()` libera todo.
import { CatalogApiError } from "./catalogApi";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../../components/AccountGate";
import { sha256Hex } from "./catalogTransfer";

export interface MediaPartGrant { partIndex: number; size: number; sha256: string | null; hashVerified: boolean; verificationLevel: "PROVIDER" | "BYTES" | null; token: string; url: string; expiresAt: string }
export interface MediaAccess { fileId: string; beatId: string; role: string; slotKey: string; revision: string; filename: string | null; mime: string | null; sizeBytes: number; partsTotalBytes: number; sha256: string | null; declaredSha256: string | null; cacheKey: string; epoch: string; parts: MediaPartGrant[]; ttlMs: number }
export interface MediaLease { url: string; cacheKey: string; bytes: number; release(): void }
export interface MediaProgress { loadedBytes: number; totalBytes: number; part: number; parts: number }
export interface MediaClientMetrics { accesses: number; fetches: number; bytes: number; leasesActive: number; urlsAlive: number; urlsRevoked: number; artworkBytes: number; artworkEntries: number; artworkEvictions: number; denied: number; hashMismatches: number }

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
  const createURL = options.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeURL = options.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));

  const metrics: MediaClientMetrics = { accesses: 0, fetches: 0, bytes: 0, leasesActive: 0, urlsAlive: 0, urlsRevoked: 0, artworkBytes: 0, artworkEntries: 0, artworkEvictions: 0, denied: 0, hashMismatches: 0 };
  let account = options.accountId();
  const accessCache = new Map<string, { access: MediaAccess; expiresAt: number }>(); // fileId → concesión vigente
  const objects = new Map<string, { url: string; bytes: number; refs: Map<string, number>; cacheKey: string; beatId: string }>(); // cacheKey → URL de objeto + refcount por consumidor
  const inflight = new Map<string, Promise<Blob>>(); // cacheKey → descarga en curso (compartida)
  const artwork = new Map<string, { url: string; bytes: number; beatId: string }>(); // LRU por cacheKey
  let artworkRunning = 0; const artworkQueue: Array<() => void> = [];

  const assertAccount = () => { if (options.accountId() !== account) throw Object.assign(new Error("media client belongs to another account"), { code: "ACCOUNT_CHANGED" }); };
  async function request<T>(method: "POST" | "GET", path: string, { signal, raw = false, range = null }: { signal?: AbortSignal; raw?: boolean; range?: string | null } = {}): Promise<{ status: number; json: T | null; blob: Blob | null; headers: Headers }> {
    const headers: Record<string, string> = { Accept: raw ? "*/*" : "application/json" };
    const bearer = token(); if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (method === "POST") { const c = csrf(); if (c) headers["X-BeatGaler-CSRF"] = c; const h = options.headers(); headers["X-Catalog-Era"] = h.era; headers["X-Catalog-Epoch"] = h.epoch; }
    if (range) headers.Range = range;
    const controller = new AbortController(); const onAbort = () => controller.abort(); signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try { response = await fetchImpl(`${baseUrl()}${path}`, { method, headers, credentials: "include", signal: controller.signal }); } catch (error) { if (signal?.aborted) throw error; throw Object.assign(new Error("Could not reach BeatGaler Cloud."), { name: "CatalogNetworkError", cause: error }); } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const code = typeof payload.code === "string" ? payload.code : response.status === 401 ? "UNAUTHENTICATED" : `HTTP_${response.status}`;
      if (response.status === 403) metrics.denied++;
      throw new CatalogApiError(response.status, code, typeof payload.error === "string" ? payload.error : `Galer Cloud HTTP ${response.status}`, (payload.detail as Record<string, unknown>) ?? {});
    }
    return raw ? { status: response.status, json: null, blob: await response.blob(), headers: response.headers } : { status: response.status, json: (await response.json()) as T, blob: null, headers: response.headers };
  }

  /** Concesión vigente para un archivo (una petición por archivo mientras no caduque; invalidada por versión/época en el servidor). */
  async function access(fileId: string, { signal, force = false }: { signal?: AbortSignal; force?: boolean } = {}): Promise<MediaAccess> {
    assertAccount();
    const hit = accessCache.get(fileId);
    if (!force && hit && hit.expiresAt - skew > now()) return hit.access;
    metrics.accesses++;
    const r = await request<MediaAccess>("POST", `/catalog/v1/files/${encodeURIComponent(fileId)}/access`, { signal });
    const a = r.json!;
    const exp = Math.min(...a.parts.map((p) => Date.parse(p.expiresAt))) || now() + a.ttlMs;
    accessCache.set(fileId, { access: a, expiresAt: Number.isFinite(exp) ? exp : now() + a.ttlMs });
    return a;
  }
  /** Bytes de una parte (opcionalmente un rango). */
  async function fetchPart(part: MediaPartGrant, { range = null, signal }: { range?: string | null; signal?: AbortSignal } = {}): Promise<Blob> {
    assertAccount();
    metrics.fetches++;
    const r = await request<never>("GET", part.url, { raw: true, range, signal });
    metrics.bytes += r.blob!.size;
    return r.blob!;
  }
  /** Archivo completo: todas las partes en orden; verifica tamaño total y hash (archivo o por parte) cuando existe. */
  async function downloadFile(fileId: string, { onProgress, signal }: { onProgress?: (p: MediaProgress) => void; signal?: AbortSignal } = {}): Promise<{ blob: Blob; access: MediaAccess; verified: "BYTES" | "SIZE" }> {
    const a = await access(fileId, { signal });
    const parts = [...a.parts].sort((x, y) => x.partIndex - y.partIndex);
    const blobs: Blob[] = []; let loaded = 0; let partHashes = true;
    for (const p of parts) {
      const b = await fetchPart(p, { signal });
      if (b.size !== p.size) throw new CatalogApiError(502, "MEDIA_SIZE_MISMATCH", `part ${p.partIndex} returned ${b.size} bytes, expected ${p.size}`, { partIndex: p.partIndex, expected: p.size, received: b.size });
      if (p.sha256) { const h = await sha256Hex(b); if (h !== p.sha256) { metrics.hashMismatches++; throw new CatalogApiError(502, "MEDIA_HASH_MISMATCH", `part ${p.partIndex} hash differs`, { partIndex: p.partIndex }); } } else partHashes = false;
      blobs.push(b); loaded += b.size; onProgress?.({ loadedBytes: loaded, totalBytes: a.partsTotalBytes, part: p.partIndex + 1, parts: parts.length });
    }
    const blob = new Blob(blobs, { type: a.mime ?? "application/octet-stream" });
    if (blob.size !== a.partsTotalBytes) throw new CatalogApiError(502, "MEDIA_SIZE_MISMATCH", "assembled size differs from the declared total", { expected: a.partsTotalBytes, received: blob.size });
    let verified: "BYTES" | "SIZE" = partHashes ? "BYTES" : "SIZE";
    if (a.sha256) { const h = await sha256Hex(blob); if (h !== a.sha256) { metrics.hashMismatches++; throw new CatalogApiError(502, "MEDIA_HASH_MISMATCH", "file hash differs from the verified hash", {}); } verified = "BYTES"; }
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
  async function loadArtwork(fileId: string, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
    const a = await access(fileId, { signal });
    const hit = artwork.get(a.cacheKey);
    if (hit) { artwork.delete(a.cacheKey); artwork.set(a.cacheKey, hit); return hit.url; }
    await slot();
    try {
      const { blob } = await downloadFile(fileId, { signal }); assertAccount();
      const again = artwork.get(a.cacheKey); if (again) return again.url;
      const url = createURL(blob);
      artwork.set(a.cacheKey, { url, bytes: blob.size, beatId: a.beatId }); metrics.artworkBytes += blob.size; metrics.artworkEntries = artwork.size;
      while (metrics.artworkBytes > budget && artwork.size > 1) { const [k, v] = artwork.entries().next().value as [string, { url: string; bytes: number; beatId: string }]; artwork.delete(k); revokeURL(v.url); metrics.artworkBytes -= v.bytes; metrics.artworkEvictions++; }
      metrics.artworkEntries = artwork.size;
      return url;
    } finally { freeSlot(); }
  }

  /** Evento autoritativo (reemplazo, trash, denegación): olvida concesiones y artwork del beat; las URLs arrendadas siguen hasta refcount 0. */
  function invalidate(beatId: string): void {
    for (const [k, v] of accessCache) if (v.access.beatId === beatId) accessCache.delete(k);
    for (const [k, v] of artwork) if (v.beatId === beatId) { artwork.delete(k); revokeURL(v.url); metrics.artworkBytes -= v.bytes; }
    metrics.artworkEntries = artwork.size;
  }
  /** Logout / cambio de cuenta: todo se libera; nada de otra cuenta sobrevive. */
  function teardown(): void {
    for (const e of objects.values()) { revokeURL(e.url); metrics.urlsRevoked++; }
    for (const v of artwork.values()) revokeURL(v.url);
    objects.clear(); artwork.clear(); accessCache.clear(); inflight.clear(); artworkQueue.length = 0; artworkRunning = 0;
    metrics.urlsAlive = 0; metrics.leasesActive = 0; metrics.artworkBytes = 0; metrics.artworkEntries = 0;
    account = options.accountId();
  }

  return Object.freeze({ access, fetchPart, downloadFile, acquire, refcount, loadArtwork, invalidate, teardown, metrics, limits: Object.freeze({ budget, concurrency, skew }) });
}
export type CatalogMediaClient = ReturnType<typeof createCatalogMediaClient>;
