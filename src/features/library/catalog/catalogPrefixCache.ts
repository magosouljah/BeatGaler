// E71 — Caché local de prefijos de audio (primeros 128 KiB de cada MP3), Documento Maestro §7.3.
// Clave = (cuenta, SHA-256 del archivo COMPLETO): direccionada por contenido, una versión nueva de un MP3 tiene otro hash y por tanto otra entrada;
// es imposible mezclar versiones o cuentas. Cada entrada guarda además el SHA-256 de sus propios bytes y el tamaño del archivo; el reproductor
// vuelve a verificar el archivo entero mientras suena (SHA progresivo) y una discrepancia borra la entrada.
// Memoria y disco acotados: LRU por bytes (límite configurable); en memoria solo un índice pequeño, los bytes viven en IndexedDB.
// Fallos de IndexedDB (privado, cuota, bloqueo) = caché vacía: nunca bloquean la reproducción.
import { Sha256 } from "./catalogTransfer";

export const PREFIX_BYTES = 128 * 1024;
export const PREFIX_CACHE_DEFAULTS = Object.freeze({ maxBytes: 256 * 1024 * 1024, readTimeoutMs: 250, dbName: "beatgaler-catalog-prefix", store: "prefixes" });

export interface PrefixEntry { account: string; fileSha256: string; fileSize: number; prefixSha256: string; bytes: Uint8Array; storedAt: number; lastUsed: number; source: "upload" | "pack" | "stream" }
export interface PrefixCacheMetrics { hits: number; misses: number; puts: number; evictions: number; rejected: number; bytes: number; entries: number }
export interface PrefixCache {
  get(account: string, fileSha256: string): Promise<PrefixEntry | null>;
  has(account: string, fileSha256: string): Promise<boolean>;
  /** Guarda un prefijo ya validado (o lo valida si no trae prefixSha256). Devuelve false si se rechaza. */
  put(input: { account: string; fileSha256: string; fileSize: number; bytes: Uint8Array; prefixSha256?: string | null; source: PrefixEntry["source"] }): Promise<boolean>;
  /** Desde los bytes ORIGINALES del archivo (subida/reemplazo): sin red. */
  putFromBlob(input: { account: string; fileSha256: string; blob: Blob }): Promise<boolean>;
  drop(account: string, fileSha256: string): Promise<void>;
  dropAccount(account: string): Promise<void>;
  keys(account: string): Promise<Set<string>>;
  /** Uso en este dispositivo de la cuenta (Settings, E80). */
  usage(account: string): Promise<{ entries: number; bytes: number }>;
  metrics: PrefixCacheMetrics;
  available: boolean;
}

const keyOf = (account: string, fileSha256: string) => `${account}|${fileSha256}`;
const SHA_RE = /^[0-9a-f]{64}$/;
const hashOf = (b: Uint8Array) => new Sha256().update(b).digestHex();

interface Backend {
  get(key: string): Promise<PrefixEntry | null>;
  set(key: string, value: PrefixEntry): Promise<void>;
  delete(key: string): Promise<void>;
  index(): Promise<Array<{ key: string; size: number; lastUsed: number; account: string; fileSha256: string }>>;
}

function memoryBackend(): Backend {
  const m = new Map<string, PrefixEntry>();
  return {
    async get(k) { return m.get(k) ?? null; },
    async set(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async index() { return [...m.entries()].map(([key, v]) => ({ key, size: v.bytes.byteLength, lastUsed: v.lastUsed, account: v.account, fileSha256: v.fileSha256 })); },
  };
}

function indexedDbBackend(dbName: string, store: string, timeoutMs: number): Backend | null {
  if (typeof indexedDB === "undefined") return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () => (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); req.onblocked = () => reject(new Error("indexedDB blocked"));
  }));
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => Promise.race([
    open().then((db) => new Promise<T>((resolve, reject) => { const t = db.transaction(store, mode); const r = fn(t.objectStore(store)); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); })),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("indexedDB timeout")), mode === "readonly" ? timeoutMs : timeoutMs * 8)),
  ]);
  return {
    async get(k) { const v = await run<PrefixEntry | undefined>("readonly", (s) => s.get(k) as IDBRequest<PrefixEntry | undefined>); return v ? { ...v, bytes: new Uint8Array(v.bytes) } : null; },
    async set(k, v) { await run("readwrite", (s) => s.put(v, k)); },
    async delete(k) { await run("readwrite", (s) => s.delete(k)); },
    async index() {
      const out: Array<{ key: string; size: number; lastUsed: number; account: string; fileSha256: string }> = [];
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).openCursor();
        req.onsuccess = () => { const c = req.result; if (!c) { resolve(); return; } const v = c.value as PrefixEntry; out.push({ key: String(c.key), size: v.bytes.byteLength, lastUsed: v.lastUsed, account: v.account, fileSha256: v.fileSha256 }); c.continue(); };
        req.onerror = () => reject(req.error);
      });
      return out;
    },
  };
}

