// E79 — Caché persistente de portadas ORIGINALES (IndexedDB). Los bytes que el navegador leyó de Telegram (ya verificados por tamaño y hash) se
// guardan en este dispositivo y se reutilizan tras recargar la Gallery o reiniciar el navegador: una portada vigente no vuelve a pedirse.
// La clave la decide el cliente de medios (cuenta + época + archivo + revisión): una portada reemplazada tiene otro archivo y por tanto otra
// entrada; es imposible mezclar cuentas, archivos o versiones. Cada beat conserva una sola portada: guardar la nueva borra la anterior.
// Disco acotado: LRU por bytes (el último uso se persiste, como mucho una vez por hora y entrada); en memoria solo vive un índice sin bytes.
// Dos almacenes: `meta` (registros pequeños; el índice se carga de aquí sin tocar imágenes) y `blobs`. Fallos de IndexedDB (modo privado, cuota,
// bloqueo) = caché vacía: nunca bloquean ni retrasan la Gallery más allá de `readTimeoutMs`.
export const ARTWORK_CACHE_DEFAULTS = Object.freeze({ maxBytes: 256 * 1024 * 1024, maxEntryBytes: 16 * 1024 * 1024, touchEveryMs: 60 * 60 * 1000, readTimeoutMs: 1000, dbName: "beatgaler-catalog-artwork" });

export interface ArtworkMeta { key: string; account: string; beatId: string; size: number; storedAt: number; lastUsed: number }
export interface ArtworkCacheMetrics { hits: number; misses: number; puts: number; evictions: number; bytes: number; entries: number }
export interface ArtworkBackend {
  metas(): Promise<ArtworkMeta[]>;
  read(key: string): Promise<Blob | null>;
  write(meta: ArtworkMeta, blob: Blob): Promise<void>;
  touch(meta: ArtworkMeta): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface ArtworkCache {
  get(key: string): Promise<Blob | null>;
  /** Guarda la portada vigente del beat y borra sus entradas anteriores. Devuelve false si no se guardó (demasiado grande o sin almacenamiento). */
  put(input: { key: string; account: string; beatId: string; blob: Blob }): Promise<boolean>;
  /** Portada reemplazada o desvinculada: nada de ese beat sobrevive en disco. */
  dropBeat(account: string, beatId: string): Promise<void>;
  /** Settings (E80): uso de la cuenta en este dispositivo y borrado de todas sus portadas locales (nunca toca Telegram). */
  usage(account: string): Promise<{ entries: number; bytes: number }>;
  dropAccount(account: string): Promise<void>;
  metrics: ArtworkCacheMetrics;
}

export function memoryArtworkBackend(): ArtworkBackend {
  const metas = new Map<string, ArtworkMeta>(); const blobs = new Map<string, Blob>();
  return {
    async metas() { return [...metas.values()].map((m) => ({ ...m })); },
    async read(key) { return blobs.get(key) ?? null; },
    async write(meta, blob) { metas.set(meta.key, { ...meta }); blobs.set(meta.key, blob); },
    async touch(meta) { if (metas.has(meta.key)) metas.set(meta.key, { ...meta }); },
    async remove(key) { metas.delete(key); blobs.delete(key); },
  };
}

function indexedDbArtworkBackend(dbName: string, timeoutMs: number): ArtworkBackend | null {
  if (typeof indexedDB === "undefined") return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () => (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => { for (const s of ["meta", "blobs"]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); req.onblocked = () => reject(new Error("indexedDB blocked"));
  }));
  // Una transacción por operación; `meta` y `blobs` se escriben/borran juntos (nunca una imagen sin registro ni un registro sin imagen).
  const tx = <T>(mode: IDBTransactionMode, stores: string[], fn: (t: IDBTransaction) => IDBRequest<T> | null): Promise<T | undefined> => Promise.race([
    open().then((db) => new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(stores, mode); const r = fn(t); let out: T | undefined;
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error ?? new Error("indexedDB aborted"));
    })),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("indexedDB timeout")), mode === "readonly" ? timeoutMs : timeoutMs * 8)),
  ]);
  return {
    async metas() { return ((await tx<ArtworkMeta[]>("readonly", ["meta"], (t) => t.objectStore("meta").getAll() as IDBRequest<ArtworkMeta[]>)) ?? []); },
    async read(key) { const v = await tx<Blob | undefined>("readonly", ["blobs"], (t) => t.objectStore("blobs").get(key) as IDBRequest<Blob | undefined>); return v instanceof Blob ? v : null; },
    async write(meta, blob) { await tx("readwrite", ["meta", "blobs"], (t) => { t.objectStore("blobs").put(blob, meta.key); return t.objectStore("meta").put(meta, meta.key); }); },
    async touch(meta) { await tx("readwrite", ["meta"], (t) => t.objectStore("meta").put(meta, meta.key)); },
    async remove(key) { await tx("readwrite", ["meta", "blobs"], (t) => { t.objectStore("blobs").delete(key); return t.objectStore("meta").delete(key); }); },
  };
}

