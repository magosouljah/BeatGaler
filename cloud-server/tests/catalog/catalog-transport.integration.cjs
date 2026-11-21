'use strict';
// E77 — Transporte de archivos 100 % navegador ↔ Telegram (Direct B) sobre PostgreSQL real aislado y Telegram FAKE. Sustituye a las pruebas del
// transporte por Cloud (capacidad + PUT de bytes + PROJECT por MASTER), eliminado. El «navegador» es un cliente de operador con sesión propia en el
// fake; el Cloud son los módulos reales y su gateway SOLO verifica metadatos. Prueba: IMPORT con MASTER + WAV + portada + PROJECT por tickets,
// PROJECT con límites de plan y tamaño real comprobado en el proveedor, lectura por referencia directa, y cero bytes de archivos por el Cloud.
// No es G2 ni evidencia de proveedor real.
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
const mediaMod = require('../../catalog/media.js');
const { createCatalogWorker } = require('../../catalog/worker.js');
const g = require('../../catalog/transport-gateway.js');
const telegramOp = require('../../operator/telegram-file-io.js');
const { createCatalogDirect } = require('../../catalog/direct.js');
const { createFakeTelegramServer } = require('../helpers/catalog-fake-mtproto.cjs');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const { Api } = require(path.join(__dirname, '..', '..', 'node_modules', 'telegram'));
const bigInt = require(path.join(__dirname, '..', '..', 'node_modules', 'big-integer'));
db.validateAdminTarget();
const sdk = { Api, bigInt };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
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
function modules(pool, { projectAccess = async () => ({ maxBytes: 1_000_000 }) } = {}) {
  const server = createFakeTelegramServer(); const a = authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
  // Cloud: gateway real de SOLO metadatos. Se envuelve para contar cualquier intento de mover bytes (no debe existir ninguno).
  const cloudGateway = g.createTelegramGateway({ client: server.session({ selfId: '20' }), sdk, senderId: '20', botId: 'Bot20', resolvePeer });
  const cloud = { verifyMessage: 0, byteCalls: [] };
  const serverGw = new Proxy({ ...cloudGateway, verifyMessage: async (x) => { cloud.verifyMessage++; return cloudGateway.verifyMessage(x); } }, { get: (t, k) => { if (k === 'sendPart' || k === 'downloadPart' || k === 'sendDocument') cloud.byteCalls.push(String(k)); return t[k]; } });
  const browser = telegramOp.createOperatorTelegram({ client: server.session({ selfId: '20' }), sdk, senderId: '20', botId: 'Bot20', resolvePeer }); // el navegador: misma identidad de bot, otra sesión
  const access = { fn: projectAccess };
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: null }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const direct = createCatalogDirect({ pool, authority: a, operations: ops, resolveProjectAccess: (uid) => access.fn(uid) });
  const media = mediaMod.createCatalogMedia({ pool, authority: a });
  const worker = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: serverGw, purge: null, owner: 'w', options: { globalConcurrency: 4, renewEveryMs: 100_000, stepsPerClaim: 4 } });
  return { pool, ops, q, cmd, direct, media, worker, server, cloud, browser, access, cloudGateway };
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
const bytesOf = (n, salt) => { const out = Buffer.alloc(n); const b = crypto.createHash('sha256').update(String(salt)).digest(); for (let i = 0; i < n; i += 32) b.copy(out, i, 0, Math.min(32, n - i)); return out; };
async function drain(m, lib, kinds, rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    await m.pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1 AND state = 'QUEUED' AND kind = ANY($2::text[])", [lib.userId, kinds]);
    await m.worker.runOnce({ kinds });
    if ((await m.pool.query("SELECT count(*)::int AS n FROM catalog_jobs WHERE user_id = $1 AND state IN ('QUEUED','LEASED') AND kind = ANY($2::text[])", [lib.userId, kinds])).rows[0].n === 0) return;
  }
}
const spec = (partKey, slotKey, role, bytes, filename, mime) => ({ partKey, slotKey, role, partIndex: 0, size: bytes.length, sha256: sha(bytes), filename, mime });
// El navegador: ticket → envío directo a Telegram → recibo. `send` permite simular un envío con otros bytes que los declarados.
async function browserUpload(m, lib, operationId, partKey, bytes, { claimSize = bytes.length } = {}) {
  const hdr = hdrOf(lib);
  const t = await m.direct.issueSendTicket({ ...hdr, operationId, partKey });
  const sent = await m.browser.sendPart({ operationId, partKey, randomId: t.randomId, chatId: t.chatId, file: { name: t.filename, size: bytes.length, buffer: bytes }, mimeType: t.mime, fileName: t.filename });
  await m.direct.submitReceipt({ ...hdr, operationId, partKey, attempt: t.attempt, receipt: { messageId: sent.messageId, size: claimSize, senderId: sent.senderId, chatId: sent.chatId } });
  return { ticket: t, sent };
}
async function browserRead(m, ref, size) { const chunks = []; for await (const c of await m.browser.downloadPart({ chatId: ref.chatId, messageId: ref.messageId })) chunks.push(Buffer.from(c)); return Buffer.concat(chunks).subarray(0, size); }
const code = (c) => (e) => e && e.code === c;

