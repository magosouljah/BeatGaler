// @vitest-environment node
// E71 — Caché de prefijos (direccionada por contenido), streaming progresivo con SHA-256 incremental y acquireStream del cliente de medios
// (el MAIN de prefijos de E75 se prueba en catalogMainPack.test.ts). Dobles: sin Telegram, sin red, sin MSE real (la compatibilidad MSE real está en el probe de Chrome).
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 30_000 });
import { PREFIX_BYTES, createPrefixCache } from "../../src/features/library/catalog/catalogPrefixCache";
import { feedStream, type StreamSink } from "../../src/features/library/catalog/catalogStreamSource";
import { createCatalogMediaClient } from "../../src/features/library/catalog/catalogMediaClient";
import type { DirectPort } from "../../src/features/library/catalog/catalogDirectTypes";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytesOf = (n: number, salt = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + salt * 7) & 0xff; return b; };
function sink() { const got: Uint8Array[] = []; let ended = false; let failed: Error | null = null; let duration: number | null = null; const s: StreamSink = { append: async (b) => { got.push(b.slice()); }, end: async () => { ended = true; }, fail: (e) => { failed = e; }, setDuration: (d) => { duration = d; } }; return { s, got, get ended() { return ended; }, get failed() { return failed; }, get duration() { return duration; }, all: () => { const n = got.reduce((x, b) => x + b.length, 0); const o = new Uint8Array(n); let p = 0; for (const b of got) { o.set(b, p); p += b.length; } return o; } }; }

describe("catalogPrefixCache", () => {
  it("clave = cuenta + SHA del archivo: sin mezcla de versiones ni cuentas; valida tamaño y hash; LRU por bytes", async () => {
    const c = createPrefixCache({ backend: "memory", maxBytes: 3 * PREFIX_BYTES });
    const f1 = bytesOf(300_000, 1); const f2 = bytesOf(300_000, 2);
    expect(await c.putFromBlob({ account: "a", fileSha256: sha(f1), blob: new Blob([f1 as BlobPart]) })).toBe(true);
    expect((await c.get("a", sha(f1)))!.bytes).toEqual(f1.subarray(0, PREFIX_BYTES));
    expect(await c.get("b", sha(f1))).toBeNull(); // otra cuenta
    expect(await c.get("a", sha(f2))).toBeNull(); // otra versión (otro hash)
    // prefijo con hash declarado distinto o tamaño incorrecto → rechazado
    expect(await c.put({ account: "a", fileSha256: sha(f2), fileSize: f2.length, bytes: f2.subarray(0, PREFIX_BYTES), prefixSha256: "0".repeat(64), source: "pack" })).toBe(false);
    expect(await c.put({ account: "a", fileSha256: sha(f2), fileSize: f2.length, bytes: f2.subarray(0, 1000), source: "pack" })).toBe(false);
    // archivo corto: el prefijo es el archivo completo
    const small = bytesOf(5000, 3); expect(await c.put({ account: "a", fileSha256: sha(small), fileSize: small.length, bytes: small, source: "pack" })).toBe(true);
    for (let i = 4; i < 9; i++) { const f = bytesOf(200_000, i); await c.putFromBlob({ account: "a", fileSha256: sha(f), blob: new Blob([f as BlobPart]) }); }
    expect(c.metrics.bytes).toBeLessThanOrEqual(3 * PREFIX_BYTES); expect(c.metrics.evictions).toBeGreaterThan(0);
    await c.dropAccount("a"); expect((await c.keys("a")).size).toBe(0);
  });
});

