// @vitest-environment node
// E75 — MAIN de prefijos construido por el navegador. Dobles: un «Cloud» en memoria que solo guarda METADATOS (con las mismas reglas que
// catalog/prefix-packs.js: umbral, ticket único, compare-and-swap) y un «Telegram» en memoria al que solo llega el puerto directo.
// La implementación real del servidor se prueba contra PostgreSQL en catalog-prefix-packs.integration.cjs.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 30_000 });
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";
import { DirectSendError } from "../../src/features/library/catalog/catalogDirectCore";
import type { DirectPort } from "../../src/features/library/catalog/catalogDirectTypes";
import { createMainPackCoordinator, encodeMainPack, rebuildMain, restoreFromMain, type MainEntry, type MainManifest, type MainPackApi } from "../../src/features/library/catalog/catalogMainPack";
import { PREFIX_BYTES, createPrefixCache, type PrefixCache } from "../../src/features/library/catalog/catalogPrefixCache";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytesOf = (n: number, salt = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + salt * 7) & 0xff; return b; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const conflict = (code: string, detail: Record<string, unknown> = {}) => new CatalogApiError(409, code, code, detail);
const THRESHOLD = 5;

/** Biblioteca simulada: Telegram (mensajes con bytes) + PostgreSQL (archivos vigentes, MAIN, ticket). El «Cloud» nunca toca `telegram`. */
function world() {
  const telegram = new Map<number, { bytes: Uint8Array; caption: string }>(); let nextMessage = 100;
  const current = new Map<string, { fileSha256: string; fileSize: number; messageId: number }>(); // fileId → MASTER MP3 vigente
  let main: { packId: string; version: number; sizeBytes: number; sha256: string; messageId: number; entries: MainEntry[] } | null = null;
  let staged: { packId: string; base: number; sizeBytes: number; sha256: string; caption: string; entries: MainEntry[]; at: number } | null = null;
  let seq = 0; let salt = 0; const cloud = { requests: [] as string[], bodyBytes: 0 }; const faults: string[] = [];
  const manifestOf = (): MainManifest => {
    const covered = new Map((main?.entries ?? []).map((e) => [e.fileId, e])); const entries: MainEntry[] = []; const pending: MainManifest["pending"] = [];
    for (const [fileId, f] of current) { const e = covered.get(fileId); if (e && e.fileSha256 === f.fileSha256) entries.push(e); else pending.push({ fileId, fileSha256: f.fileSha256, fileSize: f.fileSize, prefixLength: Math.min(PREFIX_BYTES, f.fileSize), direct: { chatId: "-1001", messageId: f.messageId, partSize: f.fileSize } }); }
    return { generationId: "g1", prefixBytes: PREFIX_BYTES, threshold: THRESHOLD, main: main ? { packId: main.packId, version: String(main.version), sizeBytes: main.sizeBytes, sha256: main.sha256, direct: { chatId: "-1001", messageId: main.messageId } } : null, entries, pending, current: current.size, pendingCount: pending.length, rebuild: pending.length >= THRESHOLD, building: Boolean(staged) };
  };
  const api: MainPackApi = {
    manifest: async () => { cloud.requests.push("manifest"); return manifestOf(); },
    begin: async (body) => {
      cloud.requests.push("begin"); cloud.bodyBytes += JSON.stringify(body).length;
      if (body.baseVersion !== String(main?.version ?? 0)) throw conflict("MAIN_VERSION_CONFLICT");
      if (staged) throw conflict("MAIN_BUILD_IN_PROGRESS", { retryAfterMs: 1000 });
      for (const e of body.entries) { const f = current.get(e.fileId); if (!f || f.fileSha256 !== e.fileSha256) throw conflict("MAIN_ENTRIES_STALE"); }
      staged = { packId: body.packId, base: main?.version ?? 0, sizeBytes: body.sizeBytes, sha256: body.sha256, caption: `catalog:v1 pack=${body.packId}`, entries: body.entries, at: Date.now() };
      return { packId: body.packId, attempt: 1, randomId: "-42", caption: staged.caption, chatId: "-1001", botId: "Bot20", filename: `${body.packId}.bgpack`, mime: "application/octet-stream", size: body.sizeBytes, baseVersion: body.baseVersion, expiresInMs: 600000 };
    },
    publish: async (packId, receipt) => {
      cloud.requests.push("publish");
      if (!staged || staged.packId !== packId) throw conflict("PACK_STATE_CONFLICT");
      const msg = telegram.get(receipt.messageId); // comprobación de METADATOS del mensaje (tamaño y marcador), no de sus bytes
      if (!msg || msg.bytes.byteLength !== staged.sizeBytes || msg.caption !== staged.caption) { staged = null; throw conflict("PACK_VERIFY_FAILED"); }
      if (staged.base !== (main?.version ?? 0)) { staged = null; throw conflict("MAIN_VERSION_CONFLICT"); }
      main = { packId, version: ++seq, sizeBytes: staged.sizeBytes, sha256: staged.sha256, messageId: receipt.messageId, entries: staged.entries }; staged = null;
      return { packId, version: String(main.version) };
    },
    cancel: async (packId) => { cloud.requests.push("cancel"); if (staged?.packId === packId) staged = null; return { cancelled: true }; },
  };
  /** Un navegador: su caché local y su puerto directo hacia el Telegram simulado. */
  function browser(name: string) {
    const cache = createPrefixCache({ backend: "memory" }); const reads: Array<{ messageId: number; offset: number; length: number }> = []; const sent: Array<{ messageId: number; size: number; caption: string }> = [];
    const direct: DirectPort = {
      ready: async () => true, close: async () => {},
      read: async (ref, o = {}) => { const m = telegram.get(ref.messageId); if (!m) throw new Error("no message"); const offset = o.offset ?? 0; const length = o.length ?? m.bytes.byteLength - offset; reads.push({ messageId: ref.messageId, offset, length }); return { blob: new Blob([m.bytes.slice(offset, offset + length) as BlobPart]), sha256: null }; },
      send: async (input) => {
        const f = faults.shift();
        if (f === "rejected") throw new DirectSendError({ kind: "REJECTED", code: "FLOOD_WAIT_9", retryAfterMs: 9000 });
        const bytes = new Uint8Array(await input.blob.arrayBuffer()); const messageId = nextMessage++; telegram.set(messageId, { bytes, caption: input.caption }); sent.push({ messageId, size: bytes.byteLength, caption: input.caption });
        if (f === "lost") throw new DirectSendError({ kind: "UNCERTAIN", code: "TIMEOUT", retryAfterMs: 60000 });
        return { messageId, documentId: "d", size: bytes.byteLength, senderId: "20", chatId: input.chatId };
      },
    };
    /** Subida confirmada de un MASTER MP3 (o reemplazo): bytes a Telegram por el puerto directo, prefijo a la caché local, versión vigente en SQL. */
    async function upload(fileId: string, size = 200_000, { failed = false } = {}) {
      const file = bytesOf(size, ++salt); if (failed) return file;
      const messageId = nextMessage++; telegram.set(messageId, { bytes: file, caption: `catalog:v1 op=o${salt} part=MASTER:0` });
      await cache.putFromBlob({ account: "acc", fileSha256: sha(file), blob: new Blob([file as BlobPart]) });
      current.set(fileId, { fileSha256: sha(file), fileSize: file.length, messageId });
      return file;
    }
    return { name, cache, direct, reads, sent, upload };
  }
  return { api, telegram, current, cloud, faults, browser, manifest: manifestOf, get main() { return main; }, get staged() { return staged; }, expire: () => { staged = null; } };
}
const coordinatorFor = (w: ReturnType<typeof world>, b: { cache: PrefixCache; direct: DirectPort }, over: Partial<Parameters<typeof createMainPackCoordinator>[0]> = {}) =>
  createMainPackCoordinator({ account: "acc", api: w.api, cache: b.cache, direct: b.direct, idleMs: 15, ...over });
