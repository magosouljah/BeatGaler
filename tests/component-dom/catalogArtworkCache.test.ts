// @vitest-environment node
// E79 — Caché persistente de portadas originales: persistencia entre cargas de la Gallery, separación por cuenta/archivo/revisión, una portada por
// beat, invalidación al reemplazar o desvincular, LRU por bytes y tolerancia a fallos de almacenamiento; y su uso por el cliente de medios
// (frío → caliente sin peticiones al Cloud ni a Telegram). Sin red: «Telegram» y Cloud simulados.
import { describe, expect, it } from "vitest";
import { createArtworkCache, memoryArtworkBackend, type ArtworkBackend } from "../../src/features/library/catalog/catalogArtworkCache";
import { createCatalogMediaClient } from "../../src/features/library/catalog/catalogMediaClient";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

const blob = (n: number, fill = 7) => new Blob([new Uint8Array(n).fill(fill)]);
const bytesOf = async (b: Blob | null) => (b ? [...new Uint8Array(await b.arrayBuffer())] : null);
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("catalogArtworkCache", () => {
  it("persiste entre instancias (recargar la Gallery / reiniciar el navegador) y nunca mezcla cuenta, archivo ni revisión", async () => {
    const backend = memoryArtworkBackend();
    const first = createArtworkCache({ backend });
    expect(await first.put({ key: "A|1|f-1|3", account: "A", beatId: "b1", blob: blob(100, 1) })).toBe(true);
    const reloaded = createArtworkCache({ backend }); // instancia nueva sobre el mismo almacenamiento
    expect(await bytesOf(await reloaded.get("A|1|f-1|3"))).toEqual(new Array(100).fill(1));
    for (const other of ["B|1|f-1|3", "A|2|f-1|3", "A|1|f-2|3", "A|1|f-1|4"]) expect(await reloaded.get(other)).toBeNull(); // otra cuenta / época / archivo / revisión
    expect(reloaded.metrics).toMatchObject({ hits: 1, misses: 4, entries: 1, bytes: 100 });
  });

  it("una portada por beat: guardar la nueva borra la anterior; dropBeat (desvinculada) borra solo la de ese beat y cuenta", async () => {
    const backend = memoryArtworkBackend(); const cache = createArtworkCache({ backend });
    await cache.put({ key: "A|1|f-old|1", account: "A", beatId: "b1", blob: blob(50) });
    await cache.put({ key: "A|1|f-x|1", account: "A", beatId: "b2", blob: blob(60) });
    await cache.put({ key: "B|1|f-y|1", account: "B", beatId: "b1", blob: blob(70) });
    await cache.put({ key: "A|1|f-new|2", account: "A", beatId: "b1", blob: blob(80) }); // reemplazo: otra referencia del mismo beat
    expect(await cache.get("A|1|f-old|1")).toBeNull();
    expect((await backend.metas()).map((m) => m.key).sort()).toEqual(["A|1|f-new|2", "A|1|f-x|1", "B|1|f-y|1"]);
    await cache.dropBeat("A", "b1");
    expect((await backend.metas()).map((m) => m.key).sort()).toEqual(["A|1|f-x|1", "B|1|f-y|1"]);
    expect(await backend.read("A|1|f-new|2")).toBeNull(); // imagen y registro se borran juntos
    expect(cache.metrics).toMatchObject({ entries: 2, bytes: 130 });
  });

  it("almacenamiento acotado: LRU por bytes con el último uso persistido; una imagen mayor que el tope por entrada no se guarda", async () => {
    const backend = memoryArtworkBackend(); let t = 1000;
    const make = () => createArtworkCache({ backend, maxBytes: 250, maxEntryBytes: 120, touchEveryMs: 10, now: () => t });
    let cache = make();
    await cache.put({ key: "k-a", account: "A", beatId: "a", blob: blob(100) }); t += 100;
    await cache.put({ key: "k-b", account: "A", beatId: "b", blob: blob(100) }); t += 100;
    expect(await cache.put({ key: "k-big", account: "A", beatId: "big", blob: blob(121) })).toBe(false);
    expect(await cache.get("k-a")).not.toBeNull(); await settle(); t += 100; // «a» se usa: su último uso se persiste
    cache = make(); // tras recargar, el orden de expulsión sigue siendo por último uso real
    await cache.put({ key: "k-c", account: "A", beatId: "c", blob: blob(100) });
    expect((await backend.metas()).map((m) => m.key).sort()).toEqual(["k-a", "k-c"]); // se expulsó «b», la menos usada
    expect(cache.metrics).toMatchObject({ evictions: 1, bytes: 200, entries: 2 });
  });

  it("fallos de almacenamiento = caché vacía, nunca un error: lectura rota, imagen truncada, escritura rechazada o índice ilegible", async () => {
    const base = memoryArtworkBackend();
    const cache = createArtworkCache({ backend: base });
    await cache.put({ key: "k1", account: "A", beatId: "b1", blob: blob(40) });
    const truncated: ArtworkBackend = { ...base, read: async () => blob(10) };
    const c2 = createArtworkCache({ backend: truncated });
    expect(await c2.get("k1")).toBeNull(); expect(await base.metas()).toEqual([]); // la entrada dañada se elimina
    const failing: ArtworkBackend = { metas: async () => { throw new Error("blocked"); }, read: async () => { throw new Error("x"); }, write: async () => { throw new Error("quota"); }, touch: async () => {}, remove: async () => {} };
    const c3 = createArtworkCache({ backend: failing });
    expect(await c3.get("k1")).toBeNull();
    expect(await c3.put({ key: "k2", account: "A", beatId: "b2", blob: blob(10) })).toBe(true); // índice ilegible → sigue en memoria esta sesión
    const noWrite: ArtworkBackend = { ...memoryArtworkBackend(), write: async () => { throw new Error("quota"); } };
    expect(await createArtworkCache({ backend: noWrite }).put({ key: "k3", account: "A", beatId: "b3", blob: blob(10) })).toBe(false);
  });
});

