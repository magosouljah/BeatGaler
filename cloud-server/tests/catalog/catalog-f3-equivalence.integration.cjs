'use strict';
// F3 — PostgreSQL efímero de CI (T09), con despacho, recibos y verificación simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const commands = require('../../catalog/commands.js');
const operations = require('../../catalog/operations.js');
const codec = require('../../catalog/beat-projection.js');
const { rebuildDerivedProjections } = require('../../catalog/facets.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const H = crypto.createHash('sha256').update('x').digest('hex');
let seq = 0;
let keyN = 0;
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
const mkCommands = (pool) => commands.createCatalogCommands({ pool, authority: auth(pool) });
const mkOperations = (pool) => operations.createCatalogOperations({ pool, authority: auth(pool), resolveAccess: async () => ({ maxBeats: null }) });

async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, generationId: ctx.generation_id, era: ctx.authority_era, epoch: ctx.authority_epoch };
}

async function seedBeats(pool, lib, beats, { state = 'ACTIVE' } = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let rank = 0;
    for (const beat of beats) {
      const p = codec.projectBeat(beat); const json = JSON.stringify(beat);
      await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, color, color2, bpm_sort_class, bpm_sort, sort_order, manual_rank,
          has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [lib.userId, lib.generationId, beat.id, state, p.name, p.bpmText, p.keyText, p.rating, p.color, p.color2, p.bpmSortClass, p.bpmSort, p.sortOrder, String(rank++ * 1000),
        p.hasArtwork, json, crypto.createHash('sha256').update(json, 'utf8').digest('hex'), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
      for (const t of p.tags) await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [lib.userId, lib.generationId, beat.id, t.position, t.label, t.normKey, t.searchKey]);
    }
    await c.query(`UPDATE catalog_libraries SET active_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE'),
      trash_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'TRASH') WHERE user_id = $1`, [lib.userId, lib.generationId]);
    await rebuildDerivedProjections(c, lib);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

const master = (n = 1000) => ({ partKey: 'm0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: n, sha256: sha(`bytes-${n}`), filename: 'beat.mp3', mime: 'audio/mpeg' });
async function transfer(ops, hdr, op, { verify = true, messageBase = 5000 } = {}) {
  for (const [i, p] of op.parts.entries()) {
    await ops.markDispatched({ ...hdr, operationId: op.operationId, partKey: p.partKey });
    await ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: p.partKey, receipt: { messageId: messageBase + i, documentId: `${900000 + i}`, size: Number(p.declaredSize) } });
    if (verify) await ops.recordVerification({ userId: hdr.userId, operationId: op.operationId, partKey: p.partKey, evidence: { size: Number(p.declaredSize), sha256: p.declaredSha256 } });
  }
}

async function commitTransfer(ops, lib, intent, messageBase) {
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent });
  await transfer(ops, hdr, op, { messageBase });
  const committed = await ops.commitOperation({ ...hdr, operationId: op.operationId });
  assert.equal(committed.status, 200);
  assert.equal(committed.operation.status, 'COMMITTED');
  return committed.operation.result;
}

const beatProjection = async (pool, lib, beatId) => (await pool.query(
  `SELECT legacy_json, legacy_sha256, legacy_export_bytes::text AS legacy_export_bytes, search_text
   FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3`,
  [lib.userId, lib.generationId, beatId])).rows[0];

async function tagProjections(pool, lib, beatId) {
  const library = [lib.userId, lib.generationId];
  const tags = (await pool.query(
    `SELECT position, label, norm_key, search_key, projection_version FROM catalog_beat_tags
     WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 ORDER BY position, projection_version`,
    [...library, beatId])).rows;
  const groups = (await pool.query(
    `SELECT beat_id, norm_key, projection_version, state, manual_rank, first_position, label_at_first_position
     FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 ORDER BY norm_key, projection_version`,
    [...library, beatId])).rows;
  const facets = (await pool.query(
    `SELECT scope, norm_key, projection_version, beat_count, rep_beat_id, rep_position, rep_label
     FROM catalog_facets WHERE user_id = $1 AND generation_id = $2 ORDER BY scope, norm_key, projection_version`, library)).rows;
  return { tags, groups, facets };
}

async function beatHistory(pool, lib, beatId) {
  const state = (await pool.query(
    `SELECT b.version::text AS version, l.revision::text AS revision
     FROM catalog_beats b JOIN catalog_libraries l USING (user_id)
     WHERE b.user_id = $1 AND b.generation_id = $2 AND b.beat_id = $3`,
    [lib.userId, lib.generationId, beatId])).rows[0];
  const events = (await pool.query(
    `SELECT event_seq::text AS seq, kind, beat_id, version::text, revision::text
     FROM catalog_events WHERE user_id = $1 ORDER BY event_seq`, [lib.userId])).rows;
  return { ...state, events };
}

