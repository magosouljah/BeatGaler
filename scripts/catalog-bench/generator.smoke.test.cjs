'use strict';
// T20 — Prueba de humo del generador sintético + benchmark en proceso (node:test, no en catalog-suites.json).
// Uso manual: CATALOG_TEST_ADMIN_URL=postgres://catalog_lab_admin@127.0.0.1:54329/catalog_lab_sentinel
//             CATALOG_TEST_INSTANCE_ID=gha-0-0-00000000000000000000000000000000
//             node --test scripts/catalog-bench/generator.smoke.test.cjs
// Crea su propia DB efímera (lab-wsl-descriptor.json, laboratorio WSL ya desechable) y la borra al salir. Sin skips.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');

const db = require(path.join(__dirname, '..', '..', 'cloud-server', 'tests', 'helpers', 'catalog-test-db.cjs'));
const mig = require(path.join(__dirname, '..', '..', 'cloud-server', 'postgres-migrations.js'));
const authority = require(path.join(__dirname, '..', '..', 'cloud-server', 'catalog', 'authority.js'));
const queries = require(path.join(__dirname, '..', '..', 'cloud-server', 'catalog', 'queries.js'));
const commands = require(path.join(__dirname, '..', '..', 'cloud-server', 'catalog', 'commands.js'));
const { generateLibrary } = require('./generator.cjs');

const { Pool } = require(path.join(__dirname, '..', '..', 'cloud-server', 'node_modules', 'pg'));
const LAB_DESCRIPTOR = require('./lab-wsl-descriptor.json');

const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const KEYS = [{ kid: 'k1', secret: crypto.randomBytes(32) }];
const auth = (pool) => authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres' });

async function withDb(fn) {
  const h = await db.createCatalogTestDb({ descriptor: LAB_DESCRIPTOR });
  const pool = new Pool({ ...h.config, max: 8 });
  try { await mig.applyMigrations(pool); return await fn(pool, h); } finally { await pool.end(); await h.cleanup(); }
}

