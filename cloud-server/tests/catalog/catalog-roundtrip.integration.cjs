'use strict';
// T04 — Roundtrip INDEX → STAGING SQL → export contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T04`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const codec = require('../../catalog/legacy-codec.js');
const staging = require('../../catalog/staging.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const DIR = path.join(__dirname, '..', 'fixtures', 'catalog');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const CHAT = '-1001';
const ELIGIBLE = ['t01-empty-certified', 't01-beat-minimal', 't01-all-slots', 't01-null-vs-absent', 't01-unicode-tags', 't01-metadata-message-id', 't01-multipart',
  't01-repeated-unknown-files', 't01-trash-deleted-garbage', 't01-trash-unwrapped', 't01-shared-reference', 't01-unknown-fields', 't01-v1-implicit',
  't01-source-order-ne-sort', 't01-tombstone-sql-only', 't01-size-zero', 't01-botapi-file-id', 't01-nul-unprojected', 'c12-n01-bpm', 'c12-f01-tags', 'c12-f02-search', 'v01a-long-metadata'];

function source(id) {
  const raw = fs.readFileSync(path.join(DIR, manifest.fixtures.find((f) => f.id === id).file));
  const v = JSON.parse(raw);
  if (v.beats) return { raw, ctx: { chatId: CHAT } };
  return { raw: Buffer.from(JSON.stringify(v.index)), ctx: { chatId: CHAT, sqlTombstones: v.sql_tombstones } };
}
async function withDb(fn) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max: 4 });
  try {
    await mig.applyMigrations(pool);
    let n = 0;
    const lib = async () => { const u = `u${++n}`; await pool.query("INSERT INTO users(id) VALUES ($1)", [u]); await pool.query('INSERT INTO vaults(id, user_id, telegram_chat_id) VALUES ($1,$2,$3)', [`v${u}`, u, `-100${n}`]); await pool.query('INSERT INTO catalog_libraries(user_id, vault_id) VALUES ($1,$2)', [u, `v${u}`]); return u; };
    return await fn(pool, lib);
  } finally { await pool.end(); await h.cleanup(); }
}
async function authoritySnapshot(pool) {
  const r = await pool.query(`SELECT (SELECT json_agg(json_build_object('u', user_id, 'a', authority, 'm', migration_state, 'e', authority_epoch, 'r', revision, 'g', active_generation_id, 'c', cleanup_enabled) ORDER BY user_id) FROM catalog_libraries) AS libs,
    (SELECT count(*) FROM library_beats) + (SELECT count(*) FROM library_quota_state) + (SELECT count(*) FROM library_trash_purges) AS legacy`);
  return JSON.stringify(r.rows[0]);
}

test('roundtrip SQL de todos los fixtures elegibles: source exacto, authoritative con deltas, VALIDATED sin autoridad', () => withDb(async (pool, lib) => {
  const before = await authoritySnapshot(pool);
  for (const id of ELIGIBLE) {
    const userId = await lib(); const scope = { userId, generationId: 'g1' };
    const { raw, ctx } = source(id);
    const r = await staging.importToStaging({ pool, scope, rawBytes: raw, ctx });
    const src = codec.parseStrict(raw).value;
    const exp = await staging.exportGeneration({ pool, scope, mode: 'source-roundtrip' });
    assert.deepEqual(codec.deepDiff(src, exp.doc), [], `${id} source-roundtrip`);
    const auth = await staging.exportGeneration({ pool, scope, mode: 'authoritative-export' });
    const expectDeltas = id === 't01-v1-implicit' ? ['V1_TO_V2', 'V1_TO_V2'] : id === 't01-tombstone-sql-only' ? ['SQL_ONLY_TOMBSTONE', 'SQL_ONLY_TOMBSTONE'] : [];
    assert.deepEqual(auth.deltas.map((d) => d.kind), expectDeltas, `${id} deltas`);
    const v = await staging.validateGeneration({ pool, scope });
    assert.equal(v.validated, true, `${id}: ${JSON.stringify(v.diffs.slice(0, 3))}`);
    const g = await pool.query('SELECT status, source_hash FROM catalog_generations WHERE user_id = $1', [userId]);
    assert.deepEqual([g.rows[0].status, g.rows[0].source_hash], ['VALIDATED', r.snapshotHash]);
    const cnt = await pool.query('SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1', [userId]);
    assert.equal(cnt.rows[0].n, r.beats);
  }
  // biblioteca sigue LEGACY, sin generación activa ni cambios de época/revisión; library_* intactas
  const after = JSON.parse(await authoritySnapshot(pool));
  assert.ok(after.libs.every((l) => l.a === 'LEGACY' && l.m === 'IDLE' && l.e === 1 && l.r === 1 && l.g === null && l.c === false));
  assert.equal(after.legacy, JSON.parse(before).legacy);
}));

