'use strict';
// E75 — MAIN de prefijos sobre PostgreSQL real aislado y Telegram FAKE. El «navegador» (sesión propia del fake) sube los MP3 por Direct B,
// construye el documento MAIN y lo envía; el Cloud (módulos reales) SOLO coordina metadatos. Prueba: umbral de 5 y contador derivado, lote de
// 12 con una publicación, reemplazo/papelera/subida fallida, ticket único, compare-and-swap, verificación del mensaje, dispositivo nuevo y que
// el gateway del servidor no envía ni descarga un solo byte (sendPart/downloadPart = 0). No es G2 ni evidencia de proveedor real.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const operations = require('../../catalog/operations.js');
const queries = require('../../catalog/queries.js');
const commands = require('../../catalog/commands.js');
const { createCatalogWorker } = require('../../catalog/worker.js');
const g = require('../../catalog/transport-gateway.js');
const telegramOp = require('../../operator/telegram-file-io.js');
const { createCatalogDirect } = require('../../catalog/direct.js');
const packsMod = require('../../catalog/prefix-packs.js');
const { createFakeTelegramServer } = require('../helpers/catalog-fake-mtproto.cjs');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const { Api } = require(path.join(__dirname, '..', '..', 'node_modules', 'telegram'));
const bigInt = require(path.join(__dirname, '..', '..', 'node_modules', 'big-integer'));
db.validateAdminTarget();
const sdk = { Api, bigInt };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const P = packsMod.PREFIX_BYTES;
let seq = 0; let keyN = 0;

