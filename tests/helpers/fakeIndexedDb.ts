// Doble mínimo de IndexedDB (sin dependencias) para probar las cachés locales del catálogo Web: solo lo que usan
// catalogFirstBlockCache / catalogPrefixCache / catalogArtworkCache (open + upgradeneeded, createObjectStore con/sin keyPath, transaction,
// get/put/delete/getAll/openCursor, oncomplete/onerror/onabort, onversionchange/onblocked). Las escrituras se confirman al completar la
// transacción (una transacción abortada no deja nada). Con inyección de fallos para pruebas de error. Los eventos son asíncronos (macrotarea).
export interface FakeIdbFaults {
  /** open() dispara onerror con este error. */
  failOpen?: Error | null;
  /** open() dispara onblocked. */
  blockOpen?: boolean;
  /** open() nunca responde. */
  hangOpen?: boolean;
  /** Las transacciones nuevas nunca terminan (ni onsuccess ni oncomplete). */
  hangTx?: boolean;
  /** Si devuelve un Error, las peticiones tienen éxito pero la transacción termina en onabort y no confirma nada. Se evalúa al crear la transacción. */
  abortTx?: (info: { stores: string[]; mode: string }) => Error | null | undefined;
  /** Si devuelve un Error, esa petición falla (onerror de la petición, onerror y onabort de la transacción). */
  failRequest?: (info: { store: string; op: string; key?: string }) => Error | null | undefined;
}
interface StoreData { keyPath: string | null; data: Map<string, unknown> }
interface DbData { version: number; stores: Map<string, StoreData> }
export interface FakeIdbFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
  readonly databases: Map<string, DbData>;
  readonly faults: FakeIdbFaults;
  readonly opens: Array<{ name: string; version: number | undefined }>;
  readonly transactions: Array<{ db: string; stores: string[]; mode: string }>;
  /** Conexiones abiertas (para disparar onversionchange). */
  readonly handles: Array<IDBDatabase & { closed: boolean }>;
  /** Contenido visible de una store: clave → valor. */
  dump(db: string, store: string): Map<string, unknown> | undefined;
}

const clone = <T,>(v: T): T => (typeof Blob !== "undefined" && v instanceof Blob ? v : structuredClone(v));
const later = (fn: () => void) => { setTimeout(fn, 0); };
const err = (name: string, message = name) => Object.assign(new Error(message), { name });