test('F3-EQ-01 · PATCH y REPLACE materializan la misma metadata para el mismo beat', () => withDb(async (pool) => {
  const patchLib = await nativeLibrary(pool);
  const replaceLib = await nativeLibrary(pool);
  const beat = { id: 'b0001', name: 'Árbol', bpm: '95', key: 'F', tags: ['trap'], rating: 1, extra_field: 'keep' };
  // Dos copias con el mismo ID, documento y rango para comparar los bytes y representantes.
  await seedBeats(pool, patchLib, [beat]);
  await seedBeats(pool, replaceLib, [beat]);
  const patch = { bpm: '120', key: 'c#m', tags: ['dark'] };
  const patched = await mkCommands(pool).patchBeat({ ...patchLib, beatId: beat.id, idempotencyKey: key(), expectedVersion: '1', patch });
  assert.equal(patched.noop, false);
  await commitTransfer(mkOperations(pool), replaceLib,
    { kind: 'REPLACE', beatId: beat.id, expectedVersion: '1', parts: [master(2000)], metadata: patch }, 6000);

  const legacyJson = JSON.stringify({ ...beat, ...patch });
  const patchedBeat = await beatProjection(pool, patchLib, beat.id);
  assert.deepEqual(patchedBeat, {
    legacy_json: legacyJson,
    legacy_sha256: sha(legacyJson),
    legacy_export_bytes: String(Buffer.byteLength(legacyJson, 'utf8')),
    search_text: ['árbol', 'c#m', '120', 'dark'].join('\u001f'),
  });
  assert.deepEqual(await beatProjection(pool, replaceLib, beat.id), patchedBeat);

  const patchedTags = await tagProjections(pool, patchLib, beat.id);
  assert.deepEqual(patchedTags.tags.map((row) => [row.position, row.label, row.norm_key, row.search_key]), [[0, 'dark', 'dark', 'dark']]);
  assert.deepEqual(patchedTags.groups.map((row) => [row.state, row.norm_key, row.first_position, row.label_at_first_position]), [['ACTIVE', 'dark', 0, 'dark']]);
  assert.deepEqual(patchedTags.facets.map((row) => [row.scope, row.norm_key, String(row.beat_count), row.rep_beat_id, row.rep_position, row.rep_label]),
    [['ACTIVE', 'dark', '1', beat.id, 0, 'dark']]);
  assert.deepEqual(await tagProjections(pool, replaceLib, beat.id), patchedTags);
}));

test('F3-EQ-02 · REPLACE de rating conserva tags, grupos y facetas', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool);
  const ops = mkOperations(pool);
  const { beatId } = await commitTransfer(ops, lib,
    { kind: 'IMPORT', parts: [master()], metadata: { name: 'Base', tags: ['trap', 'dark'], rating: 1 } }, 5000);
  const before = await tagProjections(pool, lib, beatId);
  assert.deepEqual(before.tags.map((row) => row.label), ['trap', 'dark']);
  assert.equal(before.groups.length, 2);
  assert.equal(before.facets.length, 2);
  // operations.js:411–423 reescribe tags con tagsChanged = true cuando hay metadata.
  // Para rating, el delta conserva los grupos, el conteo y los representantes.
  await commitTransfer(ops, lib, { kind: 'REPLACE', beatId, expectedVersion: '1', parts: [master(2000)], metadata: { rating: 3 } }, 6000);
  assert.equal(JSON.parse((await beatProjection(pool, lib, beatId)).legacy_json).rating, 3);
  assert.deepEqual(await tagProjections(pool, lib, beatId), before);
}));

