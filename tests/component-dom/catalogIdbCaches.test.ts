// @vitest-environment node
// M3.6 — Caracterización de los adaptadores IndexedDB de las tres cachés locales del catálogo Web (arranque rápido E66, prefijos E71,
// portadas E79) sobre un doble mínimo de IndexedDB (tests/helpers/fakeIndexedDb.ts). Fijan lo OBSERVABLE: nombre de base de datos, stores, versión,
// claves, formato de los registros, orden de expulsión y qué hace cada caché ante un fallo de IndexedDB. Escritas contra el código previo a la
// refactorización y deben seguir en verde después. Las DIFERENCIAS entre cachés son intencionadas aquí (se conservan, no se unifican).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeIndexedDb, quotaError } from "../helpers/fakeIndexedDb";
import { createFirstBlockCache, entryKey, indexedDbFirstBlockBackend, type FirstBlockIdentity } from "../../src/features/library/catalog/catalogFirstBlockCache";
import { PREFIX_BYTES, createPrefixCache } from "../../src/features/library/catalog/catalogPrefixCache";
import { createArtworkCache } from "../../src/features/library/catalog/catalogArtworkCache";
import type { CatalogPage } from "../../src/features/library/catalog/catalogApi";
import { Sha256 } from "../../src/features/library/catalog/catalogTransfer";

afterEach(() => { vi.unstubAllGlobals(); });
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const sha = (b: Uint8Array) => new Sha256().update(b).digestHex();
const bytesOf = (n: number, salt = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + salt * 7) & 0xff; return b; };
const blob = (n: number, fill = 7) => new Blob([new Uint8Array(n).fill(fill)]);
const disk = async (idb: ReturnType<typeof createFakeIndexedDb>, db: string, store: string) => { await settle(); return idb.dump(db, store); }; // las peticiones de prefijos se resuelven antes de confirmar la transacción
const sortedKeys = (m: Map<string, unknown> | undefined) => [...(m?.keys() ?? [])].sort();

// ---------------------------------------------------------------- arranque rápido (E66)
const ID: FirstBlockIdentity = { accountId: "u1", vaultId: "v", era: "era-1", epoch: "1", generationId: "gen-1" };
const page = (n = 3): CatalogPage => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, version: "1", name: `beat ${i}`, tags: [], rating: 3 })),
  startOrdinal: 0, nextCursor: "n", previousCursor: null, resumeCursor: "r", revision: "rev-1", totalMatched: n, totalLibrary: n,
}) as unknown as CatalogPage;
function firstBlock(idb = createFakeIndexedDb(), extra: { now?: () => number; readTimeoutMs?: number } = {}) {
  const backend = indexedDbFirstBlockBackend(idb as unknown as IDBFactory);
  return { idb, backend, cache: createFirstBlockCache({ backend, ...extra }) };
}