async function withDb(fn) {
  const h = await db.createCatalogTestDb(); const pool = new Pool({ ...h.config, max: 10 });
  try {
    await mig.applyMigrations(pool);
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [sha('x')]).catch(() => {});
    return await fn(pool);
  } finally { await pool.end(); await h.cleanup(); }
}
const peerOf = (chatId) => new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt('7') });
const resolvePeer = async (chatId) => ({ peer: peerOf(chatId), channel: true });
function modules(pool) {
  const server = createFakeTelegramServer(); const a = authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
  const serverClient = server.session({ selfId: '20' }); const browserClient = server.session({ selfId: '20' });
  const realGateway = telegramOp.createOperatorTelegram({ client: serverClient, sdk, senderId: '20', botId: 'Bot20', resolvePeer });
  // Gateway del SERVIDOR con contadores: en el flujo Direct B + MAIN solo puede comprobar mensajes (metadatos); nunca enviar ni descargar bytes.
  const cloud = { sendPart: 0, downloadPart: 0, verifyMessage: 0 };
  const serverGw = { ...realGateway, sendPart: async (x) => { cloud.sendPart++; return realGateway.sendPart(x); }, downloadPart: async (x) => { cloud.downloadPart++; return realGateway.downloadPart(x); }, verifyMessage: async (x) => { cloud.verifyMessage++; return realGateway.verifyMessage(x); } };
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: null }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const direct = createCatalogDirect({ pool, authority: a, operations: ops });
  const packs = packsMod.createPrefixPacks({ pool, authority: a, gateway: serverGw, directReads: true });
  const worker = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: serverGw, purge: null, owner: 'w', options: { globalConcurrency: 4, renewEveryMs: 100_000, stepsPerClaim: 4 } });
  const browserGw = telegramOp.createOperatorTelegram({ client: browserClient, sdk, senderId: '20', botId: 'Bot20', resolvePeer }); // el navegador (mismo bot, otra sesión)
  return { pool, ops, q, cmd, direct, packs, worker, server, cloud, browserGw, browserClient };
}
async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' }).provisionLibrary({ userId: id })).context;
  return { userId: id, era: ctx.authority_era, epoch: ctx.authority_epoch, chatId: `-100${seq}` };
}
const hdrOf = (lib) => ({ userId: lib.userId, era: lib.era, epoch: lib.epoch });
const i32 = (s) => crypto.createHash('md5').update(String(s)).digest().readUInt32BE(0);
const mp3 = (n, salt) => { const b = crypto.createHash('sha256').update(`seed-${salt}`).digest(); const out = Buffer.alloc(n); for (let i = 0; i < n; i += 32) b.copy(out, i, 0, Math.min(32, n - i)); out[0] = 0xff; out[1] = 0xfb; out.writeUInt32BE(i32(salt), 4); return out; };
async function drain(m, lib, { kinds = null, rounds = 80 } = {}) {
  for (let i = 0; i < rounds; i++) {
    await m.pool.query(`UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1 AND state = 'QUEUED'${kinds ? ' AND kind = ANY($2::text[])' : ''}`, kinds ? [lib.userId, kinds] : [lib.userId]);
    await m.worker.runOnce({ kinds });
    const n = (await m.pool.query(`SELECT count(*)::int AS n FROM catalog_jobs WHERE user_id = $1 AND state IN ('QUEUED','LEASED')${kinds ? ' AND kind = ANY($2::text[])' : ''}`, kinds ? [lib.userId, kinds] : [lib.userId])).rows[0].n;
    if (n === 0) return;
  }
}
// El navegador sube un MASTER MP3 por Direct B (ticket → envío → recibo) y la operación se confirma. `commit: false` = subida que no llega a confirmarse.
async function importMp3(m, lib, name, bytes, { replaceOf = null, commit = true } = {}) {
  const hdr = hdrOf(lib);
  const spec = { partKey: 'm0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: bytes.length, sha256: sha(bytes), filename: `${name}.mp3`, mime: 'audio/mpeg' };
  let op;
  if (replaceOf) { const v = (await m.pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, replaceOf])).rows[0].v; op = await m.ops.createOperation({ ...hdr, idempotencyKey: `k${++keyN}`, intent: { kind: 'REPLACE', beatId: replaceOf, expectedVersion: v, parts: [spec] } }); }
  else op = await m.ops.createOperation({ ...hdr, idempotencyKey: `k${++keyN}`, intent: { kind: 'IMPORT', parts: [spec], metadata: { name } } });
  if (!commit) return op.beatId;
  const t = await m.direct.issueSendTicket({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  const sent = await m.browserGw.sendPart({ operationId: t.operationId, partKey: 'm0', randomId: t.randomId, chatId: t.chatId, file: { name: t.filename, size: bytes.length, buffer: bytes }, mimeType: t.mime, fileName: t.filename });
  await m.direct.submitReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', attempt: t.attempt, receipt: { messageId: sent.messageId, size: sent.size, senderId: sent.senderId, chatId: sent.chatId } });
  await drain(m, lib, { kinds: ['TRANSFER_VERIFY'] });
  const r = await m.ops.commitOperation({ ...hdr, operationId: op.operationId }); assert.equal(r.status, 200);
  return op.beatId;
}
const fileOf = async (pool, lib, beatId) => (await pool.query("SELECT file_id FROM catalog_current_files WHERE user_id = $1 AND beat_id = $2 AND slot_key = 'MASTER'", [lib.userId, beatId])).rows[0].file_id;

// ---------- el NAVEGADOR: caché local de prefijos, documento BGPACK01 y lecturas/envíos directos (nunca a través del Cloud) ----------
const newPackId = () => `pk-${crypto.randomBytes(12).toString('hex')}`;
function encodeMain({ packId, generationId, items }) {
  let headerLen = 0; let header; let entries;
  for (let pass = 0; pass < 4; pass++) {
    let off = 8 + 4 + headerLen;
    entries = items.map((i) => { const e = { fileId: i.fileId, fileSha256: i.fileSha256, fileSize: i.fileSize, prefixSha256: sha(i.bytes), offset: off, length: i.bytes.length }; off += i.bytes.length; return e; });
    header = Buffer.from(JSON.stringify({ format: 'beatgaler.prefix-pack', version: 1, packId, kind: 'MAIN', generationId, prefixBytes: P, entries }), 'utf8');
    if (header.length === headerLen) break; headerLen = header.length;
  }
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length, 0);
  return { buffer: Buffer.concat([Buffer.from('BGPACK01', 'ascii'), len, header, ...items.map((i) => i.bytes)]), entries };
}
async function browserRead(m, chatId, messageId, offset, length) { const chunks = []; for await (const c of await m.browserGw.downloadPart({ chatId, messageId, offset, limit: length })) chunks.push(Buffer.from(c)); return Buffer.concat(chunks).subarray(0, length); }
async function browserSendDocument(m, ticket, buffer, { caption = ticket.caption } = {}) {
  const inputFile = await m.browserClient.uploadFile({ file: { name: ticket.filename, size: buffer.length, buffer }, workers: 1 });
  const request = telegramOp.buildSendMedia(sdk, { peer: peerOf(ticket.chatId), inputFile, mimeType: ticket.mime, fileName: ticket.filename, caption: g.captionFor({ operationId: 'main', partKey: 'pack' }), randomId: ticket.randomId });
  request.message = caption; // marcador del paquete (lo fija el ticket del servidor)
  const receipt = g.receiptFromUpdates(await m.browserClient.invoke(request), { randomId: ticket.randomId });
  return { messageId: receipt.messageId };
}
/** Reconstrucción como la hace catalogMainPack.rebuildMain: caché local + prefijos que falten leídos de Telegram + ticket + envío + publicación. */
async function browserRebuild(m, lib, cache, { manifest = null, stop = null } = {}) {
  const man = manifest || await m.packs.manifest({ userId: lib.userId }); const stats = { reads: 0 };
  const have = (e) => cache.get(e.fileSha256);
  if (man.main) { const need = man.entries.filter((e) => !have(e)); if (need.length) { const s = Math.min(...need.map((e) => e.offset)); const end = Math.max(...need.map((e) => e.offset + e.length)); const body = await browserRead(m, man.main.direct.chatId, man.main.direct.messageId, s, end - s); stats.reads++; for (const e of need) { const b = body.subarray(e.offset - s, e.offset - s + e.length); assert.equal(sha(b), e.prefixSha256); cache.set(e.fileSha256, Buffer.from(b)); } } }
  for (const p of man.pending) if (!have(p)) { cache.set(p.fileSha256, await browserRead(m, p.direct.chatId, p.direct.messageId, 0, p.prefixLength)); stats.reads++; }
  const items = [...man.entries, ...man.pending].map((c) => ({ fileId: c.fileId, fileSha256: c.fileSha256, fileSize: c.fileSize, bytes: cache.get(c.fileSha256) }));
  const packId = newPackId(); const doc = encodeMain({ packId, generationId: man.generationId, items });
  const ticket = await m.packs.beginMain({ ...hdrOf(lib), packId, baseVersion: man.main ? man.main.version : '0', sizeBytes: doc.buffer.length, sha256: sha(doc.buffer), entries: doc.entries });
  if (stop === 'afterTicket') return { ticket, doc, stats };
  const sent = await browserSendDocument(m, ticket, doc.buffer);
  if (stop === 'afterSend') return { ticket, doc, sent, stats };
  const published = await m.packs.publishMain({ ...hdrOf(lib), packId, receipt: { messageId: sent.messageId } });
  return { ticket, doc, sent, published, stats };
}
/** Sube n beats; el navegador guarda cada prefijo en su caché local al prepararlo (como onMasterPrepared). */
async function uploadMany(m, lib, cache, files, names) { const ids = []; for (const [i, f] of files.entries()) { ids.push(await importMp3(m, lib, names[i], f)); cache.set(sha(f), Buffer.from(f.subarray(0, Math.min(P, f.length)))); } return ids; }
const code = (c) => (e) => e && e.code === c;

