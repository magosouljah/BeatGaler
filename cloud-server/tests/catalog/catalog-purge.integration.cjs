'use strict';
// T15 — Purge durable contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T15`), con el servidor Telegram FAKE detrás del
// adaptador real del gateway (T11), transporte T12, worker T10 y journal externo (memoria con fallos programables). Cubre TAREAS §T15.5 y
// MATRIZ-T §T15: límite de papelera por revisión, enumeración completa (versiones, partes, recibos sin vincular), journal antes del delete,
// prueba de ausencia autorizada, cuota liberada una vez, bloqueos (compartido/OPAQUE/retención/hold/flag/operación pendiente), caída y
// reintento por objeto, 403/404-sin-entrada/timeout, purge vs restore/replace/acceso, cancel seguro, lease viejo, repeated purge,
// journal no disponible = 0 delete, restore_hold. FAKE: cleanup real sigue apagado; sin proveedor real.
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
const { createCatalogTransport } = require('../../catalog/transport.js');
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
  const gateway = gatewayWrap({ ...g.createTelegramGateway({ client, sdk, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) }), client });
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: null }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const transport = createCatalogTransport({ pool, authority: a, operations: ops, gateway, tempDir: TMP });
  const purge = purgeMod.createCatalogPurge({ pool, authority: a, gateway, journal });
  const media = mediaMod.createCatalogMedia({ pool, authority: a, gateway });
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

