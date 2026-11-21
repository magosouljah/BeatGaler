'use strict';
// T15 / E81 — Eliminación definitiva contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T15`), con el servidor Telegram FAKE detrás
// del adaptador real del gateway (T11), transporte T12, worker T10 y journal externo (memoria con fallos programables). E81: la fase de
// catálogo (PURGED, tombstone, cuota, Gallery) no espera a Telegram; la limpieza física es durable e independiente: éxito, rechazo, sin
// respuesta (incierto: solo se reconcilia consultando), archivo compartido, beat parcialmente eliminado de antes de E81, reinicio durante la
// limpieza, peticiones y workers concurrentes, restauración desde la papelera antes de eliminar, restore_hold/cleanup diferidos. FAKE: cleanup
// real sigue apagado; sin proveedor real.
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
const { createCatalogWorker } = require('../../catalog/worker.js');
const g = require('../../catalog/transport-gateway.js');
const telegramOp = require('../../operator/telegram-file-io.js');
const { createDirectSeeder } = require('../helpers/catalog-direct-seeder.cjs'); // E77: los archivos se siembran como el navegador (Direct B)
const mediaMod = require('../../catalog/media.js');
const purgeMod = require('../../catalog/purge.js');
const journalMod = require('../../catalog-deletion-journal.js');
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t15-'));
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
function modules(pool, { server = createFakeTelegramServer(), journal = journalMod.createMemoryDeletionJournal(), gatewayWrap = (x) => x } = {}) {
  const a = auth(pool);
  const client = server.session({ selfId: '20' });
  const gateway = gatewayWrap({ ...telegramOp.createOperatorTelegram({ client, sdk, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) }), client });
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: null }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const transport = createDirectSeeder({ pool, authority: a, operations: ops, browser: gateway });
  const purge = purgeMod.createCatalogPurge({ pool, authority: a, gateway, journal });
  const media = mediaMod.createCatalogMedia({ pool, authority: a });
  const worker = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: gateway, purge, owner: 'w', options: { globalConcurrency: 2, renewEveryMs: 100_000, stepsPerClaim: 4 } });
  return { a, pool, ops, q, cmd, gateway, transport, worker, purge, media, server, journal, client };
}
async function nativeLibrary(pool, { cleanup = true, hold = false } = {}) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  // flags de propietario (T24): en el laboratorio se fijan directamente y se etiquetan como tales
  await pool.query('UPDATE catalog_libraries SET cleanup_enabled = $2, restore_hold = $3 WHERE user_id = $1', [id, cleanup, hold]);
  return { userId: id, era: ctx.authority_era, epoch: ctx.authority_epoch, generationId: ctx.generation_id, chatId: `-100${seq}` };
}
const hdrOf = (lib) => ({ userId: lib.userId, era: lib.era, epoch: lib.epoch });
const part = (k, bytes, idx = 0, slot = 'MASTER', role = 'MASTER') => ({ partKey: k, slotKey: slot, role, partIndex: idx, size: bytes.length, sha256: sha(bytes), filename: `${k}.bin`, mime: 'application/octet-stream' });
// Importa un beat con N partes MASTER a través del transporte real (gateway fake) y lo confirma; devuelve beatId y fileId.
async function importBeat(m, lib, name, sizes) {
  const hdr = hdrOf(lib); const bytes = sizes.map((n, i) => Buffer.alloc(n, 65 + i));
  const op = await m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: bytes.map((b, i) => part(`m${i}`, b, i)), metadata: { name } } });
  for (const [i, b] of bytes.entries()) { const cap = await m.transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: `m${i}` }); assert.equal((await m.transport.uploadPart({ ...hdr, token: cap.token, stream: Readable.from([b]), contentLength: b.length })).status, 200); }
  await drain(m.worker, m.pool, lib, { kinds: ['TRANSFER_VERIFY'] });
  assert.equal((await m.ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
  const fileId = (await m.pool.query("SELECT file_id FROM catalog_current_files WHERE user_id = $1 AND beat_id = $2 AND slot_key = 'MASTER'", [lib.userId, op.beatId])).rows[0].file_id;
  return { beatId: op.beatId, fileId, operationId: op.operationId };
}
async function drain(worker, pool, lib, { kinds = null, rounds = 60 } = {}) {
  for (let i = 0; i < rounds; i++) {
    await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1 AND state = 'QUEUED'", [lib.userId]);
    await worker.runOnce({ kinds });
    const pending = (await pool.query(`SELECT count(*)::int AS n FROM catalog_jobs WHERE user_id = $1 AND state IN ('QUEUED', 'LEASED')${kinds ? ' AND kind = ANY($2::text[])' : ''}`, kinds ? [lib.userId, kinds] : [lib.userId])).rows[0].n;
    if (pending === 0) return i + 1;
  }
  return rounds;
}
const counts = async (pool, uid) => (await pool.query('SELECT active_count::int AS active, trash_count::int AS trash, purging_count::int AS purging, pending_count::int AS pending FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
const beatState = async (pool, uid, beatId) => (await pool.query('SELECT state FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [uid, beatId])).rows[0]?.state ?? null;
const objects = async (pool, uid) => (await pool.query('SELECT object_id, status FROM catalog_media_objects WHERE user_id = $1 ORDER BY object_id', [uid])).rows;
const purgeObjects = async (pool, uid, purgeId) => (await pool.query('SELECT object_id, status, block_reason, attempts, journal_ref IS NOT NULL AS journaled FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 ORDER BY object_id', [uid, purgeId])).rows;
const trashAll = async (m, lib, beatIds) => { const rows = (await m.pool.query('SELECT beat_id, version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = ANY($2::text[])', [lib.userId, beatIds])).rows; await m.cmd.trashBeats({ ...hdrOf(lib), idempotencyKey: key(), items: rows.map((r) => ({ beatId: r.beat_id, expectedVersion: r.v })) }); };
const rejects = (p, code, extra = () => true) => assert.rejects(p, (e) => { assert.equal(e.code, code, `código esperado ${code}, recibido ${e.code}: ${e.message}`); return extra(e); });

const gwOf = (client) => telegramOp.createOperatorTelegram({ client, sdk, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) });
const versionOf = async (pool, uid, beatId) => (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [uid, beatId])).rows[0].v;
const objOf = async (pool, uid, fileId) => (await pool.query('SELECT object_id FROM catalog_part_locations WHERE user_id = $1 AND file_id = $2 ORDER BY part_index LIMIT 1', [uid, fileId])).rows[0].object_id;
const purgeItems = (m, lib, beatIds, k) => m.purge.requestPurge({ ...hdrOf(lib), idempotencyKey: k || key(), beatIds });
// pasos manuales de un purge hasta que no quede trabajo accionable (deterministas frente a la cola de faults del fake)
async function run(purge, lib, purgeId, max = 40) { const out = []; for (let i = 0; i < max; i++) { const s = await purge.step({ userId: lib.userId, purgeId }); out.push(s); if (!s.more) break; } return out; }
const outcomes = (steps) => steps.filter((s) => s.outcome).map((s) => s.outcome);
const galleryIds = async (m, lib, state = null) => (await m.q.listBeats({ userId: lib.userId, query: { limit: '240', ...(state ? { state } : {}) } })).items.map((i) => i.id);
async function waitFor(fn, ms = 5000) { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 10)); } }