describe("feedStream", () => {
  const file = bytesOf(900_000, 5); const fileSha = sha(file);
  const reader = (log: Array<[number, number]>, data = file) => async (off: number, len: number) => { log.push([off, len]); return data.slice(off, off + len); };
  it("con prefijo local: el primer append es inmediato, solo se pide el resto, bytes contiguos y verificación SHA al final", async () => {
    const log: Array<[number, number]> = []; const k = sink();
    const r = await feedStream({ size: file.length, fileSha256: fileSha, prefix: file.slice(0, PREFIX_BYTES), read: reader(log), sink: k.s, signal: new AbortController().signal });
    expect(log[0][0]).toBe(PREFIX_BYTES); expect(log.reduce((n, x) => n + x[1], 0)).toBe(file.length - PREFIX_BYTES);
    expect(k.all()).toEqual(file); expect(k.ended).toBe(true); expect(r).toMatchObject({ prefixUsed: true, verified: true, networkBytes: file.length - PREFIX_BYTES });
    for (let i = 1; i < log.length; i++) expect(log[i][0]).toBe(log[i - 1][0] + log[i - 1][1]); // continuidad
  });
  it("sin prefijo: primera lectura de 128 KiB (se ofrece para la caché) y rangos crecientes; hash incorrecto → falla y no termina", async () => {
    const log: Array<[number, number]> = []; const k = sink(); let offered: Uint8Array | null = null;
    await feedStream({ size: file.length, fileSha256: fileSha, prefix: null, read: reader(log), sink: k.s, signal: new AbortController().signal, onPrefix: (h) => { offered = h; } });
    expect(log[0]).toEqual([0, PREFIX_BYTES]); expect(offered!).toEqual(file.subarray(0, PREFIX_BYTES)); expect(log[2][1]).toBeGreaterThan(log[1][1]);
    const bad = file.slice(); bad[500_000] ^= 1; const k2 = sink(); let integrity: boolean | null = null;
    await expect(feedStream({ size: file.length, fileSha256: fileSha, prefix: null, read: reader([], bad), sink: k2.s, signal: new AbortController().signal, onIntegrity: (ok) => { integrity = ok; } })).rejects.toMatchObject({ code: "MEDIA_HASH_MISMATCH" });
    expect(integrity).toBe(false); expect(k2.failed).not.toBeNull(); expect(k2.ended).toBe(false);
    // un prefijo local corrupto también se detecta al final (el hash cubre todos los bytes en orden)
    const pref = file.slice(0, PREFIX_BYTES); pref[10] ^= 1;
    await expect(feedStream({ size: file.length, fileSha256: fileSha, prefix: pref, read: reader([]), sink: sink().s, signal: new AbortController().signal })).rejects.toMatchObject({ code: "MEDIA_HASH_MISMATCH" });
  });
  it("cancelación (cambio rápido de canción): no se añade nada más y se detienen las lecturas", async () => {
    const ac = new AbortController(); const log: Array<[number, number]> = []; const k = sink();
    const slow = async (off: number, len: number) => { log.push([off, len]); await new Promise((r) => setTimeout(r, 5)); if (off > 0) ac.abort(); return file.slice(off, off + len); };
    await expect(feedStream({ size: file.length, fileSha256: fileSha, prefix: null, read: slow, sink: k.s, signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(k.got.length).toBe(1); expect(log.length).toBeLessThanOrEqual(3);
  });
});

describe("catalogMediaClient.acquireStream", () => {
  const file = bytesOf(700_000, 9); const fsha = sha(file);
  const access = { fileId: "f-1", beatId: "b-1", role: "MASTER", slotKey: "MASTER", revision: "1", filename: "a.mp3", mime: "audio/mpeg", sizeBytes: file.length, partsTotalBytes: file.length, sha256: null, declaredSha256: fsha, cacheKey: "u:1:b-1:f-1:1", epoch: "1", revisionLibrary: "1", ttlMs: 600000,
    parts: [{ partIndex: 0, size: file.length, sha256: fsha, hashVerified: false, verificationLevel: "PROVIDER", bytesVerified: false, direct: { chatId: "-1001", messageId: 9 } }] };
  function harness(prefix: boolean, data = file) {
    const ranges: string[] = []; const posts: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { const u = String(input); if (u.includes("/access")) return new Response(JSON.stringify(access), { status: 201 }); if (u.includes("/bytes")) { posts.push(u); return new Response("{}", { status: 200 }); }
      void init; return new Response("{}", { status: 404 }); }) as typeof fetch;
    // E77: los rangos se leen de Telegram por el puerto directo (doble); el Cloud solo autoriza.
    const direct: DirectPort = { ready: async () => true, close: async () => {}, send: async () => { throw new Error("no"); }, read: async (_ref, o = {}) => { const off = o.offset ?? 0; const len = o.length ?? data.length - off; ranges.push(`bytes=${off}-${off + len - 1}`); return { blob: new Blob([data.slice(off, off + len) as BlobPart]), sha256: null }; } };
    const cache = createPrefixCache({ backend: "memory" }); const k = sink(); let closed = 0;
    const client = createCatalogMediaClient({ fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "t", csrf: () => "c", headers: () => ({ era: "e", epoch: "1" }), accountId: () => "acc", direct, prefixCache: cache, mseSupported: () => true, createSink: () => ({ ...k.s, url: "blob:mse-1", close: () => { closed++; } }), createObjectURL: () => "blob:recent", revokeObjectURL: () => {} });
    return { client, cache, ranges, posts, k, closed: () => closed, prefix };
  }
  it("prefijo local → URL inmediata y solo el resto por rangos; sin prefijo → guarda el prefijo; repetir = memoria reciente sin red", async () => {
    let h = harness(true); await h.cache.put({ account: "acc", fileSha256: fsha, fileSize: file.length, bytes: file.slice(0, PREFIX_BYTES), source: "upload" });
    const lease = await h.client.acquireStream("f-1", "player"); expect(lease.url).toBe("blob:mse-1");
    const r = await lease.stream!; expect(r).toMatchObject({ prefixUsed: true, verified: true }); expect(h.ranges[0]).toBe(`bytes=${PREFIX_BYTES}-${PREFIX_BYTES + 256 * 1024 - 1}`);
    expect(h.k.all()).toEqual(file); expect(h.client.metrics.prefixHits).toBe(1);
    const again = await h.client.acquireStream("f-1", "player"); expect(again.url).toBe("blob:recent"); expect(h.client.metrics.recentHits).toBe(1); expect(h.ranges.length).toBe(r.requests);
    h = harness(false); const l2 = await h.client.acquireStream("f-1", "player"); await l2.stream!;
    expect(h.ranges[0]).toBe(`bytes=0-${PREFIX_BYTES - 1}`); expect(await h.cache.has("acc", fsha)).toBe(true);
    await new Promise((r2) => setTimeout(r2, 0)); expect(h.posts.length).toBe(1); // BYTES atestiguado tras verificar
  });
  it("bytes alterados → MEDIA_HASH_MISMATCH, se borra el prefijo local y no queda en memoria reciente; release cancela", async () => {
    const bad = file.slice(); bad[600_000] ^= 1; const h = harness(false, bad);
    const l = await h.client.acquireStream("f-1", "player");
    await expect(l.stream!).rejects.toMatchObject({ code: "MEDIA_HASH_MISMATCH" });
    await new Promise((r) => setTimeout(r, 0)); expect(await h.cache.has("acc", fsha)).toBe(false); expect(h.client.metrics.hashMismatches).toBe(1);
    const l2 = await h.client.acquireStream("f-1", "player"); expect(l2.url).toBe("blob:mse-1"); l2.release(); await expect(l2.stream!).rejects.toBeTruthy(); expect(h.closed()).toBeGreaterThan(0);
  });
});
