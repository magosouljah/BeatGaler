'use strict';
// T02 — Ciclo real de DB efímera. Solo corre bajo `node scripts/catalog-check.cjs integration`
// con el descriptor aprobado (service container del job catalog-checks). Sin descriptor: el runner sale con 3.
// No tiene skip: si falta el destino, falla.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');

const { Client, Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const target = db.validateAdminTarget(); // lanza si el entorno no es el aprobado
const admin = { host: target.host, port: target.port, user: target.user, password: target.password, database: target.database };
async function adminQuery(sql, params) { const c = new Client(admin); await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); } }

test('crea DB efímera verificada, la usa con rol propio y la borra solo a ella', async () => {
  const h = await db.createCatalogTestDb();
  try {
    assert.match(h.name, /^beatgaler_catalog_test_[0-9a-f]{16}$/);
    const c = new Client(h.config); await c.connect();
    try {
      const r = await c.query("SELECT current_database() AS db, current_user AS u, (SELECT count(*)::int FROM catalog_test_meta.run_marker) AS m, current_setting('server_encoding') AS enc");
      assert.deepEqual(r.rows[0], { db: h.name, u: h.role, m: 1, enc: 'UTF8' });
      await c.query('CREATE TABLE t(id int)');
      await c.query("CREATE EXTENSION IF NOT EXISTS pg_trgm").catch(() => {}); // informativo; el rol de prueba no es superuser
      const su = await c.query('SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname=current_user');
      assert.deepEqual(su.rows[0], { rolsuper: false, rolcreatedb: false });
    } finally { await c.end(); }

    const ip = db.instrumentPool(new Pool({ ...h.config, max: 2 }));
    await ip.operation('tx', async () => { const cl = await ip.pool.connect(); try { await cl.query('BEGIN'); await cl.query('INSERT INTO t VALUES (1)'); await cl.query('COMMIT'); } finally { cl.release(); } });
    const s = ip.stats(); await ip.pool.end();
    assert.equal(s.open, 0); assert.deepEqual([s.begin, s.commit, s.rollback], [1, 1, 0]);
  } finally {
    await h.cleanup();
  }
  const left = await adminQuery('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [h.name]);
  assert.equal(left.rows[0].n, 0);
  await assert.rejects(h.cleanup(), { code: 'CATALOG_TEST_DB_CLEANUP_REFUSED' });
});

test('rechaza borrar una DB ajena con nombre de prueba válido', async () => {
  const foreign = `beatgaler_catalog_test_${'f'.repeat(16)}`;
  await adminQuery(`CREATE DATABASE "${foreign}"`);
  try {
    await assert.rejects(db.cleanupCatalogTestDb({ name: foreign, role: `catalog_test_${'f'.repeat(16)}`, nonce: 'x' }), { code: 'CATALOG_TEST_DB_CLEANUP_REFUSED' });
    const still = await adminQuery('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [foreign]);
    assert.equal(still.rows[0].n, 1);
  } finally {
    await adminQuery(`DROP DATABASE "${foreign}"`); // la creó este test dentro de la instancia desechable
  }
});
