// Arranque rápido (decisión del propietario 2026-11-17, opción A): copia local en IndexedDB del PRIMER bloque de metadatos (≤ 240 beats)
// de una consulta, para pintar la Gallery en cuanto GET /context confirma la autoridad, sin esperar al primer GET /beats.
// PostgreSQL sigue siendo la única autoridad: la copia solo se usa si coincide EXACTAMENTE con la cuenta confirmada por el servidor, el
// vault, la era, la época, la generación y la consulta (filtros + orden); se muestra como provisional (sin interacción) y se revalida
// siempre contra PostgreSQL. Cualquier fallo de almacenamiento (no disponible, cuota llena, datos corruptos) se trata como «sin copia».
import type { CatalogBeatDto, CatalogContext, CatalogPage } from "./catalogApi";
import { createIdbConnection, resolveIdbFactory } from "./catalogIdb";

export const FIRST_BLOCK_CACHE_VERSION = 1;
export const FIRST_BLOCK_CACHE_DB = "beatgaler-catalog-first-block";
export const FIRST_BLOCK_CACHE_MAX_ITEMS = 240;
export const FIRST_BLOCK_CACHE_MAX_BYTES = 2 * 1024 * 1024;
export const FIRST_BLOCK_CACHE_MAX_ENTRIES_PER_ACCOUNT = 8;
export const FIRST_BLOCK_CACHE_MAX_ENTRIES = 24;
const READ_TIMEOUT_MS = 250;

export interface FirstBlockIdentity { accountId: string; vaultId: string; era: string; epoch: string; generationId: string }
export interface FirstBlockEntry extends FirstBlockIdentity {
  v: typeof FIRST_BLOCK_CACHE_VERSION;
  key: string;
  queryKey: string;
  revision: string;
  savedAt: number;
  bytes: number;
  totalMatched: number | null;
  totalLibrary: number;
  page: Pick<CatalogPage, "items" | "startOrdinal" | "nextCursor" | "previousCursor" | "resumeCursor">;
}
export type FirstBlockWriteResult = { ok: true } | { ok: false; reason: "unavailable" | "too-large" | "quota" | "error" };

/** Almacén clave → registro. IndexedDB en el navegador; memoria en pruebas. */
export interface FirstBlockBackend {
  get(key: string): Promise<unknown>;
  put(entry: FirstBlockEntry): Promise<void>;
  delete(keys: string[]): Promise<void>;
  all(): Promise<unknown[]>;
}

export const identityOf = (accountId: string, ctx: Pick<CatalogContext, "user_id" | "vault_id" | "authority_era" | "authority_epoch" | "generation_id">): FirstBlockIdentity | null =>
  // La cuenta activa (confirmada por el Cloud) y la del contexto deben ser la misma: si no, no hay identidad segura y no se usa caché.
  accountId && ctx.user_id === accountId ? { accountId, vaultId: ctx.vault_id, era: ctx.authority_era, epoch: ctx.authority_epoch, generationId: ctx.generation_id } : null;

export const entryKey = (id: FirstBlockIdentity, queryKey: string): string => [id.accountId, id.vaultId, id.era, id.epoch, id.generationId, queryKey].join("\u0000");
const sameIdentity = (a: FirstBlockIdentity, b: FirstBlockIdentity) => a.accountId === b.accountId && a.vaultId === b.vaultId && a.era === b.era && a.epoch === b.epoch && a.generationId === b.generationId;
const isStr = (v: unknown): v is string => typeof v === "string";

function validItem(it: unknown): it is CatalogBeatDto {
  const o = it as Record<string, unknown> | null;
  return Boolean(o) && isStr(o!.id) && o!.id !== "" && isStr(o!.version) && isStr(o!.name) && Array.isArray(o!.tags) && typeof o!.rating === "number";
}
/** Valida un registro leído del disco: estructura, versión, identidad exacta, tamaño y unicidad de IDs. */
export function validateEntry(raw: unknown, id: FirstBlockIdentity, queryKey: string): FirstBlockEntry | null {
  const e = raw as FirstBlockEntry | null;
  if (!e || typeof e !== "object" || e.v !== FIRST_BLOCK_CACHE_VERSION) return null;
  if (!sameIdentity(e, id) || e.queryKey !== queryKey || e.key !== entryKey(id, queryKey) || !isStr(e.revision)) return null;
  const p = e.page;
  if (!p || p.startOrdinal !== 0 || !Array.isArray(p.items) || p.items.length === 0 || p.items.length > FIRST_BLOCK_CACHE_MAX_ITEMS || !isStr(p.resumeCursor)) return null;
  const seen = new Set<string>();
  for (const it of p.items) { if (!validItem(it) || seen.has(it.id)) return null; seen.add(it.id); }
  return e;
}

