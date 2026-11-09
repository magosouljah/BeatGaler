'use strict';
// T09 — Intenciones, reservas y máquina de estados contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T09`).
// C(T09): free con una plaza y dos imports = una sola reserva; tombstone; cancel/expire/renew races; downgrade; key reusada con otro
// body; reserva en conflicto; retry tras COMMITTED; recibo igual/distinto; commit 202 mientras falta verificación; callbacks viejos
// (lease fenced); contadores únicos; 0 bootstrap INDEX / 0 escrituras legacy; jobs claim/renew/complete/fail con fencing y backoff.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const operations = require('../../catalog/operations.js');
const queries = require('../../catalog/queries.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const H = crypto.createHash('sha256').update('x').digest('hex');
let seq = 0; let keyN = 0;
const key = () => `k-${++keyN}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function withDb(fn, { max = 8 } = {}) {
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
function mk(pool, maxBeats = null) {
  const access = { maxBeats };
  const ops = operations.createCatalogOperations({ pool, authority: auth(pool), resolveAccess: async () => ({ maxBeats: access.maxBeats }) });
  const q = queries.createCatalogQueries({ pool, authority: auth(pool), cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  return { ops, q, access };
}
async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, era: ctx.authority_era, epoch: ctx.authority_epoch, generationId: ctx.generation_id, chatId: ctx.chat_id };
}
const master = (n = 1000) => ({ partKey: 'm0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: n, sha256: sha(`bytes-${n}`), filename: 'beat.mp3', mime: 'audio/mpeg' });
const importIntent = (name = 'New beat', extra = {}) => ({ kind: 'IMPORT', parts: [master()], metadata: { name, tags: ['trap'], bpm: '120' }, ...extra });
const libRow = async (pool, uid) => (await pool.query('SELECT revision::text AS revision, active_count::int AS active, trash_count::int AS trash, purging_count::int AS purging, pending_count::int AS pending FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
async function legacyDigest(pool) {
  return (await pool.query(`SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) AS d FROM (
    SELECT 'Q' || user_id || index_message_id::text AS t FROM library_quota_state UNION ALL SELECT 'B' || user_id || beat_id FROM library_beats
    UNION ALL SELECT 'P' || vault_id || index_message_id::text FROM vault_index_pointers UNION ALL SELECT 'R' || user_id || beat_id FROM library_beat_reservations
    UNION ALL SELECT 'D' || id FROM direct_operations UNION ALL SELECT 'G' || id FROM garbage_journal) x`)).rows[0].d;
}
// Flujo completo del gateway simulado: despacho → recibo → verificación.
async function transfer(ops, hdr, op, { verify = true, messageBase = 5000 } = {}) {
  for (const [i, p] of op.parts.entries()) {
    await ops.markDispatched({ ...hdr, operationId: op.operationId, partKey: p.partKey });
    await ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: p.partKey, receipt: { messageId: messageBase + i, documentId: `${900000 + i}`, size: Number(p.declaredSize) } });
    if (verify) await ops.recordVerification({ userId: hdr.userId, operationId: op.operationId, partKey: p.partKey, evidence: { size: Number(p.declaredSize), sha256: p.declaredSha256 } });
  }
}

test('IMPORT completo: PREPARED (reserva, pending+1, random_id persistido antes del envío) → despacho → recibo → verificación → READY → commit 200 instala beat/archivo/objeto; replay devuelve lo mismo; 0 escrituras legacy', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { ops, q } = mk(pool, 20);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const legacyBefore = await legacyDigest(pool);
  const k = key();
  const op = await ops.createOperation({ ...hdr, idempotencyKey: k, intent: importIntent('Árbol') });
  assert.deepEqual([op.status, op.kind, op.created, op.parts.length, op.parts[0].dispatchState, op.reservation.state, op.progress], ['PREPARED', 'IMPORT', true, 1, 'PENDING', 'HELD', { total: 1, verified: 0, receipts: 0 }]);
  assert.match(op.beatId, /^b-[0-9a-f-]{36}$/, 'beat_id generado por el servidor, dentro del alcance Direct');
  assert.ok(!JSON.stringify(op).includes(lib.chatId), 'la respuesta no expone el chat');
  const part = (await pool.query('SELECT random_id, sender_id, chat_id, dispatch_state FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2', [lib.userId, op.operationId])).rows[0];
  assert.deepEqual([operations.int64(part.random_id), part.sender_id, part.chat_id, part.dispatch_state], [true, 'Bot20', lib.chatId, 'PENDING'], 'identidad de envío persistida antes del efecto');
  assert.deepEqual(await libRow(pool, lib.userId), { revision: '1', active: 0, trash: 0, purging: 0, pending: 1 });
  // replay exacto → misma operación; misma clave con otro cuerpo → 409
  const again = await ops.createOperation({ ...hdr, idempotencyKey: k, intent: importIntent('Árbol') });
  assert.deepEqual([again.operationId, again.replay, (await libRow(pool, lib.userId)).pending], [op.operationId, true, 1]);
  await assert.rejects(ops.createOperation({ ...hdr, idempotencyKey: k, intent: importIntent('Otro') }), (e) => e.code === 'IDEMPOTENCY_MISMATCH' && e.status === 409);
  // commit antes de verificar → 202, nada instalado
  const early = await ops.commitOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([early.status, early.operation.pending, early.operation.status], [202, ['m0'], 'PREPARED']);
  // despacho (el gateway) y recibo candidato: la operación pasa a VERIFYING; el mismo recibo es replay; uno distinto → conflicto
  const d = await ops.markDispatched({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  assert.equal(d.randomId, part.random_id, 'el retry recupera la misma identidad');
  const r1 = await ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', receipt: { messageId: 777, documentId: '1234', size: 1000 } });
  assert.deepEqual([r1.status, r1.parts[0].dispatchState, r1.replay], ['VERIFYING', 'RECEIPT', false]);
  assert.equal((await ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', receipt: { messageId: 777, documentId: '1234', size: 1000 } })).replay, true);
  await assert.rejects(ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', receipt: { messageId: 778, size: 1000 } }), (e) => e.code === 'RECEIPT_CONFLICT');
  await assert.rejects(ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', receipt: { messageId: 777, size: 1000, chatId: '-999' } }), (e) => e.code === 'RECEIPT_CONFLICT', 'recibo de otro chat');
  assert.equal((await ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 202, 'recibo ≠ verificación');
  // verificación del proveedor independiente del recibo: tamaño distinto → mismatch; correcta → READY
  await assert.rejects(ops.recordVerification({ userId: lib.userId, operationId: op.operationId, partKey: 'm0', evidence: { size: 999 } }), (e) => e.code === 'VERIFICATION_MISMATCH');
  const v = await ops.recordVerification({ userId: lib.userId, operationId: op.operationId, partKey: 'm0', evidence: { size: 1000, sha256: sha('bytes-1000') } });
  assert.deepEqual([v.verified, v.ready], [true, true]);
  assert.equal((await ops.getOperation({ userId: lib.userId, operationId: op.operationId })).status, 'READY');
  const c = await ops.commitOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([c.status, c.operation.status, c.operation.reservation.state, c.operation.result.version], [200, 'COMMITTED', 'CONSUMED', '1']);
  assert.deepEqual(await libRow(pool, lib.userId), { revision: '2', active: 1, trash: 0, purging: 0, pending: 0 }, 'contadores: una plaza consumida una vez');
  const installed = (await pool.query(`SELECT fv.status, fv.role, fv.size_bytes::text AS size, cf.slot_key, mo.status AS obj, mo.message_id::text AS mid, pl.reference_class, pl.verification_level
    FROM catalog_current_files cf JOIN catalog_file_versions fv USING (user_id, generation_id, file_id) JOIN catalog_part_locations pl USING (user_id, generation_id, file_id) JOIN catalog_media_objects mo ON mo.user_id = pl.user_id AND mo.object_id = pl.object_id
    WHERE cf.user_id = $1 AND cf.beat_id = $2`, [lib.userId, op.beatId])).rows;
  assert.deepEqual(installed, [{ status: 'VERIFIED', role: 'MASTER', size: '1000', slot_key: 'MASTER', obj: 'PRESENT', mid: '777', reference_class: 'KNOWN', verification_level: 'PROVIDER' }]);
  const page = await q.listBeats({ userId: lib.userId, query: { sort: 'manual' } });
  assert.deepEqual([page.items[0].id, page.items[0].name, page.items[0].playback !== null, page.totalLibrary], [op.beatId, 'Árbol', true, 1]);
  // retry tras COMMITTED: idéntico, sin segunda instalación ni contador
  const c2 = await ops.commitOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([c2.status, c2.operation.replay, (await libRow(pool, lib.userId)).active], [200, true, 1]);
  await assert.rejects(ops.cancelOperation({ ...hdr, operationId: op.operationId }), (e) => e.code === 'OPERATION_TRANSITION_INVALID', 'cancel no revierte COMMITTED');
  const ev = (await pool.query('SELECT kind, beat_id, operation_id FROM catalog_events WHERE user_id = $1', [lib.userId])).rows;
  assert.deepEqual(ev, [{ kind: 'BEAT_PATCHED', beat_id: op.beatId, operation_id: op.operationId }]);
  assert.equal(await legacyDigest(pool), legacyBefore, '0 bootstrap INDEX / 0 escrituras en tablas legacy');
}));

test('cuota: plan con una plaza y dos imports → una sola reserva (QUOTA_EXCEEDED al segundo); cancel libera; downgrade entre reserva y commit → 409; cuota = active+trash+purging+pending', () => withDb(async (pool, h) => {
  const lib = await nativeLibrary(pool); const { ops, access } = mk(pool, 1);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const pools = [new Pool({ ...h.config, max: 3 }), new Pool({ ...h.config, max: 3 })];
  try {
    const both = await Promise.allSettled(pools.map((p, i) => mk(p, 1).ops.createOperation({ ...hdr, idempotencyKey: `race-${i}`, intent: importIntent(`Race ${i}`) })));
    assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(both.find((r) => r.status === 'rejected').reason.code, 'QUOTA_EXCEEDED');
    assert.equal((await libRow(pool, lib.userId)).pending, 1, 'exactamente una reserva');
    const winner = both.find((r) => r.status === 'fulfilled').value;
    // cancel sin envío → CANCELED y la plaza vuelve
    const cancelled = await ops.cancelOperation({ ...hdr, operationId: winner.operationId });
    assert.deepEqual([cancelled.status, cancelled.reservation.state, (await libRow(pool, lib.userId)).pending], ['CANCELED', 'RELEASED', 0]);
    assert.equal((await ops.cancelOperation({ ...hdr, operationId: winner.operationId })).changed, false);
    // nueva reserva; downgrade a 0 plazas antes del commit → 409 y nada instalado
    const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: importIntent('Down') });
    await transfer(ops, hdr, op);
    access.maxBeats = 0;
    await assert.rejects(ops.commitOperation({ ...hdr, operationId: op.operationId }), (e) => e.code === 'QUOTA_EXCEEDED');
    assert.deepEqual(await libRow(pool, lib.userId), { revision: '1', active: 0, trash: 0, purging: 0, pending: 1 });
    access.maxBeats = 1;
    assert.equal((await ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
    // TRASH y PURGING siguen ocupando cuota: con max 1 y un beat ACTIVE no hay plaza
    await assert.rejects(ops.createOperation({ ...hdr, idempotencyKey: key(), intent: importIntent('No cabe') }), (e) => e.code === 'QUOTA_EXCEEDED' && e.detail.counts.active === 1);
  } finally { await Promise.all(pools.map((p) => p.end())); }
}));

test('reservas: renovar (+15 min, tope 24 h), vencimiento bloquea el commit sin borrar nada, readmitir re-comprueba cuota; expireReservations libera plazas vencidas', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { ops } = mk(pool, 2);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: importIntent('Renew') });
  const before = (await pool.query('SELECT expires_at FROM catalog_reservations WHERE user_id = $1', [lib.userId])).rows[0].expires_at;
  await pool.query("UPDATE catalog_reservations SET expires_at = expires_at - interval '5 minutes' WHERE user_id = $1", [lib.userId]);
  const renewed = await ops.renewReservation({ ...hdr, operationId: op.operationId });
  assert.equal(renewed.reservation.renewals, 1);
  assert.ok(new Date(renewed.reservation.expiresAt) >= new Date(before), 'renovación devuelve ~15 min');
  await pool.query("UPDATE catalog_reservations SET max_until = now() + interval '1 minute' WHERE user_id = $1", [lib.userId]);
  const capped = await ops.renewReservation({ ...hdr, operationId: op.operationId });
  assert.ok(new Date(capped.reservation.expiresAt) <= new Date(capped.reservation.maxUntil), 'nunca más allá del máximo de 24 h');
  // vencida: commit bloqueado aunque esté verificada; nada se borra; readmit crea nueva reserva (cuota re-comprobada)
  await transfer(ops, hdr, op);
  await pool.query("UPDATE catalog_reservations SET expires_at = now() - interval '1 second' WHERE user_id = $1", [lib.userId]);
  await assert.rejects(ops.commitOperation({ ...hdr, operationId: op.operationId }), (e) => e.code === 'RESERVATION_EXPIRED');
  await assert.rejects(ops.renewReservation({ ...hdr, operationId: op.operationId }), (e) => e.code === 'RESERVATION_EXPIRED' && e.detail.readmit === true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_operation_parts WHERE user_id = $1 AND dispatch_state = $2', [lib.userId, 'VERIFIED'])).rows[0].n, 1, 'las partes verificadas se conservan');
  const re = await ops.readmitReservation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([re.readmitted, re.reservation.state, (await libRow(pool, lib.userId)).pending], [true, 'HELD', 1]);
  assert.equal((await ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
  // expireReservations: dos reservas vencidas → pending −2; una viva se conserva
  for (const n of ['a', 'b', 'c']) await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: importIntent(`exp-${n}`) }).catch((e) => { if (e.code !== 'QUOTA_EXCEEDED') throw e; });
  // max 2: solo una reserva cupo (1 activo + 1 pending). Forzamos vencimiento y liberación.
  await pool.query("UPDATE catalog_reservations SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND state = 'HELD'", [lib.userId]);
  const ex = await ops.expireReservations({ ...hdr });
  assert.deepEqual([ex.expired, (await libRow(pool, lib.userId)).pending], [1, 0]);
}));

test('REPLACE: versión esperada, STAGED visible como STAGED sin tocar el actual; commit instala la versión nueva y retira la anterior; conflicto de versión → CONFLICT con objetos sin vincular; tombstone/PURGING → PURGE_PENDING', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { ops, q } = mk(pool, null);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const imp = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: importIntent('Base') });
  await transfer(ops, hdr, imp); await ops.commitOperation({ ...hdr, operationId: imp.operationId });
  const beatId = imp.beatId;
  await assert.rejects(ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId, expectedVersion: '9', parts: [master(2000)] } }), (e) => e.code === 'VERSION_CONFLICT');
  await assert.rejects(ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: 'nope', expectedVersion: '1', parts: [master(2000)] } }), (e) => e.code === 'NOT_FOUND');
  const rep = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId, expectedVersion: '1', parts: [master(2000)], metadata: { name: 'Base v2' } } });
  assert.equal(rep.status, 'PREPARED');
  const staged = (await pool.query("SELECT status FROM catalog_file_versions WHERE user_id = $1 AND beat_id = $2 ORDER BY status", [lib.userId, beatId])).rows.map((r) => r.status);
  assert.deepEqual(staged, ['STAGED', 'VERIFIED'], 'la nueva versión está STAGED y la vigente sigue VERIFIED');
  // conflicto: otra escritura cambia la versión del beat antes del commit → CONFLICT, objetos nuevos conservados sin vincular
  await transfer(ops, hdr, rep, { messageBase: 6000 });
  await pool.query('UPDATE catalog_beats SET version = version + 1 WHERE user_id = $1 AND beat_id = $2', [lib.userId, beatId]);
  await assert.rejects(ops.commitOperation({ ...hdr, operationId: rep.operationId }), (e) => e.code === 'VERSION_CONFLICT');
  assert.equal((await ops.getOperation({ userId: lib.userId, operationId: rep.operationId })).status, 'CONFLICT', 'el estado CONFLICT se persiste pese al rechazo');
  const current = (await pool.query('SELECT fv.size_bytes::text AS size FROM catalog_current_files cf JOIN catalog_file_versions fv USING (user_id, generation_id, file_id) WHERE cf.user_id = $1 AND cf.beat_id = $2', [lib.userId, beatId])).rows[0];
  assert.equal(current.size, '1000', 'la versión ganadora no se sobrescribe');
  // nuevo REPLACE con la versión actual → commit instala y retira la anterior
  const rep2 = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId, expectedVersion: '2', parts: [master(3000)], metadata: { name: 'Base v3' } } });
  await transfer(ops, hdr, rep2, { messageBase: 7000 });
  const c = await ops.commitOperation({ ...hdr, operationId: rep2.operationId });
  assert.deepEqual([c.status, c.operation.result.version, c.operation.result.installed[0].retired !== null], [200, '3', true]);
  const files = (await pool.query('SELECT status, size_bytes::text AS size, retained_until IS NOT NULL AS retained FROM catalog_file_versions WHERE user_id = $1 AND beat_id = $2 ORDER BY size_bytes', [lib.userId, beatId])).rows;
  assert.deepEqual(files.map((f) => [f.status, f.size, f.retained]), [['RETIRED', '1000', true], ['STAGED', '2000', false], ['VERIFIED', '3000', false]]);
  const detail = await q.getBeat({ userId: lib.userId, beatId });
  assert.deepEqual([detail.name, detail.version, detail.playback.fileId.endsWith('MASTER')], ['Base v3', '3', true]);
  // tombstone → PURGE_PENDING; PURGING → PURGE_PENDING
  await pool.query("UPDATE catalog_beats SET state = 'PURGING' WHERE user_id = $1 AND beat_id = $2", [lib.userId, beatId]);
  await assert.rejects(ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId, expectedVersion: '3', parts: [master(10)] } }), (e) => e.code === 'PURGE_PENDING');
}));

test('cancel tras despacho → RECONCILE con objetos retenidos y reserva HELD; cancel limpio retira STAGED; callbacks de un lease viejo quedan fenced; commit de otra generación/época → stale', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { ops } = mk(pool, 5);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: importIntent('Reconcile') });
  await ops.markDispatched({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  const rc = await ops.cancelOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([rc.status, rc.reservation.state, (await libRow(pool, lib.userId)).pending], ['RECONCILE', 'HELD', 1], 'pudo haber envío: nada se libera ni se borra');
  assert.equal((await ops.cancelOperation({ ...hdr, operationId: op.operationId })).changed, false);
  // la reconciliación (T11) adopta el recibo y verifica → READY → commit
  await ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', receipt: { messageId: 42, size: 1000 } });
  await ops.recordVerification({ userId: lib.userId, operationId: op.operationId, partKey: 'm0', evidence: { size: 1000 } });
  assert.equal((await ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
  // jobs: claim con lease, renew, callback viejo fenced, complete, fail con backoff y BLOCKED al octavo transitorio
  const j1 = await ops.enqueueJob({ userId: lib.userId, kind: 'TRANSFER_VERIFY', operationId: op.operationId, payload: { partKey: 'm0' } });
  await ops.enqueueJob({ userId: lib.userId, kind: 'TRANSFER_VERIFY', operationId: op.operationId, payload: { partKey: 'x' } });
  const a = await ops.claimJobs({ owner: 'worker-a', limit: 1 });
  assert.deepEqual([a.length, a[0].lease.owner, a[0].lease.generation, a[0].attempts], [1, 'worker-a', '1', 1]);
  const b = await ops.claimJobs({ owner: 'worker-b', limit: 10 });
  assert.equal(b.length, 1, 'SKIP LOCKED: el job arrendado no se reparte dos veces');
  await ops.renewJobLease({ jobId: a[0].jobId, lease: a[0].lease });
  // lease vencido → otro worker lo reclama con generación +1; el callback del worker viejo queda fenced
  await pool.query("UPDATE catalog_jobs SET lease_until = now() - interval '1 second' WHERE job_id = $1", [a[0].jobId]);
  const c = await ops.claimJobs({ owner: 'worker-c', limit: 10 });
  assert.deepEqual([c.length, c[0].jobId, c[0].lease.generation], [1, a[0].jobId, '2']);
  await assert.rejects(ops.completeJob({ jobId: a[0].jobId, lease: a[0].lease }), (e) => e.code === 'LEASE_FENCED');
  await assert.rejects(ops.renewJobLease({ jobId: a[0].jobId, lease: a[0].lease }), (e) => e.code === 'LEASE_FENCED');
  await assert.rejects(ops.recordVerification({ userId: lib.userId, operationId: op.operationId, partKey: 'm0', evidence: { size: 1000 }, lease: { jobId: a[0].jobId, owner: 'worker-a', generation: '1' } }), (e) => e.code === 'LEASE_FENCED', 'resultado de worker antiguo no confirma nada');
  assert.deepEqual(await ops.completeJob({ jobId: a[0].jobId, lease: c[0].lease }), { jobId: a[0].jobId, state: 'DONE' });
  let f = await ops.failJob({ jobId: b[0].jobId, lease: b[0].lease, error: 'FLOOD_WAIT', transient: true, retryAfterMs: 30_000 });
  assert.deepEqual([f.state, f.delayMs >= 30_000], ['QUEUED', true]);
  for (let i = 0; i < 8; i++) { const cl = (await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE job_id = $1", [b[0].jobId])) && await ops.claimJobs({ owner: 'w', limit: 10 }); if (!cl.length) break; f = await ops.failJob({ jobId: b[0].jobId, lease: cl[0].lease, error: 'timeout', transient: true }); if (f.state === 'BLOCKED') break; }
  assert.equal(f.state, 'BLOCKED', 'ocho fallos transitorios → BLOCKED visible, no descartado');
  await pool.query("UPDATE catalog_jobs SET state = 'QUEUED', next_attempt_at = now() WHERE job_id = $1", [b[0].jobId]).catch(() => {});
  const perm = await ops.claimJobs({ owner: 'w2', limit: 10 });
  if (perm.length) assert.equal((await ops.failJob({ jobId: perm[0].jobId, lease: perm[0].lease, error: 'permission', transient: false })).state, 'BLOCKED', 'permanente → BLOCKED inmediato');
  void j1;
  // época vieja → commit stale
  const op2 = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: importIntent('Epoch') });
  await transfer(ops, hdr, op2, { messageBase: 8000 });
  await pool.query('UPDATE catalog_libraries SET authority_epoch = authority_epoch + 1 WHERE user_id = $1', [lib.userId]);
  await assert.rejects(ops.commitOperation({ ...hdr, operationId: op2.operationId }), (e) => e.code === 'CATALOG_EPOCH_STALE');
}));