export function createFakeIndexedDb(shared?: Map<string, DbData>): FakeIdbFactory {
  const databases = shared ?? new Map<string, DbData>();
  const faults: FakeIdbFaults = {};
  const opens: FakeIdbFactory["opens"] = [];
  const transactions: FakeIdbFactory["transactions"] = [];
  const handles: FakeIdbFactory["handles"] = [];

  function makeDb(name: string, data: DbData, upgrading: boolean) {
    const db: Record<string, unknown> = {
      name, version: data.version, onversionchange: null, closed: false,
      objectStoreNames: { contains: (s: string) => data.stores.has(s), get length() { return data.stores.size; } },
      createObjectStore(s: string, opts?: { keyPath?: string }) {
        if (!upgrading) throw err("InvalidStateError");
        if (data.stores.has(s)) throw err("ConstraintError");
        data.stores.set(s, { keyPath: opts?.keyPath ?? null, data: new Map() });
        return {};
      },
      close() { db.closed = true; },
      transaction(storeNames: string | string[], mode: IDBTransactionMode = "readonly") {
        const stores = Array.isArray(storeNames) ? storeNames : [storeNames];
        for (const s of stores) if (!data.stores.has(s)) throw err("NotFoundError", `no store ${s}`);
        transactions.push({ db: name, stores, mode });
        return makeTx(data, name, stores, mode);
      },
    };
    handles.push(db as unknown as IDBDatabase & { closed: boolean });
    return db as unknown as IDBDatabase & { closed: boolean };
  }

  function makeTx(data: DbData, dbName: string, stores: string[], mode: string) {
    const writes: Array<() => void> = [];
    let pending = 0; let done = false; let failed: Error | null = null;
    const tx: Record<string, unknown> = { oncomplete: null, onerror: null, onabort: null, error: null, mode };
    const finish = () => {
      if (done) return; done = true;
      if (failed) { tx.error = failed; (tx.onabort as (() => void) | null)?.(); return; }
      for (const w of writes) w();
      (tx.oncomplete as (() => void) | null)?.();
    };
    const settleCheck = () => later(() => { if (pending === 0 && !done) finish(); });
    const abortAll = (e: Error, viaRequestError: boolean) => {
      failed = e; tx.error = e;
      if (viaRequestError) (tx.onerror as (() => void) | null)?.();
      done = false; later(finish);
    };
    const preAbort = faults.abortTx?.({ stores, mode });
    const hung = Boolean(faults.hangTx);
    if (preAbort) failed = preAbort; // las peticiones tienen éxito, pero la transacción termina en onabort y no confirma nada (p. ej. cuota al confirmar)
    if (!hung) settleCheck();

    const request = <T,>(store: string, op: string, key: string | undefined, run: () => T) => {
      const r: Record<string, unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
      pending++;
      if (hung) return r as unknown as IDBRequest<T>;
      later(() => {
        const bad = faults.failRequest?.({ store, op, key });
        pending--;
        if (bad) { r.error = bad; (r.onerror as (() => void) | null)?.(); abortAll(bad, true); return; }
        try { r.result = run(); } catch (e) { r.error = e; (r.onerror as (() => void) | null)?.(); abortAll(e as Error, true); return; }
        (r.onsuccess as (() => void) | null)?.();
        settleCheck();
      });
      return r as unknown as IDBRequest<T>;
    };

    tx.objectStore = (name: string) => {
      if (!stores.includes(name)) throw err("NotFoundError", `store ${name} not in transaction`);
      const st = data.stores.get(name)!;
      const sortedKeys = () => [...st.data.keys()].sort();
      const keyFor = (v: unknown, k?: string) => (st.keyPath ? String((v as Record<string, unknown>)[st.keyPath]) : k as string);
      return {
        get: (k: string) => request(name, "get", k, () => (st.data.has(k) ? clone(st.data.get(k)) : undefined)),
        getAll: () => request(name, "getAll", undefined, () => sortedKeys().map((k) => clone(st.data.get(k)))),
        put: (v: unknown, k?: string) => { if (mode === "readonly") throw err("ReadOnlyError"); const key = keyFor(v, k); const c = clone(v); return request(name, "put", key, () => { writes.push(() => { st.data.set(key, c); }); return key; }); },
        delete: (k: string) => { if (mode === "readonly") throw err("ReadOnlyError"); return request(name, "delete", k, () => { writes.push(() => { st.data.delete(k); }); return undefined; }); },
        openCursor: () => {
          const keys = sortedKeys(); let i = 0;
          const r: Record<string, unknown> = { result: null, error: null, onsuccess: null, onerror: null };
          pending++;
          const step = () => later(() => {
            if (hung) return;
            const bad = faults.failRequest?.({ store: name, op: "openCursor" });
            if (bad) { pending--; r.error = bad; (r.onerror as (() => void) | null)?.(); abortAll(bad, true); return; }
            if (i >= keys.length) { r.result = null; (r.onsuccess as (() => void) | null)?.(); pending--; settleCheck(); return; }
            const key = keys[i++];
            r.result = { key, value: clone(st.data.get(key)), continue: () => step() };
            (r.onsuccess as (() => void) | null)?.();
          });
          step();
          return r as unknown as IDBRequest;
        },
      };
    };
    return tx as unknown as IDBTransaction;
  }

  const factory: FakeIdbFactory = {
    databases, faults, opens, transactions, handles,
    dump: (db, store) => databases.get(db)?.stores.get(store)?.data,
    open(name: string, version?: number) {
      opens.push({ name, version });
      const req: Record<string, unknown> = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        if (faults.hangOpen) return;
        if (faults.failOpen) { req.error = faults.failOpen; (req.onerror as (() => void) | null)?.(); return; }
        if (faults.blockOpen) { (req.onblocked as (() => void) | null)?.(); return; }
        let data = databases.get(name);
        const want = version ?? data?.version ?? 1;
        if (data && data.version > want) { req.error = err("VersionError"); (req.onerror as (() => void) | null)?.(); return; }
        if (!data || data.version < want) {
          const old = data?.version ?? 0;
          data = data ?? { version: 0, stores: new Map() };
          databases.set(name, data); data.version = want;
          req.result = makeDb(name, data, true);
          (req.onupgradeneeded as ((e: unknown) => void) | null)?.({ oldVersion: old, newVersion: want });
        }
        req.result = makeDb(name, data, false);
        (req.onsuccess as (() => void) | null)?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  };
  return factory;
}

export const quotaError = () => err("QuotaExceededError", "quota exceeded");