test('purge todo: límite por revisión (lo trasheado después queda fuera); TRASH→PURGING ocupa cuota; enumeración completa incl. recibo sin vincular de un REPLACE en conflicto; journal → delete → MessageEmpty → DELETED; PURGED libera cuota UNA vez; tombstone CATALOG; eventos; repeated purge sin items', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const m = modules(pool); const hdr = hdrOf(lib);
  const A = await importBeat(m, lib, 'A', [3000, 1500]); const B = await importBeat(m, lib, 'B', [800]); const C = await importBeat(m, lib, 'C', [500]);
  // REPLACE de A que termina en CONFLICT: su objeto nuevo queda PRESENT sin vincular (recibo de operación no confirmada)
  const vA = (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, A.beatId])).rows[0].v;
  const rep = await m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: A.beatId, expectedVersion: vA, parts: [part('m0', Buffer.alloc(900, 9))] } });
  const cap = await m.transport.issueUploadCapability({ ...hdr, operationId: rep.operationId, partKey: 'm0' }); await m.transport.uploadPart({ ...hdr, token: cap.token, stream: Readable.from([Buffer.alloc(900, 9)]), contentLength: 900 });
  await drain(m.worker, m.pool, lib, { kinds: ['TRANSFER_VERIFY'] });
  await m.cmd.patchBeat({ ...hdr, idempotencyKey: key(), beatId: A.beatId, expectedVersion: vA, patch: { name: 'A2' } });
  await rejects(m.ops.commitOperation({ ...hdr, operationId: rep.operationId }), 'VERSION_CONFLICT');
  const before = m.server.messages().length; assert.equal(before, 5);
  await trashAll(m, lib, [A.beatId, B.beatId]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 1, trash: 2, purging: 0, pending: 0 });
  // concesión viva sobre A: tras el purge debe quedar revocada
  const grant = await m.media.issueAccess({ userId: lib.userId, fileId: A.fileId }).catch((e) => e);
  assert.equal(grant.code, 'ACCESS_DENIED', 'TRASH ya niega acceso');
  const p = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-1' });
  assert.deepEqual([p.status, p.created, p.durable], ['ENUMERATING', true, true]);
  const replay = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-1' }); assert.deepEqual([replay.replay, replay.purgeId], [true, p.purgeId]);
  await rejects(m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-2' }), 'PURGE_IN_PROGRESS');
  // C se trashea DESPUÉS de la intención: queda fuera del alcance de esta purga
  await trashAll(m, lib, [C.beatId]);
  // paso 1: enumeración → PURGING (cuota ocupada, nada borrado todavía)
  const e1 = await m.purge.step({ userId: lib.userId, purgeId: p.purgeId });
  assert.deepEqual([e1.status, e1.enumerated], ['DELETING', 2]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 0, trash: 1, purging: 2, pending: 0 }, 'C (trasheado tras la intención) sigue en TRASH; A y B ocupan cuota como PURGING');
  assert.deepEqual([await beatState(pool, lib.userId, A.beatId), await beatState(pool, lib.userId, C.beatId)], ['PURGING', 'TRASH']);
  assert.equal(m.server.messages().length, 5, 'enumerar no borra');
  const po = await purgeObjects(pool, lib.userId, p.purgeId);
  assert.equal(po.length, 4, 'A (2 partes) + objeto sin vincular del REPLACE en conflicto + B (1 parte)');
  assert.ok(po.every((o) => o.status === 'PENDING'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_tombstones WHERE user_id = $1", [lib.userId])).rows[0].n, 0, 'sin tombstone mientras el beat está vivo (0026)');
  // worker: un objeto por paso (journal → delete → probe → DELETED); al final PURGED y cuota liberada una sola vez
  await drain(m.worker, m.pool, lib);
  const final = await m.purge.getPurge({ userId: lib.userId, purgeId: p.purgeId });
  assert.deepEqual([final.status, final.progress.total, final.progress.purged, final.progress.blocked, final.progress.objects], ['PURGED', 2, 2, 0, { DELETED: 4 }]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 0, trash: 1, purging: 0, pending: 0 }, 'cuota liberada una sola vez por beat PURGED');
  assert.deepEqual([await beatState(pool, lib.userId, A.beatId), await beatState(pool, lib.userId, B.beatId), await beatState(pool, lib.userId, C.beatId)], ['PURGED', 'PURGED', 'TRASH']);
  assert.equal(m.server.messages().length, 1, 'solo queda el MASTER de C');
  assert.equal(m.server.counters().deletes, 4);
  assert.equal((await m.journal.list(lib.userId)).length, 4, 'una entrada de journal por objeto, escrita antes del delete');
  assert.ok((await objects(pool, lib.userId)).filter((o) => o.status === 'DELETED').length === 4);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_file_versions WHERE user_id = $1 AND beat_id = ANY($2::text[]) AND status <> 'DELETED'", [lib.userId, [A.beatId, B.beatId]])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_tombstones WHERE user_id = $1 AND source = 'CATALOG' AND deleted_at IS NOT NULL", [lib.userId])).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_events WHERE user_id = $1 AND kind = 'OPERATION_STATUS' AND operation_id = $2 AND payload_json LIKE '%PURGED%'", [lib.userId, p.purgeId])).rows[0].n, 2, 'un evento durable por beat PURGED');
  const te = (await pool.query('SELECT beat_state FROM catalog_trash_entries WHERE user_id = $1 AND beat_id = $2', [lib.userId, A.beatId])).rows[0];
  assert.equal(te.beat_state, 'PURGED', 'el wrapper de papelera sigue al estado del beat (FK ON UPDATE CASCADE)');
  // repeated purge: nada que hacer (C queda, pero fue trasheado después de la primera intención → ahora sí entra)
  const p2 = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-3' });
  await drain(m.worker, m.pool, lib);
  const f2 = await m.purge.getPurge({ userId: lib.userId, purgeId: p2.purgeId });
  assert.deepEqual([f2.status, f2.progress.total, f2.progress.purged], ['PURGED', 1, 1]);
  assert.deepEqual(await counts(pool, lib.userId), { active: 0, trash: 0, purging: 0, pending: 0 });
  const p3 = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-4' });
  await drain(m.worker, m.pool, lib);
  assert.deepEqual((await m.purge.getPurge({ userId: lib.userId, purgeId: p3.purgeId })).progress.total, 0);
  assert.equal(m.purge.metrics.purged, 3);
}));