test('E81 eliminación definitiva: el beat sale del catálogo y de la Gallery sin esperar a Telegram (PURGED, tombstone, cuota liberada una vez, evento) con manifiesto de limpieza durable; luego journal → delete → MessageEmpty → DELETED; límite por revisión; idempotencia y peticiones concurrentes', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const m = modules(pool); const hdr = hdrOf(lib);
  const A = await importBeat(m, lib, 'A', [3000, 1500]); const B = await importBeat(m, lib, 'B', [800]); const C = await importBeat(m, lib, 'C', [500]);
  // REPLACE de A que termina en CONFLICT: su objeto nuevo queda PRESENT sin vincular (recibo de operación no confirmada)
  const vA = await versionOf(pool, lib.userId, A.beatId);
  const rep = await m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: A.beatId, expectedVersion: vA, parts: [part('m0', Buffer.alloc(900, 9))] } });
  const cap = await m.transport.issueUploadCapability({ ...hdr, operationId: rep.operationId, partKey: 'm0' }); await m.transport.uploadPart({ ...hdr, token: cap.token, stream: Readable.from([Buffer.alloc(900, 9)]), contentLength: 900 });
  await drain(m.worker, m.pool, lib, { kinds: ['TRANSFER_VERIFY'] });
  await m.cmd.patchBeat({ ...hdr, idempotencyKey: key(), beatId: A.beatId, expectedVersion: vA, patch: { name: 'A2' } });
  await rejects(m.ops.commitOperation({ ...hdr, operationId: rep.operationId }), 'VERSION_CONFLICT');
  assert.equal(m.server.messages().length, 5);
  await trashAll(m, lib, [A.beatId, B.beatId]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 1, trash: 2, purging: 0, pending: 0 });
  // concurrentes: la misma clave → una sola intención; otra clave mientras la fase de catálogo está viva → PURGE_IN_PROGRESS
  const [p, same] = await Promise.all([m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-1' }), m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-1' })]);
  assert.equal(p.purgeId, same.purgeId); assert.equal([p.created, same.created].filter(Boolean).length, 1);
  await rejects(m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-2' }), 'PURGE_IN_PROGRESS');
  // C se trashea DESPUÉS de la intención: queda fuera del alcance de esta purga
  await trashAll(m, lib, [C.beatId]);
  // fase de catálogo: A y B salen de la biblioteca YA (sin ninguna llamada a Telegram)
  const e1 = await m.purge.step({ userId: lib.userId, purgeId: p.purgeId });
  assert.deepEqual([e1.status, e1.enumerated], ['PURGED', 2]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 0, trash: 1, purging: 0, pending: 0 }, 'cuota liberada al salir del catálogo; C sigue en la papelera');
  assert.deepEqual([await beatState(pool, lib.userId, A.beatId), await beatState(pool, lib.userId, B.beatId), await beatState(pool, lib.userId, C.beatId)], ['PURGED', 'PURGED', 'TRASH']);
  assert.deepEqual([await galleryIds(m, lib), await galleryIds(m, lib, 'TRASH')], [[], [C.beatId]], 'Gallery y papelera ya no muestran A ni B');
  assert.deepEqual([m.server.messages().length, m.server.counters().deletes], [5, 0], 'Telegram intacto hasta la limpieza');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_tombstones WHERE user_id = $1 AND source = 'CATALOG' AND deleted_at IS NOT NULL", [lib.userId])).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_events WHERE user_id = $1 AND kind = 'OPERATION_STATUS' AND operation_id = $2 AND payload_json LIKE '%PURGED%'", [lib.userId, p.purgeId])).rows[0].n, 2, 'un evento durable por beat PURGED');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_file_versions WHERE user_id = $1 AND beat_id = ANY($2::text[]) AND status <> 'DELETED'", [lib.userId, [A.beatId, B.beatId]])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT beat_state FROM catalog_trash_entries WHERE user_id = $1 AND beat_id = $2', [lib.userId, A.beatId])).rows[0].beat_state, 'PURGED');
  await rejects(m.media.issueAccess({ userId: lib.userId, fileId: A.fileId }), 'ACCESS_DENIED');
  const po = await purgeObjects(pool, lib.userId, p.purgeId);
  assert.equal(po.length, 4, 'manifiesto: A (2 partes) + objeto sin vincular del REPLACE en conflicto + B');
  assert.ok(po.every((o) => o.status === 'PENDING'));
  assert.deepEqual((await m.purge.getPurge({ userId: lib.userId, purgeId: p.purgeId })).cleanup, { deleted: 0, kept: 0, rejected: 0, uncertain: 0, pending: 4 });
  // la limpieza física pendiente no impide otra eliminación definitiva
  const p2 = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-3' });
  await drain(m.worker, m.pool, lib);
  const f1 = await m.purge.getPurge({ userId: lib.userId, purgeId: p.purgeId }); const f2 = await m.purge.getPurge({ userId: lib.userId, purgeId: p2.purgeId });
  assert.deepEqual([f1.status, f1.progress.purged, f1.cleanup.deleted, f2.status, f2.progress.total, f2.cleanup.deleted], ['PURGED', 2, 4, 'PURGED', 1, 1]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 0, trash: 0, purging: 0, pending: 0 });
  assert.deepEqual([m.server.messages().length, m.server.counters().deletes, (await m.journal.list(lib.userId)).length], [0, 5, 5], 'un delete y una entrada de journal (previa) por objeto');
  assert.equal((await objects(pool, lib.userId)).filter((o) => o.status === 'DELETED').length, 5);
  const replay = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-1' }); assert.deepEqual([replay.replay, replay.purgeId, replay.status], [true, p.purgeId, 'PURGED']);
  const p3 = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-4' }); await drain(m.worker, m.pool, lib);
  assert.deepEqual([(await m.purge.getPurge({ userId: lib.userId, purgeId: p3.purgeId })).progress.total, m.purge.metrics.purged], [0, 3]);
}));