describe("IndexedDB · arranque rápido (primer bloque)", () => {
  it("abre/crea beatgaler-catalog-first-block v1 con la store `entries` (keyPath key); guarda y lee por clave; persiste entre instancias", async () => {
    const { idb, cache } = firstBlock();
    expect(await cache.write(ID, "q", page())).toEqual({ ok: true });
    expect(idb.opens).toEqual([{ name: "beatgaler-catalog-first-block", version: 1 }]);
    const db = idb.databases.get("beatgaler-catalog-first-block")!;
    expect(db.version).toBe(1); expect([...db.stores.keys()]).toEqual(["entries"]); expect(db.stores.get("entries")!.keyPath).toBe("key");
    expect(sortedKeys(idb.dump("beatgaler-catalog-first-block", "entries"))).toEqual([entryKey(ID, "q")]);
    const stored = idb.dump("beatgaler-catalog-first-block", "entries")!.get(entryKey(ID, "q")) as Record<string, unknown>;
    expect(stored).toMatchObject({ v: 1, accountId: "u1", queryKey: "q", revision: "rev-1", totalLibrary: 3, key: entryKey(ID, "q") });
    const again = firstBlock(idb).cache; // «recarga»: instancia nueva sobre el mismo almacenamiento
    expect((await again.read(ID, "q"))?.page.items.map((i) => i.id)).toEqual(["b0", "b1", "b2"]);
    expect(await again.read({ ...ID, epoch: "2" }, "q")).toBeNull();
  });

  it("poda por antigüedad (savedAt): conserva las 8 más recientes de la cuenta y borra las demás del disco", async () => {
    let t = 0; const { idb, cache } = firstBlock(undefined, { now: () => ++t });
    for (let i = 0; i < 11; i++) await cache.write(ID, `q${i}`, page());
    expect(sortedKeys(idb.dump("beatgaler-catalog-first-block", "entries"))).toEqual(Array.from({ length: 8 }, (_, i) => entryKey(ID, `q${i + 3}`)).sort());
  });

  it("invalidateAccount / dropBeat / usage operan sobre el disco; corrupto → se borra al leer", async () => {
    const { idb, cache } = firstBlock();
    await cache.write(ID, "q1", page()); await cache.write({ ...ID, accountId: "u2" }, "q1", page(1));
    expect(await cache.usage("u1")).toMatchObject({ entries: 1 });
    expect(await cache.dropBeat("u1", "b0")).toBe(1); expect(sortedKeys(idb.dump("beatgaler-catalog-first-block", "entries"))).toEqual([entryKey({ ...ID, accountId: "u2" }, "q1")]);
    await cache.write(ID, "q2", page()); expect(await cache.invalidateAccount("u1")).toBe(1);
    idb.dump("beatgaler-catalog-first-block", "entries")!.set(entryKey({ ...ID, accountId: "u2" }, "q1"), { key: entryKey({ ...ID, accountId: "u2" }, "q1"), v: 9 });
    expect(await cache.read({ ...ID, accountId: "u2" }, "q1")).toBeNull();
    await settle(); expect(idb.dump("beatgaler-catalog-first-block", "entries")!.size).toBe(0);
  });

  it("errores: abrir falla → sin copia / `error` sin lanzar y SE REINTENTA abrir en la operación siguiente; bloqueado = fallo; transacción abortada = `error`", async () => {
    const { idb, cache } = firstBlock();
    idb.faults.failOpen = new Error("blocked by browser");
    expect(await cache.read(ID, "q")).toBeNull(); expect(await cache.write(ID, "q", page())).toEqual({ ok: false, reason: "error" });
    expect(await cache.usage("u1")).toEqual({ entries: 0, bytes: 0 }); expect(await cache.invalidateAccount("u1")).toBe(0);
    idb.faults.failOpen = null; idb.faults.blockOpen = true;
    expect(await cache.write(ID, "q", page())).toEqual({ ok: false, reason: "error" });
    idb.faults.blockOpen = false;
    expect(await cache.write(ID, "q", page())).toEqual({ ok: true }); // abrir se reintenta tras un fallo (no se cachea el rechazo)
    expect(idb.opens.length).toBe(6); // read, write, usage, invalidate, write(bloqueado), write(ok): cada operación reabre tras el fallo
    idb.faults.abortTx = ({ mode }) => (mode === "readwrite" ? new Error("aborted") : null);
    expect(await cache.write(ID, "q2", page())).toEqual({ ok: false, reason: "error" });
    expect(sortedKeys(idb.dump("beatgaler-catalog-first-block", "entries"))).toEqual([entryKey(ID, "q")]); // la transacción abortada no dejó nada
  });

  it("cuota: libera TODAS las demás copias y reintenta una vez (ok); si sigue llena → `quota`", async () => {
    const { idb, cache } = firstBlock();
    await cache.write({ ...ID, accountId: "otra" }, "q", page()); await cache.write(ID, "old", page());
    let fails = 1; idb.faults.abortTx = ({ mode }) => (mode === "readwrite" && fails-- > 0 ? quotaError() : null);
    expect(await cache.write(ID, "new", page())).toEqual({ ok: true });
    expect(sortedKeys(idb.dump("beatgaler-catalog-first-block", "entries"))).toEqual([entryKey(ID, "new")]);
    idb.faults.abortTx = ({ mode }) => (mode === "readwrite" ? quotaError() : null);
    expect(await cache.write(ID, "x", page())).toEqual({ ok: false, reason: "quota" });
  });

  it("lectura lenta (abrir no responde) → sin copia dentro del plazo; onversionchange cierra la conexión y la siguiente operación reabre", async () => {
    const slow = firstBlock(undefined, { readTimeoutMs: 20 }); slow.idb.faults.hangOpen = true;
    expect(await slow.cache.read(ID, "q")).toBeNull(); expect(await slow.cache.candidates("u1")).toEqual([]);
    const { idb, cache } = firstBlock();
    await cache.write(ID, "q", page()); expect(idb.opens.length).toBe(1);
    const h = idb.handles.at(-1)!; (h as unknown as { onversionchange: () => void }).onversionchange();
    expect(h.closed).toBe(true);
    expect(await cache.read(ID, "q")).not.toBeNull(); expect(idb.opens.length).toBe(2);
  });
});