export function createArtworkCache(options: { maxBytes?: number; maxEntryBytes?: number; touchEveryMs?: number; backend?: ArtworkBackend; now?: () => number; dbName?: string } = {}): ArtworkCache {
  const maxBytes = options.maxBytes ?? ARTWORK_CACHE_DEFAULTS.maxBytes;
  const maxEntryBytes = options.maxEntryBytes ?? ARTWORK_CACHE_DEFAULTS.maxEntryBytes;
  const touchEveryMs = options.touchEveryMs ?? ARTWORK_CACHE_DEFAULTS.touchEveryMs;
  const now = options.now ?? (() => Date.now());
  let backend: ArtworkBackend = options.backend ?? indexedDbArtworkBackend(options.dbName ?? ARTWORK_CACHE_DEFAULTS.dbName, ARTWORK_CACHE_DEFAULTS.readTimeoutMs) ?? memoryArtworkBackend();
  const metrics: ArtworkCacheMetrics = { hits: 0, misses: 0, puts: 0, evictions: 0, bytes: 0, entries: 0 };
  // Índice en memoria (sin bytes), cargado una sola vez y de forma perezosa: el arranque de la Gallery no lo espera.
  let index: Promise<Map<string, ArtworkMeta>> | null = null;
  const loadIndex = () => (index ??= backend.metas().catch(() => { backend = memoryArtworkBackend(); return [] as ArtworkMeta[]; }).then((list) => {
    const m = new Map(list.map((e) => [e.key, e])); metrics.entries = m.size; metrics.bytes = list.reduce((n, e) => n + e.size, 0); return m;
  }));
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => { try { return await fn(); } catch { return fallback; } };
  async function forget(idx: Map<string, ArtworkMeta>, key: string): Promise<void> {
    const e = idx.get(key); if (!e) return;
    idx.delete(key); metrics.bytes -= e.size; metrics.entries = idx.size;
    await safe(() => backend.remove(key), undefined);
  }

  async function get(key: string): Promise<Blob | null> {
    const idx = await loadIndex(); const e = idx.get(key);
    if (!e) { metrics.misses++; return null; }
    const blob = await safe(() => backend.read(key), null);
    if (!blob || blob.size !== e.size) { await forget(idx, key); metrics.misses++; return null; } // registro sin imagen o imagen truncada
    metrics.hits++;
    if (now() - e.lastUsed >= touchEveryMs) { e.lastUsed = now(); void safe(() => backend.touch(e), undefined); }
    return blob;
  }
  async function put({ key, account, beatId, blob }: { key: string; account: string; beatId: string; blob: Blob }): Promise<boolean> {
    if (!key || !account || !beatId || blob.size <= 0 || blob.size > maxEntryBytes) return false;
    const idx = await loadIndex();
    for (const e of [...idx.values()]) if (e.key === key || (e.account === account && e.beatId === beatId)) await forget(idx, e.key);
    const meta: ArtworkMeta = { key, account, beatId, size: blob.size, storedAt: now(), lastUsed: now() };
    if (!(await safe(async () => { await backend.write(meta, blob); return true; }, false))) return false;
    idx.set(key, meta); metrics.bytes += meta.size; metrics.entries = idx.size; metrics.puts++;
    for (const e of [...idx.values()].sort((a, b) => a.lastUsed - b.lastUsed)) { // LRU por bytes; la entrada recién guardada es la más reciente
      if (metrics.bytes <= maxBytes || e.key === key) break;
      await forget(idx, e.key); metrics.evictions++;
    }
    return true;
  }
  async function dropBeat(account: string, beatId: string): Promise<void> {
    const idx = await loadIndex();
    for (const e of [...idx.values()]) if (e.account === account && e.beatId === beatId) await forget(idx, e.key);
  }
  async function usage(account: string): Promise<{ entries: number; bytes: number }> {
    const idx = await loadIndex(); let entries = 0, bytes = 0;
    for (const e of idx.values()) if (e.account === account) { entries++; bytes += e.size; }
    return { entries, bytes };
  }
  async function dropAccount(account: string): Promise<void> {
    const idx = await loadIndex();
    for (const e of [...idx.values()]) if (e.account === account) await forget(idx, e.key);
  }
  return { get, put, dropBeat, usage, dropAccount, metrics };
}