test('E81 archivo compartido y bloqueos: compartido/retenido → el beat sale del catálogo y el objeto se CONSERVA (el otro beat intacto; se borra cuando ya nadie lo usa); OPAQUE / operación en vuelo → el beat sigue en la papelera; cleanup apagado / restore_hold → limpieza diferida durable que se reanuda por evento explícito', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const m = modules(pool); const hdr = hdrOf(lib);
  const S1 = await importBeat(m, lib, 'S1', [1000]); const S2 = await importBeat(m, lib, 'S2', [1000]);
  const OP = await importBeat(m, lib, 'OP', [700]); const RT = await importBeat(m, lib, 'RT', [600]); const PO = await importBeat(m, lib, 'PO', [650]); const OK = await importBeat(m, lib, 'OK', [400]);
  const gen = lib.generationId;
  const objS1 = await objOf(pool, lib.userId, S1.fileId);
  await pool.query('UPDATE catalog_part_locations SET object_id = $3, locator = $4 WHERE user_id = $1 AND file_id = $2', [lib.userId, S2.fileId, objS1, `direct:${objS1.split(':')[2]}`]);
  await pool.query("UPDATE catalog_part_locations SET reference_class = 'OPAQUE', object_id = NULL WHERE user_id = $1 AND file_id = $2", [lib.userId, OP.fileId]);
  const objRT = await objOf(pool, lib.userId, RT.fileId);
  await pool.query(`INSERT INTO catalog_file_versions(user_id, generation_id, file_id, beat_id, role, legacy_path, status, retained_until) VALUES ($1, $2, 'f-ok-old', $3, 'MASTER', '$.master', 'RETIRED', now() + interval '30 days')`, [lib.userId, gen, OK.beatId]);
  await pool.query("INSERT INTO catalog_file_parts(user_id, generation_id, file_id, part_index, size_bytes) VALUES ($1, $2, 'f-ok-old', 0, 600)", [lib.userId, gen]);
  await pool.query("INSERT INTO catalog_part_locations(user_id, generation_id, file_id, part_index, location, reference_class, object_id, provider, locator) VALUES ($1, $2, 'f-ok-old', 0, 'PRIMARY', 'KNOWN', $3, 'telegram', 'direct:x')", [lib.userId, gen, objRT]);
  const vPO = await versionOf(pool, lib.userId, PO.beatId);
  const rep = await m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: PO.beatId, expectedVersion: vPO, parts: [part('m0', Buffer.alloc(300, 1))] } });
  await m.ops.markDispatched({ ...hdr, operationId: rep.operationId, partKey: 'm0' }); await m.ops.cancelOperation({ ...hdr, operationId: rep.operationId }); // RECONCILE (en vuelo)
  await trashAll(m, lib, [S1.beatId, OP.beatId, RT.beatId, PO.beatId]);
  const beforeMsgs = m.server.messages().length;
  const p = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'blk-1' });
  await drain(m.worker, m.pool, lib, { kinds: ['PURGE'] });
  const f = await m.purge.getPurge({ userId: lib.userId, purgeId: p.purgeId });
  const byBeat = Object.fromEntries(f.items.map((i) => [i.beatId, [i.status, i.blockReason]]));
  assert.deepEqual([byBeat[S1.beatId], byBeat[RT.beatId], byBeat[OP.beatId], byBeat[PO.beatId]], [['PURGED', null], ['PURGED', null], ['BLOCKED', 'OPAQUE_REFERENCE'], ['BLOCKED', 'PENDING_OPERATION']]);
  assert.deepEqual([f.status, f.progress.purged, f.progress.blocked, f.cleanup.kept, f.cleanup.pending], ['PARTIAL', 2, 2, 2, 0]);
  const po = Object.fromEntries((await purgeObjects(pool, lib.userId, p.purgeId)).map((o) => [o.object_id, [o.status, o.block_reason]]));
  assert.deepEqual([po[objS1], po[objRT]], [['BLOCKED', 'SHARED_OBJECT'], ['BLOCKED', 'RETENTION_WINDOW']]);
  assert.equal(m.server.messages().length, beforeMsgs, 'nada que otro beat usa se borró');
  assert.deepEqual(await counts(pool, lib.userId), { active: 2, trash: 2, purging: 0, pending: 0 });
  assert.deepEqual([await beatState(pool, lib.userId, OP.beatId), await beatState(pool, lib.userId, PO.beatId), await beatState(pool, lib.userId, S2.beatId)], ['TRASH', 'TRASH', 'ACTIVE']);
  assert.equal((await objects(pool, lib.userId)).find((o) => o.object_id === objS1).status, 'PRESENT');
  assert.ok((await m.media.issueAccess({ userId: lib.userId, fileId: S2.fileId })), 'el beat que comparte el archivo sigue reproducible');
  // cuando ya nadie lo usa (S2 eliminado definitivamente), el objeto compartido sí se limpia
  await trashAll(m, lib, [S2.beatId]); const pS2 = await purgeItems(m, lib, [S2.beatId]); await drain(m.worker, m.pool, lib, { kinds: ['PURGE'] });
  assert.deepEqual([(await m.purge.getPurge({ userId: lib.userId, purgeId: pS2.purgeId })).cleanup.deleted, (await objects(pool, lib.userId)).find((o) => o.object_id === objS1).status], [1, 'DELETED']);
  // cleanup apagado: el beat sale del catálogo; su objeto queda como limpieza diferida (sin efecto externo) y se reanuda al habilitarse
  const lib2 = await nativeLibrary(pool, { cleanup: false, hold: false }); const m2 = modules(pool);
  const X = await importBeat(m2, lib2, 'X', [500]); await trashAll(m2, lib2, [X.beatId]);
  const p2 = await m2.purge.requestPurge({ ...hdrOf(lib2), idempotencyKey: 'blk-2' }); await drain(m2.worker, m2.pool, lib2, { kinds: ['PURGE'] });
  const f2 = await m2.purge.getPurge({ userId: lib2.userId, purgeId: p2.purgeId });
  assert.deepEqual([f2.status, await beatState(pool, lib2.userId, X.beatId), (await purgeObjects(pool, lib2.userId, p2.purgeId))[0].block_reason, f2.cleanup.pending, m2.server.messages().length], ['PURGED', 'PURGED', 'CLEANUP_DISABLED', 1, 1]);
  assert.deepEqual(await counts(pool, lib2.userId), { active: 0, trash: 0, purging: 0, pending: 0 });
  await m2.purge.requestPurge({ ...hdrOf(lib2), idempotencyKey: 'blk-2b' }); await drain(m2.worker, m2.pool, lib2, { kinds: ['PURGE'] });
  assert.equal((await purgeObjects(pool, lib2.userId, p2.purgeId))[0].block_reason, 'CLEANUP_DISABLED', 'sin cambio de causa no se reanuda (sin bucles)');
  await pool.query('UPDATE catalog_libraries SET cleanup_enabled = true WHERE user_id = $1', [lib2.userId]); // aprobación del propietario (T24), simulada
  await m2.purge.requestPurge({ ...hdrOf(lib2), idempotencyKey: 'blk-2c' }); await drain(m2.worker, m2.pool, lib2, { kinds: ['PURGE'] });
  assert.deepEqual([(await purgeObjects(pool, lib2.userId, p2.purgeId))[0].status, m2.server.messages().length], ['DELETED', 0]);
  // restore_hold: diferido hasta liberar el hold (journal reconciliado), que reanuda la limpieza
  const lib3 = await nativeLibrary(pool, { cleanup: true, hold: true }); const m3 = modules(pool);
  const Y = await importBeat(m3, lib3, 'Y', [500]); await trashAll(m3, lib3, [Y.beatId]);
  const p3 = await m3.purge.requestPurge({ ...hdrOf(lib3), idempotencyKey: 'blk-3' }); await drain(m3.worker, m3.pool, lib3, { kinds: ['PURGE'] });
  assert.deepEqual([await beatState(pool, lib3.userId, Y.beatId), (await purgeObjects(pool, lib3.userId, p3.purgeId))[0].block_reason, m3.server.messages().length], ['PURGED', 'RESTORE_HOLD', 1]);
  const rel = await m3.purge.releaseRestoreHold({ ...hdrOf(lib3) }); assert.deepEqual([rel.restoreHold, rel.cleanupResumed], [false, 1]);
  await drain(m3.worker, m3.pool, lib3, { kinds: ['PURGE'] });
  assert.deepEqual([(await purgeObjects(pool, lib3.userId, p3.purgeId))[0].status, m3.server.messages().length], ['DELETED', 0]);
}));