// ---------------------------------------------------------------- prefijos (E71)
const PDB = "beatgaler-catalog-prefix";
function prefix(opts: { maxBytes?: number; now?: () => number } = {}, idb = createFakeIndexedDb()) {
  vi.stubGlobal("indexedDB", idb);
  return { idb, cache: createPrefixCache({ backend: "indexeddb", ...opts }) };
}
const putPrefix = (c: ReturnType<typeof createPrefixCache>, f: Uint8Array, account = "a") => c.put({ account, fileSha256: sha(f), fileSize: f.length, bytes: f.subarray(0, PREFIX_BYTES), source: "pack" });

describe("IndexedDB · prefijos de audio", () => {
  it("abre/crea beatgaler-catalog-prefix v1, store `prefixes` sin keyPath, clave cuenta|sha; guarda, lee, persiste y verifica el hash propio", async () => {
    const { idb, cache } = prefix(); const f = bytesOf(300_000, 1);
    expect(await putPrefix(cache, f)).toBe(true);
    const db = idb.databases.get(PDB)!;
    expect(db.version).toBe(1); expect([...db.stores.keys()]).toEqual(["prefixes"]); expect(db.stores.get("prefixes")!.keyPath).toBeNull();
    expect(sortedKeys(await disk(idb, PDB, "prefixes"))).toEqual([`a|${sha(f)}`]);
    const stored = idb.dump(PDB, "prefixes")!.get(`a|${sha(f)}`) as { bytes: Uint8Array; fileSize: number; source: string; prefixSha256: string };
    expect(stored).toMatchObject({ fileSize: 300_000, source: "pack", prefixSha256: sha(f.subarray(0, PREFIX_BYTES)) }); expect(stored.bytes.byteLength).toBe(PREFIX_BYTES);
    const again = prefix({}, idb).cache; // recarga
    expect((await again.get("a", sha(f)))!.bytes).toEqual(f.subarray(0, PREFIX_BYTES));
    expect(await again.get("b", sha(f))).toBeNull(); expect(await again.has("a", sha(f))).toBe(true);
    expect(await again.usage("a")).toEqual({ entries: 1, bytes: PREFIX_BYTES });
    stored.bytes[0] ^= 0xff; // bytes dañados en disco → se descarta
    expect(await again.get("a", sha(f))).toBeNull(); expect(sortedKeys(await disk(idb, PDB, "prefixes"))).toEqual([]);
  });

  it("LRU por bytes: expulsa el de menor `lastUsed` en memoria; el uso (get) NO se persiste → tras recargar manda el momento de guardado; un prefijo mayor que el tope se guarda y se expulsa a sí mismo", async () => {
    let t = 1000; const { idb, cache } = prefix({ maxBytes: 2 * PREFIX_BYTES, now: () => t });
    const [fa, fb, fc] = [bytesOf(200_000, 1), bytesOf(200_000, 2), bytesOf(200_000, 3)];
    await putPrefix(cache, fa); t += 10; await putPrefix(cache, fb); t += 10;
    await cache.get("a", sha(fa)); t += 10; // «a» se usa (solo en el índice en memoria)
    await putPrefix(cache, fc); // excede el tope → sale la menos usada = «b»
    expect(sortedKeys(await disk(idb, PDB, "prefixes"))).toEqual([`a|${sha(fa)}`, `a|${sha(fc)}`].sort());
    expect(cache.metrics).toMatchObject({ evictions: 1, entries: 2, bytes: 2 * PREFIX_BYTES });
    // tras recargar, el último uso persistido es el de guardado: «a» (más antiguo) sale antes que «c»
    t += 10; const re = prefix({ maxBytes: 2 * PREFIX_BYTES, now: () => t }, idb).cache; const fd = bytesOf(200_000, 4);
    await putPrefix(re, fd);
    expect(sortedKeys(await disk(idb, PDB, "prefixes"))).toEqual([`a|${sha(fc)}`, `a|${sha(fd)}`].sort());
    const tiny = prefix({ maxBytes: 1000 }); const fe = bytesOf(200_000, 5);
    expect(await putPrefix(tiny.cache, fe)).toBe(true); expect(tiny.cache.metrics).toMatchObject({ entries: 0, bytes: 0, evictions: 1 }); expect((await disk(tiny.idb, PDB, "prefixes"))!.size).toBe(0);
  });

  it("dropAccount / drop / keys sobre el disco", async () => {
    const { idb, cache } = prefix(); const [f1, f2] = [bytesOf(1000, 1), bytesOf(1000, 2)];
    await putPrefix(cache, f1); await putPrefix(cache, f2); await putPrefix(cache, f1, "b");
    expect([...(await cache.keys("a"))].sort()).toEqual([sha(f1), sha(f2)].sort());
    await cache.drop("a", sha(f1)); await cache.dropAccount("a");
    expect(sortedKeys(await disk(idb, PDB, "prefixes"))).toEqual([`b|${sha(f1)}`]);
  });

  it("error al abrir: el índice no carga → `available:false` y trabaja en memoria esta sesión; el rechazo de abrir queda CACHEADO (no reintenta)", async () => {
    const { idb, cache } = prefix(); const f = bytesOf(1000, 1);
    idb.faults.failOpen = new Error("private mode");
    expect(await cache.get("a", sha(f))).toBeNull(); // lectura: safe → miss
    expect(await putPrefix(cache, f)).toBe(true); // el índice no carga → memoria
    expect(cache.available).toBe(false); expect(await cache.has("a", sha(f))).toBe(true); expect((await cache.get("a", sha(f)))!.bytes.byteLength).toBe(1000);
    expect(idb.databases.size).toBe(0);
    // el rechazo de open() se cachea: aunque el navegador ya funcione, una caché que falló una vez no reabre
    const solo = prefix(); const g = bytesOf(2000, 2); expect(await putPrefix(solo.cache, g)).toBe(true);
    const re = prefix({}, solo.idb).cache; solo.idb.faults.failOpen = new Error("x");
    expect(await re.get("a", sha(g))).toBeNull(); solo.idb.faults.failOpen = null;
    expect(await re.get("a", sha(g))).toBeNull();
  });

  it("errores de escritura: petición fallida → put=false (rejected); transacción abortada TRAS el éxito de la petición → put=true pero nada queda en disco (asimetría respecto a portadas)", async () => {
    const { idb, cache } = prefix(); const [f1, f2] = [bytesOf(1000, 1), bytesOf(1000, 2)];
    await putPrefix(cache, f1); // carga el índice y crea la base
    idb.faults.failRequest = ({ op }) => (op === "put" ? quotaError() : null);
    expect(await putPrefix(cache, f2)).toBe(false); expect(cache.metrics.rejected).toBe(1);
    idb.faults.failRequest = undefined;
    idb.faults.abortTx = ({ mode }) => (mode === "readwrite" ? quotaError() : null);
    expect(await putPrefix(cache, f2)).toBe(true);
    expect(sortedKeys(await disk(idb, PDB, "prefixes"))).toEqual([`a|${sha(f1)}`]);
  });

  it("lectura que no responde → miss al cabo de ~250 ms (sin bloquear la reproducción)", async () => {
    const { idb, cache } = prefix(); const f = bytesOf(1000, 1); await putPrefix(cache, f);
    idb.faults.hangTx = true; const t0 = Date.now();
    expect(await prefix({}, idb).cache.get("a", sha(f))).toBeNull();
    const dt = Date.now() - t0; expect(dt).toBeGreaterThanOrEqual(200); expect(dt).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------- portadas (E79)
const ADB = "beatgaler-catalog-artwork";
function artwork(opts: { maxBytes?: number; maxEntryBytes?: number; touchEveryMs?: number; now?: () => number } = {}, idb = createFakeIndexedDb()) {
  vi.stubGlobal("indexedDB", idb);
  return { idb, cache: createArtworkCache(opts) };
}

describe("IndexedDB · portadas originales", () => {
  it("abre/crea beatgaler-catalog-artwork v1 con stores `meta` y `blobs` (sin keyPath, clave = key); guarda juntos, lee, persiste; una portada por beat", async () => {
    const { idb, cache } = artwork();
    expect(await cache.put({ key: "A|1|f-1|3", account: "A", beatId: "b1", blob: blob(100, 1) })).toBe(true);
    const db = idb.databases.get(ADB)!;
    expect(db.version).toBe(1); expect([...db.stores.keys()].sort()).toEqual(["blobs", "meta"]); expect(db.stores.get("meta")!.keyPath).toBeNull(); expect(db.stores.get("blobs")!.keyPath).toBeNull();
    expect(sortedKeys(idb.dump(ADB, "meta"))).toEqual(["A|1|f-1|3"]); expect(sortedKeys(idb.dump(ADB, "blobs"))).toEqual(["A|1|f-1|3"]);
    expect(idb.dump(ADB, "meta")!.get("A|1|f-1|3")).toMatchObject({ key: "A|1|f-1|3", account: "A", beatId: "b1", size: 100 });
    const again = artwork({}, idb).cache;
    expect(new Uint8Array(await (await again.get("A|1|f-1|3"))!.arrayBuffer())).toEqual(new Uint8Array(100).fill(1));
    expect(await again.get("B|1|f-1|3")).toBeNull();
    await again.put({ key: "A|1|f-2|4", account: "A", beatId: "b1", blob: blob(50) }); // reemplazo: borra la anterior de AMBAS stores
    expect(sortedKeys(idb.dump(ADB, "meta"))).toEqual(["A|1|f-2|4"]); expect(sortedKeys(idb.dump(ADB, "blobs"))).toEqual(["A|1|f-2|4"]);
    expect(await again.usage("A")).toEqual({ entries: 1, bytes: 50 });
    await again.dropBeat("A", "b1"); expect(idb.dump(ADB, "meta")!.size + idb.dump(ADB, "blobs")!.size).toBe(0);
  });

  it("LRU por bytes con el último uso PERSISTIDO (touch ≥ touchEveryMs): expulsa la menos usada; la recién guardada nunca; tope por entrada", async () => {
    let t = 1000; const mk = (idb?: ReturnType<typeof createFakeIndexedDb>) => artwork({ maxBytes: 250, maxEntryBytes: 120, touchEveryMs: 10, now: () => t }, idb);
    const { idb, cache } = mk();
    await cache.put({ key: "k-a", account: "A", beatId: "a", blob: blob(100) }); t += 100;
    await cache.put({ key: "k-b", account: "A", beatId: "b", blob: blob(100) }); t += 100;
    expect(await cache.put({ key: "k-big", account: "A", beatId: "big", blob: blob(121) })).toBe(false);
    expect(await cache.get("k-a")).not.toBeNull(); await settle(); t += 100;
    expect((idb.dump(ADB, "meta")!.get("k-a") as { lastUsed: number }).lastUsed).toBe(1200); // el uso se escribió en disco
    const re = mk(idb).cache; await re.put({ key: "k-c", account: "A", beatId: "c", blob: blob(100) });
    expect(sortedKeys(idb.dump(ADB, "meta"))).toEqual(["k-a", "k-c"]); expect(sortedKeys(idb.dump(ADB, "blobs"))).toEqual(["k-a", "k-c"]);
    expect(re.metrics).toMatchObject({ evictions: 1, bytes: 200, entries: 2 });
    const solo = artwork({ maxBytes: 50, now: () => t }); await solo.cache.put({ key: "k-z", account: "A", beatId: "z", blob: blob(100) });
    expect(sortedKeys(solo.idb.dump(ADB, "meta"))).toEqual(["k-z"]); // la recién guardada sobrevive aunque exceda sola el tope
  });

  it("error al abrir (índice ilegible) → trabaja en memoria esta sesión (put=true, nada en disco); el rechazo de abrir queda cacheado", async () => {
    const { idb, cache } = artwork(); idb.faults.failOpen = new Error("blocked");
    expect(await cache.get("k1")).toBeNull();
    expect(await cache.put({ key: "k2", account: "A", beatId: "b2", blob: blob(10) })).toBe(true);
    expect((await cache.get("k2"))!.size).toBe(10); expect(idb.databases.size).toBe(0);
    idb.faults.failOpen = null; // sigue en memoria: el backend ya se sustituyó
    await cache.put({ key: "k3", account: "A", beatId: "b3", blob: blob(10) }); expect(idb.databases.size).toBe(0);
  });

  it("errores de escritura: cuota/aborto/petición fallida → put=false y NADA queda (ni meta ni blob); lectura fallida → miss y el registro se elimina del disco", async () => {
    const { idb, cache } = artwork(); await cache.put({ key: "k1", account: "A", beatId: "b1", blob: blob(40) });
    idb.faults.abortTx = ({ mode }) => (mode === "readwrite" ? quotaError() : null);
    expect(await cache.put({ key: "k2", account: "A", beatId: "b2", blob: blob(10) })).toBe(false);
    idb.faults.abortTx = undefined; idb.faults.failRequest = ({ op, store }) => (op === "put" && store === "blobs" ? quotaError() : null);
    expect(await cache.put({ key: "k3", account: "A", beatId: "b3", blob: blob(10) })).toBe(false);
    idb.faults.failRequest = undefined;
    expect(sortedKeys(idb.dump(ADB, "meta"))).toEqual(["k1"]); expect(sortedKeys(idb.dump(ADB, "blobs"))).toEqual(["k1"]);
    idb.faults.failRequest = ({ op }) => (op === "get" ? new Error("io") : null);
    expect(await cache.get("k1")).toBeNull(); idb.faults.failRequest = undefined; await settle();
    expect(idb.dump(ADB, "meta")!.size + idb.dump(ADB, "blobs")!.size).toBe(0); expect(cache.metrics).toMatchObject({ misses: 1, entries: 0, bytes: 0 });
  });

  it("abrir no responde → tras ~1 s el índice cae a memoria y la Gallery no se bloquea", async () => {
    const { idb, cache } = artwork(); idb.faults.hangOpen = true; const t0 = Date.now();
    expect(await cache.put({ key: "k1", account: "A", beatId: "b1", blob: blob(10) })).toBe(true);
    const dt = Date.now() - t0; expect(dt).toBeGreaterThanOrEqual(900); expect(dt).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------- módulo común (catalogIdb)
describe("catalogIdb · inyección uniforme y LRU", () => {
  it("las tres cachés aceptan un IDBFactory inyectado (sin tocar el global) y usan la misma base de datos que con el global", async () => {
    const idb = createFakeIndexedDb(); const f = bytesOf(1000, 1);
    expect(await createPrefixCache({ idb: idb as unknown as IDBFactory }).put({ account: "a", fileSha256: sha(f), fileSize: 1000, bytes: f, source: "pack" })).toBe(true);
    expect(await createArtworkCache({ idb: idb as unknown as IDBFactory }).put({ key: "k", account: "A", beatId: "b", blob: blob(10) })).toBe(true);
    expect(await createFirstBlockCache({ backend: indexedDbFirstBlockBackend(idb as unknown as IDBFactory) }).write(ID, "q", page())).toEqual({ ok: true });
    await settle(); expect([...idb.databases.keys()].sort()).toEqual([ADB, PDB, "beatgaler-catalog-first-block"].sort());
    expect(createPrefixCache({ idb: null }).available).toBe(true); // sin IndexedDB: memoria
    expect(indexedDbFirstBlockBackend(null)).toBeNull();
  });

  it("evictLeastRecentlyUsed: menos usada primero, desempate estable, se detiene al llegar al tope y nunca expulsa la protegida", async () => {
    const { evictLeastRecentlyUsed } = await import("../../src/features/library/catalog/catalogIdb");
    const m = new Map([["a", { lastUsed: 3, size: 10 }], ["b", { lastUsed: 1, size: 10 }], ["c", { lastUsed: 1, size: 10 }], ["d", { lastUsed: 2, size: 10 }]]);
    let total = 40; const out: string[] = [];
    const n = await evictLeastRecentlyUsed(m.entries(), { totalBytes: () => total, maxBytes: 20, evict: async (k, e) => { out.push(k); total -= e.size; } });
    expect([n, out]).toEqual([2, ["b", "c"]]);
    total = 40; out.length = 0;
    expect(await evictLeastRecentlyUsed(m.entries(), { totalBytes: () => total, maxBytes: 0, protectKey: "d", evict: async (k, e) => { out.push(k); total -= e.size; } })).toBe(2); expect(out).toEqual(["b", "c"]);
  });
});
