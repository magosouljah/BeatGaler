'use strict';
// E70 — Direct B (Web) sobre PostgreSQL real aislado (`node scripts/catalog-check.cjs T12`), con Telegram FAKE:
//  - el «navegador» es OTRA sesión del mismo bot (otra clave de autorización) que envía con el random_id y el caption del ticket;
//  - el servidor (sesión del gateway) NO envía ni sube bytes: solo verifica (PROVIDER) y reconcilia.
// Prueba: camino feliz sin bytes en Cloud, reintento sin efecto con la MISMA identidad, incierto → reconciliación sin reenvío (un solo mensaje),
// ticket sin informe → bloqueado, recibo tardío contradictorio rechazado, aislamiento entre usuarios y sin credenciales en la sesión.
// NO demuestra aislamiento entre usuarios que comparten un bot en Telegram real (D2 omitido) ni G2.
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
const { createFakeTelegramServer } = require('../helpers/catalog-fake-mtproto.cjs');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const { Api } = require(path.join(__dirname, '..', '..', 'node_modules', 'telegram'));
const bigInt = require(path.join(__dirname, '..', '..', 'node_modules', 'big-integer'));
db.validateAdminTarget();
const sdk = { Api, bigInt };
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
let seq = 0; let keyN = 0;
const key = () => `k-${++keyN}`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function withDb(fn) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max: 10 });
  try {
    await mig.applyMigrations(pool);
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [sha('x')]).catch(() => {});
    return await fn(pool, h);
  } finally { await pool.end(); await h.cleanup(); }
}
const auth = (pool) => authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres' });
const peerOf = (chatId) => new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt('7') });
const resolvePeer = async (chatId) => ({ peer: peerOf(chatId), channel: true });
function modules(pool, serverOpts = {}) {
  const server = createFakeTelegramServer(serverOpts); const a = auth(pool);
  const serverClient = server.session({ selfId: '20' }); // sesión del gateway del SERVIDOR (solo verifica/reconcilia)
  const gateway = { ...telegramOp.createOperatorTelegram({ client: serverClient, sdk, senderId: '20', botId: 'Bot20', resolvePeer }), client: serverClient };
  const browserClient = server.session({ selfId: '20' }); // «navegador»: misma identidad de bot, otra clave
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: null }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const calls = [];
  const direct = createCatalogDirect({ pool, authority: a, operations: ops,
    sessionSource: async ({ botId, chatId }) => { calls.push({ botId, chatId }); return { ok: true, session_id: 's1', transport_id: botId, chat_id: chatId, bot_token: 'SECRET-TOKEN', telegram_api_id: 1, telegram_api_hash: 'SECRET-HASH', transport_user_id: '20' }; },
    bindBuilder: async (session, metadata) => { const { bot_token: _t, telegram_api_hash: _h, telegram_api_id: _i, ...safe } = session; return { ...safe, mode: 'galer-direct-temp-mtproto', temp_auth_required: !metadata, temp_auth: { version: 1, dc_id: 2, api_id: 1, expected_bot_id: '20', expires_at: metadata ? metadata.expiresAt : null, binding: metadata ? { perm_auth_key_id: { low: 1, high: 2, unsigned: false }, encrypted_message: 'AA==' } : null } }; } });
  const worker = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: gateway, purge: null, owner: 'w', options: { globalConcurrency: 2, renewEveryMs: 100_000, stepsPerClaim: 4 } });
  return { pool, ops, q, cmd, gateway, direct, worker, server, browserClient, calls };
}
// «Navegador»: envía como lo haría mtcute con el ticket (random_id + caption del servidor) y devuelve el recibo candidato.
async function browserSend(m, ticket, bytes, { client = m.browserClient } = {}) {
  const gw = telegramOp.createOperatorTelegram({ client, sdk, senderId: '20', botId: 'Bot20', resolvePeer });
  return gw.sendPart({ operationId: ticket.operationId, partKey: ticket.partKey, randomId: ticket.randomId, chatId: ticket.chatId, file: { name: ticket.filename, size: bytes.length, buffer: bytes }, mimeType: ticket.mime, fileName: ticket.filename });
}
const receiptOf = (sent, bytes) => ({ messageId: sent.messageId, documentId: sent.documentId, size: sent.size ?? bytes.length, senderId: sent.senderId, chatId: sent.chatId });
async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, era: ctx.authority_era, epoch: ctx.authority_epoch, chatId: `-100${seq}` };
}
const hdrOf = (lib) => ({ userId: lib.userId, era: lib.era, epoch: lib.epoch });
const part = (k, bytes, slot, role) => ({ partKey: k, slotKey: slot, role, partIndex: 0, size: bytes.length, sha256: sha(bytes), filename: `${k}.bin`, mime: role === 'ARTWORK' ? 'image/png' : 'audio/mpeg' });
async function drain(worker, pool, lib, { kinds = null, rounds = 60 } = {}) {
  for (let i = 0; i < rounds; i++) {
    await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1 AND state = 'QUEUED'", [lib.userId]);
    await worker.runOnce({ kinds });
    const pending = (await pool.query(`SELECT count(*)::int AS n FROM catalog_jobs WHERE user_id = $1 AND state IN ('QUEUED', 'LEASED')${kinds ? ' AND kind = ANY($2::text[])' : ''}`, kinds ? [lib.userId, kinds] : [lib.userId])).rows[0].n;
    if (pending === 0) return i + 1;
  }
  return rounds;
}
const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, `esperado ${code}, recibido ${e.code}: ${e.message}`); return true; });
const capRows = async (pool, lib, op, partKey) => (await pool.query('SELECT attempt, status, outcome FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 ORDER BY attempt', [lib.userId, op, partKey])).rows;
const partRow = async (pool, lib, op, partKey) => (await pool.query('SELECT dispatch_state, random_id, provider_message_id::text AS msg, verified_sha256 FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND part_key = $3', [lib.userId, op, partKey])).rows[0];