test('E81 Telegram falla: rechazo → REJECTED (no se reintenta solo); timeout sin efecto → solo consulta, presente → nuevo intento → DELETED; timeout con efecto → consulta → DELETED sin reenviar; sin respuesta → UNCERTAIN aparcado y reanudado por evento; journal caído → diferido sin delete; tope de intentos. El beat nunca vuelve ni queda en PURGING', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); let failJournal = false;
  const journal = journalMod.createMemoryDeletionJournal({ failAppend: () => failJournal });
  const m = modules(pool, { journal }); const hdr = hdrOf(lib);
  const one = async (name) => { const b = await importBeat(m, lib, name, [500]); await trashAll(m, lib, [b.beatId]); const p = await purgeItems(m, lib, [b.beatId]); await m.purge.step({ userId: lib.userId, purgeId: p.purgeId }); assert.equal(await beatState(pool, lib.userId, b.beatId), 'PURGED', `${name} sale del catálogo antes de tocar Telegram`); return { ...b, purgeId: p.purgeId, obj: await objOf(pool, lib.userId, b.fileId) }; };
  const del = () => m.server.counters().deletes; const alive = (b) => m.server.messages().some((x) => b.obj.endsWith(`:${x.id}`));
  const row = async (b) => (await purgeObjects(pool, lib.userId, b.purgeId))[0];
  // (1) rechazo permanente: el RPC no se aplicó → REJECTED, mensaje intacto, sin reintento automático
  const J = await one('J'); let d0 = del(); m.client.script({ type: 'forbidden' });
  assert.deepEqual(outcomes(await run(m.purge, lib, J.purgeId)), ['REJECTED']);
  assert.deepEqual([(await row(J)).status, (await row(J)).block_reason, alive(J), del() - d0], ['BLOCKED', 'PROVIDER_REJECTED', true, 1]);
  const fJ = await m.purge.getPurge({ userId: lib.userId, purgeId: J.purgeId }); assert.deepEqual([fJ.status, fJ.cleanup.rejected], ['PURGED', 1]);
  // (2) timeout SIN efecto: incierto → la siguiente acción solo consulta; presente → se puede volver a intentar → DELETED
  const K = await one('K'); d0 = del(); m.client.script({ type: 'timeout' });
  assert.deepEqual(outcomes(await run(m.purge, lib, K.purgeId)), ['UNCERTAIN', 'PENDING', 'DELETED']);
  assert.deepEqual([(await row(K)).status, (await row(K)).attempts, del() - d0, alive(K)], ['DELETED', 2, 2, false]);
  // (3) timeout CON efecto aplicado: la consulta lo demuestra y NO se reenvía el borrado
  const L = await one('L'); d0 = del(); m.client.script({ type: 'timeout', applyEffect: true });
  assert.deepEqual(outcomes(await run(m.purge, lib, L.purgeId)), ['UNCERTAIN', 'DELETED']);
  assert.deepEqual([(await row(L)).status, (await row(L)).attempts, del() - d0], ['DELETED', 1, 1]);
  // (4) Telegram no responde (delete y consulta): UNCERTAIN aparcado, el job termina (sin bucles); una acción explícita lo reanuda
  const N = await one('N'); d0 = del(); m.client.script({ type: 'timeout' }).script({ type: 'timeout' });
  const sN = await run(m.purge, lib, N.purgeId);
  assert.deepEqual([outcomes(sN), sN.at(-1).more, (await row(N)).status, (await row(N)).block_reason, del() - d0], [['UNCERTAIN', 'UNCERTAIN'], false, 'UNCERTAIN', 'PROVIDER_UNCERTAIN', 1]);
  assert.equal((await m.purge.getPurge({ userId: lib.userId, purgeId: N.purgeId })).cleanup.uncertain, 1);
  const res = await m.purge.resumeCleanup(hdr); assert.ok(res.unparked >= 1);
  assert.deepEqual(outcomes(await run(m.purge, lib, N.purgeId)), ['PENDING', 'DELETED'], 'reconciliar: consulta (presente) y solo entonces nuevo borrado');
  assert.deepEqual([(await row(N)).status, del() - d0, alive(N)], ['DELETED', 2, false]);
  assert.equal((await row(J)).block_reason, 'PROVIDER_REJECTED', 'el rechazo de (1) no se reanudó');
  // (5) journal caído: sin persistencia demostrada no hay delete → diferido; al volver el journal y reanudar → DELETED
  const Q = await one('Q'); d0 = del(); failJournal = true;
  assert.deepEqual(outcomes(await run(m.purge, lib, Q.purgeId)), ['DEFERRED']);
  assert.deepEqual([(await row(Q)).status, (await row(Q)).block_reason, (await row(Q)).journaled, del() - d0], ['BLOCKED', 'JOURNAL_UNAVAILABLE', false, 0]);
  failJournal = false; assert.ok((await m.purge.resumeCleanup(hdr)).requeued >= 1);
  assert.deepEqual([outcomes(await run(m.purge, lib, Q.purgeId)), del() - d0], [['DELETED'], 1]);
  // (6) tope de intentos existente: cada ciclo es delete (timeout) → consulta (presente); tras OBJECT_MAX_ATTEMPTS queda para el operador
  const R = await one('R'); d0 = del(); for (let i = 0; i < purgeMod.OBJECT_MAX_ATTEMPTS; i++) m.client.script({ type: 'timeout' }).script({ type: 'noop' }); // la cola de faults es FIFO: delete (timeout), consulta (neutra)
  await run(m.purge, lib, R.purgeId, 60);
  assert.deepEqual([(await row(R)).status, (await row(R)).block_reason, (await row(R)).attempts, del() - d0, alive(R)], ['BLOCKED', 'PROVIDER_UNCERTAIN', purgeMod.OBJECT_MAX_ATTEMPTS, purgeMod.OBJECT_MAX_ATTEMPTS, true]);
  await m.purge.resumeCleanup(hdr); assert.equal((await row(R)).status, 'BLOCKED', 'el tope no se reanuda solo');
  assert.deepEqual(await counts(pool, lib.userId), { active: 0, trash: 0, purging: 0, pending: 0 }, 'ningún beat quedó en la papelera ni en PURGING');
}));

