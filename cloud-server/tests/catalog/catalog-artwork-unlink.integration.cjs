'use strict';
// T07 / E68 — «Remove» de portada = DESVINCULAR en PostgreSQL (decisión del propietario 2026-11-17), contra PostgreSQL real aislado
// (`node scripts/catalog-check.cjs T07`) con el servidor Telegram FAKE detrás del adaptador real del gateway. Demuestra:
//  - PATCH {artwork:null} + expectedVersion: slot ARTWORK eliminado, versión de archivo RETIRED (+35 días), version/revisión +1, evento, DTO sin portada;
//  - el objeto físico y sus filas (media_objects PRESENT, partes, ubicaciones) NO se tocan y los bytes originales siguen descargables del proveedor;
//  - ni el worker (todos los jobs), ni la purga solicitada sobre la papelera, ni un tick posterior borran nada (0 deleteMessage, 0 journal), ni siquiera
//    con `cleanup_enabled = true` y `restore_hold = false` (la configuración más peligrosa);
//  - concurrencia (misma versión: 1 éxito / 1 conflicto), idempotencia (replay), no-op sin portada, BULK_PATCH sigue rechazando `artwork`,
//    poner otra portada después instala un archivo nuevo y conserva el retirado.
// NO prueba ni cambia la política de purga de la papelera (sigue PENDIENTE).
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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-e68-'));
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
function modules(pool) {
  const server = createFakeTelegramServer(); const journal = journalMod.createMemoryDeletionJournal();
  const a = auth(pool); const client = server.session({ selfId: '20' });
  const gateway = { ...telegramOp.createOperatorTelegram({ client, sdk, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) }), client };
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: null }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const transport = createDirectSeeder({ pool, authority: a, operations: ops, browser: gateway });
  const purge = purgeMod.createCatalogPurge({ pool, authority: a, gateway, journal });
  const worker = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: gateway, purge, owner: 'w', options: { globalConcurrency: 2, renewEveryMs: 100_000, stepsPerClaim: 4 } });
  return { pool, ops, q, cmd, gateway, transport, worker, purge, server, journal };
}
async function nativeLibrary(pool, { cleanup = true, hold = false } = {}) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  // Peor caso: limpieza HABILITADA y sin hold (en el laboratorio se fija directamente; en producción lo decide el propietario, T24).
  await pool.query('UPDATE catalog_libraries SET cleanup_enabled = $2, restore_hold = $3 WHERE user_id = $1', [id, cleanup, hold]);
  return { userId: id, era: ctx.authority_era, epoch: ctx.authority_epoch, generationId: ctx.generation_id, chatId: `-100${seq}` };
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
async function upload(m, hdr, operationId, partKey, bytes) {
  const cap = await m.transport.issueUploadCapability({ ...hdr, operationId, partKey });
  assert.equal((await m.transport.uploadPart({ ...hdr, token: cap.token, stream: Readable.from([bytes]), contentLength: bytes.length })).status, 200);
}
// IMPORT (MASTER + ARTWORK) o REPLACE solo ARTWORK a través del transporte real (gateway fake) y confirmado.
async function importBeat(m, lib, name, master, art) {
  const hdr = hdrOf(lib);
  const op = await m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', master, 'MASTER', 'MASTER'), part('a0', art, 'ARTWORK', 'ARTWORK')], metadata: { name } } });
  await upload(m, hdr, op.operationId, 'm0', master); await upload(m, hdr, op.operationId, 'a0', art);
  await drain(m.worker, m.pool, lib, { kinds: ['TRANSFER_VERIFY'] });
  assert.equal((await m.ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
  return op.beatId;
}
async function replaceArtwork(m, lib, beatId, art) {
  const hdr = hdrOf(lib); const v = await versionOf(m.pool, lib, beatId);
  const op = await m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'REPLACE', beatId, expectedVersion: v, parts: [part('a1', art, 'ARTWORK', 'ARTWORK')] } });
  await upload(m, hdr, op.operationId, 'a1', art);
  await drain(m.worker, m.pool, lib, { kinds: ['TRANSFER_VERIFY'] });
  assert.equal((await m.ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
}
const versionOf = async (pool, lib, beatId) => (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, beatId])).rows[0].v;
const patch = (m, lib, beatId, expectedVersion, p, idempotencyKey = key()) => m.cmd.patchBeat({ ...hdrOf(lib), beatId, expectedVersion, patch: p, idempotencyKey });
const slotFile = async (pool, lib, beatId, slot) => (await pool.query('SELECT file_id FROM catalog_current_files WHERE user_id = $1 AND beat_id = $2 AND slot_key = $3', [lib.userId, beatId, slot])).rows[0]?.file_id ?? null;
const fileVersion = async (pool, lib, fileId) => (await pool.query('SELECT status, retained_until, (retained_until > now() + interval \'34 days\') AS long_retention FROM catalog_file_versions WHERE user_id = $1 AND file_id = $2', [lib.userId, fileId])).rows[0] ?? null;
const physical = async (pool, lib, fileId) => ({
  objects: (await pool.query(`SELECT m.object_id, m.status, m.chat_id::text AS chat, m.message_id::text AS msg FROM catalog_part_locations l JOIN catalog_media_objects m ON m.user_id = l.user_id AND m.object_id = l.object_id WHERE l.user_id = $1 AND l.file_id = $2 ORDER BY m.object_id`, [lib.userId, fileId])).rows,
  parts: (await pool.query('SELECT part_index, size_bytes::text AS size, verified_sha256 FROM catalog_file_parts WHERE user_id = $1 AND file_id = $2 ORDER BY part_index', [lib.userId, fileId])).rows,
});
async function bytesOf(m, o) { const chunks = []; for await (const c of await m.gateway.downloadPart({ chatId: o.chat, messageId: o.msg })) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); }
const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, `esperado ${code}, recibido ${e.code}: ${e.message}`); return true; });