async function sendPartDirect(m, lib, op, partKey, bytes) {
  const t = await m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op, partKey });
  const sent = await browserSend(m, t, bytes);
  const dto = await m.direct.submitReceipt({ ...hdrOf(lib), operationId: op, partKey, attempt: t.attempt, receipt: receiptOf(sent, bytes) });
  return { t, sent, dto };
}

test('camino feliz: ticket → envío del «navegador» → recibo → verificación PROVIDER → commit, sin un solo byte por el gateway del servidor', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool);
    const master = Buffer.alloc(4096, 7); const art = Buffer.from(crypto.randomBytes(900));
    const op = await m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER'), part('a0', art, 'ARTWORK', 'ARTWORK')], metadata: { name: 'Direct A' } } });
    const before = await pool.query('SELECT random_id FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 ORDER BY part_key', [lib.userId, op.operationId]);
    const a = await sendPartDirect(m, lib, op.operationId, 'm0', master); const b = await sendPartDirect(m, lib, op.operationId, 'a0', art);
    // identidad persistida ANTES del efecto: el ticket entrega exactamente el random_id guardado en createOperation
    assert.deepEqual([a.t.randomId, b.t.randomId].sort(), before.rows.map((r) => r.random_id).sort());
    assert.equal(a.t.caption, `catalog:v1 op=${op.operationId} part=m0`); assert.equal(a.t.chatId, lib.chatId); assert.equal(a.t.botId, 'Bot20');
    assert.ok(!('bot_token' in a.t) && !('token' in a.t));
    assert.equal((await partRow(pool, lib, op.operationId, 'm0')).dispatch_state, 'RECEIPT');
    // el servidor no subió ni envió nada: solo hay envíos del «navegador»; las lecturas del servidor son verificaciones
    const c0 = m.server.counters(); assert.equal(c0.sends, 2); assert.equal(c0.uploads, 2); assert.equal(c0.downloadBytes, 0);
    await drain(m.worker, pool, lib, { kinds: ['TRANSFER_VERIFY'] });
    assert.equal((await partRow(pool, lib, op.operationId, 'm0')).dispatch_state, 'VERIFIED');
    const r = await m.ops.commitOperation({ ...hdrOf(lib), operationId: op.operationId }); assert.equal(r.status, 200);
    const loc = (await pool.query("SELECT verification_level FROM catalog_part_locations WHERE user_id = $1", [lib.userId])).rows; assert.ok(loc.length >= 2); assert.ok(loc.every((x) => x.verification_level === 'PROVIDER'));
    assert.deepEqual((await capRows(pool, lib, op.operationId, 'm0')).map((x) => `${x.status}/${x.outcome}`), ['CONSUMED/SENT']);
    assert.equal(m.server.messages().length, 2, 'un solo mensaje por parte');
  });
});