test('E81 reinicio y concurrencia en la limpieza: reinicio tras enviar el delete → la reanudación solo consulta (sin reenviar); reinicio antes del journal → se completa; mismo objeto con borrado en vuelo en otra purga → espera sin efecto; dos workers no procesan el mismo objeto; lease viejo no confirma', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); let hang = false;
  const m = modules(pool, { gatewayWrap: (gw) => ({ ...gw, deleteMessage: async (a) => { const r = await gw.deleteMessage(a); if (hang) await new Promise(() => {}); return r; } }) });
  const hdr = hdrOf(lib);
  const after = purgeMod.createCatalogPurge({ pool, authority: m.a, gateway: gwOf(m.client), journal: m.journal }); // el proceso tras el reinicio
  const del = () => m.server.counters().deletes;
  // (1) el proceso muere con el delete ya enviado (la fila queda DELETING)
  const T = await importBeat(m, lib, 'T', [400]); await trashAll(m, lib, [T.beatId]); const pT = await purgeItems(m, lib, [T.beatId]);
  await m.purge.step({ userId: lib.userId, purgeId: pT.purgeId }); let d0 = del(); hang = true;
  m.purge.step({ userId: lib.userId, purgeId: pT.purgeId }); await waitFor(() => del() > d0); hang = false;
  assert.equal((await purgeObjects(pool, lib.userId, pT.purgeId))[0].status, 'DELETING');
  assert.deepEqual(outcomes(await run(after, lib, pT.purgeId)), ['DELETED']);
  assert.equal(del() - d0, 1, 'tras el reinicio no se reenvía: la consulta demuestra la ausencia');
  // (2) el proceso muere durante el journal (antes de cualquier efecto externo): el siguiente lo completa
  const U = await importBeat(m, lib, 'U', [400]); await trashAll(m, lib, [U.beatId]); const pU = await purgeItems(m, lib, [U.beatId]);
  const stuck = purgeMod.createCatalogPurge({ pool, authority: m.a, gateway: gwOf(m.client), journal: { append: () => new Promise(() => {}), verify: async () => true, list: async () => [] } });
  await stuck.step({ userId: lib.userId, purgeId: pU.purgeId }); d0 = del();
  stuck.step({ userId: lib.userId, purgeId: pU.purgeId }); await waitFor(async () => (await purgeObjects(pool, lib.userId, pU.purgeId))[0].attempts === 1);
  assert.deepEqual(outcomes(await run(after, lib, pU.purgeId)), ['DELETED']); assert.equal(del() - d0, 1);
  // (3) mismo objeto físico en dos purgas (archivo compartido por dos beats eliminados por separado) con un borrado en vuelo
  const S1 = await importBeat(m, lib, 'S1', [300]); const S2 = await importBeat(m, lib, 'S2', [300]);
  const X = await objOf(pool, lib.userId, S1.fileId);
  await pool.query('UPDATE catalog_part_locations SET object_id = $3 WHERE user_id = $1 AND file_id = $2', [lib.userId, S2.fileId, X]);
  await trashAll(m, lib, [S1.beatId, S2.beatId]);
  const p1 = await purgeItems(m, lib, [S1.beatId]); await m.purge.step({ userId: lib.userId, purgeId: p1.purgeId });
  const p2 = await purgeItems(m, lib, [S2.beatId]); await after.step({ userId: lib.userId, purgeId: p2.purgeId });
  d0 = del(); hang = true; m.purge.step({ userId: lib.userId, purgeId: p1.purgeId }); await waitFor(() => del() > d0); hang = false;
  assert.deepEqual(outcomes([await after.step({ userId: lib.userId, purgeId: p2.purgeId })]), ['DEFERRED']);
  assert.equal((await purgeObjects(pool, lib.userId, p2.purgeId))[0].block_reason, 'PENDING_OPERATION');
  assert.deepEqual(outcomes(await run(after, lib, p1.purgeId)), ['DELETED']);
  await after.resumeCleanup(hdr); assert.deepEqual(outcomes(await run(after, lib, p2.purgeId)), ['DELETED']);
  assert.equal(del() - d0, 1, 'un solo delete para el objeto compartido');
  // (4) dos workers a la vez sobre la misma purga: SKIP LOCKED reparte objetos distintos
  const W = await importBeat(m, lib, 'W', [300, 300]); await trashAll(m, lib, [W.beatId]); const pW = await purgeItems(m, lib, [W.beatId]);
  await after.step({ userId: lib.userId, purgeId: pW.purgeId }); d0 = del();
  const w2 = purgeMod.createCatalogPurge({ pool, authority: m.a, gateway: gwOf(m.client), journal: m.journal });
  const both = await Promise.all([after.step({ userId: lib.userId, purgeId: pW.purgeId }), w2.step({ userId: lib.userId, purgeId: pW.purgeId })]);
  assert.notEqual(both[0].objectId, both[1].objectId);
  assert.deepEqual([outcomes(both), del() - d0, (await purgeObjects(pool, lib.userId, pW.purgeId)).map((o) => o.status)], [['DELETED', 'DELETED'], 2, ['DELETED', 'DELETED']]);
  // (5) lease viejo: el worker con lease vencido no confirma el job (fencing de T10); el objeto no se procesa dos veces
  const L = await importBeat(m, lib, 'L', [500]); await trashAll(m, lib, [L.beatId]);
  await pool.query("UPDATE catalog_jobs SET state = 'DONE', completed_at = now(), lease_owner = NULL, lease_until = NULL WHERE user_id = $1 AND kind = 'PURGE' AND state IN ('QUEUED', 'LEASED')", [lib.userId]); // jobs de los pasos manuales anteriores
  const p3 = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'f-3' });
  const claimed = await m.ops.claimJobs({ owner: 'old', kinds: ['PURGE'] });
  const job = claimed.find((j) => j.operationId === p3.purgeId); assert.ok(job, 'el worker viejo reclamó el job de la purga');
  await pool.query("UPDATE catalog_jobs SET lease_until = now() - interval '1 second' WHERE lease_owner = 'old'");
  d0 = del(); await drain(m.worker, m.pool, lib, { kinds: ['PURGE'] });
  await rejects(m.ops.completeJob({ jobId: job.jobId, lease: job.lease }), 'LEASE_FENCED');
  assert.deepEqual([(await m.purge.getPurge({ userId: lib.userId, purgeId: p3.purgeId })).cleanup.deleted, del() - d0], [1, 1]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 0, trash: 0, purging: 0, pending: 0 });
}));