export function createPrefixCache(options: { maxBytes?: number; backend?: "memory" | "indexeddb"; now?: () => number; dbName?: string } = {}): PrefixCache {
  const maxBytes = options.maxBytes ?? PREFIX_CACHE_DEFAULTS.maxBytes;
  const now = options.now ?? (() => Date.now());
  const idb = options.backend === "memory" ? null : indexedDbBackend(options.dbName ?? PREFIX_CACHE_DEFAULTS.dbName, PREFIX_CACHE_DEFAULTS.store, PREFIX_CACHE_DEFAULTS.readTimeoutMs);
  let backend: Backend = idb ?? memoryBackend();
  let broken = false;
  const metrics: PrefixCacheMetrics = { hits: 0, misses: 0, puts: 0, evictions: 0, rejected: 0, bytes: 0, entries: 0 };
  // Índice en memoria (sin bytes): tamaño + último uso por clave, cargado perezosamente una vez.
  let index: Map<string, { size: number; lastUsed: number; account: string; fileSha256: string }> | null = null;
  const loadIndex = async () => {
    if (index) return index;
    try { index = new Map((await backend.index()).map((e) => [e.key, e])); } catch { broken = true; backend = memoryBackend(); index = new Map(); }
    metrics.entries = index.size; metrics.bytes = [...index.values()].reduce((n, e) => n + e.size, 0);
    return index;
  };
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => { try { return await fn(); } catch { return fallback; } };

  async function evict(): Promise<void> {
    const idx = await loadIndex();
    if (metrics.bytes <= maxBytes) return;
    const order = [...idx.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, e] of order) {
      if (metrics.bytes <= maxBytes) break;
      await safe(() => backend.delete(k), undefined);
      idx.delete(k); metrics.bytes -= e.size; metrics.evictions++;
    }
    metrics.entries = idx.size;
  }

  async function get(account: string, fileSha256: string): Promise<PrefixEntry | null> {
    if (!account || !SHA_RE.test(fileSha256)) return null;
    const k = keyOf(account, fileSha256);
    const v = await safe(() => backend.get(k), null);
    if (!v || v.account !== account || v.fileSha256 !== fileSha256 || hashOf(v.bytes) !== v.prefixSha256) { if (v) await drop(account, fileSha256); metrics.misses++; return null; }
    metrics.hits++;
    const idx = await loadIndex(); const e = idx.get(k); if (e) e.lastUsed = now();
    return v;
  }
  async function put(input: { account: string; fileSha256: string; fileSize: number; bytes: Uint8Array; prefixSha256?: string | null; source: PrefixEntry["source"] }): Promise<boolean> {
    const { account, fileSha256, fileSize, source } = input;
    const bytes = input.bytes.byteLength > PREFIX_BYTES ? input.bytes.slice(0, PREFIX_BYTES) : input.bytes.slice();
    const expectLen = Math.min(PREFIX_BYTES, fileSize);
    const own = hashOf(bytes);
    if (!account || !SHA_RE.test(fileSha256) || !Number.isSafeInteger(fileSize) || fileSize <= 0 || bytes.byteLength !== expectLen || (input.prefixSha256 && input.prefixSha256 !== own)) { metrics.rejected++; return false; }
    const k = keyOf(account, fileSha256);
    const entry: PrefixEntry = { account, fileSha256, fileSize, prefixSha256: own, bytes, storedAt: now(), lastUsed: now(), source };
    const idx = await loadIndex();
    const ok = await safe(async () => { await backend.set(k, entry); return true; }, false);
    if (!ok) { metrics.rejected++; return false; }
    const prev = idx.get(k); if (prev) metrics.bytes -= prev.size;
    idx.set(k, { size: bytes.byteLength, lastUsed: entry.lastUsed, account, fileSha256 }); metrics.bytes += bytes.byteLength; metrics.entries = idx.size; metrics.puts++;
    await evict();
    return true;
  }
  async function putFromBlob({ account, fileSha256, blob }: { account: string; fileSha256: string; blob: Blob }): Promise<boolean> {
    const head = blob.slice(0, Math.min(PREFIX_BYTES, blob.size));
    const buf = typeof head.arrayBuffer === "function" ? await head.arrayBuffer() : await new Response(head).arrayBuffer();
    return put({ account, fileSha256, fileSize: blob.size, bytes: new Uint8Array(buf), source: "upload" });
  }
  async function drop(account: string, fileSha256: string): Promise<void> {
    const k = keyOf(account, fileSha256); const idx = await loadIndex();
    await safe(() => backend.delete(k), undefined);
    const e = idx.get(k); if (e) { idx.delete(k); metrics.bytes -= e.size; metrics.entries = idx.size; }
  }
  async function dropAccount(account: string): Promise<void> { const idx = await loadIndex(); for (const e of [...idx.values()]) if (e.account === account) await drop(account, e.fileSha256); }
  async function keys(account: string): Promise<Set<string>> { const idx = await loadIndex(); return new Set([...idx.values()].filter((e) => e.account === account).map((e) => e.fileSha256)); }
  async function usage(account: string): Promise<{ entries: number; bytes: number }> { const idx = await loadIndex(); let entries = 0, bytes = 0; for (const e of idx.values()) if (e.account === account) { entries++; bytes += e.size; } return { entries, bytes }; }
  async function has(account: string, fileSha256: string): Promise<boolean> { const idx = await loadIndex(); return idx.has(keyOf(account, fileSha256)); }

  return { get, has, put, putFromBlob, drop, dropAccount, keys, usage, metrics, get available() { return !broken; } } as PrefixCache;
}