test('ticket sin informe tras un fallo de envío: otro ticket queda bloqueado (PART_UNCERTAIN, sin reenvío)', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool); const master = Buffer.alloc(1500, 5);
    const op = await m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER')], metadata: { name: 'Flood' } } });
    const t1 = await m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' });
    m.browserClient.script({ type: 'flood', seconds: 2 });
    await assert.rejects(browserSend(m, t1, master), (e) => /SEND_REJECTED/.test(e.code)); // sin efecto: nada en el proveedor
    assert.equal(m.server.messages().length, 0);
    // sin informe, otro ticket está bloqueado (no se sabe si hubo efecto)
    await rejects(m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' }), 'PART_UNCERTAIN');
  });
});

test('informe REJECTED → nuevo ticket con el mismo random_id → recibo → commit (un mensaje)', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool); const master = Buffer.alloc(1500, 6);
    const op = await m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER')], metadata: { name: 'Retry' } } });
    const t1 = await m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' });
    m.browserClient.script({ type: 'flood', seconds: 3 });
    await assert.rejects(browserSend(m, t1, master));
    const rep = await m.direct.reportSend({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t1.attempt, outcome: 'REJECTED', code: 'FLOOD_WAIT_3', retryAfterMs: 3000 });
    assert.equal(rep.retry, 'SAME_IDENTITY'); assert.equal(rep.retryAfterMs, 3000);
    const replay = await m.direct.reportSend({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t1.attempt, outcome: 'REJECTED' }); assert.equal(replay.replay, true);
    const t2 = await m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' });
    assert.equal(t2.randomId, t1.randomId, 'misma identidad'); assert.equal(t2.attempt, t1.attempt + 1);
    const sent = await browserSend(m, t2, master);
    await m.direct.submitReceipt({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t2.attempt, receipt: receiptOf(sent, master) });
    await drain(m.worker, pool, lib, { kinds: ['TRANSFER_VERIFY'] });
    assert.equal((await m.ops.commitOperation({ ...hdrOf(lib), operationId: op.operationId })).status, 200);
    assert.equal(m.server.messages().length, 1);
    assert.deepEqual((await capRows(pool, lib, op.operationId, 'm0')).map((x) => `${x.status}/${x.outcome}`), ['FAILED/REJECTED', 'CONSUMED/SENT']);
  });
});

test('respuesta perdida (el mensaje SÍ existe): UNCERTAIN → sin reenvío → la reconciliación NO adopta sola (E5/C7.8) y queda para revisión', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool); const master = Buffer.alloc(2200, 9);
    const op = await m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER')], metadata: { name: 'Lost' } } });
    const t1 = await m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' });
    m.browserClient.script({ type: 'loseResponse' });
    await assert.rejects(browserSend(m, t1, master)); // el efecto ocurrió en Telegram, el navegador no lo sabe
    assert.equal(m.server.messages().length, 1);
    const rep = await m.direct.reportSend({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t1.attempt, outcome: 'UNCERTAIN', code: 'ETIMEDOUT' });
    assert.equal(rep.state, 'UNCERTAIN'); assert.equal(rep.resend, 'BLOCKED'); assert.equal(rep.reconcile, true);
    await rejects(m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' }), 'PART_UNCERTAIN');
    await drain(m.worker, pool, lib);
    // contrato vigente: una sola coincidencia por búsqueda no prueba unicidad → revisión; nada adoptado, reenviado ni borrado
    const p = await partRow(pool, lib, op.operationId, 'm0'); assert.equal(p.dispatch_state, 'DISPATCHED'); assert.equal(p.msg, null);
    const job = (await pool.query("SELECT state, last_error FROM catalog_jobs WHERE user_id = $1 AND kind = 'TRANSFER_RECONCILE'", [lib.userId])).rows[0];
    assert.match(String(job.last_error || job.state), /RECONCILE_REVIEW_REQUIRED|BLOCKED|FAILED|DEAD/i);
    assert.equal(m.server.messages().length, 1, 'ni reenvío ni borrado');
    assert.equal(m.server.counters().deletes, 0);
  });
});

