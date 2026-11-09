'use strict';
// T19-N — Backup/restore PostgreSQL contra PostgreSQL efimero y proveedor Telegram FAKE (node scripts/catalog-check.cjs T19). NATIVO s11 / TAREAS T19:
// backup en A, purge posterior, restore aislado con restore_hold + epoca+1, journal externo, bytes, backup corrupto/ausente, proveedor inaccesible,
// restore previo a la activacion (STOP-DATA). FAKE/LAB: no es G4 ni evidencia de proveedor real.
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
const backupMod = require('../../catalog/backup.js');
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t19-'));
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

// Destino de restore: instancia aislada, migrada y VACÍA (sin la activación ni el bot que añade withDb).
async function withTarget(fn) {
  const h = await db.createCatalogTestDb(); const pool = new Pool({ ...h.config, max: 6 });
  try { await mig.applyMigrations(pool); return await fn(pool, h); } finally { await pool.end(); await h.cleanup(); }
}
const gwRandom = () => require('../../catalog/transport-gateway.js').newRandomId();
const bkOf = (pool) => backupMod.createCatalogBackup({ pool });
const tableCount = async (pool, t) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;

// Escenario común: A (ACTIVE), B (en papelera) y C (ACTIVE) en origen; backup en A; después se trashea C y se purga TODO (B y C) con journal.
async function scenario(src, { store = backupMod.createMemoryBackupStore() } = {}) {
  const lib = await nativeLibrary(src); const m = modules(src); const hdr = hdrOf(lib);
  const A = await importBeat(m, lib, 'A', [3000, 1500]); const B = await importBeat(m, lib, 'B', [800]); const C = await importBeat(m, lib, 'C', [700]);
  await trashAll(m, lib, [B.beatId]);
  const op = await m.ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', Buffer.alloc(100, 7))], metadata: { name: 'pending' } } });
  await m.transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: 'm0' }); // capacidad viva al hacer el backup
  const bk = bkOf(src);
  const t0 = Date.now(); const made = await bk.createBackup({ store, backupId: 'bkA' }); const backupMs = Date.now() - t0;
  // ---- después de A ----
  const D = await importBeat(m, lib, 'D', [400]);
  await trashAll(m, lib, [C.beatId]);
  const p = await m.purge.requestPurge({ ...hdr, idempotencyKey: 'purge-after-A' });
  await drain(m.worker, m.pool, lib);
  assert.equal((await m.purge.getPurge({ userId: lib.userId, purgeId: p.purgeId })).status, 'PURGED');
  assert.ok((await m.journal.list(lib.userId)).length >= 2, 'journal externo posterior a A');
  return { lib, m, A, B, C, D, store, bk, made, backupMs, hdr };
}