const isQuota = (e: unknown) => { const n = (e as { name?: string })?.name; return n === "QuotaExceededError" || n === "NS_ERROR_DOM_QUOTA_REACHED"; };
const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> => new Promise((resolve) => {
  const t = setTimeout(() => resolve(fallback), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
});

export function createFirstBlockCache(options: { backend: FirstBlockBackend | null; now?: () => number; maxBytes?: number; readTimeoutMs?: number }) {
  const { backend } = options;
  const now = options.now ?? (() => Date.now());
  const maxBytes = options.maxBytes ?? FIRST_BLOCK_CACHE_MAX_BYTES;

  async function read(id: FirstBlockIdentity, queryKey: string): Promise<FirstBlockEntry | null> {
    if (!backend) return null;
    const key = entryKey(id, queryKey);
    // Una lectura lenta no puede retrasar el arranque normal: pasado el plazo se arranca sin copia.
    const raw = await withTimeout(backend.get(key), options.readTimeoutMs ?? READ_TIMEOUT_MS, null);
    if (raw == null) return null;
    const entry = validateEntry(raw, id, queryKey);
    if (!entry) { await backend.delete([key]).catch(() => {}); return null; } // corrupto / de otra versión → se descarta
    return entry;
  }

  // Lectura anticipada: las copias de la cuenta se leen EN PARALELO a GET /context (solo datos locales, nada se muestra). Tras /context,
  // `pick` elige únicamente la de identidad y consulta exactas; así abrir IndexedDB no se suma al camino crítico (primera visita incluida).
  function candidates(accountId: string): Promise<unknown[]> {
    if (!backend) return Promise.resolve([]);
    return withTimeout(backend.all().then((all) => all.filter((e) => (e as FirstBlockEntry)?.accountId === accountId)), options.readTimeoutMs ?? READ_TIMEOUT_MS, []);
  }
  async function pick(list: Promise<unknown[]> | unknown[], id: FirstBlockIdentity, queryKey: string): Promise<FirstBlockEntry | null> {
    const key = entryKey(id, queryKey);
    const raw = (await list).find((e) => (e as FirstBlockEntry)?.key === key);
    if (raw == null) return null;
    const entry = validateEntry(raw, id, queryKey);
    if (!entry) { await backend?.delete([key]).catch(() => {}); return null; }
    return entry;
  }

  async function prune(keepKey: string, accountId: string): Promise<void> {
    if (!backend) return;
    const all = (await backend.all()).filter((e): e is FirstBlockEntry => Boolean(e && typeof e === "object" && isStr((e as FirstBlockEntry).key)));
    const byAge = all.filter((e) => e.key !== keepKey).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    const drop: string[] = [];
    let mine = 1, total = 1;
    for (const e of byAge) {
      const own = e.accountId === accountId;
      if ((own && mine >= FIRST_BLOCK_CACHE_MAX_ENTRIES_PER_ACCOUNT) || total >= FIRST_BLOCK_CACHE_MAX_ENTRIES) { drop.push(e.key); continue; }
      if (own) mine++; total++;
    }
    if (drop.length) await backend.delete(drop);
  }

  async function write(id: FirstBlockIdentity, queryKey: string, page: CatalogPage): Promise<FirstBlockWriteResult> {
    if (!backend) return { ok: false, reason: "unavailable" };
    if (page.startOrdinal !== 0 || page.items.length === 0 || page.items.length > FIRST_BLOCK_CACHE_MAX_ITEMS) return { ok: false, reason: "too-large" };
    const items = page.items.slice();
    const bytes = new TextEncoder().encode(JSON.stringify(items)).length;
    if (bytes > maxBytes) return { ok: false, reason: "too-large" };
    const entry: FirstBlockEntry = {
      v: FIRST_BLOCK_CACHE_VERSION, ...id, key: entryKey(id, queryKey), queryKey, revision: page.revision, savedAt: now(), bytes,
      totalMatched: page.totalMatched, totalLibrary: page.totalLibrary,
      page: { items, startOrdinal: 0, nextCursor: page.nextCursor, previousCursor: page.previousCursor, resumeCursor: page.resumeCursor },
    };
    try { await backend.put(entry); }
    catch (e) {
      if (!isQuota(e)) return { ok: false, reason: "error" };
      // Cuota llena: se liberan TODAS las demás copias (son prescindibles) y se reintenta una sola vez.
      try { const others = (await backend.all()).map((x) => (x as FirstBlockEntry)?.key).filter((k): k is string => isStr(k) && k !== entry.key); if (others.length) await backend.delete(others); await backend.put(entry); }
      catch (again) { return { ok: false, reason: isQuota(again) ? "quota" : "error" }; }
    }
    await prune(entry.key, id.accountId).catch(() => {});
    return { ok: true };
  }

  /** Borra las copias de la cuenta; con `keep`, conserva solo las de esa identidad exacta (vault/era/época/generación vigentes). */
  async function invalidateAccount(accountId: string, keep?: FirstBlockIdentity): Promise<number> {
    if (!backend) return 0;
    try {
      const drop = (await backend.all()).filter((e): e is FirstBlockEntry => Boolean(e && typeof e === "object" && (e as FirstBlockEntry).accountId === accountId))
        .filter((e) => !keep || !sameIdentity(e, keep)).map((e) => e.key);
      if (drop.length) await backend.delete(drop);
      return drop.length;
    } catch { return 0; }
  }

  /** Borra las copias de la cuenta que contienen el beat (p. ej. tras quitar su portada): la siguiente visita no puede mostrar la antigua. */
  async function dropBeat(accountId: string, beatId: string): Promise<number> {
    if (!backend) return 0;
    try {
      const drop = (await backend.all()).filter((e): e is FirstBlockEntry => Boolean(e && typeof e === "object" && (e as FirstBlockEntry).accountId === accountId && Array.isArray((e as FirstBlockEntry).page?.items) && (e as FirstBlockEntry).page.items.some((it) => it?.id === beatId))).map((e) => e.key);
      if (drop.length) await backend.delete(drop);
      return drop.length;
    } catch { return 0; }
  }

  /** Settings (E80): copias de la cuenta en este dispositivo (número y bytes de metadatos guardados). */
  async function usage(accountId: string): Promise<{ entries: number; bytes: number }> {
    if (!backend) return { entries: 0, bytes: 0 };
    try {
      const mine = (await backend.all()).filter((e): e is FirstBlockEntry => Boolean(e && typeof e === "object" && (e as FirstBlockEntry).accountId === accountId));
      return { entries: mine.length, bytes: mine.reduce((n, e) => n + (Number.isFinite(e.bytes) ? e.bytes : 0), 0) };
    } catch { return { entries: 0, bytes: 0 }; }
  }

  return Object.freeze({ read, candidates, pick, write, invalidateAccount, dropBeat, usage, available: Boolean(backend) });
}
export type FirstBlockCache = ReturnType<typeof createFirstBlockCache>;

// ---------- backends ----------
export function memoryFirstBlockBackend(): FirstBlockBackend & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (e) => { map.set(e.key, structuredClone(e)); },
    delete: async (keys) => { for (const k of keys) map.delete(k); },
    all: async () => [...map.values()].map((v) => structuredClone(v)),
  };
}