test('confirmaciones tardías contradictorias: la primera recibida se verifica y gana; un duplicado posterior se rechaza y queda huérfano sin referencia', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool); const master = Buffer.alloc(2200, 8);
    const op = await m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER')], metadata: { name: 'Late' } } });
    const t1 = await m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' });
    const first = await browserSend(m, t1, master);
    // un segundo envío duplicado (otra identidad: p. ej. un cliente que reintentó fuera de la ventana de deduplicación de Telegram)
    const dup = await browserSend(m, { ...t1, randomId: g.newRandomId() }, master, { client: m.server.session({ selfId: '20' }) });
    assert.notEqual(first.messageId, dup.messageId);
    await m.direct.submitReceipt({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t1.attempt, receipt: receiptOf(first, master) });
    await rejects(m.direct.submitReceipt({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t1.attempt, receipt: receiptOf(dup, master) }), 'RECEIPT_CONFLICT');
    const adopted = (await partRow(pool, lib, op.operationId, 'm0')).msg; assert.equal(adopted, String(first.messageId));
    // el mismo recibo repetido es idempotente
    const again = await m.direct.submitReceipt({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t1.attempt, receipt: receiptOf(first, master) }); assert.equal(again.replay, true);
    await drain(m.worker, pool, lib, { kinds: ['TRANSFER_VERIFY'] });
    assert.equal((await m.ops.commitOperation({ ...hdrOf(lib), operationId: op.operationId })).status, 200);
    const refs = (await pool.query("SELECT o.message_id::text AS msg FROM catalog_part_locations l JOIN catalog_media_objects o ON o.user_id = l.user_id AND o.object_id = l.object_id WHERE l.user_id = $1 AND l.location = 'PRIMARY'", [lib.userId])).rows;
    assert.deepEqual(refs.map((r) => r.msg), [String(first.messageId)], 'PostgreSQL conserva UNA referencia activa');
    assert.equal(m.server.messages().length, 2, 'el duplicado queda huérfano en Telegram (aceptado por el propietario), nunca referenciado');
    // el recibo tardío tras el commit tampoco puede cambiar nada
    await rejects(m.direct.submitReceipt({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t1.attempt, receipt: receiptOf(dup, master) }), 'RECEIPT_CONFLICT');
  });
});

test('recibo que apunta a OTRO mensaje del mismo bot, chat y tamaño (sin el marcador de esta parte): la verificación del proveedor lo rechaza', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool); const master = Buffer.alloc(1800, 3);
    const op1 = await m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER')], metadata: { name: 'One' } } });
    const op2 = await m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER')], metadata: { name: 'Two' } } });
    const a = await sendPartDirect(m, lib, op1.operationId, 'm0', master);
    const t2 = await m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op2.operationId, partKey: 'm0' });
    // la segunda operación presenta el mensaje de la primera (mismo tamaño, mismo remitente, mismo chat)
    await m.direct.submitReceipt({ ...hdrOf(lib), operationId: op2.operationId, partKey: 'm0', attempt: t2.attempt, receipt: receiptOf(a.sent, master) });
    await drain(m.worker, pool, lib, { kinds: ['TRANSFER_VERIFY'] });
    assert.equal((await partRow(pool, lib, op1.operationId, 'm0')).dispatch_state, 'VERIFIED');
    assert.notEqual((await partRow(pool, lib, op2.operationId, 'm0')).dispatch_state, 'VERIFIED', 'no se confirma con un mensaje ajeno a la parte');
    await rejects(m.ops.commitOperation({ ...hdrOf(lib), operationId: op2.operationId }).then((r) => { if (r.status === 200) return r; throw Object.assign(new Error('not committed'), { code: 'NOT_COMMITTED' }); }), 'NOT_COMMITTED');
  });
});

test('recibo cuyo tamaño no coincide / operación cerrada: rechazado; el ticket queda abierto y bloquea otro envío (RECONCILE)', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool); const master = Buffer.alloc(1300, 4);
    const op = await m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER')], metadata: { name: 'Bad' } } });
    const t = await m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' });
    const sent = await browserSend(m, t, master);
    await rejects(m.direct.submitReceipt({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t.attempt, receipt: { ...receiptOf(sent, master), size: 7 } }), 'RECEIPT_CONFLICT');
    await rejects(m.direct.submitReceipt({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t.attempt, receipt: { ...receiptOf(sent, master), chatId: '-100999' } }), 'RECEIPT_CONFLICT');
    await rejects(m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' }), 'PART_UNCERTAIN');
    // el recibo correcto sigue siendo posible y el ticket se cierra
    await m.direct.submitReceipt({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0', attempt: t.attempt, receipt: receiptOf(sent, master) });
    assert.equal((await partRow(pool, lib, op.operationId, 'm0')).dispatch_state, 'RECEIPT');
    await rejects(m.direct.issueSendTicket({ ...hdrOf(lib), operationId: op.operationId, partKey: 'm0' }), 'PART_STATE_CONFLICT');
  });
});