test('F3-EQ-03 · REPLACE conserva campos omitidos y aplica crop: null; IMPORT completa defaults', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool);
  const ops = mkOperations(pool);
  const crop = { x: 0, y: 0, w: 1, h: 1, unit: 'ratio' };
  const metadata = { name: 'Base', bpm: '95', key: 'F', tags: ['trap'], rating: 1, color: '#123', color2: '#456', crop };
  const { beatId } = await commitTransfer(ops, lib, { kind: 'IMPORT', parts: [master()], metadata }, 5000);
  const initial = { id: beatId, name: 'Base', bpm: '95', key: 'F', tags: ['trap'], rating: 1, color: '#123', color2: '#456', image_crop: crop };
  assert.deepEqual(JSON.parse((await beatProjection(pool, lib, beatId)).legacy_json), initial);

  await commitTransfer(ops, lib, { kind: 'REPLACE', beatId, expectedVersion: '1', parts: [master(2000)], metadata: { rating: 3 } }, 6000);
  const partial = await beatProjection(pool, lib, beatId);
  assert.deepEqual(JSON.parse(partial.legacy_json), { ...initial, rating: 3 });

  await commitTransfer(ops, lib, { kind: 'REPLACE', beatId, expectedVersion: '2', parts: [master(3000)], metadata: null }, 7000);
  assert.deepEqual(await beatProjection(pool, lib, beatId), partial);

  await commitTransfer(ops, lib, { kind: 'REPLACE', beatId, expectedVersion: '3', parts: [master(4000)], metadata: { crop: null } }, 8000);
  assert.deepEqual(JSON.parse((await beatProjection(pool, lib, beatId)).legacy_json), { ...initial, rating: 3, image_crop: null });

  const added = await commitTransfer(ops, lib, { kind: 'IMPORT', parts: [master()], metadata: { name: 'Nuevo' } }, 9000);
  assert.deepEqual(JSON.parse((await beatProjection(pool, lib, added.beatId)).legacy_json),
    { id: added.beatId, name: 'Nuevo', bpm: '', key: '', tags: [], rating: 0, color: '', color2: '' });
}));

test('F3-EQ-06 · PATCH idéntico es no-op y REPLACE con MASTER nuevo suma versión, revisión y evento', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool);
  const ops = mkOperations(pool);
  const metadata = { name: 'Base', bpm: '120', key: 'c#m', tags: ['dark'], rating: 3 };
  const imported = await commitTransfer(ops, lib, { kind: 'IMPORT', parts: [master()], metadata }, 5000);
  const { beatId } = imported;
  const baseline = await beatHistory(pool, lib, beatId);
  const projection = await beatProjection(pool, lib, beatId);
  assert.equal(baseline.events.length, 1);

  const noop = await mkCommands(pool).patchBeat({ ...lib, beatId, idempotencyKey: key(), expectedVersion: baseline.version, patch: metadata });
  assert.deepEqual([noop.noop, noop.beat.version, noop.revision], [true, baseline.version, baseline.revision]);
  assert.deepEqual(await beatHistory(pool, lib, beatId), baseline);

  const replaced = await commitTransfer(ops, lib,
    { kind: 'REPLACE', beatId, expectedVersion: baseline.version, parts: [master(2000)], metadata }, 6000);
  const version = String(BigInt(baseline.version) + 1n);
  const revision = String(BigInt(baseline.revision) + 1n);
  const eventSeq = String(BigInt(baseline.events[0].seq) + 1n);
  assert.deepEqual([replaced.version, replaced.revision, replaced.eventSeq], [version, revision, eventSeq]);
  assert.deepEqual(await beatHistory(pool, lib, beatId), {
    version, revision, events: [...baseline.events, { seq: eventSeq, kind: 'BEAT_PATCHED', beat_id: beatId, version, revision }],
  });
  assert.deepEqual(await beatProjection(pool, lib, beatId), projection);
  const currentMaster = (await pool.query(
    `SELECT cf.file_id, fv.size_bytes::text AS size FROM catalog_current_files cf
     JOIN catalog_file_versions fv USING (user_id, generation_id, file_id)
     WHERE cf.user_id = $1 AND cf.generation_id = $2 AND cf.beat_id = $3 AND cf.slot_key = 'MASTER'`,
    [lib.userId, lib.generationId, beatId])).rows;
  assert.deepEqual(currentMaster, [{ file_id: replaced.installed[0].fileId, size: '2000' }]);
  assert.notEqual(currentMaster[0].file_id, imported.installed[0].fileId);
}));

test('F3-EQ-08 · REPLACE con metadata omitida o nula solo cambia medios e historial', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool);
  const ops = mkOperations(pool);
  const metadata = { name: 'Árbol', bpm: '95', key: 'F', tags: ['trap', 'dark'], rating: 3 };
  const { beatId } = await commitTransfer(ops, lib, { kind: 'IMPORT', parts: [master()], metadata }, 5000);
  const projection = await beatProjection(pool, lib, beatId);
  const tags = await tagProjections(pool, lib, beatId);
  assert.equal(projection.search_text, ['árbol', 'f', '95', 'trap', 'dark'].join('\u001f'));
  assert.deepEqual(tags.tags.map((row) => row.label), metadata.tags);
  assert.equal(tags.groups.length, 2);
  assert.equal(tags.facets.length, 2);

  for (const [i, fields] of [{}, { metadata: null }].entries()) {
    const label = i === 0 ? 'metadata omitida' : 'metadata nula';
    const before = await beatHistory(pool, lib, beatId);
    const replaced = await commitTransfer(ops, lib, {
      kind: 'REPLACE', beatId, expectedVersion: before.version, parts: [master(2000 + i)], ...fields,
    }, 6000 + i);

    assert.deepEqual(await beatProjection(pool, lib, beatId), projection, label);
    assert.deepEqual(await tagProjections(pool, lib, beatId), tags, label);
    const version = String(BigInt(before.version) + 1n);
    const revision = String(BigInt(before.revision) + 1n);
    const eventSeq = String(BigInt(before.events.at(-1).seq) + 1n);
    assert.deepEqual([replaced.version, replaced.revision, replaced.eventSeq], [version, revision, eventSeq], label);
    assert.deepEqual(await beatHistory(pool, lib, beatId), {
      version, revision, events: [...before.events, { seq: eventSeq, kind: 'BEAT_PATCHED', beat_id: beatId, version, revision }],
    }, label);
  }
}));