test('umbral y contador derivado: 4 no reconstruyen, el 5.º sí; lote de 12 = una publicación y contador a cero; dispositivo nuevo; Cloud sin bytes', async () => {
  await withDb(async (pool) => {
    const m = modules(pool); const lib = await nativeLibrary(pool); const cache = new Map();
    const files = Array.from({ length: 17 }, (_, i) => mp3(150 * 1024 + i * 1024, `t1-${i}`));
    await uploadMany(m, lib, cache, files.slice(0, 4), ['a0', 'a1', 'a2', 'a3']);
    let man = await m.packs.manifest({ userId: lib.userId });
    assert.equal(man.threshold, 5); assert.equal(man.main, null); assert.equal(man.pendingCount, 4); assert.equal(man.rebuild, false, '4 cambios: no se reconstruye');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_prefix_packs')).rows[0].n, 0, 'subir no publica nada (sin DELTA ni jobs)');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_jobs WHERE kind NOT IN ('TRANSFER_VERIFY','TRANSFER_COMMIT','TRANSFER_RECONCILE','QUERY_SET_BUILD','OPERATION_STEP','PURGE')")).rows[0].n, 0);
    await uploadMany(m, lib, cache, files.slice(4, 5), ['a4']);
    man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.pendingCount, 5); assert.equal(man.rebuild, true, 'quinto cambio: toca reconstruir');
    const messagesBefore = m.server.messages().length;
    const r1 = await browserRebuild(m, lib, cache);
    assert.equal(r1.published.version, '1'); assert.equal(r1.stats.reads, 0, 'todos los prefijos eran locales');
    assert.equal(m.server.messages().length, messagesBefore + 1, 'un único documento MAIN');
    man = await m.packs.manifest({ userId: lib.userId });
    assert.equal(man.pendingCount, 0, 'contador a cero'); assert.equal(man.rebuild, false); assert.equal(man.entries.length, 5); assert.equal(man.main.version, '1'); assert.equal(man.building, false);
    assert.deepEqual(await m.packs.publishMain({ ...hdrOf(lib), packId: r1.ticket.packId, receipt: { messageId: r1.sent.messageId } }), { packId: r1.ticket.packId, version: '1', replay: true }, 'publicar dos veces es idempotente');
    // lote de 12: una sola reconstrucción al final → contador a cero y un único MAIN vigente (el anterior queda SUPERSEDED, sin borrar nada)
    await uploadMany(m, lib, cache, files.slice(5, 17), Array.from({ length: 12 }, (_, i) => `b${i}`));
    man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.pendingCount, 12); assert.equal(man.entries.length, 5, 'los cubiertos por el MAIN siguen sirviéndose');
    const r2 = await browserRebuild(m, lib, cache); assert.equal(r2.published.version, '2'); assert.equal(r2.published.superseded, r1.ticket.packId);
    man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.pendingCount, 0); assert.equal(man.entries.length, 17); assert.equal(man.current, 17);
    assert.deepEqual((await pool.query('SELECT status, count(*)::int AS n FROM catalog_prefix_packs GROUP BY status ORDER BY status')).rows, [{ status: 'PUBLISHED', n: 1 }, { status: 'SUPERSEDED', n: 1 }]);
    // dispositivo nuevo (caché vacía): UNA lectura del MAIN restaura los 17 prefijos íntegros
    const start = Math.min(...man.entries.map((e) => e.offset)); const end = Math.max(...man.entries.map((e) => e.offset + e.length));
    const body = await browserRead(m, man.main.direct.chatId, man.main.direct.messageId, start, end - start);
    for (const e of man.entries) { const b = body.subarray(e.offset - start, e.offset - start + e.length); assert.equal(sha(b), e.prefixSha256); const f = files.find((x) => sha(x) === e.fileSha256); assert.ok(f && b.equals(f.subarray(0, P)), 'prefijo = primeros 128 KiB del original'); }
    // un beat posterior al MAIN: sigue accesible individualmente (pendiente con su referencia directa), sin exigir reconstrucción
    const late = mp3(140 * 1024, 't1-late'); await importMp3(m, lib, 'late', late);
    man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.pendingCount, 1); assert.equal(man.rebuild, false);
    assert.ok((await browserRead(m, man.pending[0].direct.chatId, man.pending[0].direct.messageId, 0, man.pending[0].prefixLength)).equals(late.subarray(0, P)));
    // tráfico del Cloud: comprobó mensajes (metadatos) pero no envió ni descargó un solo byte de MP3 ni de paquete; nada borrado
    assert.equal(m.cloud.sendPart, 0); assert.equal(m.cloud.downloadPart, 0); assert.ok(m.cloud.verifyMessage >= 18); assert.equal(m.server.counters().deletes, 0);
  });
});