test('bloqueos con motivo explícito y 0 cuota liberada: objeto compartido con otro beat vivo (el otro queda intacto), OPAQUE, retención vigente de otro beat, operación pendiente (RECONCILE), cleanup apagado, restore_hold; el purge termina PARTIAL/BLOCKED y la UI ve pendiente', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const m = modules(pool); const hdr = hdrOf(lib);
  const S1 = await importBeat(m, lib, 'S1', [1000]); const S2 = await importBeat(m, lib, 'S2', [1000]);
  const OP = await importBeat(m, lib, 'OP', [700]); const RT = await importBeat(m, lib, 'RT', [600]); const PO = await importBeat(m, lib, 'PO', [650]); const OK = await importBeat(m, lib, 'OK', [400]);
  const gen = lib.generationId;
  // compartido: la parte de S2 apunta al objeto de S1 (identidad física compartida)
  const objS1 = (await pool.query("SELECT l.object_id FROM catalog_part_locations l WHERE l.user_id = $1 AND l.file_id = $2", [lib.userId, S1.fileId])).rows[0].object_id;
  await pool.query('UPDATE catalog_part_locations SET object_id = $3, locator = $4 WHERE user_id = $1 AND file_id = $2', [lib.userId, S2.fileId, objS1, `direct:${objS1.split(':')[2]}`]);
  // OPAQUE: la ubicación de OP pierde su objeto conocido
  await pool.query("UPDATE catalog_part_locations SET reference_class = 'OPAQUE', object_id = NULL WHERE user_id = $1 AND file_id = $2", [lib.userId, OP.fileId]);
  // retención: una versión RETIRED de OK (otro beat) referencia el objeto de RT con retained_until futuro
  const objRT = (await pool.query('SELECT object_id FROM catalog_part_locations WHERE user_id = $1 AND file_id = $2', [lib.userId, RT.fileId])).rows[0].object_id;
  await pool.query(`INSERT INTO catalog_file_versions(user_id, generation_id, file_id, beat_id, role, legacy_path, status, retained_until) VALUES ($1, $2, 'f-ok-old', $3, 'MASTER', '$.master', 'RETIRED', now() + interval '30 days')`, [lib.userId, gen, OK.beatId]);
  await pool.query("INSERT INTO catalog_file_parts(user_id, generation_id, file_id, part_index, size_bytes) VALUES ($1, $2, 'f-ok-old', 0, 600)", [lib.userId, gen]);
  await pool.query("INSERT INTO catalog_part_locations(user_id, generation_id, file_id, part_index, location, reference_class, object_id, provider, locator) VALUES ($1, $2, 'f-ok-old', 0, 'PRIMARY', 'KNOWN', $3, 'telegram', 'direct:x')", [lib.userId, gen, objRT]);
  // operación pendiente sobre PO: REPLACE despachado y cancelado → RECONCILE (en vuelo)
  const vPO = (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, PO.beatId])).rows[0].v;
  const rep = await m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: PO.beatId, expectedVersion: vPO, parts: [part('m0', Buffer.alloc(300, 1))] } });
  await m.ops.markDispatched({ ...hdr, operationId: rep.operationId, partKey: 'm0' }); await m.ops.cancelOperation({ ...hdr, operationId: rep.operationId });
  await trashAll(m, lib, [S1.beatId, OP.beatId, RT.beatId, PO.beatId]);
  const beforeMsgs = m.server.messages().length;
  const p = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'blk-1' });
  await drain(m.worker, m.pool, lib, { kinds: ['PURGE'] });
  const f = await m.purge.getPurge({ userId: lib.userId, purgeId: p.purgeId });
  const byBeat = Object.fromEntries(f.items.map((i) => [i.beatId, [i.status, i.blockReason]]));
  assert.deepEqual(byBeat[S1.beatId], ['BLOCKED', 'SHARED_OBJECT']); assert.deepEqual(byBeat[OP.beatId], ['BLOCKED', 'OPAQUE_REFERENCE']);
  assert.deepEqual(byBeat[RT.beatId], ['BLOCKED', 'RETENTION_WINDOW']); assert.deepEqual(byBeat[PO.beatId], ['BLOCKED', 'PENDING_OPERATION']);
  assert.deepEqual([f.status, f.progress.purged, f.progress.blocked], ['BLOCKED', 0, 4]);
  assert.equal(m.server.messages().length, beforeMsgs, 'ningún objeto bloqueado se borró');
  assert.equal((await m.journal.list(lib.userId)).length, 0, 'sin journal porque no hubo intención de borrado efectiva');
  assert.deepEqual(await counts(pool, lib.userId), { active: 2, trash: 0, purging: 4, pending: 0 }, 'PURGING ocupa cuota: nada liberado');
  assert.equal(await beatState(pool, lib.userId, S2.beatId), 'ACTIVE');
  assert.equal((await objects(pool, lib.userId)).find((o) => o.object_id === objS1).status, 'PRESENT', 'la referencia del otro beat no se copia ni se borra');
  // flags de propietario: cleanup apagado / restore_hold → bloqueo explícito (otra biblioteca)
  const lib2 = await nativeLibrary(pool, { cleanup: false, hold: false }); const m2 = modules(pool);
  const X = await importBeat(m2, lib2, 'X', [500]); await trashAll(m2, lib2, [X.beatId]);
  const p2 = await m2.purge.requestPurge({ ...hdrOf(lib2), idempotencyKey: 'blk-2' }); await drain(m2.worker, m2.pool, lib2, { kinds: ['PURGE'] });
  assert.deepEqual((await m2.purge.getPurge({ userId: lib2.userId, purgeId: p2.purgeId })).items.map((i) => i.blockReason), ['CLEANUP_DISABLED']);
  const lib3 = await nativeLibrary(pool, { cleanup: true, hold: true }); const m3 = modules(pool);
  const Y = await importBeat(m3, lib3, 'Y', [500]); await trashAll(m3, lib3, [Y.beatId]);
  const p3 = await m3.purge.requestPurge({ ...hdrOf(lib3), idempotencyKey: 'blk-3' }); await drain(m3.worker, m3.pool, lib3, { kinds: ['PURGE'] });
  assert.deepEqual((await m3.purge.getPurge({ userId: lib3.userId, purgeId: p3.purgeId })).items.map((i) => i.blockReason), ['RESTORE_HOLD']);
  assert.equal(m2.server.messages().length + m3.server.messages().length, 2);
}));