test('IMPORT completo por Direct B (MASTER, WAV, portada y PROJECT con el bot): verificación del proveedor, commit, lectura por referencia directa y CERO bytes por el Cloud', async () => {
  await withDb(async (pool) => {
    const m = modules(pool); const lib = await nativeLibrary(pool); const hdr = hdrOf(lib);
    const files = { 'MASTER:0': bytesOf(300_000, 'mp3'), 'FILES:0:0': bytesOf(700_000, 'wav'), 'ARTWORK:0': bytesOf(40_000, 'png'), 'PROJECT:0': bytesOf(900_000, 'zip') };
    const op = await m.ops.createOperation({ ...hdr, idempotencyKey: `k${++keyN}`, intent: { kind: 'IMPORT', metadata: { name: 'Beat completo' }, parts: [
      spec('MASTER:0', 'MASTER', 'MASTER', files['MASTER:0'], 'beat.mp3', 'audio/mpeg'), spec('FILES:0:0', 'FILES:0', 'WAV', files['FILES:0:0'], 'beat.wav', 'audio/wav'),
      spec('ARTWORK:0', 'ARTWORK', 'ARTWORK', files['ARTWORK:0'], 'cover.png', 'image/png'), spec('PROJECT:0', 'PROJECT', 'PROJECT', files['PROJECT:0'], 'beat.zip', 'application/zip')] } });
    const sent = {};
    for (const [k, b] of Object.entries(files)) sent[k] = await browserUpload(m, lib, op.operationId, k, b);
    assert.equal(sent['PROJECT:0'].ticket.botId, 'Bot20', 'PROJECT sale con el bot de la biblioteca, sin MASTER');
    assert.equal(sent['PROJECT:0'].ticket.caption, 'catalog:v1 op=' + op.operationId + ' part=PROJECT:0');
    await drain(m, lib, ['TRANSFER_VERIFY']);
    assert.equal((await m.ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
    const attempts = await m.direct.listAttempts({ userId: lib.userId, operationId: op.operationId });
    assert.equal(attempts.attempts.length, 4); assert.ok(attempts.attempts.every((x) => x.status === 'CONSUMED' && x.outcome === 'SENT'), JSON.stringify(attempts.attempts.map((x) => [x.status, x.outcome])));
    // remitente persistido de TODAS las partes = el bot (ninguna identidad MASTER)
    const senders = (await pool.query('SELECT DISTINCT sender_id FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2', [lib.userId, op.operationId])).rows.map((r) => r.sender_id);
    assert.deepEqual(senders, ['Bot20']);
    // lectura: el acceso solo autoriza y entrega la referencia directa; el navegador lee de Telegram y los bytes son los originales
    const current = (await pool.query('SELECT slot_key, file_id FROM catalog_current_files WHERE user_id = $1 ORDER BY slot_key', [lib.userId])).rows;
    assert.deepEqual(current.map((r) => r.slot_key), ['ARTWORK', 'FILES:0', 'MASTER', 'PROJECT']);
    const partOf = { ARTWORK: 'ARTWORK:0', 'FILES:0': 'FILES:0:0', MASTER: 'MASTER:0', PROJECT: 'PROJECT:0' };
    for (const row of current) {
      const access = await m.media.issueAccess({ userId: lib.userId, fileId: row.file_id });
      assert.equal(access.parts.length, 1); const p = access.parts[0];
      assert.deepEqual(Object.keys(p).sort(), ['bytesVerified', 'direct', 'hashVerified', 'partIndex', 'sha256', 'size', 'verificationLevel'], 'sin token ni URL de medios');
      const want = files[partOf[row.slot_key]];
      assert.ok((await browserRead(m, p.direct, p.size)).equals(want), `bytes íntegros de ${row.slot_key}`);
      assert.deepEqual(await m.media.confirmBytes({ userId: lib.userId, fileId: row.file_id, partIndex: 0, sha256: sha(want), size: want.length }), { partIndex: 0, level: 'BYTES', bytesVerified: true });
    }
    // otro usuario no obtiene referencias
    const other = await nativeLibrary(pool);
    await assert.rejects(m.media.issueAccess({ userId: other.userId, fileId: current[0].file_id }), code('NOT_FOUND'));
    // tráfico del Cloud: solo comprobó mensajes; jamás intentó enviar ni descargar; el gateway real ni siquiera tiene esos métodos
    assert.equal(m.cloud.verifyMessage, 4); assert.deepEqual(m.cloud.byteCalls, []);
    assert.deepEqual(Object.keys(m.cloudGateway).filter((k) => typeof m.cloudGateway[k] === 'function').sort(), ['deleteMessage', 'probeAbsence', 'searchByRandomId', 'verifyMessage']);
    assert.equal(m.server.messages().length, 4); assert.equal(m.server.counters().deletes, 0);
  });
});

test('PROJECT: límites de plan antes del ticket (sin efecto) y tamaño REAL comprobado en el proveedor (un documento distinto del declarado nunca se confirma)', async () => {
  await withDb(async (pool) => {
    const m = modules(pool); const lib = await nativeLibrary(pool); const hdr = hdrOf(lib);
    const mp3 = bytesOf(200_000, 'm'); const zip = bytesOf(500_000, 'z');
    const mk = async (name) => m.ops.createOperation({ ...hdr, idempotencyKey: `k${++keyN}`, intent: { kind: 'IMPORT', metadata: { name }, parts: [spec('MASTER:0', 'MASTER', 'MASTER', mp3, 'a.mp3', 'audio/mpeg'), spec('PROJECT:0', 'PROJECT', 'PROJECT', zip, 'a.zip', 'application/zip')] } });
    const op = await mk('Con proyecto');
    const before = m.server.messages().length;
    // plan sin PROJECT → 403; tope menor que lo declarado → 413; Access caído → 503. Ninguno despacha ni crea mensajes; el MASTER no se ve afectado.
    m.access.fn = async () => { throw Object.assign(new Error('PROJECT upload is not available on this plan.'), { code: 'PROJECT_UPLOAD_DENIED', status: 403 }); };
    await assert.rejects(m.direct.issueSendTicket({ ...hdr, operationId: op.operationId, partKey: 'PROJECT:0' }), (e) => e.code === 'PROJECT_UPLOAD_DENIED' && e.status === 403);
    m.access.fn = async () => ({ maxBytes: zip.length - 1 });
    await assert.rejects(m.direct.issueSendTicket({ ...hdr, operationId: op.operationId, partKey: 'PROJECT:0' }), (e) => e.code === 'PROJECT_TOO_LARGE' && e.status === 413 && e.detail.max_bytes === zip.length - 1);
    m.access.fn = async () => ({ maxBytes: null });
    await assert.rejects(m.direct.issueSendTicket({ ...hdr, operationId: op.operationId, partKey: 'PROJECT:0' }), (e) => e.code === 'PROJECT_ACCESS_UNAVAILABLE' && e.status === 503);
    assert.equal((await pool.query("SELECT dispatch_state FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND part_key = 'PROJECT:0'", [lib.userId, op.operationId])).rows[0].dispatch_state, 'PENDING');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2", [lib.userId, op.operationId])).rows[0].n, 0, 'ningún ticket emitido');
    assert.equal(m.server.messages().length, before);
    await browserUpload(m, lib, op.operationId, 'MASTER:0', mp3); // el límite de PROJECT no afecta a las demás partes
    // con plan válido el PROJECT sube y se confirma
    m.access.fn = async () => ({ maxBytes: zip.length });
    await browserUpload(m, lib, op.operationId, 'PROJECT:0', zip);
    await drain(m, lib, ['TRANSFER_VERIFY']);
    assert.equal((await m.ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
    // tamaño real distinto: el cliente envía menos bytes y declara en el recibo el tamaño esperado → la verificación del proveedor lo rechaza
    const op2 = await mk('Proyecto alterado');
    await browserUpload(m, lib, op2.operationId, 'MASTER:0', mp3);
    await browserUpload(m, lib, op2.operationId, 'PROJECT:0', zip.subarray(0, zip.length - 1000), { claimSize: zip.length });
    await drain(m, lib, ['TRANSFER_VERIFY'], 6);
    const part = (await pool.query("SELECT dispatch_state FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND part_key = 'PROJECT:0'", [lib.userId, op2.operationId])).rows[0];
    assert.equal(part.dispatch_state, 'RECEIPT', 'nunca pasa a VERIFIED');
    const job = (await pool.query("SELECT last_error FROM catalog_jobs WHERE user_id = $1 AND operation_id = $2 AND kind = 'TRANSFER_VERIFY' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1", [lib.userId, op2.operationId])).rows[0];
    assert.match(String(job && job.last_error), /VERIFICATION_MISMATCH/);
    assert.notEqual((await m.ops.commitOperation({ ...hdr, operationId: op2.operationId })).status, 200, 'sin verificación no hay commit');
    assert.equal((await m.q.listBeats({ userId: lib.userId, query: {} })).items.filter((b) => b.name === 'Proyecto alterado').length, 0);
    // un recibo honesto con el tamaño real se rechaza de inmediato (tamaño distinto del declarado)
    const op3 = await mk('Recibo honesto');
    const t = await m.direct.issueSendTicket({ ...hdr, operationId: op3.operationId, partKey: 'PROJECT:0' });
    const short = zip.subarray(0, 1000);
    const s = await m.browser.sendPart({ operationId: op3.operationId, partKey: 'PROJECT:0', randomId: t.randomId, chatId: t.chatId, file: { name: 'a.zip', size: short.length, buffer: short }, mimeType: t.mime, fileName: 'a.zip' });
    await assert.rejects(m.direct.submitReceipt({ ...hdr, operationId: op3.operationId, partKey: 'PROJECT:0', attempt: t.attempt, receipt: { messageId: s.messageId, size: s.size, senderId: s.senderId, chatId: s.chatId } }), code('RECEIPT_CONFLICT'));
    assert.deepEqual(m.cloud.byteCalls, []); assert.equal(m.server.counters().deletes, 0);
  });
});