test('reemplazo, papelera y subida fallida; ticket único, caducidad, cancelación y validación de entradas; aislamiento', async () => {
  await withDb(async (pool) => {
    const m = modules(pool); const lib = await nativeLibrary(pool); const other = await nativeLibrary(pool); const cache = new Map();
    const files = Array.from({ length: 5 }, (_, i) => mp3(160 * 1024, `t2-${i}`));
    const ids = await uploadMany(m, lib, cache, files, ['A', 'B', 'C', 'D', 'E']);
    const r1 = await browserRebuild(m, lib, cache); assert.equal(r1.published.version, '1');
    // reemplazo de MP3: cuenta como cambio y la versión anterior deja de servirse de inmediato (antes de cualquier MAIN nuevo)
    const fA1 = await fileOf(pool, lib, ids[0]); const a2 = mp3(170 * 1024, 't2-a-v2');
    await importMp3(m, lib, 'A', a2, { replaceOf: ids[0] }); cache.set(sha(a2), Buffer.from(a2.subarray(0, P)));
    let man = await m.packs.manifest({ userId: lib.userId });
    assert.equal(man.pendingCount, 1); assert.equal(man.pending[0].fileSha256, sha(a2)); assert.equal(man.entries.length, 4);
    assert.equal(man.entries.some((e) => e.fileId === fA1 || e.fileSha256 === sha(files[0])), false, 'prefijo antiguo nunca servido');
    // papelera: la entrada desaparece y NO cuenta como cambio; subida que no se confirma: tampoco
    const v = (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, ids[1]])).rows[0].v;
    await m.cmd.trashBeats({ ...hdrOf(lib), idempotencyKey: `k${++keyN}`, items: [{ beatId: ids[1], expectedVersion: v }] });
    await importMp3(m, lib, 'nunca-confirmada', mp3(150 * 1024, 't2-failed'), { commit: false });
    man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.entries.length, 3); assert.equal(man.pendingCount, 1, 'ni la papelera ni la subida fallida cuentan'); assert.equal(man.current, 4);
    // validación del ticket: base obsoleta, entradas que ya no son vigentes, entradas mal formadas
    const stale = encodeMain({ packId: newPackId(), generationId: man.generationId, items: [{ fileId: fA1, fileSha256: sha(files[0]), fileSize: files[0].length, bytes: files[0].subarray(0, P) }] });
    await assert.rejects(m.packs.beginMain({ ...hdrOf(lib), packId: newPackId(), baseVersion: '1', sizeBytes: stale.buffer.length, sha256: sha(stale.buffer), entries: stale.entries }), code('MAIN_ENTRIES_STALE'));
    await assert.rejects(m.packs.beginMain({ ...hdrOf(lib), packId: newPackId(), baseVersion: '0', sizeBytes: stale.buffer.length, sha256: sha(stale.buffer), entries: stale.entries }), code('MAIN_VERSION_CONFLICT'));
    const okEntry = { fileId: man.pending[0].fileId, fileSha256: sha(a2), fileSize: a2.length, prefixSha256: sha(a2.subarray(0, P)), offset: 100, length: P };
    for (const bad of [{ entries: [] }, { entries: [{ ...okEntry, length: P + 1 }] }, { entries: [{ ...okEntry, offset: 999_999_999 }] }, { entries: [okEntry, { ...okEntry }] }, { entries: [{ ...okEntry, prefixSha256: 'x' }] }, { packId: 'nope' }, { sizeBytes: 0 }, { baseVersion: '-1' }]) {
      await assert.rejects(m.packs.beginMain({ ...hdrOf(lib), packId: newPackId(), baseVersion: '1', sizeBytes: 1_000_000, sha256: sha('d'), entries: [okEntry], ...bad }), code('INPUT_INVALID'), JSON.stringify(bad).slice(0, 60));
    }
    await assert.rejects(m.packs.beginMain({ ...hdrOf(lib), packId: newPackId(), baseVersion: '1', sizeBytes: 1_000_000, sha256: sha('d'), entries: [{ ...okEntry, length: 1000 }] }), code('MAIN_ENTRIES_STALE'), 'longitud de prefijo distinta de la vigente');
    await assert.rejects(m.packs.beginMain({ ...hdrOf(lib), era: crypto.randomUUID(), packId: newPackId(), baseVersion: '1', sizeBytes: 1_000_000, sha256: sha('d'), entries: [okEntry] }), (e) => e && e.status >= 400 && e.status < 500, 'era distinta');
    // ticket único: una construcción en curso bloquea a la segunda; cancelar (sin efecto) o caducar la libera
    const t1 = await browserRebuild(m, lib, cache, { stop: 'afterTicket' });
    man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.building, true); assert.equal(man.main.version, '1', 'un ticket no cambia el MAIN vigente');
    await assert.rejects(browserRebuild(m, lib, cache, { manifest: { ...man, building: false } }), (e) => e && e.code === 'MAIN_BUILD_IN_PROGRESS' && e.detail && e.detail.retryAfterMs > 0);
    assert.deepEqual(await m.packs.cancelMain({ ...hdrOf(other), packId: t1.ticket.packId }), { cancelled: false }, 'otro usuario no puede cancelar');
    assert.deepEqual(await m.packs.cancelMain({ ...hdrOf(lib), packId: t1.ticket.packId, code: 'FLOOD_WAIT_5' }), { cancelled: true });
    assert.deepEqual(await m.packs.cancelMain({ ...hdrOf(lib), packId: t1.ticket.packId }), { cancelled: false });
    const t2 = await browserRebuild(m, lib, cache, { stop: 'afterTicket' });
    await pool.query("UPDATE catalog_prefix_packs SET created_at = now() - interval '11 minutes' WHERE pack_id = $1", [t2.ticket.packId]);
    assert.equal((await m.packs.manifest({ userId: lib.userId })).building, false, 'una construcción caducada no bloquea');
    const r3 = await browserRebuild(m, lib, cache); assert.equal(r3.published.version, '2');
    assert.equal((await pool.query('SELECT status, last_error FROM catalog_prefix_packs WHERE pack_id = $1', [t2.ticket.packId])).rows[0].last_error, 'BUILD_EXPIRED');
    await assert.rejects(m.packs.publishMain({ ...hdrOf(lib), packId: t2.ticket.packId, receipt: { messageId: r3.sent.messageId } }), code('PACK_STATE_CONFLICT'), 'un ticket caducado no puede publicar');
    man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.pendingCount, 0); assert.equal(man.entries.length, 4);
    assert.equal(man.entries.find((e) => e.fileSha256 === sha(a2)).prefixSha256, sha(a2.subarray(0, P)), 'el MAIN nuevo lleva el prefijo del MP3 reemplazado');
    // aislamiento: otro usuario no ve nada de esta biblioteca ni puede publicar en ella
    const om = await m.packs.manifest({ userId: other.userId }); assert.equal(om.main, null); assert.equal(om.entries.length, 0); assert.equal(om.current, 0);
    await assert.rejects(m.packs.publishMain({ ...hdrOf(other), packId: r3.ticket.packId, receipt: { messageId: r3.sent.messageId } }), code('NOT_FOUND'));
    assert.equal(m.cloud.sendPart, 0); assert.equal(m.cloud.downloadPart, 0); assert.equal(m.server.counters().deletes, 0);
  });
});