/** Importación/reemplazo como lo hace catalogMutations: start → subida → end(confirmada). */
async function transfer(c: ReturnType<typeof createMainPackCoordinator>, run: () => Promise<unknown>, committed = true) { c.transferStarted(); try { await run(); } finally { c.transferFinished(committed); } }
const settle = async (c: ReturnType<typeof createMainPackCoordinator>) => { for (let i = 0; i < 200; i++) { await tick(10); if (!c.state.rebuilding && !(c.state.dirty && c.state.inflight === 0 && !c.state.batchOpen)) { await tick(40); if (!c.state.rebuilding) return; } } };

describe("documento BGPACK01 y restauración desde el MAIN", () => {
  it("la cabecera describe offsets absolutos exactos; un dispositivo vacío restaura todo con UNA lectura, uno con caché no lee nada", async () => {
    const files = Array.from({ length: 6 }, (_, i) => bytesOf(150_000 + i * 1000, 10 + i));
    const items = files.map((f, i) => { const p = f.slice(0, PREFIX_BYTES); return { fileId: `f-${i}`, fileSha256: sha(f), fileSize: f.length, prefixSha256: sha(p), bytes: p }; });
    const doc = encodeMainPack({ packId: "pk-aaaaaaaaaaaa", generationId: "g", prefixBytes: PREFIX_BYTES, items });
    const pack = new Uint8Array(doc.size); let pos = 0; for (const p of doc.parts) { pack.set(p, pos); pos += p.byteLength; }
    expect(new TextDecoder().decode(pack.subarray(0, 8))).toBe("BGPACK01");
    const headerLen = new DataView(pack.buffer).getUint32(8, false); const header = JSON.parse(new TextDecoder().decode(pack.subarray(12, 12 + headerLen)));
    expect(header).toMatchObject({ format: "beatgaler.prefix-pack", kind: "MAIN", packId: "pk-aaaaaaaaaaaa" }); expect(header.entries).toEqual(doc.entries);
    for (const [i, e] of doc.entries.entries()) expect(sha(pack.subarray(e.offset, e.offset + e.length))).toBe(items[i].prefixSha256);
    const manifest: MainManifest = { generationId: "g", prefixBytes: PREFIX_BYTES, threshold: 5, main: { packId: "pk-aaaaaaaaaaaa", version: "1", sizeBytes: pack.length, sha256: sha(pack), direct: { chatId: "-1001", messageId: 77 } }, entries: doc.entries, pending: [], current: 6, pendingCount: 0, rebuild: false, building: false };
    const reads: Array<{ offset?: number; length?: number }> = [];
    const direct: DirectPort = { ready: async () => true, send: async () => { throw new Error("no"); }, close: async () => {}, read: async (ref, o = {}) => { reads.push({ offset: o.offset, length: o.length }); expect(ref).toMatchObject({ chatId: "-1001", messageId: 77 }); return { blob: new Blob([pack.slice(o.offset!, o.offset! + o.length!) as BlobPart]), sha256: null }; } };
    const cache = createPrefixCache({ backend: "memory" });
    expect(await restoreFromMain({ account: "a", manifest, cache, direct, yieldFn: async () => {} })).toMatchObject({ status: "done", wanted: 6, stored: 6, rejected: 0, requests: 1 });
    for (const f of files) expect((await cache.get("a", sha(f)))!.bytes).toEqual(f.subarray(0, PREFIX_BYTES));
    expect(await restoreFromMain({ account: "a", manifest, cache, direct, yieldFn: async () => {} })).toMatchObject({ wanted: 0, requests: 0 }); expect(reads).toHaveLength(1);
    await cache.drop("a", sha(files[3])); pack[doc.entries[3].offset + 5] ^= 0xff; // falta uno y su copia en el MAIN está alterada → rechazado, no se guarda
    expect(await restoreFromMain({ account: "a", manifest, cache, direct, yieldFn: async () => {} })).toMatchObject({ wanted: 1, stored: 0, rejected: 1, requests: 1 });
    expect((await restoreFromMain({ account: "a", manifest, cache, direct: null })).status).toBe("skipped");
    expect(await restoreFromMain({ account: "b", manifest: { ...manifest, main: null, entries: [] }, cache, direct })).toMatchObject({ status: "skipped", reason: "NO_MAIN", requests: 0 });
  });
});