test('backup en A → purge posterior → restore aislado: estado de A, restore_hold + época+1, capacidades revocadas, workers apagados, época vieja rechazada', () => withDb(async (src) => {
  const S = await scenario(src);
  assert.equal(S.made.activated, true);
  assert.equal((await S.bk.verifyBackup({ store: S.store, backupId: 'bkA' })).ok, true);
  await withTarget(async (dst) => {
    const dbk = bkOf(dst);
    const r = await dbk.restoreBackup({ store: S.store, backupId: 'bkA', restoreId: 'rs1' });
    assert.equal(r.status, 'HELD'); assert.equal(r.librariesEpochBumped, 1); assert.ok(r.rows > 0);
    assert.equal(await beatState(dst, S.lib.userId, S.D.beatId), null, 'D es posterior a A');
    assert.deepEqual([await beatState(dst, S.lib.userId, S.C.beatId), await beatState(dst, S.lib.userId, S.B.beatId)], ['ACTIVE', 'TRASH']);
    assert.ok((await objects(dst, S.lib.userId)).every((o) => o.status === 'PRESENT'), 'restore no marca DELETED ni infiere nada');
    const lib = (await dst.query('SELECT authority_epoch::text AS e, restore_hold FROM catalog_libraries WHERE user_id = $1', [S.lib.userId])).rows[0];
    assert.deepEqual([lib.e, lib.restore_hold], [String(Number(S.lib.epoch) + 1), true]);
    assert.equal((await dst.query("SELECT count(*)::int AS n FROM catalog_transfer_capabilities WHERE status IN ('ISSUED', 'REDEEMED')")).rows[0].n, 0);
    const m2 = modules(dst, { server: S.m.server, journal: S.m.journal });
    await assert.rejects(m2.ops.createOperation({ ...S.hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('x', Buffer.alloc(10, 1))], metadata: { name: 'old-client' } } }), (e) => { assert.match(String(e.code), /EPOCH|STALE|AUTHORITY/, `código inesperado ${e.code}`); return true; });
    await dst.query("INSERT INTO catalog_jobs(job_id, user_id, kind, payload_json) VALUES ('held-job', $1, 'OPERATION_STEP', '{}')", [S.lib.userId]);
    assert.deepEqual(await m2.ops.claimJobs({ owner: 'w' }), [], 'workers apagados mientras la corrida está HELD');
    assert.deepEqual((await dbk.openRuns()).map((x) => x.status), ['HELD']);
    await assert.rejects(dbk.releaseRestoreHold({ purge: m2.purge, userId: S.lib.userId }), (e) => e.code === 'RESTORE_NOT_RECONCILED');
    await rejects(dbk.restoreBackup({ store: S.store, backupId: 'bkA', restoreId: 'rs2' }), 'RESTORE_TARGET_NOT_EMPTY');
    console.log(`T19 LAB métricas: backupMs=${S.backupMs} rows=${r.rows} tablas=${r.tables} verifyMs=${r.timings.verifyMs} restoreTotalMs=${r.timings.totalMs}`);
  });
}));