test('lotes de 250 con crash/replay: sin duplicados, checkpoint verificado y facetas reconstruidas', () => withDb(async (pool, lib) => {
  const userId = await lib(); const scope = { userId, generationId: 'g1' };
  const { raw, ctx } = source('c12-f02-search'); // 241 beats
  await assert.rejects(staging.importToStaging({ pool, scope, rawBytes: raw, ctx, batchSize: 100, onBatchCommitted: ({ batches }) => { if (batches === 2) throw new Error('crash simulado'); } }), /crash simulado/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1', [userId])).rows[0].n, 200);
  const r = await staging.importToStaging({ pool, scope, rawBytes: raw, ctx, batchSize: 100 });
  assert.deepEqual([r.resumedFrom, r.batches, r.beats], [200, 1, 241]);
  const again = await staging.importToStaging({ pool, scope, rawBytes: raw, ctx });
  assert.deepEqual([again.resumedFrom, again.batches], [241, 0], 'repetir el mismo snapshot no duplica');
  const d = await pool.query('SELECT count(*)::int AS n, count(DISTINCT beat_id)::int AS u FROM catalog_beats WHERE user_id = $1', [userId]);
  assert.deepEqual(d.rows[0], { n: 241, u: 241 });
  const big = source('v01a-long-metadata'); const u2 = await lib();
  const r2 = await staging.importToStaging({ pool, scope: { userId: u2, generationId: 'g1' }, rawBytes: big.raw, ctx: big.ctx });
  assert.deepEqual([r2.beats, r2.batches], [240, 1], 'lote por defecto 250');
  const f = await pool.query("SELECT beat_count::int AS n, rep_beat_id FROM catalog_facets WHERE user_id = $1 AND norm_key = 'tag-0-' || repeat('é', 20)", [u2]);
  assert.deepEqual(f.rows[0], { n: 240, rep_beat_id: 'L0' });
}));

test('snapshot cambiado exige generación nueva; REVIEW no escribe nada', () => withDb(async (pool, lib) => {
  const userId = await lib(); const scope = { userId, generationId: 'g1' };
  const a = source('t01-beat-minimal');
  await staging.importToStaging({ pool, scope, rawBytes: a.raw, ctx: a.ctx });
  const changed = Buffer.from(String(a.raw).replace('"Min"', '"Min2"'));
  await assert.rejects(staging.importToStaging({ pool, scope, rawBytes: changed, ctx: a.ctx }), { code: 'CATALOG_SNAPSHOT_CHANGED' });
  await staging.importToStaging({ pool, scope: { userId, generationId: 'g2' }, rawBytes: changed, ctx: a.ctx });
  const u2 = await lib();
  for (const id of ['t01-duplicate-keys', 't01-unsafe-int', 't01-nul-surrogates', 't01-garbage-intersects-live', 't01-manifest-toplevel-ref', 't01-version-null']) {
    const raw = fs.readFileSync(path.join(DIR, manifest.fixtures.find((x) => x.id === id).file));
    await assert.rejects(staging.importToStaging({ pool, scope: { userId: u2, generationId: 'g1' }, rawBytes: raw, ctx: { chatId: CHAT } }), { code: 'CATALOG_IMPORT_REVIEW' }, id);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_generations WHERE user_id = $1', [u2])).rows[0].n, 0);
}));