test('F3-EQ-09 · REPLACE rechaza metadata vacía con 400 y admite null y omisión', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool);
  const ops = mkOperations(pool);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const { beatId, version } = await commitTransfer(ops, lib,
    { kind: 'IMPORT', parts: [master()], metadata: { name: 'Base' } }, 5000);
  const intent = { kind: 'REPLACE', beatId, expectedVersion: version, parts: [master(2000)] };

  await assert.rejects(ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { ...intent, metadata: {} } }), {
    code: 'INPUT_INVALID', status: 400, detail: { reason: 'METADATA', errors: [{ field: '$', reason: 'patch has no fields' }] },
  });
  for (const fields of [{ metadata: null }, {}]) {
    const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { ...intent, ...fields } });
    assert.equal(op.status, 'PREPARED');
    assert.equal(op.intent.metadata, null);
  }
}));

test('F3-EQ-12 · PATCH obsoleto se rechaza y REPLACE obsoleto persiste el conflicto', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool);
  const ops = mkOperations(pool);
  const cmd = mkCommands(pool);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const imported = await commitTransfer(ops, lib,
    { kind: 'IMPORT', parts: [master()], metadata: { name: 'Base', tags: ['trap'] } }, 5000);
  const { beatId, version: expectedVersion } = imported;
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: {
    kind: 'REPLACE', beatId, expectedVersion, parts: [master(2000)], metadata: { tags: ['dark'] },
  } });
  await transfer(ops, hdr, op, { messageBase: 6000 });

  const winningPatch = await cmd.patchBeat({ ...hdr, beatId, idempotencyKey: key(), expectedVersion, patch: { rating: 3 } });
  const currentVersion = winningPatch.beat.version;
  assert.equal(currentVersion, String(BigInt(expectedVersion) + 1n));

  const beatKey = [lib.userId, lib.generationId, beatId];
  const snapshot = async () => ({
    beat: (await pool.query(`SELECT to_jsonb(b) AS beat FROM catalog_beats b
      WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3`, beatKey)).rows[0].beat,
    links: (await pool.query(`SELECT slot_key, file_id FROM catalog_current_files
      WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 ORDER BY slot_key`, beatKey)).rows,
    tags: await tagProjections(pool, lib, beatId),
    history: await beatHistory(pool, lib, beatId),
  });
  const before = await snapshot();
  assert.deepEqual(before.links, [{ slot_key: 'MASTER', file_id: imported.installed[0].fileId }]);

  const versionConflict = { code: 'VERSION_CONFLICT', status: 409,
    detail: { current_version: currentVersion, expected_version: expectedVersion } };
  await assert.rejects(cmd.patchBeat({ ...hdr, beatId, idempotencyKey: key(), expectedVersion, patch: { rating: 1 } }), versionConflict);
  assert.deepEqual(await snapshot(), before, 'PATCH obsoleto');

  const transferArgs = { ...hdr, operationId: op.operationId };
  assert.equal((await ops.getOperation(transferArgs)).status, 'READY');
  await assert.rejects(ops.commitOperation(transferArgs), { ...versionConflict, commit: true });
  const conflict = await ops.getOperation(transferArgs);
  assert.equal(conflict.status, 'CONFLICT');
  assert.equal(conflict.lastError, 'VERSION_CONFLICT');
  assert.equal(conflict.result, null);
  assert.deepEqual(await snapshot(), before, 'REPLACE en conflicto');

  await assert.rejects(ops.commitOperation(transferArgs), {
    code: 'OPERATION_TRANSITION_INVALID', status: 409, detail: { status: 'CONFLICT' },
  });
  assert.deepEqual(await ops.getOperation(transferArgs), conflict);
  assert.deepEqual(await snapshot(), before, 'reintento del mismo REPLACE');
}));