describe("umbral y lotes: cuándo se reconstruye el MAIN", () => {
  it("4 beats no reconstruyen; el quinto reconstruye UNA vez y el contador queda a cero; el Cloud solo recibe metadatos", async () => {
    const w = world(); const b = w.browser("A"); const c = coordinatorFor(w, b);
    for (let i = 0; i < 4; i++) await transfer(c, () => b.upload(`f-${i}`));
    await settle(c); expect(c.state.rebuilds).toBe(0); expect(w.main).toBeNull(); expect(w.manifest().pendingCount).toBe(4);
    await transfer(c, () => b.upload("f-4")); await settle(c);
    expect(c.state.rebuilds).toBe(1); expect(c.state.last).toMatchObject({ status: "published", entries: 5, fetched: 0, version: "1" });
    expect(w.manifest()).toMatchObject({ pendingCount: 0, rebuild: false }); expect(w.manifest().entries).toHaveLength(5);
    // el documento viajó SOLO por el puerto directo; al Cloud llegó un ticket JSON pequeño (sin bytes de audio)
    expect(b.sent).toHaveLength(1); expect(b.sent[0].size).toBeGreaterThan(5 * PREFIX_BYTES); expect(b.sent[0].caption).toBe(`catalog:v1 pack=${w.main!.packId}`);
    expect(w.cloud.bodyBytes).toBeLessThan(5 * 400); expect(b.reads).toHaveLength(0); // todos los prefijos eran locales: ninguna lectura de Telegram
    c.teardown();
  });

  it("lote de 12 con la interfaz ocupada: una sola reconstrucción al terminar el lote, contador a cero", async () => {
    const w = world(); const b = w.browser("A"); const c = coordinatorFor(w, b);
    c.setBatchOpen(true); // revisiones en cola / tarjetas subiendo
    for (let i = 0; i < 12; i++) { await transfer(c, () => b.upload(`f-${i}`)); await tick(30); } // huecos mayores que la espera de calma entre subidas
    expect(c.state.rebuilds).toBe(0); expect(w.cloud.requests).not.toContain("begin");
    c.setBatchOpen(false); await settle(c);
    expect(c.state.rebuilds).toBe(1); expect(w.cloud.requests.filter((x) => x === "begin")).toHaveLength(1); expect(b.sent).toHaveLength(1);
    expect(w.manifest()).toMatchObject({ pendingCount: 0, current: 12 }); expect(w.main!.entries).toHaveLength(12);
    c.teardown();
  });

  it("subidas simultáneas sin lote declarado: espera a que no quede ninguna en curso y reconstruye una vez", async () => {
    const w = world(); const b = w.browser("A"); const c = coordinatorFor(w, b);
    await Promise.all(Array.from({ length: 7 }, (_, i) => transfer(c, async () => { await tick(5 + i * 12); await b.upload(`f-${i}`); })));
    await settle(c); expect(c.state.rebuilds).toBe(1); expect(w.manifest().pendingCount).toBe(0);
    c.teardown();
  });

  it("reemplazar un MP3 cuenta como cambio y el prefijo antiguo deja de servirse; una subida fallida no cuenta", async () => {
    const w = world(); const b = w.browser("A"); const c = coordinatorFor(w, b);
    for (let i = 0; i < 5; i++) await transfer(c, () => b.upload(`f-${i}`));
    await settle(c); expect(w.main!.version).toBe(1);
    const oldSha = w.current.get("f-0")!.fileSha256;
    await transfer(c, () => b.upload("f-0", 180_000)); // reemplazo: mismo file slot, otro contenido
    await settle(c);
    const m = w.manifest(); expect(m.pendingCount).toBe(1); expect(m.pending[0].fileId).toBe("f-0"); expect(m.entries.some((e) => e.fileSha256 === oldSha)).toBe(false); // la entrada antigua ya no se sirve
    expect(c.state.rebuilds).toBe(1); // 1 cambio < umbral
    await transfer(c, () => b.upload("f-x", 200_000, { failed: true }), false); // subida fallida: ni vigente ni contabilizada
    await settle(c); expect(w.manifest().pendingCount).toBe(1); expect(c.state.rebuilds).toBe(1);
    for (let i = 5; i < 9; i++) await transfer(c, () => b.upload(`f-${i}`)); // 1 reemplazo + 4 nuevos = 5
    await settle(c); expect(c.state.rebuilds).toBe(2); expect(w.main!.version).toBe(2);
    const e0 = w.manifest().entries.find((e) => e.fileId === "f-0")!; expect(e0.fileSha256).toBe(w.current.get("f-0")!.fileSha256); expect(e0.fileSha256).not.toBe(oldSha);
    expect(w.manifest().pendingCount).toBe(0);
    c.teardown();
  });
});