export function indexedDbFirstBlockBackend(factory?: IDBFactory | null): FirstBlockBackend | null {
  const idb = resolveIdbFactory(factory);
  if (!idb) return null;
  // Política propia: sin plazo en la conexión (la lectura lleva el suyo, `withTimeout`), la transacción acaba en oncomplete, un open() fallido
  // se reintenta y onversionchange cierra la conexión.
  const conn = createIdbConnection({ factory: idb, name: FIRST_BLOCK_CACHE_DB, version: 1, stores: [{ name: "entries", keyPath: "key" }], settle: "transaction", retryOpen: true, closeOnVersionChange: true });
  const tx = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => conn.run<T>(mode, ["entries"], (t) => fn(t.objectStore("entries")));
  return {
    get: (k) => tx("readonly", (s) => s.get(k)),
    put: async (e) => { await tx("readwrite", (s) => { s.put(e); }); },
    delete: async (keys) => { if (keys.length) await tx("readwrite", (s) => { for (const k of keys) s.delete(k); }); },
    all: async () => (await tx<unknown[]>("readonly", (s) => s.getAll())) ?? [],
  };
}

let shared: FirstBlockCache | null = null;
/** Caché compartida del navegador (IndexedDB); `available: false` si el entorno no la tiene. */
export function browserFirstBlockCache(): FirstBlockCache {
  if (!shared) { let backend: FirstBlockBackend | null = null; try { backend = indexedDbFirstBlockBackend(); } catch { backend = null; } shared = createFirstBlockCache({ backend }); }
  return shared;
}
