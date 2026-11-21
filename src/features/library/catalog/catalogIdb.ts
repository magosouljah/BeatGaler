// M3.6 — Acceso común a IndexedDB para las cachés locales del catálogo Web (arranque rápido E66, prefijos E71, portadas E79): abrir con versión y
// creación de stores, una transacción por operación, `safe()` y expulsión LRU por bytes. Es solo fontanería: cada caché conserva SU política
// (nombre de base de datos, stores, claves, límites, qué hace ante un fallo) y la declara aquí con opciones explícitas; las diferencias que ya
// existían entre cachés NO se unifican en silencio (ver `settle`, `retryOpen`, `closeOnVersionChange`, `timeoutMs`).
// Inyección uniforme: `factory` (un IDBFactory); `resolveIdbFactory` devuelve el global `indexedDB` si no se indica y `null` si no existe.

/** Ejecuta `fn` y devuelve `fallback` si falla (el error se traga: las cachés son prescindibles). */
export const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => { try { return await fn(); } catch { return fallback; } };

/** `undefined` → el `indexedDB` global (o `null` si no existe); `null` → sin IndexedDB; un IDBFactory → ese (pruebas). */
export function resolveIdbFactory(factory?: IDBFactory | null): IDBFactory | null {
  if (factory !== undefined) return factory;
  return typeof indexedDB === "undefined" ? null : indexedDB;
}

export interface IdbStoreSpec { name: string; /** Sin keyPath = claves fuera de línea (`put(valor, clave)`). */ keyPath?: string }
export interface IdbConnectionOptions {
  factory: IDBFactory;
  name: string;
  version: number;
  /** Stores que `onupgradeneeded` crea si faltan (nunca borra ni modifica las existentes). */
  stores: IdbStoreSpec[];
  /** Plazo en ms de las lecturas (las escrituras, ×8): vencido, la operación rechaza con «indexedDB timeout». Sin valor = sin plazo. */
  timeoutMs?: number;
  /** `transaction`: la operación acaba en oncomplete (y rechaza con onerror/onabort). `request`: acaba en el onsuccess de la petición, antes de confirmar. */
  settle: "request" | "transaction";
  /** `true`: un open() fallido se descarta y la siguiente operación vuelve a abrir. `false`: el rechazo queda cacheado. */
  retryOpen: boolean;
  /** `true`: onversionchange cierra la conexión y la siguiente operación reabre. */
  closeOnVersionChange: boolean;
}
export interface IdbConnection {
  open(): Promise<IDBDatabase>;
  /** Una transacción sobre `stores`; `fn` devuelve la petición cuyo resultado se entrega (o nada). */
  run<T>(mode: IDBTransactionMode, stores: string[], fn: (t: IDBTransaction) => IDBRequest<T> | null | void): Promise<T | undefined>;
}
export const IDB_WRITE_TIMEOUT_FACTOR = 8;

export function createIdbConnection(o: IdbConnectionOptions): IdbConnection {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (dbp) return dbp;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = o.factory.open(o.name, o.version);
      req.onupgradeneeded = () => { for (const s of o.stores) if (!req.result.objectStoreNames.contains(s.name)) req.result.createObjectStore(s.name, s.keyPath ? { keyPath: s.keyPath } : undefined); };
      req.onsuccess = () => { const db = req.result; if (o.closeOnVersionChange) db.onversionchange = () => { db.close(); dbp = null; }; resolve(db); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    });
    dbp = o.retryOpen ? p.catch((e) => { dbp = null; throw e; }) : p;
    return dbp;
  };
  const exec = <T,>(mode: IDBTransactionMode, stores: string[], fn: (t: IDBTransaction) => IDBRequest<T> | null | void): Promise<T | undefined> =>
    open().then((db) => new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(stores, mode); const r = fn(t) ?? null;
      if (o.settle === "request") { if (r) { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); } return; }
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error ?? (r ? r.error : null));
      t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
    }));
  const run: IdbConnection["run"] = (mode, stores, fn) => {
    if (o.timeoutMs === undefined) return exec(mode, stores, fn);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("indexedDB timeout")), mode === "readonly" ? o.timeoutMs! : o.timeoutMs! * IDB_WRITE_TIMEOUT_FACTOR); });
    return Promise.race([exec(mode, stores, fn), timeout]).finally(() => clearTimeout(timer));
  };
  return { open, run };
}

/**
 * Expulsión LRU por bytes: recorre los candidatos del menos al más recientemente usado (`lastUsed` ascendente, estable) y llama a `evict` hasta
 * que `totalBytes()` ≤ `maxBytes`. `protectKey` (la entrada recién guardada) nunca se expulsa: el recorrido se detiene al llegar a ella.
 * `evict` debe actualizar el total que `totalBytes` lee. Devuelve cuántas expulsó.
 */
export async function evictLeastRecentlyUsed<E extends { lastUsed: number }>(
  candidates: Iterable<[string, E]>,
  o: { totalBytes: () => number; maxBytes: number; protectKey?: string; evict: (key: string, entry: E) => Promise<void> },
): Promise<number> {
  let n = 0;
  for (const [key, e] of [...candidates].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
    if (o.totalBytes() <= o.maxBytes || key === o.protectKey) break;
    await o.evict(key, e); n++;
  }
  return n;
}