test('aislamiento: otro usuario no obtiene ticket, informe ni recibo; PROJECT exige Access (plan) antes del ticket; informes inválidos se rechazan', async () => {
  await withDb(async (pool) => {
    const A = await nativeLibrary(pool); const B = await nativeLibrary(pool); const m = modules(pool); const master = Buffer.alloc(900, 2);
    const op = await m.ops.createOperation({ ...hdrOf(A), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER'), { ...part('p0', Buffer.alloc(300, 1), 'PROJECT', 'PROJECT') }], metadata: { name: 'Mine' } } });
    await rejects(m.direct.issueSendTicket({ ...hdrOf(B), operationId: op.operationId, partKey: 'm0' }), 'NOT_FOUND');
    const t = await m.direct.issueSendTicket({ ...hdrOf(A), operationId: op.operationId, partKey: 'm0' });
    await rejects(m.direct.reportSend({ ...hdrOf(B), operationId: op.operationId, partKey: 'm0', attempt: t.attempt, outcome: 'REJECTED' }), 'NOT_FOUND');
    const sent = await browserSend(m, t, master);
    await rejects(m.direct.submitReceipt({ ...hdrOf(B), operationId: op.operationId, partKey: 'm0', attempt: t.attempt, receipt: receiptOf(sent, master) }), 'NOT_FOUND');
    await rejects(m.direct.reportSend({ ...hdrOf(A), operationId: op.operationId, partKey: 'm0', attempt: t.attempt, outcome: 'SENT' }), 'INPUT_INVALID');
    await rejects(m.direct.reportSend({ ...hdrOf(A), operationId: op.operationId, partKey: 'm0', attempt: 0, outcome: 'REJECTED' }), 'INPUT_INVALID');
    await rejects(m.direct.issueSendTicket({ ...hdrOf(A), operationId: op.operationId, partKey: 'p0' }), 'PROJECT_ACCESS_UNAVAILABLE'); // E77: PROJECT va por Direct B, pero sin resolver de Access (plan) no se emite ticket
    await rejects(m.direct.issueSendTicket({ userId: A.userId, era: A.era, epoch: '999', operationId: op.operationId, partKey: 'm0' }), 'CATALOG_EPOCH_STALE');
  });
});

test('sesión: sin credenciales permanentes, solo el bot/chat de la biblioteca, ventana de expiración acotada, sin INDEX', async () => {
  await withDb(async (pool) => {
    const A = await nativeLibrary(pool); const B = await nativeLibrary(pool); const m = modules(pool);
    const boot = await m.direct.startSession({ userId: A.userId });
    assert.equal(boot.temp_auth_required, true); assert.equal(boot.index_pointer, null); assert.equal(boot.chat_id, A.chatId); assert.equal(boot.protocol, 'catalog-v1-direct');
    assert.equal(boot.catalog.authority_era, A.era);
    const blob = JSON.stringify(boot); for (const forbidden of ['SECRET-TOKEN', 'SECRET-HASH', 'bot_token', 'telegram_api_hash']) assert.ok(!blob.includes(forbidden), `la respuesta no debe contener ${forbidden}`);
    const exp = Math.floor(Date.now() / 1000) + 600;
    const bound = await m.direct.startSession({ userId: A.userId, tempAuthMetadata: { expiresAt: exp, msgId: {}, nonce: {}, tempAuthKeyId: {}, tempSessionId: {} } });
    assert.equal(bound.temp_auth_required, false); assert.equal(bound.temp_auth.expires_at, exp);
    await rejects(m.direct.startSession({ userId: A.userId, tempAuthMetadata: { expiresAt: Math.floor(Date.now() / 1000) + 5 } }), 'INPUT_INVALID');
    await rejects(m.direct.startSession({ userId: A.userId, tempAuthMetadata: { expiresAt: Math.floor(Date.now() / 1000) + 3600 } }), 'INPUT_INVALID');
    const other = await m.direct.startSession({ userId: B.userId });
    assert.equal(other.chat_id, B.chatId); assert.notEqual(other.chat_id, boot.chat_id);
    assert.deepEqual(m.calls.map((c) => c.chatId), [A.chatId, A.chatId, B.chatId], 'la fuente de sesión solo recibe el chat de la propia biblioteca');
    // usuario sin biblioteca nativa: fail-closed
    await pool.query("INSERT INTO users(id, email) VALUES ('nolib', 'n@fake.invalid')");
    await assert.rejects(m.direct.startSession({ userId: 'nolib' }));
  });
});

test('lectura directa: el acceso entrega la referencia chat/message_id (sin concesiones de bytes ni URLs); el hash de los bytes recibidos sube la ubicación a BYTES', async () => {
  const { createCatalogMedia } = require('../../catalog/media.js');
  await withDb(async (pool) => {
    const A = await nativeLibrary(pool); const B = await nativeLibrary(pool); const m = modules(pool); const master = Buffer.from(crypto.randomBytes(3000));
    const op = await m.ops.createOperation({ ...hdrOf(A), idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER')], metadata: { name: 'Read' } } });
    const s = await sendPartDirect(m, A, op.operationId, 'm0', master);
    await drain(m.worker, pool, A, { kinds: ['TRANSFER_VERIFY'] });
    assert.equal((await m.ops.commitOperation({ ...hdrOf(A), operationId: op.operationId })).status, 200);
    const beat = (await m.q.listBeats({ userId: A.userId, limit: 5 })).items[0];
    const fileId = (await pool.query("SELECT file_id FROM catalog_current_files WHERE user_id = $1 AND slot_key = 'MASTER'", [A.userId])).rows[0].file_id; assert.ok(beat && fileId);
    const a = auth(pool);
    const mediaOn = createCatalogMedia({ pool, authority: a });
    const acc = await mediaOn.issueAccess({ userId: A.userId, fileId });
    assert.equal(JSON.stringify(acc).includes('/media/'), false, 'sin URL de medios'); assert.equal(acc.parts[0].token, undefined, 'sin token de bytes');
    const p0 = acc.parts[0]; assert.deepEqual(p0.direct, { chatId: A.chatId, messageId: s.sent.messageId }); assert.equal(p0.bytesVerified, false); assert.equal(p0.sha256, sha(master)); assert.equal(p0.hashVerified, false, 'solo hash DECLARADO');
    // el «navegador» descarga de Telegram con su propia sesión y calcula el hash de lo recibido
    const dl = []; const msg = (await m.browserClient.invoke(g.buildGetMessages(sdk, { peer: peerOf(A.chatId), messageId: p0.direct.messageId, channel: true }))).messages[0];
    for await (const c of m.browserClient.iterDownload({ file: msg.media, offset: 0, limit: null, requestSize: 1024 })) dl.push(Buffer.from(c));
    const got = Buffer.concat(dl); assert.equal(sha(got), p0.sha256);
    assert.equal(m.server.counters().downloadBytes, master.length, 'solo el «navegador» leyó los bytes; el servidor no descargó nada');
    // discrepancia: 409 y ningún cambio de nivel
    await rejects(mediaOn.confirmBytes({ userId: A.userId, fileId, partIndex: 0, sha256: sha(Buffer.from('otro')), size: master.length }), 'BYTES_MISMATCH');
    await rejects(mediaOn.confirmBytes({ userId: A.userId, fileId, partIndex: 0, sha256: sha(master), size: master.length + 1 }), 'BYTES_MISMATCH');
    assert.equal((await mediaOn.issueAccess({ userId: A.userId, fileId })).parts[0].bytesVerified, false);
    // otro usuario no puede atestiguar ni leer la parte
    await rejects(mediaOn.confirmBytes({ userId: B.userId, fileId, partIndex: 0, sha256: sha(master), size: master.length }), 'LIBRARY_NOT_PROVISIONED').catch(async () => rejects(mediaOn.confirmBytes({ userId: B.userId, fileId, partIndex: 0, sha256: sha(master), size: master.length }), 'NOT_FOUND'));
    const ok = await mediaOn.confirmBytes({ userId: A.userId, fileId, partIndex: 0, sha256: sha(got), size: got.length }); assert.equal(ok.level, 'BYTES');
    assert.equal((await mediaOn.confirmBytes({ userId: A.userId, fileId, partIndex: 0, sha256: sha(got), size: got.length })).replay, true);
    const after = await mediaOn.issueAccess({ userId: A.userId, fileId, direct: true }); assert.equal(after.parts[0].bytesVerified, true); assert.equal(after.parts[0].verificationLevel, 'BYTES');
    // el gateway del servidor sigue sirviendo (respaldo)
    assert.equal(mediaOn.stream, undefined, 'el Cloud no transmite bytes: no existe stream de medios');
  });
});