describe("fallos y concurrencia", () => {
  it("reconstrucción fallida (rechazo sin efecto): se libera el ticket, el MAIN anterior y los pendientes siguen; el siguiente lote publica", async () => {
    const w = world(); const b = w.browser("A"); const c = coordinatorFor(w, b);
    for (let i = 0; i < 5; i++) await transfer(c, () => b.upload(`f-${i}`));
    await settle(c); const v1 = w.main!.packId;
    w.faults.push("rejected");
    for (let i = 5; i < 10; i++) await transfer(c, () => b.upload(`f-${i}`));
    await settle(c);
    expect(c.state.last).toMatchObject({ status: "failed", reason: "FLOOD_WAIT_9" }); expect(w.cloud.requests).toContain("cancel"); expect(w.staged).toBeNull();
    expect(w.main!.packId).toBe(v1); expect(w.manifest().pendingCount).toBe(5); expect(w.manifest().entries).toHaveLength(5); // nada perdido
    await transfer(c, () => b.upload("f-10")); await settle(c);
    expect(c.state.last!.status).toBe("published"); expect(w.manifest()).toMatchObject({ pendingCount: 0, current: 11 });
    c.teardown();
  });

  it("envío incierto: no se reenvía ni se cancela (C7.8); el MAIN vigente no cambia y los pendientes se conservan", async () => {
    const w = world(); const b = w.browser("A"); const c = coordinatorFor(w, b);
    w.faults.push("lost");
    for (let i = 0; i < 5; i++) await transfer(c, () => b.upload(`f-${i}`));
    await settle(c);
    expect(c.state.last).toMatchObject({ status: "uncertain" }); expect(b.sent).toHaveLength(1); expect(w.cloud.requests).not.toContain("cancel"); expect(w.cloud.requests).not.toContain("publish");
    expect(w.main).toBeNull(); expect(w.manifest().pendingCount).toBe(5); expect(w.staged).not.toBeNull(); // el ticket caduca solo
    await transfer(c, () => b.upload("f-5")); await settle(c);
    expect(b.sent).toHaveLength(1); // construcción en curso: no se envía otro documento
    w.expire(); await transfer(c, () => b.upload("f-6")); await settle(c);
    expect(c.state.last!.status).toBe("published"); expect(w.manifest().pendingCount).toBe(0); expect(b.sent).toHaveLength(2); // identidad nueva, nunca la misma
    c.teardown();
  });

  it("dos navegadores a la vez: una sola construcción; el que llega tarde no pisa nada y ningún cambio se pierde", async () => {
    const w = world(); const a = w.browser("A"); const b = w.browser("B");
    for (let i = 0; i < 3; i++) await a.upload(`a-${i}`);
    for (let i = 0; i < 3; i++) await b.upload(`b-${i}`);
    const [ra, rb] = await Promise.all([rebuildMain({ account: "acc", api: w.api, cache: a.cache, direct: a.direct }), rebuildMain({ account: "acc", api: w.api, cache: b.cache, direct: b.direct })]);
    const results = [ra.status, rb.status].sort(); expect(results[1]).toBe("published"); expect(["conflict", "skipped"]).toContain(results[0]);
    expect(w.main!.version).toBe(1); expect(w.manifest()).toMatchObject({ pendingCount: 0, current: 6 }); expect(w.main!.entries).toHaveLength(6); // el ganador leyó de Telegram los prefijos del otro
    expect(a.sent.length + b.sent.length).toBe(1);
    // base obsoleta: B tomó el manifiesto antes de que A publicara una versión nueva → su ticket se rechaza y el MAIN de A queda intacto
    const stale = w.manifest();
    for (let i = 3; i < 8; i++) await a.upload(`a-${i}`);
    expect((await rebuildMain({ account: "acc", api: w.api, cache: a.cache, direct: a.direct })).status).toBe("published"); const v2 = w.main!.packId;
    await b.upload("b-9");
    expect(await rebuildMain({ account: "acc", api: w.api, cache: b.cache, direct: b.direct, manifest: stale })).toMatchObject({ status: "conflict", reason: "MAIN_VERSION_CONFLICT" });
    expect(w.main!.packId).toBe(v2); expect(w.manifest().pending.map((p) => p.fileId)).toEqual(["b-9"]); // el cambio de B sigue pendiente, no perdido
  });
});