test('quitar portada: desvincula en SQL, conserva objeto y bytes, y ningún worker/purga/limpieza borra nada (con cleanup HABILITADO)', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool, { cleanup: true, hold: false }); const m = modules(pool);
    const master = Buffer.alloc(2048, 7); const art = Buffer.from(crypto.randomBytes(1500));
    const A = await importBeat(m, lib, 'A', master, art);
    const other = await importBeat(m, lib, 'Other', Buffer.alloc(600, 3), Buffer.from(crypto.randomBytes(400)));
    const fileId = await slotFile(pool, lib, A, 'ARTWORK'); assert.ok(fileId);
    const otherFile = await slotFile(pool, lib, other, 'ARTWORK'); assert.ok(otherFile);
    const before = await physical(pool, lib, fileId); assert.equal(before.objects.length, 1); assert.equal(before.objects[0].status, 'PRESENT');
    const beforeOther = await physical(pool, lib, otherFile);
    assert.equal(sha(await bytesOf(m, before.objects[0])), sha(art), 'precondición: los bytes del proveedor son los originales');
    const v0 = await versionOf(pool, lib, A); const rev0 = (await pool.query('SELECT revision::text AS r FROM catalog_libraries WHERE user_id = $1', [lib.userId])).rows[0].r;
    const key1 = key();

    const r = await patch(m, lib, A, v0, { artwork: null }, key1);
    assert.equal(r.noop, false); assert.equal(r.beat.hasArtwork, false); assert.equal(r.beat.version, String(Number(v0) + 1));
    assert.equal(await slotFile(pool, lib, A, 'ARTWORK'), null); assert.ok(await slotFile(pool, lib, A, 'MASTER'));
    const fv = await fileVersion(pool, lib, fileId); assert.equal(fv.status, 'RETIRED'); assert.equal(fv.long_retention, true, 'retención de 35 días como un reemplazo');
    assert.equal((await pool.query('SELECT has_artwork FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, A])).rows[0].has_artwork, false);
    assert.equal((await pool.query('SELECT revision::text AS r FROM catalog_libraries WHERE user_id = $1', [lib.userId])).rows[0].r, String(Number(rev0) + 1));
    const ev = (await pool.query("SELECT payload_json FROM catalog_events WHERE user_id = $1 AND beat_id = $2 AND kind = 'BEAT_PATCHED' ORDER BY event_seq DESC LIMIT 1", [lib.userId, A])).rows[0];
    assert.equal(JSON.parse(ev.payload_json).artworkUnlinked, fileId);
    const dto = await m.q.getBeat({ userId: lib.userId, beatId: A }); assert.equal(dto.artwork, null); assert.equal(dto.hasArtwork, false); assert.notEqual(dto.playback, null, 'el MASTER no se toca');
    const files = await m.q.listBeatFiles({ userId: lib.userId, beatId: A }); assert.equal(files.items.some((f) => f.role === 'ARTWORK' && f.current !== false), false);

    // idempotencia: la misma clave repite el resultado sin segundo efecto
    const again = await patch(m, lib, A, v0, { artwork: null }, key1); assert.equal(again.replay, true); assert.equal(await versionOf(pool, lib, A), String(Number(v0) + 1));
    // sin portada vigente: no-op (sin versión nueva)
    const noop = await patch(m, lib, A, await versionOf(pool, lib, A), { artwork: null }); assert.equal(noop.noop, true); assert.equal(await versionOf(pool, lib, A), String(Number(v0) + 1));

    // lo físico NO se tocó: objeto PRESENT, partes idénticas, bytes del proveedor idénticos; el otro beat intacto
    const after = await physical(pool, lib, fileId); assert.deepEqual(after, before);
    assert.equal(sha(await bytesOf(m, after.objects[0])), sha(art)); assert.deepEqual(await physical(pool, lib, otherFile), beforeOther); assert.ok(await slotFile(pool, lib, other, 'ARTWORK'));

    // NINGÚN proceso posterior lo borra: worker completo (todos los kinds), purga de papelera (vacía: el beat está ACTIVE) y más ticks
    const deletesBefore = m.server.counters().deletes;
    await drain(m.worker, pool, lib, { rounds: 8 });
    const purgeOp = await m.purge.requestPurge({ ...hdrOf(lib), idempotencyKey: key(), beatIds: null });
    for (let i = 0; i < 6; i++) { await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1 AND state = 'QUEUED'", [lib.userId]); await m.worker.runOnce({}); }
    assert.ok(purgeOp.purgeId || purgeOp.operationId);
    assert.equal(m.server.counters().deletes, deletesBefore, 'ningún deleteMessage al proveedor');
    assert.equal((await m.journal.list(lib.userId)).length, 0, 'ninguna entrada en el journal de borrado');
    assert.equal(m.server.messages().length, 4, 'MASTER+ARTWORK de A y de Other siguen en el proveedor');
    assert.deepEqual(await physical(pool, lib, fileId), before); assert.equal((await fileVersion(pool, lib, fileId)).status, 'RETIRED');
    assert.equal(await (async () => (await pool.query("SELECT state FROM catalog_beats WHERE user_id = $1 AND beat_id = $2", [lib.userId, A])).rows[0].state)(), 'ACTIVE');
  });
});