function harness(backend: ArtworkBackend, server = createCatalogFakeCommands({ beats: fakeBeats(20) }), account = "acc-1") {
  let n = 0; const revoked: string[] = [];
  const cache = createArtworkCache({ backend });
  const client = createCatalogMediaClient({ direct: server.directPort, fetchImpl: server.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }), accountId: () => account, artworkCache: cache, createObjectURL: () => `blob:fake/${++n}`, revokeObjectURL: (u) => { revoked.push(u); } });
  return { server, client, cache, revoked };
}
const ref = (id: string, revision = "1") => ({ fileId: `f-${id}`, revision });

describe("catalogMediaClient + caché persistente de portadas", () => {
  it("frío: cada portada se lee una vez de Telegram; caliente (Gallery recargada): 0 peticiones al Cloud y 0 lecturas de Telegram", async () => {
    const backend = memoryArtworkBackend(); const ids = ["g1", "g2", "g3", "g4", "g5", "g6"];
    const cold = harness(backend);
    const [u1, u1bis] = await Promise.all([cold.client.loadArtwork(ref("g1"), "g1"), cold.client.loadArtwork(ref("g1"), "g1")]); // dos tarjetas a la vez: una sola carga
    expect(u1).toBe(u1bis);
    await Promise.all(ids.slice(1).map((id) => cold.client.loadArtwork(ref(id), id)));
    await settle();
    expect([cold.server.mediaStats.accesses, cold.server.mediaStats.streams]).toEqual([6, 12]); // 6 archivos × 2 partes
    expect(cold.client.metrics).toMatchObject({ artworkDownloads: 6, artworkStored: 0 });
    expect(await cold.client.loadArtwork(ref("g1"), "g1")).toBe(u1); // misma sesión: memoria, ni siquiera se abre el disco
    expect(cold.cache.metrics.hits).toBe(0);

    const warm = harness(backend, cold.server); // recarga: cliente y caché nuevos, mismo almacenamiento
    const before = { ...warm.server.mediaStats };
    const urls = await Promise.all(ids.map((id) => warm.client.loadArtwork(ref(id), id)));
    expect(new Set(urls).size).toBe(6);
    expect(warm.server.mediaStats).toEqual(before); // ni concesiones (Cloud) ni lecturas (Telegram)
    expect(warm.client.metrics).toMatchObject({ artworkDownloads: 0, artworkStored: 6, accesses: 0, directReads: 0 });
    expect(await bytesOf(await warm.cache.get("acc-1|1|f-g3|1"))).toEqual([...warm.server.mediaBytes("g3")]); // los bytes originales, íntegros
  });

  it("invalidación: reemplazo (otra revisión) vuelve a leer y sustituye la entrada; desvinculada se borra del disco; otra cuenta no la ve; un DTO desfasado no se persiste", async () => {
    const backend = memoryArtworkBackend(); const h = harness(backend);
    await h.client.loadArtwork(ref("g1"), "g1"); await h.client.loadArtwork(ref("g2"), "g2"); await settle();
    // reemplazo confirmado por PostgreSQL: el DTO trae otra revisión
    h.server.beats.get("g1")!.version = 2;
    const a0 = h.server.mediaStats.accesses;
    await h.client.loadArtwork(ref("g1", "2"), "g1"); await settle();
    expect(h.server.mediaStats.accesses).toBe(a0 + 1);
    expect((await backend.metas()).map((m) => m.key).sort()).toEqual(["acc-1|1|f-g1|2", "acc-1|1|f-g2|1"]);
    // portada desvinculada
    h.client.invalidate("g2"); await settle();
    expect((await backend.metas()).map((m) => m.key)).toEqual(["acc-1|1|f-g1|2"]);
    // otra cuenta en el mismo navegador: su clave es distinta → lee de Telegram
    const other = harness(backend, h.server, "acc-2"); const a1 = h.server.mediaStats.accesses;
    await other.client.loadArtwork(ref("g1", "2"), "g1"); await settle();
    expect(h.server.mediaStats.accesses).toBe(a1 + 1); expect(other.client.metrics.artworkStored).toBe(0);
    // el DTO pide una revisión que el servidor ya no confirma: se muestra lo que hay, pero no se guarda bajo esa clave
    await h.client.loadArtwork(ref("g3", "9"), "g3"); await settle();
    expect((await backend.metas()).some((m) => m.key.includes("f-g3"))).toBe(false);
  });
});