describe("dispositivos nuevos", () => {
  it("con MAIN: lo restaura con una lectura y NO reconstruye aunque haya pendientes; los posteriores al MAIN quedan para el streaming normal", async () => {
    const w = world(); const a = w.browser("A"); const ca = coordinatorFor(w, a);
    for (let i = 0; i < 6; i++) await transfer(ca, () => a.upload(`f-${i}`));
    await settle(ca); expect(w.main!.entries).toHaveLength(6);
    for (let i = 6; i < 11; i++) await a.upload(`f-${i}`); // 5 pendientes que nadie ha consolidado aún
    const n = w.browser("N"); let known: string | null = null; const cn = coordinatorFor(w, n, { knownVersion: () => known, rememberVersion: (v) => { known = v; } });
    await cn.open();
    expect(cn.state.lastRestore).toMatchObject({ status: "done", wanted: 6, stored: 6, requests: 1 }); expect(n.reads).toHaveLength(1); expect(n.reads[0].messageId).toBe(w.main!.messageId);
    expect((await n.cache.keys("acc")).size).toBe(6); expect(cn.state.rebuilds).toBe(0); expect(n.sent).toHaveLength(0); // no se le exige reconstruir
    expect(known).toBe("1");
    await cn.open(); expect(cn.state.lastRestore).toMatchObject({ status: "skipped", reason: "KNOWN_VERSION" }); expect(n.reads).toHaveLength(1); // misma versión: no repite la descarga
    // el dispositivo que subió los pendientes sí consolida al volver a abrir (ya los tiene todos en local)
    const ca2 = coordinatorFor(w, a); await ca2.open();
    expect(ca2.state.rebuilds).toBe(1); expect(w.manifest()).toMatchObject({ pendingCount: 0, current: 11 }); expect(a.reads).toHaveLength(0);
    ca.teardown(); cn.teardown(); ca2.teardown();
  });

  it("sin MAIN o con el MAIN ilegible: no hay error ni dependencia (la reproducción sigue por streaming); sin plano directo no se intenta nada", async () => {
    const w = world(); const n = w.browser("N"); const cn = coordinatorFor(w, n);
    const a = w.browser("A"); for (let i = 0; i < 3; i++) await a.upload(`f-${i}`);
    await cn.open(); expect(cn.state.lastRestore).toMatchObject({ status: "skipped", reason: "NO_MAIN", requests: 0 }); expect(cn.state.rebuilds).toBe(0);
    for (let i = 3; i < 5; i++) await a.upload(`f-${i}`);
    expect((await rebuildMain({ account: "acc", api: w.api, cache: a.cache, direct: a.direct })).status).toBe("published");
    w.telegram.delete(w.main!.messageId); // el documento ya no se puede leer
    const n2 = w.browser("N2"); const c2 = coordinatorFor(w, n2); await c2.open();
    expect(c2.state.lastRestore).toMatchObject({ status: "done", stored: 0 }); expect((await n2.cache.keys("acc")).size).toBe(0);
    expect((await rebuildMain({ account: "acc", api: w.api, cache: n2.cache, direct: null })).status).toBe("skipped");
    cn.teardown(); c2.teardown();
  });
});