test('publicación: verificación del mensaje (marcador y tamaño), compare-and-swap entre dispositivos y fallos que conservan el MAIN y los pendientes', async () => {
  await withDb(async (pool) => {
    const m = modules(pool); const lib = await nativeLibrary(pool); const cacheA = new Map(); const cacheB = new Map();
    const files = Array.from({ length: 5 }, (_, i) => mp3(150 * 1024, `t3-${i}`));
    await uploadMany(m, lib, cacheA, files, ['A', 'B', 'C', 'D', 'E']);
    // recibo que apunta a OTRO mensaje (un MP3 del mismo bot): el marcador no coincide → rechazado, invisible, MAIN sin cambios
    const mp3Message = m.server.messages().find((x) => /part=m0$/.test(x.caption)).id;
    const bad1 = await browserRebuild(m, lib, cacheA, { stop: 'afterTicket' });
    await assert.rejects(m.packs.publishMain({ ...hdrOf(lib), packId: bad1.ticket.packId, receipt: { messageId: mp3Message } }), code('PACK_VERIFY_FAILED'));
    assert.equal((await pool.query('SELECT status FROM catalog_prefix_packs WHERE pack_id = $1', [bad1.ticket.packId])).rows[0].status, 'FAILED');
    // documento con el marcador correcto pero otro tamaño (bytes distintos de los declarados en el ticket) → rechazado
    const bad2 = await browserRebuild(m, lib, cacheA, { stop: 'afterTicket' });
    const wrong = await browserSendDocument(m, bad2.ticket, bad2.doc.buffer.subarray(0, bad2.doc.buffer.length - 10));
    await assert.rejects(m.packs.publishMain({ ...hdrOf(lib), packId: bad2.ticket.packId, receipt: { messageId: wrong.messageId } }), code('PACK_VERIFY_FAILED'));
    await assert.rejects(m.packs.publishMain({ ...hdrOf(lib), packId: bad2.ticket.packId, receipt: { messageId: 0 } }), code('INPUT_INVALID'));
    let man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.main, null); assert.equal(man.pendingCount, 5, 'reconstrucción fallida: los pendientes se conservan'); assert.equal(man.building, false);
    // dispositivo A publica v1
    const a1 = await browserRebuild(m, lib, cacheA); assert.equal(a1.published.version, '1');
    // dispositivo B (caché vacía) sube 5 beats y reconstruye: toma del MAIN los prefijos que no tiene (1 lectura) y publica v2 sin perder los de A
    const more = Array.from({ length: 5 }, (_, i) => mp3(150 * 1024, `t3-b-${i}`));
    await uploadMany(m, lib, cacheB, more, ['F', 'G', 'H', 'I', 'J']);
    const staleForA = await m.packs.manifest({ userId: lib.userId }); // A consulta el manifiesto ANTES de que B publique
    const b1 = await browserRebuild(m, lib, cacheB); assert.equal(b1.published.version, '2'); assert.equal(b1.stats.reads, 1, 'B leyó del MAIN lo que le faltaba, de una vez');
    man = await m.packs.manifest({ userId: lib.userId }); assert.equal(man.entries.length, 10); assert.equal(man.pendingCount, 0);
    // A intenta publicar sobre la base antigua (v1): rechazado en el ticket; el MAIN de B queda intacto
    await assert.rejects(browserRebuild(m, lib, cacheA, { manifest: staleForA }), code('MAIN_VERSION_CONFLICT'));
    // carrera en la publicación (defensa en profundidad): el MAIN cambia mientras un ticket sigue abierto → la publicación antigua pierde
    const extra = mp3(150 * 1024, 't3-extra'); await importMp3(m, lib, 'K', extra); cacheA.set(sha(extra), Buffer.from(extra.subarray(0, P)));
    const racer = await browserRebuild(m, lib, cacheA, { stop: 'afterSend' });
    await pool.query("UPDATE catalog_prefix_packs SET status = 'SUPERSEDED', superseded_at = now() WHERE user_id = $1 AND status = 'PUBLISHED'", [lib.userId]);
    await pool.query(`INSERT INTO catalog_prefix_packs(user_id, pack_id, generation_id, status, base_seq, seq, random_id, bot_id, chat_id, message_id, size_bytes, sha256, entry_count, data_bytes, published_at)
      SELECT user_id, 'pk-otrodispositivo01', generation_id, 'PUBLISHED', 2, 3, '-999', bot_id, chat_id, message_id, size_bytes, sha256, entry_count, data_bytes, now() FROM catalog_prefix_packs WHERE pack_id = $1`, [b1.ticket.packId]);
    await assert.rejects(m.packs.publishMain({ ...hdrOf(lib), packId: racer.ticket.packId, receipt: { messageId: racer.sent.messageId } }), code('MAIN_VERSION_CONFLICT'));
    const loser = (await pool.query('SELECT status, last_error, message_id FROM catalog_prefix_packs WHERE pack_id = $1', [racer.ticket.packId])).rows[0];
    assert.equal(loser.status, 'FAILED'); assert.equal(loser.last_error, 'MAIN_VERSION_CONFLICT'); assert.equal(Number(loser.message_id), racer.sent.messageId, 'huérfano conocido, nunca referenciado');
    assert.equal((await pool.query("SELECT pack_id FROM catalog_prefix_packs WHERE user_id = $1 AND status = 'PUBLISHED'", [lib.userId])).rows[0].pack_id, 'pk-otrodispositivo01', 'el más reciente no fue pisado');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_prefix_packs WHERE user_id = $1 AND status = 'PUBLISHED'", [lib.userId])).rows[0].n, 1, 'un único MAIN vigente');
    // sin verificador configurado no se emiten tickets (fail-closed) y el manifiesto sigue disponible
    const noVerifier = packsMod.createPrefixPacks({ pool, authority: authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' }), gateway: null, directReads: false });
    await assert.rejects(noVerifier.beginMain({ ...hdrOf(lib), packId: newPackId(), baseVersion: '3', sizeBytes: racer.doc.buffer.length, sha256: sha(racer.doc.buffer), entries: racer.doc.entries }), (e) => e && e.code === 'TRANSFER_UNAVAILABLE');
    const plain = await noVerifier.manifest({ userId: lib.userId }); assert.equal(plain.pending.every((p) => p.direct === undefined), true, 'sin plano directo no se exponen referencias de mensajes');
    assert.equal(m.cloud.sendPart, 0); assert.equal(m.cloud.downloadPart, 0); assert.equal(m.server.counters().deletes, 0);
  });
});