test('fallos: journal no disponible → 0 delete y reintento; delete 403 → UNCERTAIN sin DELETED; probe sin entrada (otro chat) → UNCERTAIN; timeout con efecto aplicado → recuperación exacta en el siguiente intento; tope de intentos → BLOCKED PROVIDER_UNCERTAIN; lease viejo no confirma', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); let failJournal = true;
  const journal = journalMod.createMemoryDeletionJournal({ failAppend: () => failJournal });
  const m = modules(pool, { journal }); const hdr = hdrOf(lib);
  const J = await importBeat(m, lib, 'J', [500]); await trashAll(m, lib, [J.beatId]);
  const p = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'f-1' });
  await m.purge.step({ userId: lib.userId, purgeId: p.purgeId }); // enumerar
  await rejects(m.purge.step({ userId: lib.userId, purgeId: p.purgeId }), 'JOURNAL_UNAVAILABLE');
  let po = await purgeObjects(pool, lib.userId, p.purgeId);
  assert.deepEqual([po[0].status, po[0].journaled, m.server.messages().length, m.server.counters().deletes], ['PENDING', false, 1, 0], 'sin journal no hay delete; el manifiesto sigue PENDING y el objeto físico queda DELETING (sin nuevas referencias)');
  assert.equal((await objects(pool, lib.userId))[0].status, 'DELETING');
  // 403 al borrar → UNCERTAIN, nada DELETED
  failJournal = false; m.client.script({ type: 'forbidden' });
  await rejects(m.purge.step({ userId: lib.userId, purgeId: p.purgeId }), 'PURGE_PROVIDER_UNCERTAIN');
  po = await purgeObjects(pool, lib.userId, p.purgeId);
  assert.deepEqual([po[0].status, po[0].journaled, m.server.messages().length], ['UNCERTAIN', true, 1]);
  assert.equal((await journal.list(lib.userId)).length, 1, 'el journal se escribió una sola vez y se reutiliza');
  // probe sin entrada (otro peer) → no prueba ausencia → UNCERTAIN (el borrado sí ocurrió en el fake, pero no lo damos por bueno)
  m.client.script({ type: 'noop' }).script({ type: 'wrongChat' }); // el primer fault lo consume DeleteMessages (neutro); el segundo, GetMessages (probe)
  await rejects(m.purge.step({ userId: lib.userId, purgeId: p.purgeId }), 'PURGE_PROVIDER_UNCERTAIN');
  po = await purgeObjects(pool, lib.userId, p.purgeId); assert.equal(po[0].status, 'UNCERTAIN'); assert.equal(m.server.messages().length, 0);
  assert.equal((await objects(pool, lib.userId))[0].status, 'DELETING', 'sin prueba autorizada no hay DELETED');
  // siguiente intento: delete sobre un id ya ausente + probe MessageEmpty → DELETED (recuperación parcial exacta)
  const r = await m.purge.step({ userId: lib.userId, purgeId: p.purgeId });
  assert.deepEqual([r.deleted, r.evidence, r.closed.status], [true, 'MESSAGE_EMPTY', 'PURGED']);
  assert.equal((await objects(pool, lib.userId))[0].status, 'DELETED'); assert.equal(await beatState(pool, lib.userId, J.beatId), 'PURGED');
  // tope de intentos → BLOCKED PROVIDER_UNCERTAIN (otro beat; timeouts seguidos)
  const K = await importBeat(m, lib, 'K', [500]); await trashAll(m, lib, [K.beatId]);
  const p2 = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'f-2' }); await m.purge.step({ userId: lib.userId, purgeId: p2.purgeId });
  for (let i = 0; i < purgeMod.OBJECT_MAX_ATTEMPTS; i++) { m.client.script({ type: 'timeout' }); await rejects(m.purge.step({ userId: lib.userId, purgeId: p2.purgeId }), 'PURGE_PROVIDER_UNCERTAIN'); }
  const r2 = await m.purge.step({ userId: lib.userId, purgeId: p2.purgeId });
  assert.deepEqual([r2.blocked, (await purgeObjects(pool, lib.userId, p2.purgeId))[0].block_reason], [true, 'PROVIDER_UNCERTAIN']);
  await m.purge.step({ userId: lib.userId, purgeId: p2.purgeId });
  assert.equal((await m.purge.getPurge({ userId: lib.userId, purgeId: p2.purgeId })).status, 'BLOCKED');
  // lease viejo: el worker con lease vencido no confirma el job (fencing de T10); el objeto no se procesa dos veces
  const L = await importBeat(m, lib, 'L', [500]); await trashAll(m, lib, [L.beatId]);
  const p3 = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'f-3' });
  const claimed = await m.ops.claimJobs({ owner: 'old', kinds: ['PURGE'] });
  const job = claimed.find((j) => j.operationId === p3.purgeId); assert.ok(job, 'el worker viejo reclamó el job de la purga');
  await pool.query("UPDATE catalog_jobs SET lease_until = now() - interval '1 second' WHERE lease_owner = 'old'"); // leases del worker viejo vencidos
  await drain(m.worker, m.pool, lib, { kinds: ['PURGE'] });
  await rejects(m.ops.completeJob({ jobId: job.jobId, lease: job.lease }), 'LEASE_FENCED');
  assert.equal((await m.purge.getPurge({ userId: lib.userId, purgeId: p3.purgeId })).status, 'PURGED');
  assert.equal(m.server.counters().deletes, 2 + purgeMod.OBJECT_MAX_ATTEMPTS + 1 + 1, 'deletes solicitados = objetos (+ reintentos de K); ningún doble borrado efectivo');
}));

