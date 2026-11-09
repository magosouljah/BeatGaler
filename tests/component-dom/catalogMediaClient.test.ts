// @vitest-environment node
// T14 — Cliente de medios: concesión por archivo con caché por época/revisión; descarga multipart completa en orden con verificación de
// tamaño; refcount por consumidor (la URL solo se revoca con refcount 0, nunca por evicción); artwork perezoso con concurrencia 4 y LRU por
// bytes; denegado en TRASH; invalidación por evento autoritativo; teardown por cuenta libera todo. Sin red: fetch del fake.
import { describe, expect, it } from "vitest";
import { createCatalogMediaClient } from "../../src/features/library/catalog/catalogMediaClient";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

function harness(opts: Parameters<typeof createCatalogFakeCommands>[0] = {}) {
  const server = createCatalogFakeCommands({ beats: fakeBeats(20), ...opts });
  let account = "acc-1"; const urls: string[] = []; const revoked: string[] = []; let n = 0;
  const client = createCatalogMediaClient({ fetchImpl: server.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }), accountId: () => account, artworkBudgetBytes: 3000, artworkConcurrency: 2, createObjectURL: () => { const u = `blob:fake/${++n}`; urls.push(u); return u; }, revokeObjectURL: (u) => { revoked.push(u); } });
  return { server, client, urls, revoked, setAccount: (a: string) => { account = a; } };
}

describe("catalogMediaClient", () => {
  it("access: una concesión por archivo reutilizada hasta caducar; descarga multipart en orden = bytes originales; tamaño verificado; denegado en TRASH; otra cuenta → error", async () => {
    const h = harness();
    const a1 = await h.client.access("f-g1"); const a2 = await h.client.access("f-g1");
    expect(a1).toBe(a2); expect(h.server.mediaStats.accesses).toBe(1);
    expect(a1.parts.map((p) => p.partIndex)).toEqual([0, 1]); expect(a1.cacheKey).toMatch(/^fake:1:g1:f-g1:1$/);
    expect(JSON.stringify(a1)).not.toMatch(/chat|message|bot/i);
    const { blob, verified } = await h.client.downloadFile("f-g1");
    const expected = h.server.mediaBytes("g1");
    expect(blob.size).toBe(expected.length); expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected); expect(verified).toBe("SIZE");
    expect(h.server.mediaStats.streams).toBe(2);
    const part = await h.client.fetchPart(a1.parts[0], { range: "bytes=0-9" });
    expect(part.size).toBe(10); expect(new Uint8Array(await part.arrayBuffer())).toEqual(expected.subarray(0, 10));
    h.server.beats.get("g2")!.state = "TRASH";
    await expect(h.client.access("f-g2")).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(h.client.metrics.denied).toBe(1);
    h.server.beats.get("g2")!.state = "ACTIVE";
    expect((await h.client.access("f-g2")).beatId).toBe("g2");
    h.server.expireGrants();
    await expect(h.client.fetchPart(a1.parts[0])).rejects.toMatchObject({ code: "MEDIA_GRANT_EXPIRED" });
    const fresh = await h.client.access("f-g1", { force: true }); expect(fresh).not.toBe(a1);
  });

  it("media manager: refcount por consumidor; la URL se comparte entre grid/player y solo se revoca con refcount 0; la evicción (release del grid) no corta al player; teardown libera todo", async () => {
    const h = harness();
    const grid = await h.client.acquire("f-g3", "grid"); const player = await h.client.acquire("f-g3", "player"); const grid2 = await h.client.acquire("f-g3", "grid");
    expect(player.url).toBe(grid.url); expect(h.client.refcount(grid.cacheKey)).toBe(3); expect(h.urls.length).toBe(1); expect(h.server.mediaStats.streams).toBe(2);
    grid.release(); grid2.release(); grid.release(); // release idempotente
    expect(h.client.refcount(grid.cacheKey)).toBe(1); expect(h.revoked).toEqual([]);
    player.release();
    expect(h.client.refcount(grid.cacheKey)).toBe(0); expect(h.revoked).toEqual([grid.url]); expect(h.client.metrics.urlsAlive).toBe(0);
    const again = await h.client.acquire("f-g3", "player"); expect(again.url).not.toBe(grid.url);
    // descarga concurrente del mismo archivo: una sola transferencia compartida
    const before = h.server.mediaStats.streams;
    const [x, y] = await Promise.all([h.client.acquire("f-g4", "a"), h.client.acquire("f-g4", "b")]);
    expect(x.url).toBe(y.url); expect(h.server.mediaStats.streams - before).toBe(2);
    h.setAccount("acc-2"); h.client.teardown();
    expect(h.client.metrics.urlsAlive).toBe(0); expect(h.revoked).toContain(again.url); expect(h.revoked).toContain(x.url);
    expect(h.client.metrics.leasesActive).toBe(0);
  });

  it("artwork perezoso: ≤2 descargas concurrentes (opción), LRU por bytes acotado, cache hit sin red, invalidate por beat revoca su artwork", async () => {
    const h = harness();
    const urls = await Promise.all(["g5", "g6", "g7", "g8"].map((id) => h.client.loadArtwork(`f-${id}`)));
    expect(new Set(urls).size).toBe(4);
    expect(h.client.metrics.artworkBytes).toBeLessThanOrEqual(3000);
    expect(h.client.metrics.artworkEvictions).toBeGreaterThan(0);
    const hitBefore = h.server.mediaStats.streams;
    const last = await h.client.loadArtwork("f-g8"); expect(last).toBe(urls[3]); expect(h.server.mediaStats.streams).toBe(hitBefore);
    h.client.invalidate("g8");
    expect(h.revoked).toContain(urls[3]);
    expect(h.client.metrics.artworkEntries).toBeLessThanOrEqual(3);
  });
});