test('reconciliación del journal: B (papelera)=DELETED_CONFIRMED; C (ACTIVE en A)=UNRECOVERABLE bloquea; con copia verificada→BYTES_RESTORED→RECONCILED; bytes alterados=BYTES_MISMATCH', () => withDb(async (src) => {
  const S = await scenario(src);
  await withTarget(async (dst) => {
    const dbk = bkOf(dst); await dbk.restoreBackup({ store: S.store, backupId: 'bkA', restoreId: 'rs1' });
    const m2 = modules(dst, { server: S.m.server, journal: S.m.journal });
    const rec = await dbk.reconcileRestore({ restoreId: 'rs1', journal: S.m.journal, gateway: m2.gateway });
    const kinds = (await dst.query('SELECT kind FROM catalog_restore_findings WHERE restore_id = $1', ['rs1'])).rows.map((r) => r.kind);
    assert.equal(rec.status, 'BLOCKED');
    assert.ok(kinds.includes('DELETED_CONFIRMED') && kinds.includes('UNRECOVERABLE'), kinds.join(','));
    const objs = await objects(dst, S.lib.userId);
    assert.ok(objs.some((o) => o.status === 'DELETED') && objs.some((o) => o.status === 'PRESENT'), 'el objeto de C no se marca presente ni borrado');
    assert.deepEqual((await dbk.openRuns()).map((x) => x.status), ['BLOCKED']);
    assert.deepEqual(await m2.ops.claimJobs({ owner: 'w' }), []);
    await assert.rejects(dbk.releaseRestoreHold({ purge: m2.purge, userId: S.lib.userId }), (e) => e.code === 'RESTORE_NOT_RECONCILED');
    assert.equal((await dst.query('SELECT restore_hold FROM catalog_libraries WHERE user_id = $1', [S.lib.userId])).rows[0].restore_hold, true);
    const cBytes = Buffer.alloc(700, 65); // importBeat(C): 700 bytes de 'A'
    const wrong = await dbk.reconcileRestore({ restoreId: 'rs1', journal: S.m.journal, gateway: m2.gateway, checkBytes: false, recoverBytes: async () => { const s = await m2.gateway.sendPart({ operationId: 'rsbad', partKey: 'p0', randomId: gwRandom(), chatId: S.lib.chatId, file: { name: 'c.bin', buffer: Buffer.alloc(700, 66) }, mimeType: 'application/octet-stream', fileName: 'c.bin' }); return { chatId: S.lib.chatId, messageId: s.messageId }; } });
    assert.equal(wrong.status, 'BLOCKED', 'una copia con hash distinto no se acepta');
    const recoverBytes = async ({ sha256 }) => {
      if (sha(cBytes) !== sha256) return null;
      const s = await m2.gateway.sendPart({ operationId: 'rsrec', partKey: 'p0', randomId: gwRandom(), chatId: S.lib.chatId, file: { name: 'c.bin', buffer: cBytes }, mimeType: 'application/octet-stream', fileName: 'c.bin' });
      return { chatId: S.lib.chatId, messageId: s.messageId };
    };
    const rec2 = await dbk.reconcileRestore({ restoreId: 'rs1', journal: S.m.journal, gateway: m2.gateway, recoverBytes });
    assert.equal(rec2.status, 'RECONCILED', JSON.stringify(rec2.blocking));
    assert.deepEqual(await dbk.openRuns(), []);
    await dst.query("INSERT INTO catalog_jobs(job_id, user_id, kind, payload_json) VALUES ('free-job', $1, 'OPERATION_STEP', '{}')", [S.lib.userId]);
    const claimed = await m2.ops.claimJobs({ owner: 'w' }); assert.ok(claimed.length >= 1 && claimed.some((j) => j.jobId === 'free-job'), 'reconciliada: los workers pueden reclamar (incluidos jobs restaurados)');
    const era = (await dst.query('SELECT authority_era::text AS e FROM catalog_libraries WHERE user_id = $1', [S.lib.userId])).rows[0].e;
    const rel = await dbk.releaseRestoreHold({ purge: m2.purge, userId: S.lib.userId, era, epoch: String(Number(S.lib.epoch) + 1) }).catch((e) => e);
    assert.ok(rel.restoreHold === false || rel.code === 'RESTORE_HOLD_PENDING', `release: ${rel.code || JSON.stringify(rel)}`);
    const ok = await dbk.verifyBytes({ gateway: m2.gateway });
    assert.deepEqual([ok.mismatches.length, ok.missing.length], [0, 0]); assert.ok(ok.checked >= 3 && ok.ok === ok.checked);
    S.m.server.truncateDocument(S.m.server.messages().find((x) => x.size === 3000).id, 2900);
    await dst.query("INSERT INTO catalog_restore_runs(restore_id, backup_id, manifest_sha256, source_taken_at, status, libraries_epoch_bumped) VALUES ('rs-bytes', 'bkA', $1, now(), 'HELD', 0)", [sha('x')]);
    const bad = await dbk.reconcileRestore({ restoreId: 'rs-bytes', journal: S.m.journal, gateway: m2.gateway });
    assert.equal(bad.status, 'BLOCKED'); assert.equal(bad.bytes.mismatches.length, 1);
  });
}));

