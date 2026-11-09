'use strict';
// T12 — Transferencias por capacidad y PROJECT por MASTER contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T12`), con el
// servidor Telegram FAKE (forma gramjs) detrás del adaptador real del gateway (T11) y el worker real (T10). Cubre la matriz de TAREAS §T12.4:
// respuesta perdida en reserve/upload/recibo/commit, conflicto de reemplazo, downgrade de Access, archivo reseleccionado distinto,
// multipart, cancel durante la subida y temporal perdido. Nada de esto es evidencia de proveedor (G2 NOT_PROVEN): etiqueta FAKE.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const operations = require('../../catalog/operations.js');
const queries = require('../../catalog/queries.js');
const commands = require('../../catalog/commands.js');
const codec = require('../../catalog/legacy-codec.js');
const { rebuildDerivedProjections } = require('../../catalog/staging.js');
const { createCatalogWorker } = require('../../catalog/worker.js');
const g = require('../../catalog/transport-gateway.js');
const { createCatalogTransport } = require('../../catalog/transport.js');
const { CatalogQueryError } = require('../../catalog/cursor.js');
const { createFakeTelegramServer } = require('../helpers/catalog-fake-mtproto.cjs');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const { Api } = require(path.join(__dirname, '..', '..', 'node_modules', 'telegram'));
const bigInt = require(path.join(__dirname, '..', '..', 'node_modules', 'big-integer'));
db.validateAdminTarget();
const sdk = { Api, bigInt };
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const H = crypto.createHash('sha256').update('x').digest('hex');
let seq = 0; let keyN = 0;
const key = () => `k-${++keyN}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t12-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function withDb(fn, { max = 10 } = {}) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max });
  try {
    await mig.applyMigrations(pool);
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [H]);
    return await fn(pool, h);
  } finally { await pool.end(); await h.cleanup(); }
}
const auth = (pool) => authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres' });
const peerOf = (chatId) => new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt('7') });
function gatewayOn(server) {
  const client = server.session({ selfId: '20' });
  // adaptador real del gateway (T11) sobre la sesión fake del bot 20 (= transport_bots.id 'Bot20'); la sesión se expone para programar fallos
  return { ...g.createTelegramGateway({ client, sdk, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) }), client };
}
// MASTER fake: cuenta de usuario 777 en el mismo servidor fake; publica con el caption del catálogo y randomId explícito.
function fakeMaster(server, { probe = null, failAfterSend = null } = {}) {
  const session = server.session({ selfId: '777' }); const calls = [];
  return {
    calls, session,
    async resolveSenderId() { calls.push('me'); return '777'; },
    async publishProjectFile({ chatId, filePath, filename, caption, randomId }) {
      calls.push('publish'); if (probe) await probe();
      const inputFile = await session.uploadFile({ file: { name: filename, path: filePath } });
      const res = await session.invoke(g.buildSendMedia(sdk, { peer: peerOf(chatId), inputFile, mimeType: 'application/zip', fileName: filename, caption, randomId }));
      const fail = failAfterSend ? failAfterSend() : null; if (fail) throw fail;
      const r = g.receiptFromUpdates(res, { randomId });
      return { messageId: r.messageId, documentId: r.documentId, senderId: '777', sizeBytes: r.size };
    },
  };
}
function modules(pool, { maxBeats = null, server, master = null, access = { maxBytes: 1_000_000 }, ops: opsOverride = null, gateway: gwOverride = null, ttlMs = 600_000 } = {}) {
  const a = auth(pool);
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const gateway = gwOverride ? gwOverride(gatewayOn(server)) : gatewayOn(server);
  const transport = createCatalogTransport({ pool, authority: a, operations: opsOverride ? opsOverride(ops) : ops, gateway, master, resolveProjectAccess: async () => access, tempDir: TMP, capabilityTtlMs: ttlMs });
  const worker = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: gateway, owner: 'w', options: { globalConcurrency: 2, renewEveryMs: 100_000 } });
  return { a, ops, q, cmd, gateway, transport, worker };
}
async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, era: ctx.authority_era, epoch: ctx.authority_epoch, generationId: ctx.generation_id, chatId: `-100${seq}` };
}
async function seedBeats(pool, lib, n) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (let i = 0; i < n; i++) {
      const beat = { id: `b${String(i).padStart(4, '0')}`, name: `Beat ${i}`, bpm: '120', key: 'Cm', rating: i % 5, tags: ['all'] };
      const p = codec.projectBeat(beat); const json = JSON.stringify(beat);
      await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, bpm_sort_class, bpm_sort, manual_rank, has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
        VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [lib.userId, lib.generationId, beat.id, p.name, p.bpmText, p.keyText, p.rating, p.bpmSortClass, p.bpmSort, String(i * 1000), json, sha(json), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
      for (const t of p.tags) await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [lib.userId, lib.generationId, beat.id, t.position, t.label, t.normKey, t.searchKey]);
    }
    await c.query('UPDATE catalog_libraries SET active_count = $2 WHERE user_id = $1', [lib.userId, n]);
    await rebuildDerivedProjections(c, lib); await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const bytesOf = (s, n) => Buffer.alloc(n, s);
const partOf = (partKey, bytes, over = {}) => ({ partKey, slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: bytes.length, sha256: sha(bytes), filename: 'beat.mp3', mime: 'audio/mpeg', ...over });
const hdrOf = (lib) => ({ userId: lib.userId, era: lib.era, epoch: lib.epoch });
const put = (transport, hdr, token, bytes, chunks = 1) => {
  const parts = []; const size = Math.ceil(bytes.length / chunks);
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
  return transport.uploadPart({ ...hdr, token, stream: Readable.from(parts), contentLength: bytes.length });
};
const partRow = async (pool, uid, op, partKey) => (await pool.query('SELECT dispatch_state, random_id, sender_id, attempts, receipt_json, provider_message_id::text AS mid FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND part_key = $3', [uid, op, partKey])).rows[0];
const journalOf = async (pool, uid, op) => (await pool.query('SELECT part_key, direction, attempt, status, outcome, bytes_sha256 FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 ORDER BY part_key, attempt', [uid, op])).rows;
const jobsOf = async (pool, uid) => (await pool.query('SELECT job_id, kind, state, attempts FROM catalog_jobs WHERE user_id = $1 ORDER BY created_at, job_id', [uid])).rows;
const opStatus = async (pool, uid, op) => (await pool.query('SELECT status FROM catalog_transfer_operations WHERE user_id = $1 AND operation_id = $2', [uid, op])).rows[0].status;
// Ejecuta el worker hasta vaciar la cola (adelanta next_attempt_at: el backoff real no se espera en pruebas).
async function drain(worker, pool, uid, { rounds = 8, kinds = null } = {}) {
  for (let i = 0; i < rounds; i++) {
    await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1 AND state = 'QUEUED'", [uid]);
    await worker.runOnce({ kinds });
    const pending = (await pool.query(`SELECT count(*)::int AS n FROM catalog_jobs WHERE user_id = $1 AND state IN ('QUEUED', 'LEASED')${kinds ? ' AND kind = ANY($2::text[])' : ''}`, kinds ? [uid, kinds] : [uid])).rows[0].n;
    if (pending === 0) return i + 1;
  }
  return rounds;
}
const VERIFY_ONLY = ['TRANSFER_VERIFY', 'TRANSFER_RECONCILE'];
const rejects = (p, code, extra = (e) => true) => assert.rejects(p, (e) => { assert.equal(e.code, code, `código esperado ${code}, recibido ${e.code}: ${e.message}`); return extra(e); });

test('IMPORT multipart por capacidad: token de un solo uso, bytes → gateway sin cliente SQL retenido, recibo con hash GATEWAY, verificación PROVIDER por worker, commit instala 2 partes y replay devuelve lo mismo', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const server = createFakeTelegramServer();
  const { ops, transport, worker, gateway } = modules(pool, { maxBeats: 10, server });
  const hdr = hdrOf(lib);
  const b0 = bytesOf('a', 1500); const b1 = bytesOf('b', 700);
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [partOf('m0', b0), partOf('m1', b1, { partIndex: 1 })], metadata: { name: 'Multi' } } });
  const cap0 = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  assert.match(cap0.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(cap0.attempt, 1); assert.equal(cap0.uploadPath, `/catalog/v1/transfer/upload/${cap0.token}`);
  assert.deepEqual(Object.keys(cap0).filter((k) => /chat|message|random|token$/i.test(k)), ['token'], 'el cliente solo recibe el token opaco: nunca chat, message ni random_id');
  const stored = (await pool.query('SELECT capability_hash, status FROM catalog_transfer_capabilities WHERE user_id = $1', [lib.userId])).rows;
  assert.deepEqual(stored, [{ capability_hash: sha(cap0.token), status: 'ISSUED' }], 'solo se guarda el hash');
  // pausa el envío tras el efecto: durante la espera remota ningún cliente SQL del transporte está retenido (C1.5)
  let release; const gate = new Promise((r) => { release = r; });
  gateway.client.script({ type: 'pause', gate });
  const pending = put(transport, hdr, cap0.token, b0, 3);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(pool.totalCount - pool.idleCount, 0, 'sin conexiones retenidas mientras el envío está en curso');
  release();
  const r0 = await pending;
  assert.equal(r0.status, 200);
  assert.deepEqual([r0.body.upload.state, r0.body.upload.level, r0.body.upload.bytesSha256, r0.body.upload.verification], ['RECEIPT', 'GATEWAY', sha(b0), 'PENDING_PROVIDER']);
  await rejects(put(transport, hdr, cap0.token, b0), 'CAPABILITY_INVALID', (e) => e.status === 403 && e.detail.reason === 'CONSUMED', 'token de un solo uso');
  const p0 = await partRow(pool, lib.userId, op.operationId, 'm0');
  assert.deepEqual([p0.dispatch_state, p0.attempts, JSON.parse(p0.receipt_json).bytesSha256, JSON.parse(p0.receipt_json).senderId], ['RECEIPT', 1, sha(b0), '20']);
  const msgs = server.messages();
  assert.equal(msgs.length, 1); assert.deepEqual([msgs[0].caption, msgs[0].size, msgs[0].sender, msgs[0].randomId], [`catalog:v1 op=${op.operationId} part=m0`, 1500, '20', p0.random_id]);
  const cap1 = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm1' });
  assert.equal((await put(transport, hdr, cap1.token, b1)).status, 200);
  // verificación independiente del proveedor por el worker (gateway: sender 'Bot20' ↔ id numérico 20)
  await drain(worker, pool, lib.userId, { kinds: VERIFY_ONLY });
  assert.equal(await opStatus(pool, lib.userId, op.operationId), 'READY');
  const c1 = await ops.commitOperation({ ...hdr, operationId: op.operationId });
  assert.equal(c1.status, 200); assert.equal(c1.operation.status, 'COMMITTED');
  const c2 = await ops.commitOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([c2.status, c2.operation.replay, c2.operation.result.version], [200, true, '1'], 'replay del commit (respuesta perdida en commit) devuelve lo mismo');
  const fv = (await pool.query('SELECT status, size_bytes::text AS size, verified_sha256 FROM catalog_file_versions WHERE user_id = $1 AND beat_id = $2', [lib.userId, op.beatId])).rows;
  assert.deepEqual(fv, [{ status: 'VERIFIED', size: '2200', verified_sha256: null }], 'multipart: tamaño total de 2 partes; sin hash remoto (nivel BYTES no demostrado)');
  const locs = (await pool.query('SELECT part_index, verification_level, checksum_sha256 FROM catalog_part_locations WHERE user_id = $1 ORDER BY part_index', [lib.userId])).rows;
  assert.deepEqual(locs, [{ part_index: 0, verification_level: 'PROVIDER', checksum_sha256: null }, { part_index: 1, verification_level: 'PROVIDER', checksum_sha256: null }], 'nivel PROVIDER veraz: el hash del gateway no se etiqueta como BYTES');
  const att = await transport.listAttempts({ userId: lib.userId, operationId: op.operationId });
  assert.deepEqual(att.attempts.map((x) => [x.partKey, x.status, x.outcome, x.level]), [['m0', 'CONSUMED', 'SENT', 'GATEWAY'], ['m1', 'CONSUMED', 'SENT', 'GATEWAY']]);
  assert.equal((await pool.query('SELECT active_count::int AS a, pending_count::int AS p FROM catalog_libraries WHERE user_id = $1', [lib.userId])).rows[0].a, 1);
  assert.deepEqual(transport.metrics.sent, 2);
}));

test('respuesta perdida en reserve (replay idempotente), en upload (envío incierto → 202, sin reenvío, reconcile adopta el único mensaje) y en recibo (enviado sin recibo → RECEIPT_PERSIST_FAILED + reconcile)', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const server = createFakeTelegramServer();
  let failReceipt = false;
  const { ops, transport, worker, gateway } = modules(pool, { maxBeats: 10, server, ops: (o) => ({ ...o, putReceipt: async (a) => { if (failReceipt) { failReceipt = false; throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'sql down after send', { reason: 'SQL_ERROR' }); } return o.putReceipt(a); } }) });
  const hdr = hdrOf(lib); const b = bytesOf('z', 1000);
  const k = key();
  const op = await ops.createOperation({ ...hdr, idempotencyKey: k, intent: { kind: 'IMPORT', parts: [partOf('m0', b)], metadata: { name: 'Lost' } } });
  const again = await ops.createOperation({ ...hdr, idempotencyKey: k, intent: { kind: 'IMPORT', parts: [partOf('m0', b)], metadata: { name: 'Lost' } } });
  assert.deepEqual([again.operationId, again.replay, again.created], [op.operationId, true, false], 'respuesta perdida en reserve: misma operación y misma reserva');
  assert.equal((await pool.query('SELECT pending_count::int AS p FROM catalog_libraries WHERE user_id = $1', [lib.userId])).rows[0].p, 1);
  // upload: el fake aplica el efecto y pierde la respuesta
  const t2 = transport; const w2 = worker; const ops2 = ops;
  const cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  gateway.client.script({ type: 'loseResponse' });
  const r = await put(t2, hdr, cap.token, b);
  assert.equal(r.status, 202);
  assert.deepEqual([r.body.upload.state, r.body.upload.reconcile, r.body.upload.resend, r.body.status], ['UNCERTAIN', true, 'BLOCKED', 'TRANSFERRING']);
  assert.equal(server.messages().length, 1, 'el efecto existe aunque la respuesta se perdió');
  assert.deepEqual((await journalOf(pool, lib.userId, op.operationId)).map((j) => [j.attempt, j.status, j.outcome]), [[1, 'CONSUMED', 'UNCERTAIN']]);
  assert.deepEqual((await jobsOf(pool, lib.userId)).map((j) => [j.kind, j.state]), [['TRANSFER_RECONCILE', 'QUEUED']]);
  await rejects(t2.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' }), 'PART_UNCERTAIN', (e) => e.detail.reconcile === true);
  assert.equal((await partRow(pool, lib.userId, op.operationId, 'm0')).dispatch_state, 'DISPATCHED');
  // reconcile por caption + remitente + tamaño → adopta el recibo → verificación → READY (un solo mensaje, nunca reenvío)
  await drain(w2, pool, lib.userId);
  assert.equal(server.messages().length, 1);
  assert.equal(await opStatus(pool, lib.userId, op.operationId), 'COMMITTED', 'reconcile → verificación → commit automático del worker');
  assert.equal((await partRow(pool, lib.userId, op.operationId, 'm0')).mid, String(server.messages()[0].id));
  assert.equal(server.counters().sends, 1, 'ningún reenvío automático');
  // recibo perdido: enviado pero SQL cae antes de persistir el recibo
  const op2 = await ops2.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [partOf('m0', bytesOf('q', 900))], metadata: { name: 'Receipt lost' } } });
  const cap2 = await t2.issueUploadCapability({ ...hdr, operationId: op2.operationId, partKey: 'm0' });
  failReceipt = true;
  await rejects(put(t2, hdr, cap2.token, bytesOf('q', 900)), 'RECEIPT_PERSIST_FAILED', (e) => e.status === 503 && e.detail.reconcile === true);
  assert.equal(server.messages().length, 2);
  assert.deepEqual((await journalOf(pool, lib.userId, op2.operationId)).map((j) => [j.status, j.outcome]), [['CONSUMED', 'UNCERTAIN']]);
  await rejects(t2.issueUploadCapability({ ...hdr, operationId: op2.operationId, partKey: 'm0' }), 'PART_UNCERTAIN');
  await drain(w2, pool, lib.userId);
  assert.equal(await opStatus(pool, lib.userId, op2.operationId), 'COMMITTED');
  assert.equal(server.counters().sends, 2);
}));

test('FLOOD_WAIT → 503 SEND_REJECTED con Retry-After, sin efecto; nueva capacidad conserva la misma identidad random_id; permanente → 403 y la parte queda sin enviar', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const server = createFakeTelegramServer();
  const session = server.session({ selfId: '20' });
  const a = auth(pool); const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: 10 }) });
  const gateway = g.createTelegramGateway({ client: session, sdk, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) });
  const transport = createCatalogTransport({ pool, authority: a, operations: ops, gateway, tempDir: TMP });
  const hdr = hdrOf(lib); const b = bytesOf('f', 1200);
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [partOf('m0', b)], metadata: { name: 'Flood' } } });
  const before = await partRow(pool, lib.userId, op.operationId, 'm0');
  session.script({ type: 'flood', seconds: 7 });
  const cap1 = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  await rejects(put(transport, hdr, cap1.token, b), 'SEND_REJECTED', (e) => e.status === 503 && e.detail.retry_after_ms === 7000 && e.detail.same_identity === true && e.detail.rpc === 'FLOOD_WAIT_7');
  assert.equal(server.messages().length, 0, 'FLOOD no crea mensaje');
  let p = await partRow(pool, lib.userId, op.operationId, 'm0');
  assert.deepEqual([p.dispatch_state, p.attempts, p.random_id], ['DISPATCHED', 1, before.random_id]);
  assert.deepEqual((await journalOf(pool, lib.userId, op.operationId)).map((j) => [j.attempt, j.status, j.outcome]), [[1, 'FAILED', 'REJECTED']]);
  assert.equal((await jobsOf(pool, lib.userId)).length, 0, 'un rechazo explícito no es incierto: sin reconcile');
  const cap2 = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  assert.equal(cap2.attempt, 2);
  assert.equal((await put(transport, hdr, cap2.token, b)).status, 200);
  p = await partRow(pool, lib.userId, op.operationId, 'm0');
  assert.deepEqual([p.dispatch_state, p.attempts, p.random_id, server.messages()[0].randomId], ['RECEIPT', 2, before.random_id, before.random_id], 'misma identidad en el reintento');
  assert.equal(server.messages().length, 1);
  // permanente (CHAT_WRITE_FORBIDDEN): 403, journal PERMANENT, sin mensaje
  const op2 = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [partOf('m0', bytesOf('p', 300))], metadata: { name: 'Perm' } } });
  session.script({ type: 'forbidden' });
  const cap3 = await transport.issueUploadCapability({ ...hdr, operationId: op2.operationId, partKey: 'm0' });
  await rejects(put(transport, hdr, cap3.token, bytesOf('p', 300)), 'SEND_REJECTED_PERMANENT', (e) => e.status === 403 && e.detail.same_identity === false);
  assert.deepEqual((await journalOf(pool, lib.userId, op2.operationId)).map((j) => j.outcome), ['PERMANENT']);
  assert.equal(server.messages().length, 1);
}));

test('archivo reseleccionado distinto o exceso → 409 sin efecto (parte PENDING); cancel limpio libera la reserva; stream abortado → ABORTED; temporal perdido → UPLOAD_FAILED y el reintento envía una sola vez', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const server = createFakeTelegramServer();
  let loseTemp = false;
  const { ops, transport } = modules(pool, { maxBeats: 10, server, gateway: (gw) => ({ ...gw, sendPart: async (x) => { if (loseTemp) { loseTemp = false; await fs.promises.unlink(x.file.path); } return gw.sendPart(x); } }) });
  const hdr = hdrOf(lib); const b = bytesOf('o', 800);
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [partOf('m0', b)], metadata: { name: 'Reselect' } } });
  let cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  await rejects(put(transport, hdr, cap.token, bytesOf('x', 800)), 'PART_BYTES_MISMATCH', (e) => e.status === 409 && e.detail.hash_matches === false);
  cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  await rejects(put(transport, hdr, cap.token, bytesOf('o', 801)), 'PART_BYTES_MISMATCH', (e) => e.detail.max_bytes === 800);
  cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  await rejects(put(transport, hdr, cap.token, bytesOf('o', 799)), 'PART_BYTES_MISMATCH', (e) => e.detail.received === 799);
  // cancel durante la subida: el stream del cliente se corta a mitad
  cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  const broken = new Readable({ read() {} }); broken.push(bytesOf('o', 100)); setTimeout(() => broken.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })), 20);
  await rejects(transport.uploadPart({ ...hdr, token: cap.token, stream: broken, contentLength: 800 }), 'UPLOAD_ABORTED', (e) => e.status === 400);
  assert.equal(server.messages().length, 0); assert.equal(server.counters().uploads, 0, 'nada llegó al proveedor');
  assert.deepEqual((await journalOf(pool, lib.userId, op.operationId)).map((j) => [j.attempt, j.status, j.outcome]), [[1, 'FAILED', 'BYTES_MISMATCH'], [2, 'FAILED', 'BYTES_MISMATCH'], [3, 'FAILED', 'BYTES_MISMATCH'], [4, 'FAILED', 'ABORTED']]);
  assert.equal((await partRow(pool, lib.userId, op.operationId, 'm0')).dispatch_state, 'PENDING', 'sin despacho: nunca hubo intento de envío');
  assert.equal(fs.readdirSync(TMP).filter((f) => f.endsWith('.part')).length, 0, 'ningún temporal queda en disco');
  // cancel limpio: CANCELED y reserva liberada (pending_count vuelve a 0)
  const c = await ops.cancelOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([c.status, c.reservation.state], ['CANCELED', 'RELEASED']);
  assert.equal((await pool.query('SELECT pending_count::int AS p FROM catalog_libraries WHERE user_id = $1', [lib.userId])).rows[0].p, 0);
  await rejects(transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' }), 'OPERATION_TRANSITION_INVALID');
  // temporal perdido entre la medición y el envío: la subida al proveedor falla sin efecto; el reintento envía una vez
  const op2 = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [partOf('m0', b)], metadata: { name: 'Temp lost' } } });
  loseTemp = true;
  cap = await transport.issueUploadCapability({ ...hdr, operationId: op2.operationId, partKey: 'm0' });
  await rejects(put(transport, hdr, cap.token, b), 'UPLOAD_FAILED', (e) => e.status === 503 && e.detail.same_identity === true);
  assert.deepEqual((await journalOf(pool, lib.userId, op2.operationId)).map((j) => j.outcome), ['UPLOAD_FAILED']);
  assert.equal((await jobsOf(pool, lib.userId)).filter((j) => j.kind === 'TRANSFER_RECONCILE').length, 0, 'fallo de subida (sin mensaje posible) no es incierto');
  cap = await transport.issueUploadCapability({ ...hdr, operationId: op2.operationId, partKey: 'm0' });
  assert.equal((await put(transport, hdr, cap.token, b)).status, 200);
  assert.equal(server.messages().length, 1);
}));

test('REPLACE con conflicto de versión: el commit no sobrescribe la versión ganadora; los objetos nuevos quedan verificados pero sin vincular', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); await seedBeats(pool, lib, 2); const server = createFakeTelegramServer();
  const { ops, cmd, transport, worker } = modules(pool, { maxBeats: 10, server });
  const hdr = hdrOf(lib); const b = bytesOf('r', 640);
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: 'b0000', expectedVersion: '1', parts: [partOf('m0', b)], metadata: { name: 'Replaced' } } });
  const staged = (await pool.query("SELECT file_id, status FROM catalog_file_versions WHERE user_id = $1 AND beat_id = 'b0000'", [lib.userId])).rows;
  assert.deepEqual(staged.map((f) => f.status), ['STAGED'], 'REPLACE prepara versiones STAGED visibles; la vigente no cambia');
  const cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  assert.equal((await put(transport, hdr, cap.token, b)).status, 200);
  await drain(worker, pool, lib.userId, { kinds: VERIFY_ONLY });
  assert.equal(await opStatus(pool, lib.userId, op.operationId), 'READY');
  // otro cliente gana: PATCH → versión 2
  const patched = await cmd.patchBeat({ ...hdr, idempotencyKey: key(), beatId: 'b0000', expectedVersion: '1', patch: { name: 'Winner' } });
  assert.equal(patched.beat.version, '2');
  await rejects(ops.commitOperation({ ...hdr, operationId: op.operationId }), 'VERSION_CONFLICT', (e) => e.detail.current_version === '2' && e.detail.expected_version === '1');
  assert.equal(await opStatus(pool, lib.userId, op.operationId), 'CONFLICT');
  const beat = (await pool.query("SELECT name, version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = 'b0000'", [lib.userId])).rows[0];
  assert.deepEqual(beat, { name: 'Winner', v: '2' }, 'la versión ganadora no se sobrescribe');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_current_files WHERE user_id = $1 AND beat_id = 'b0000'", [lib.userId])).rows[0].n, 0, 'nada vinculado');
  assert.deepEqual((await pool.query("SELECT status FROM catalog_file_versions WHERE user_id = $1 AND beat_id = 'b0000'", [lib.userId])).rows, [{ status: 'STAGED' }], 'el objeto nuevo se conserva para resolución/cleanup, no se borra ni se instala');
  assert.equal(server.messages().length, 1, 'ningún borrado por intuición');
  await rejects(ops.commitOperation({ ...hdr, operationId: op.operationId }), 'OPERATION_TRANSITION_INVALID');
}));

test('PROJECT por MASTER: intención durable y despacho antes de publicar, remitente MASTER fijado antes del primer envío, verificación del bot y commit; downgrade de Access → 413 sin bytes ni efecto; publicación incierta → reconcile por caption + remitente', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); await seedBeats(pool, lib, 1); const server = createFakeTelegramServer();
  const access = { maxBytes: 10_000 };
  const observed = [];
  let failAfterSend = null;
  const master = fakeMaster(server, {
    probe: async () => { const p = await partRow(pool, lib.userId, observed.op, observed.part); const j = await journalOf(pool, lib.userId, observed.op); observed.push({ state: p.dispatch_state, sender: p.sender_id, journal: j.map((x) => [x.direction, x.status, x.outcome]) }); },
    failAfterSend: () => (failAfterSend ? failAfterSend() : null),
  });
  const { ops, transport, worker } = modules(pool, { maxBeats: 10, server, master, access });
  const hdr = hdrOf(lib); const zip = Buffer.from('zip!zip!zip!');
  const proj = { partKey: 'p0', slotKey: 'PROJECT', role: 'PROJECT', partIndex: 0, size: zip.length, sha256: sha(zip), filename: 'song.flp', mime: 'application/zip' };
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: 'b0000', expectedVersion: '1', parts: [proj] } });
  observed.op = op.operationId; observed.part = 'p0';
  await rejects(transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'p0' }), 'INPUT_INVALID', (e) => e.detail.reason === 'PROJECT_USES_MASTER');
  const r = await transport.uploadProjectPart({ ...hdr, operationId: op.operationId, partKey: 'p0', stream: Readable.from([zip]), contentLength: zip.length, filename: 'song.flp' });
  assert.equal(r.status, 200); assert.equal(r.body.upload.state, 'RECEIPT');
  assert.deepEqual(master.calls, ['me', 'publish']);
  assert.deepEqual(observed[0], { state: 'DISPATCHED', sender: '777', journal: [['PROJECT_UPLOAD', 'REDEEMED', null]] }, 'intención durable + despacho + remitente MASTER persistidos ANTES de publicar');
  const p = await partRow(pool, lib.userId, op.operationId, 'p0');
  assert.deepEqual([p.dispatch_state, p.sender_id, JSON.parse(p.receipt_json).senderId], ['RECEIPT', '777', '777']);
  assert.deepEqual([server.messages()[0].sender, server.messages()[0].caption], ['777', `catalog:v1 op=${op.operationId} part=p0`]);
  await drain(worker, pool, lib.userId, { kinds: VERIFY_ONLY });
  assert.equal(await opStatus(pool, lib.userId, op.operationId), 'READY', 'el bot verifica un mensaje del MASTER (remitente esperado literal 777)');
  const c = await ops.commitOperation({ ...hdr, operationId: op.operationId });
  assert.equal(c.status, 200);
  assert.deepEqual((await pool.query("SELECT slot_key FROM catalog_current_files WHERE user_id = $1 AND beat_id = 'b0000'", [lib.userId])).rows, [{ slot_key: 'PROJECT' }]);
  assert.equal((await pool.query('SELECT sender_id FROM catalog_media_objects WHERE user_id = $1', [lib.userId])).rows[0].sender_id, '777');
  await rejects(ops.assignSender({ ...hdr, operationId: op.operationId, partKey: 'p0', senderId: '888' }), 'OPERATION_TRANSITION_INVALID');
  // downgrade de Access antes de recibir bytes: 413, sin journal, sin llamada al MASTER
  const op2 = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: 'b0000', expectedVersion: '2', parts: [proj] } });
  access.maxBytes = 5;
  await rejects(transport.uploadProjectPart({ ...hdr, operationId: op2.operationId, partKey: 'p0', stream: Readable.from([zip]), contentLength: zip.length }), 'PROJECT_TOO_LARGE', (e) => e.status === 413 && e.detail.max_bytes === 5);
  assert.deepEqual(await journalOf(pool, lib.userId, op2.operationId), []); assert.equal(master.calls.length, 2);
  access.maxBytes = 10_000;
  // publicación incierta (el MASTER envió pero la respuesta se perdió): 202, reconcile por caption + remitente 777 adopta el mensaje
  observed.op = op2.operationId;
  failAfterSend = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const r2 = await transport.uploadProjectPart({ ...hdr, operationId: op2.operationId, partKey: 'p0', stream: Readable.from([zip]), contentLength: zip.length });
  failAfterSend = null;
  assert.deepEqual([r2.status, r2.body.upload.state, r2.body.upload.resend], [202, 'UNCERTAIN', 'BLOCKED']);
  await rejects(transport.uploadProjectPart({ ...hdr, operationId: op2.operationId, partKey: 'p0', stream: Readable.from([zip]), contentLength: zip.length }), 'PART_UNCERTAIN');
  await drain(worker, pool, lib.userId, { kinds: VERIFY_ONLY });
  assert.equal(await opStatus(pool, lib.userId, op2.operationId), 'READY');
  assert.equal(server.messages().filter((m) => m.sender === '777').length, 2, 'ningún reenvío del PROJECT');
  assert.equal((await ops.commitOperation({ ...hdr, operationId: op2.operationId })).status, 200);
}));

test('capacidad vencida → 403 CAPABILITY_EXPIRED (marcada EXPIRED); capacidad de otro usuario → 403; cuerpo redimido y despacho limpios tras un rechazo temprano', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const other = await nativeLibrary(pool); const server = createFakeTelegramServer();
  const { ops, transport } = modules(pool, { maxBeats: 10, server, ttlMs: 1000 });
  const hdr = hdrOf(lib); const b = bytesOf('e', 100);
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [partOf('m0', b)], metadata: { name: 'Exp' } } });
  const cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  await rejects(put(transport, hdrOf(other), cap.token, b), 'CAPABILITY_INVALID', (e) => e.detail.reason === 'UNKNOWN');
  await pool.query("UPDATE catalog_transfer_capabilities SET expires_at = now() - interval '1 second' WHERE capability_hash = $1", [sha(cap.token)]);
  await rejects(put(transport, hdr, cap.token, b), 'CAPABILITY_EXPIRED');
  assert.deepEqual((await journalOf(pool, lib.userId, op.operationId)).map((j) => j.status), ['EXPIRED']);
  assert.equal((await partRow(pool, lib.userId, op.operationId, 'm0')).dispatch_state, 'PENDING');
  assert.equal(server.counters().uploads, 0);
  const cap2 = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  assert.equal(cap2.attempt, 2);
  assert.equal((await put(transport, hdr, cap2.token, b)).status, 200);
}));