test('purge vs restore/replace/acceso: PURGING rechaza restore y REPLACE (PURGE_PENDING) y el acceso a medios (PURGE_PENDING); cancel seguro revierte a TRASH solo lo no borrado; restore_hold se libera solo con el journal reconciliado y cleanup aprobado', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const m = modules(pool); const hdr = hdrOf(lib);
  const P = await importBeat(m, lib, 'P', [500]); const Q = await importBeat(m, lib, 'Q', [500]); await trashAll(m, lib, [P.beatId, Q.beatId]);
  const p = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'c-1' });
  await m.purge.step({ userId: lib.userId, purgeId: p.purgeId }); // enumerar → PURGING
  const vP = (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, P.beatId])).rows[0].v;
  await rejects(m.cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: P.beatId, expectedVersion: vP }] }), 'VERSION_CONFLICT', (e) => e.detail.conflicts[0].reason === 'PURGE_PENDING');
  await rejects(m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: P.beatId, expectedVersion: vP, parts: [part('m0', Buffer.alloc(10))] } }), 'PURGE_PENDING');
  await rejects(m.media.issueAccess({ userId: lib.userId, fileId: P.fileId }), 'ACCESS_DENIED', (e) => e.detail.reason === 'PURGE_PENDING');
  // un objeto borrado (P), el otro no; cancel: Q vuelve a TRASH, P no (ya se le borraron partes)
  const r1 = await m.purge.step({ userId: lib.userId, purgeId: p.purgeId }); assert.equal(r1.deleted, true);
  const gone = (await pool.query('SELECT beat_id FROM catalog_purge_objects WHERE user_id = $1 AND object_id = $2', [lib.userId, r1.objectId])).rows[0].beat_id;
  const kept = gone === P.beatId ? Q : P; // el orden de objetos es por beat_id COLLATE "C": el borrado puede ser P o Q
  const c = await m.purge.cancelPurge({ ...hdr, purgeId: p.purgeId });
  assert.deepEqual([c.status, c.reverted], ['CANCELLED', 1]);
  assert.equal(await beatState(pool, lib.userId, gone), 'PURGED', 'el beat con partes borradas no vuelve a la papelera');
  assert.equal(await beatState(pool, lib.userId, kept.beatId), 'TRASH', 'el beat sin nada borrado vuelve a TRASH');
  assert.deepEqual(await counts(pool, lib.userId), { active: 0, trash: 1, purging: 0, pending: 0 });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_tombstones WHERE user_id = $1 AND beat_id = $2", [lib.userId, kept.beatId])).rows[0].n, 0, 'sin tombstone para el beat revertido');
  const vK = (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, kept.beatId])).rows[0].v;
  await m.cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: kept.beatId, expectedVersion: vK }] });
  assert.equal(await beatState(pool, lib.userId, kept.beatId), 'ACTIVE');
  // restore_hold: hold activo → exige cleanup y journal reconciliado
  await pool.query('UPDATE catalog_libraries SET restore_hold = true WHERE user_id = $1', [lib.userId]);
  const rel = await m.purge.releaseRestoreHold({ ...hdr });
  assert.deepEqual([rel.restoreHold, rel.journalEntries], [false, 1]);
  // "restore" simulado: SQL vuelve a creer PRESENT un objeto que el journal dice borrado → hold no se libera
  await pool.query("UPDATE catalog_libraries SET restore_hold = true WHERE user_id = $1", [lib.userId]);
  await pool.query("UPDATE catalog_media_objects SET status = 'PRESENT', deletion_generation = NULL WHERE user_id = $1 AND status = 'DELETED'", [lib.userId]);
  await rejects(m.purge.releaseRestoreHold({ ...hdr }), 'RESTORE_HOLD_PENDING', (e) => e.detail.count === 1);
  await pool.query('UPDATE catalog_libraries SET cleanup_enabled = false WHERE user_id = $1', [lib.userId]);
  await rejects(m.purge.releaseRestoreHold({ ...hdr }), 'CLEANUP_DISABLED');
}));