test('quitar portada: concurrencia (1 éxito / 1 conflicto), versión vieja, BULK_PATCH sigue rechazando `artwork`, valores no nulos rechazados', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool);
    const A = await importBeat(m, lib, 'A', Buffer.alloc(900, 5), Buffer.from(crypto.randomBytes(300)));
    const v0 = await versionOf(pool, lib, A);
    const res = await Promise.allSettled([patch(m, lib, A, v0, { artwork: null }), patch(m, lib, A, v0, { artwork: null }), patch(m, lib, A, v0, { artwork: null, rating: 3 })]);
    const ok = res.filter((x) => x.status === 'fulfilled'); const bad = res.filter((x) => x.status === 'rejected');
    assert.equal(ok.length, 1, 'una sola confirma'); assert.equal(bad.length, 2);
    for (const b of bad) assert.equal(b.reason.code, 'VERSION_CONFLICT');
    assert.equal(await versionOf(pool, lib, A), String(Number(v0) + 1));
    await rejects(patch(m, lib, A, v0, { artwork: null }), 'VERSION_CONFLICT'); // versión vieja
    await rejects(patch(m, lib, A, await versionOf(pool, lib, A), { artwork: 'x' }), 'INPUT_INVALID');
    await rejects(patch(m, lib, A, await versionOf(pool, lib, A), { artwork: { fileId: 'f' } }), 'INPUT_INVALID');
    await rejects(m.cmd.createOperation({ ...hdrOf(lib), idempotencyKey: key(), kind: 'BULK_PATCH', selectionId: 'sel-x', selectionVersion: '1', patch: { artwork: null } }), 'INPUT_INVALID');
    await rejects(m.ops.createOperation({ ...hdrOf(lib), idempotencyKey: key(), intent: { kind: 'REPLACE', beatId: A, expectedVersion: await versionOf(pool, lib, A), parts: [], metadata: { artwork: null } } }), 'INPUT_INVALID');
  });
});