test('E81 papelera y restos anteriores: restaurar antes de eliminar definitivamente deja el beat intacto; tras eliminar, restore/REPLACE/acceso se rechazan; cancel solo detiene la fase de catálogo; beat PURGING de antes de E81 con una parte ya borrada → sale del catálogo y su limpieza continúa; restore_hold exige journal reconciliado', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const m = modules(pool); const hdr = hdrOf(lib);
  const P = await importBeat(m, lib, 'P', [500]); const Q = await importBeat(m, lib, 'Q', [500]); await trashAll(m, lib, [P.beatId, Q.beatId]);
  // restaurar Q ANTES de eliminar definitivamente: vuelve intacto y la purga de toda la papelera no lo toca
  await m.cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: Q.beatId, expectedVersion: await versionOf(pool, lib.userId, Q.beatId) }] });
  const p = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'c-1' }); await drain(m.worker, m.pool, lib, { kinds: ['PURGE'] });
  assert.deepEqual([await beatState(pool, lib.userId, P.beatId), await beatState(pool, lib.userId, Q.beatId), await galleryIds(m, lib)], ['PURGED', 'ACTIVE', [Q.beatId]]);
  assert.ok(await m.media.issueAccess({ userId: lib.userId, fileId: Q.fileId }), 'Q reproducible');
  assert.deepEqual(await counts(pool, lib.userId), { active: 1, trash: 0, purging: 0, pending: 0 });
  const vP = await versionOf(pool, lib.userId, P.beatId);
  await rejects(m.cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: P.beatId, expectedVersion: vP }] }), 'VERSION_CONFLICT');
  await rejects(m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: P.beatId, expectedVersion: vP, parts: [part('m0', Buffer.alloc(10))] } }), 'NOT_FOUND'); // ya no existe en la biblioteca
  await rejects(m.media.issueAccess({ userId: lib.userId, fileId: P.fileId }), 'ACCESS_DENIED', (e) => e.detail.reason === 'PURGE_PENDING');
  // cancel antes de la fase de catálogo: el beat sigue en la papelera y restaurable; después, nada que cancelar
  const R = await importBeat(m, lib, 'R', [300]); await trashAll(m, lib, [R.beatId]);
  const pr = await purgeItems(m, lib, [R.beatId]);
  const c = await m.purge.cancelPurge({ ...hdr, purgeId: pr.purgeId }); assert.deepEqual([c.status, c.changed, c.stopped], ['CANCELLED', true, 1]);
  await drain(m.worker, m.pool, lib, { kinds: ['PURGE'] });
  assert.equal(await beatState(pool, lib.userId, R.beatId), 'TRASH');
  await m.cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: R.beatId, expectedVersion: await versionOf(pool, lib.userId, R.beatId) }] });
  assert.equal(await beatState(pool, lib.userId, R.beatId), 'ACTIVE');
  assert.equal((await m.purge.cancelPurge({ ...hdr, purgeId: p.purgeId })).changed, false);
  // resto anterior a E81: beat en PURGING (fuera de la papelera, sin poder restaurarse) con UNA de sus dos partes ya borrada
  const E = await importBeat(m, lib, 'E', [300, 300]); await trashAll(m, lib, [E.beatId]);
  const pe = await purgeItems(m, lib, [E.beatId]);
  await pool.query("UPDATE catalog_jobs SET state = 'BLOCKED', lease_owner = NULL, lease_until = NULL WHERE user_id = $1 AND operation_id = $2", [lib.userId, pe.purgeId]); // el job de entonces se agotó
  const locs = (await pool.query('SELECT l.object_id, l.file_id, l.part_index, o.chat_id, o.message_id::text AS message_id FROM catalog_part_locations l JOIN catalog_media_objects o USING (user_id, object_id) WHERE l.user_id = $1 AND l.file_id = $2 ORDER BY l.part_index', [lib.userId, E.fileId])).rows;
  assert.equal(locs.length, 2);
  await pool.query("UPDATE catalog_beats SET state = 'PURGING', version = version + 1 WHERE user_id = $1 AND beat_id = $2", [lib.userId, E.beatId]);
  await pool.query('UPDATE catalog_libraries SET trash_count = trash_count - 1, purging_count = purging_count + 1 WHERE user_id = $1', [lib.userId]);
  await pool.query("UPDATE catalog_purges SET status = 'DELETING' WHERE user_id = $1 AND purge_id = $2", [lib.userId, pe.purgeId]);
  await pool.query("UPDATE catalog_purge_items SET status = 'ENUMERATED', enumerated_at = now(), objects_total = 2 WHERE user_id = $1 AND purge_id = $2", [lib.userId, pe.purgeId]);
  for (const l of locs) await pool.query("INSERT INTO catalog_purge_objects(user_id, purge_id, object_id, beat_id, file_id, part_index, chat_id, message_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, 'PENDING')", [lib.userId, pe.purgeId, l.object_id, E.beatId, l.file_id, l.part_index, l.chat_id, l.message_id]);
  await m.gateway.deleteMessage({ chatId: locs[0].chat_id, messageId: Number(locs[0].message_id) });
  await pool.query("UPDATE catalog_media_objects SET status = 'DELETED', deletion_generation = $3 WHERE user_id = $1 AND object_id = $2", [lib.userId, locs[0].object_id, lib.generationId]);
  await pool.query("UPDATE catalog_purge_objects SET status = 'DELETED', journal_ref = 'prior', deleted_at = now(), attempts = 1 WHERE user_id = $1 AND object_id = $2", [lib.userId, locs[0].object_id]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 2, trash: 0, purging: 1, pending: 0 });
  // la siguiente acción del usuario lo resuelve: sale del catálogo (cuota liberada) y la parte restante se limpia
  await m.purge.requestPurge({ ...hdr, idempotencyKey: 'c-legacy' }); await drain(m.worker, m.pool, lib, { kinds: ['PURGE'] });
  const fe = await m.purge.getPurge({ userId: lib.userId, purgeId: pe.purgeId });
  assert.deepEqual([await beatState(pool, lib.userId, E.beatId), fe.status, fe.items[0].status, fe.cleanup.deleted], ['PURGED', 'PURGED', 'PURGED', 2]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 2, trash: 0, purging: 0, pending: 0 });
  assert.equal(m.server.messages().filter((x) => locs.some((l) => Number(l.message_id) === x.id)).length, 0);
  // restore_hold: se libera solo con el journal reconciliado y cleanup aprobado
  await pool.query('UPDATE catalog_libraries SET restore_hold = true WHERE user_id = $1', [lib.userId]);
  const rel = await m.purge.releaseRestoreHold({ ...hdr }); assert.equal(rel.restoreHold, false);
  await pool.query('UPDATE catalog_libraries SET restore_hold = true WHERE user_id = $1', [lib.userId]);
  await pool.query("UPDATE catalog_media_objects SET status = 'PRESENT', deletion_generation = NULL WHERE user_id = $1 AND object_id = (SELECT object_id FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 LIMIT 1)", [lib.userId, p.purgeId]);
  await rejects(m.purge.releaseRestoreHold({ ...hdr }), 'RESTORE_HOLD_PENDING', (e) => e.detail.count === 1);
  await pool.query('UPDATE catalog_libraries SET cleanup_enabled = false WHERE user_id = $1', [lib.userId]);
  await rejects(m.purge.releaseRestoreHold({ ...hdr }), 'CLEANUP_DISABLED');
}));
