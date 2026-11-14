'use strict';
// G4 (parcial, LAB/CI aislado, FAKE) — Backup/restore a escala de 500 beats con medios falsos: backup a ARCHIVOS reales en disco, restore en instancia
// vacía, igualdad de contenido por tabla (hash), consultas del catálogo restaurado, integridad de bytes por hash vía gateway (sana, alterada, ausente),
// y medición de backup/restore. NO es G4 ni evidencia de proveedor: sin bytes reales, sin destino de backups aprobado, sin RPO/RTO de entorno real.
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
const codec = require('../../catalog/legacy-codec.js');
const { rebuildDerivedProjections } = require('../../catalog/staging.js');

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

const TABLES = ['catalog_beats', 'catalog_beat_tags', 'catalog_file_versions', 'catalog_file_parts', 'catalog_part_locations', 'catalog_media_objects'];
const digest = async (pool, uid) => { const o = {}; for (const t of TABLES) { const r = (await pool.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x WHERE user_id = $1`, [uid])).rows[0]; o[t] = `${r.n}:${r.h}`; } return o; };

test('G4 parcial a 500 beats: backup a archivos → restore vacío → igualdad por tabla, consultas, bytes sanos/alterados/ausentes y tiempos (FAKE)', () => withDb(async (src) => {
  const lib = await nativeLibrary(src); const m = modules(src); const hdr = hdrOf(lib);
  const MEDIA = 60; const TOTAL = 500;
  await seedBeats(src, lib, TOTAL - MEDIA);
  const imported = [];
  for (let i = 0; i < MEDIA; i++) imported.push(await importBeat(m, lib, `Media ${i}`, i % 7 === 0 ? [900, 400] : [300 + i]));
  assert.equal((await counts(src, lib.userId)).active, TOTAL);
  const dir = fs.mkdtempSync(path.join(TMP, 'bk-')); const store = backupMod.createFileBackupStore({ dir });
  const bk = bkOf(src);
  const t0 = Date.now(); const made = await bk.createBackup({ store, backupId: 'bk500' }); const backupMs = Date.now() - t0;
  assert.equal(made.activated, true);
  assert.equal((await bk.verifyBackup({ store, backupId: 'bk500' })).ok, true);
  const before = await digest(src, lib.userId);
  const diskBytes = fs.readdirSync(dir, { recursive: true }).reduce((n, f) => { const p = path.join(dir, String(f)); return n + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
  await withTarget(async (dst) => {
    const dbk = bkOf(dst);
    const t1 = Date.now(); const r = await dbk.restoreBackup({ store, backupId: 'bk500', restoreId: 'rs500' }); const restoreMs = Date.now() - t1;
    assert.equal(r.status, 'HELD');
    assert.deepEqual(await digest(dst, lib.userId), before, 'contenido de las tablas de catálogo idéntico (conteo + hash) tras el restore');
    const m2 = modules(dst, { server: m.server, journal: m.journal });
    const page = await m2.q.listBeats({ userId: lib.userId, query: { sort: 'name', limit: '240' } });
    const srcPage = await m.q.listBeats({ userId: lib.userId, query: { sort: 'name', limit: '240' } });
    assert.equal(page.items.length, 240);
    assert.deepEqual(page.items.map((i) => i.id), srcPage.items.map((i) => i.id), 'misma primera página que el origen');
    assert.equal((await counts(dst, lib.userId)).active, TOTAL);
    // integridad de bytes: sanos
    const ok = await dbk.verifyBytes({ gateway: m2.gateway, restoreId: 'rs500' });
    assert.equal(ok.mismatches.length + ok.missing.length, 0); assert.ok(ok.checked >= MEDIA, `partes verificadas ${ok.checked}`); assert.equal(ok.ok, ok.checked);
    // alterados / ausentes en el proveedor falso
    const objs = (await dst.query("SELECT chat_id, message_id::text AS mid FROM catalog_media_objects WHERE user_id = $1 AND status = 'PRESENT' ORDER BY object_id", [lib.userId])).rows;
    assert.ok(objs.length >= MEDIA);
    m.server.truncateDocument(objs[0].mid, 5); // lectura corta: mismo anuncio, menos bytes
    await m2.gateway.deleteMessage({ chatId: objs[1].chat_id, messageId: Number(objs[1].mid) });
    const bad = await dbk.verifyBytes({ gateway: m2.gateway, restoreId: 'rs500' });
    assert.equal(bad.mismatches.length, 1, JSON.stringify(bad.mismatches).slice(0, 200)); assert.equal(bad.missing.length, 1); assert.equal(bad.ok, bad.checked - 2);
    const kinds = (await dst.query("SELECT kind, count(*)::int AS n FROM catalog_restore_findings WHERE restore_id = 'rs500' GROUP BY kind ORDER BY kind")).rows;
    assert.deepEqual(kinds, [{ kind: 'BYTES_MISMATCH', n: 1 }, { kind: 'BYTES_MISSING', n: 1 }], 'hallazgos bloqueantes registrados');
    assert.deepEqual(await m2.ops.claimJobs({ owner: 'w' }), [], 'workers apagados mientras la corrida sigue HELD');
    await assert.rejects(dbk.releaseRestoreHold({ purge: m2.purge, userId: lib.userId }), (e) => e.code === 'RESTORE_NOT_RECONCILED');
    console.log(`G4 LAB 500 beats: backupMs=${backupMs} restoreMs=${restoreMs} verifyMs=${r.timings.verifyMs} rows=${r.rows} tablas=${r.tables} diskBytes=${diskBytes} bytesChecked=${ok.checked}`);
  });
}));