test('quitar portada y poner otra después: instala un archivo NUEVO y conserva el retirado; metadatos del mismo PATCH se aplican atómicamente', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool); const m = modules(pool);
    const art1 = Buffer.from(crypto.randomBytes(500)); const art2 = Buffer.from(crypto.randomBytes(700));
    const A = await importBeat(m, lib, 'A', Buffer.alloc(700, 2), art1);
    const f1 = await slotFile(pool, lib, A, 'ARTWORK');
    const r = await patch(m, lib, A, await versionOf(pool, lib, A), { artwork: null, rating: 4, bpm: '120' });
    assert.equal(r.beat.rating, 4); assert.equal(r.beat.bpm, '120'); assert.equal(r.beat.hasArtwork, false); assert.equal((await m.q.getBeat({ userId: lib.userId, beatId: A })).artwork, null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_events WHERE user_id = $1 AND beat_id = $2 AND kind = \'BEAT_PATCHED\' AND payload_json LIKE \'%artworkUnlinked%\'', [lib.userId, A])).rows[0].n, 1);
    await replaceArtwork(m, lib, A, art2);
    const f2 = await slotFile(pool, lib, A, 'ARTWORK'); assert.ok(f2); assert.notEqual(f2, f1);
    assert.equal((await fileVersion(pool, lib, f1)).status, 'RETIRED'); assert.equal((await fileVersion(pool, lib, f2)).status, 'VERIFIED');
    assert.equal((await m.q.getBeat({ userId: lib.userId, beatId: A })).artwork.fileId, f2);
    const p1 = await physical(pool, lib, f1); assert.equal(p1.objects[0].status, 'PRESENT'); assert.equal(sha(await bytesOf(m, p1.objects[0])), sha(art1));
    assert.equal(sha(await bytesOf(m, (await physical(pool, lib, f2)).objects[0])), sha(art2));
  });
});

// Control positivo: el contador de borrados SÍ cuenta. La purga existente borra los objetos de un beat que el usuario envió a la papelera
// (comportamiento previo, solo observado: la política de purga sigue PENDIENTE), y aun así NO toca la portada retirada de un beat ACTIVO.
test('control positivo: la purga borra los objetos de un beat en papelera (el contador funciona) y no toca la portada retirada de un beat ACTIVO', async () => {
  await withDb(async (pool) => {
    const lib = await nativeLibrary(pool, { cleanup: true, hold: false }); const m = modules(pool); const hdr = hdrOf(lib);
    const art = Buffer.from(crypto.randomBytes(800));
    const A = await importBeat(m, lib, 'A', Buffer.alloc(900, 4), art); const B = await importBeat(m, lib, 'B', Buffer.alloc(700, 6), Buffer.from(crypto.randomBytes(300)));
    const fileA = await slotFile(pool, lib, A, 'ARTWORK');
    await patch(m, lib, A, await versionOf(pool, lib, A), { artwork: null });
    const physA = await physical(pool, lib, fileA);
    assert.equal(m.server.messages().length, 4);
    await m.cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: B, expectedVersion: await versionOf(pool, lib, B) }] });
    const p = await m.purge.requestPurge({ ...hdr, idempotencyKey: key() });
    for (let i = 0; i < 40; i++) { const st = await m.purge.step({ userId: lib.userId, purgeId: p.purgeId }); if (!st.more) break; }
    assert.ok(m.server.counters().deletes >= 1, 'la purga del beat en papelera SÍ borró en el proveedor (el contador no es vacuo)');
    assert.equal(m.server.messages().length, 2, 'solo quedan los 2 objetos de A (MASTER + portada retirada)');
    assert.deepEqual(await physical(pool, lib, fileA), physA); assert.equal((await fileVersion(pool, lib, fileA)).status, 'RETIRED');
    assert.equal(sha(await bytesOf(m, physA.objects[0])), sha(art), 'la portada retirada de A conserva sus bytes originales');
  });
});