test('proveedor Telegram inaccesible: sin ausencia probada no se concluye nada (PROVIDER_UNREACHABLE bloquea); verifyBytes propaga el fallo; al recuperarse reconcilia', () => withDb(async (src) => {
  const S = await scenario(src);
  await withTarget(async (dst) => {
    const dbk = bkOf(dst); await dbk.restoreBackup({ store: S.store, backupId: 'bkA', restoreId: 'rs1' });
    const m2 = modules(dst, { server: S.m.server, journal: S.m.journal });
    const boom = async () => { throw Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT', transient: true }); };
    const down = { ...m2.gateway, probeAbsence: boom, downloadPart: boom };
    const r = await dbk.reconcileRestore({ restoreId: 'rs1', journal: S.m.journal, gateway: down, checkBytes: false });
    assert.equal(r.status, 'BLOCKED'); assert.ok(r.blocking.length >= 1 && r.blocking.every((b) => b.kind === 'PROVIDER_UNREACHABLE'));
    assert.ok((await objects(dst, S.lib.userId)).every((o) => o.status === 'PRESENT'), 'nada cambia sin pruebas');
    await assert.rejects(dbk.verifyBytes({ gateway: down }), (e) => e.code === 'PROVIDER_TIMEOUT');
    const again = await dbk.reconcileRestore({ restoreId: 'rs1', journal: S.m.journal, gateway: m2.gateway, checkBytes: false });
    assert.ok(again.blocking.length >= 1 && again.blocking.every((b) => b.kind === 'UNRECOVERABLE'), 'recuperado el proveedor solo queda C');
  });
}));

test('backup corrupto o ausente: se rechaza ANTES de tocar el destino (BACKUP_CORRUPT / BACKUP_MISSING)', () => withDb(async (src) => {
  const S = await scenario(src);
  const find = (st, suffix) => [...st.files.keys()].find((x) => x.endsWith(suffix));
  const damage = {
    'byte volteado': (st) => { const k = find(st, 'catalog_beats.ndjson'); const b = Buffer.from(st.files.get(k)); b[10] ^= 1; st.files.set(k, b); return 'BACKUP_CORRUPT'; },
    'tabla truncada': (st) => { const k = find(st, 'catalog_media_objects.ndjson'); st.files.set(k, st.files.get(k).subarray(0, 20)); return 'BACKUP_CORRUPT'; },
    'tabla ausente': (st) => { st.files.delete(find(st, 'catalog_part_locations.ndjson')); return 'BACKUP_MISSING'; },
    'manifiesto ausente': (st) => { st.files.delete('bkA/manifest.json'); return 'BACKUP_MISSING'; },
    'manifiesto alterado': (st) => { st.files.set('bkA/manifest.json', Buffer.from(st.files.get('bkA/manifest.json').toString().replace('"rows": ', '"rows": 1'))); return 'BACKUP_CORRUPT'; },
  };
  for (const [label, fn] of Object.entries(damage)) {
    const store = backupMod.createMemoryBackupStore(); for (const [k, v] of S.store.files) store.files.set(k, Buffer.from(v));
    const code = fn(store);
    await withTarget(async (dst) => {
      await assert.rejects(bkOf(dst).restoreBackup({ store, backupId: 'bkA' }), (e) => { assert.equal(e.code, code, label); return true; });
      assert.equal(await tableCount(dst, 'catalog_libraries'), 0, `${label}: destino intacto`);
      assert.equal(await tableCount(dst, 'catalog_restore_runs'), 0);
    });
  }
}));

test('STOP-DATA: backup previo a la activación no se restaura; esquema distinto rechazado; backup por archivos hace roundtrip', () => withDb(async (src) => {
  const S = await scenario(src);
  const store = backupMod.createMemoryBackupStore(); for (const [k, v] of S.store.files) store.files.set(k, Buffer.from(v));
  const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
  const m = JSON.parse(store.files.get('bkA/manifest.json').toString()); delete m.manifest_sha256; m.activation = null;
  m.manifest_sha256 = sha(canon(m)); store.files.set('bkA/manifest.json', Buffer.from(JSON.stringify(m)));
  await withTarget(async (dst) => {
    await assert.rejects(bkOf(dst).restoreBackup({ store, backupId: 'bkA' }), (e) => { assert.equal(e.code, 'RESTORE_BEFORE_ACTIVATION'); return true; });
    assert.equal(await tableCount(dst, 'catalog_libraries'), 0);
  });
  const h = await db.createCatalogTestDb(); const dst = new Pool({ ...h.config, max: 4 });
  try {
    await mig.applyMigrations(dst, mig.listMigrations().slice(0, -1));
    await assert.rejects(bkOf(dst).restoreBackup({ store: S.store, backupId: 'bkA' }), (e) => e.code === 'RESTORE_SCHEMA_MISMATCH');
  } finally { await dst.end(); await h.cleanup(); }
  const fstore = backupMod.createFileBackupStore({ dir: path.join(TMP, 'bk-files') });
  await S.bk.createBackup({ store: fstore, backupId: 'bkF' });
  await withTarget(async (dst2) => {
    const r = await bkOf(dst2).restoreBackup({ store: fstore, backupId: 'bkF' });
    assert.equal(await tableCount(dst2, 'catalog_beats'), await tableCount(src, 'catalog_beats'), 'backup posterior: incluye D y el estado post-purge');
    assert.ok(r.rows > 0);
  });
}));