test('T20 smoke: generador determinista + consultas reales sobre 10k filas', { timeout: 300000 }, () => withDb(async (pool) => {
  const N = 10000;
  const lib = await generateLibrary({ pool, userId: 'bench-u1', n: N, seed: 777, concurrency: 2, trashFraction: 0.10, batchRows: 500, commitEvery: 2000 });
  assert.equal(lib.n, N);
  assert.equal(lib.activeCount + lib.trashCount, N);
  assert.ok(lib.trashCount > N * 0.08 && lib.trashCount < N * 0.12, `trashCount fuera de rango: ${lib.trashCount}`);

  // Determinismo: regenerar la misma fila (índice 42) con la misma semilla produce el mismo beat_id/legacy_sha256.
  const { buildRow } = require('./generator.cjs');
  const a = buildRow({ userId: 'x', generationId: 'g', index: 42, seed: 777, tagVocabSize: 500, trashFraction: 0.10 });
  const b = buildRow({ userId: 'x', generationId: 'g', index: 42, seed: 777, tagVocabSize: 500, trashFraction: 0.10 });
  assert.equal(a.beatRow.beat_id, b.beatRow.beat_id);
  assert.equal(a.beatRow.legacy_sha256, b.beatRow.legacy_sha256);
  assert.deepEqual(a.tagRows.map((t) => t.label), b.tagRows.map((t) => t.label));

  // Consistencia: contadores = filas; facetas = grupos reales (misma invariante que T07).
  const counts = (await pool.query("SELECT state, count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 GROUP BY state", [lib.userId, lib.generationId])).rows;
  const n = (st) => counts.find((c) => c.state === st)?.n || 0;
  assert.deepEqual([n('ACTIVE'), n('TRASH')], [lib.activeCount, lib.trashCount]);
  const libRow = (await pool.query('SELECT active_count::int AS a, trash_count::int AS t FROM catalog_libraries WHERE user_id = $1', [lib.userId])).rows[0];
  assert.deepEqual([libRow.a, libRow.t], [lib.activeCount, lib.trashCount]);
  const drift = (await pool.query(`SELECT f.scope, f.norm_key, f.beat_count::int AS n, (SELECT count(*)::int FROM catalog_beat_tag_groups g
      WHERE g.user_id = f.user_id AND g.generation_id = f.generation_id AND g.norm_key = f.norm_key AND g.state = f.scope) AS real
    FROM catalog_facets f WHERE f.user_id = $1 AND f.generation_id = $2`, [lib.userId, lib.generationId])).rows.filter((r) => r.n !== r.real);
  assert.deepEqual(drift, [], 'facetas sin drift respecto a los grupos');

  const q = queries.createCatalogQueries({ pool, authority: auth(pool), cursorKeys: KEYS });
  const cmd = commands.createCatalogCommands({ pool, authority: auth(pool) });

  // page1 (rating, default)
  const page1 = await q.listBeats({ userId: lib.userId, query: {} });
  assert.equal(page1.items.length, 100);
  assert.ok(page1.totalLibrary >= lib.activeCount - 1);

  // cursor profundo: avanzar varias páginas con nextCursor real
  let cursor = page1.nextCursor; let hops = 0;
  while (cursor && hops < 20) { const p = await q.listBeats({ userId: lib.userId, query: { cursor } }); cursor = p.nextCursor; hops++; }
  assert.ok(hops > 0, 'el cursor avanzó al menos una página');

  // filtro frecuente (tag0) y raro (tag499)
  const freq = await q.listBeats({ userId: lib.userId, query: { includeTag: 'tag0' } });
  const rare = await q.listBeats({ userId: lib.userId, query: { includeTag: 'tag499' } });
  assert.ok(freq.totalMatched >= rare.totalMatched, `tag0 (${freq.totalMatched}) debería ser más frecuente que tag499 (${rare.totalMatched})`);

  // q corto
  const shortQ = await q.listBeats({ userId: lib.userId, query: { q: 'mi' } });
  assert.ok(Array.isArray(shortQ.items));

  // count exacto (includeTotal con filtro)
  const counted = await q.listBeats({ userId: lib.userId, query: { includeTag: 'tag0', includeTotal: 'true' } });
  assert.equal(typeof counted.totalMatched, 'number');

  // legacy navigation (offset 0 y offset grande dentro del límite)
  const legacy0 = await q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: '0' } });
  assert.equal(legacy0.resolution, 'exact');
  const legacyDeep = await q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: '5000' } });
  assert.ok(['exact', 'last'].includes(legacyDeep.resolution));

  // read
  const oneId = page1.items[0].id;
  const got = await q.getBeat({ userId: lib.userId, beatId: oneId });
  assert.equal(got.id, oneId);

  // edit (PATCH)
  const patched = await cmd.patchBeat({
    userId: lib.userId, beatId: oneId, era: lib.era, epoch: lib.epoch,
    idempotencyKey: 'smoke-patch-1', expectedVersion: got.version, patch: { rating: (got.rating + 1) % 6 },
  });
  assert.equal(patched.noop, false);

  // trash + restore round trip
  const trashed = await cmd.trashBeats({ userId: lib.userId, era: lib.era, epoch: lib.epoch, idempotencyKey: 'smoke-trash-1', items: [{ beatId: oneId, expectedVersion: patched.beat.version }] });
  assert.equal(trashed.items[0].beatId, oneId);
  const restored = await cmd.restoreBeats({ userId: lib.userId, era: lib.era, epoch: lib.epoch, idempotencyKey: 'smoke-restore-1', items: [{ beatId: oneId, expectedVersion: trashed.items[0].version }] });
  assert.equal(restored.items[0].beatId, oneId);

  // SQL retenido: ninguna transacción abierta propia al final (instrumentación igual que T02).
  const open = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = current_database()")).rows[0].n;
  assert.equal(open, 0, 'no debe quedar ninguna transacción idle-in-transaction');
}));
