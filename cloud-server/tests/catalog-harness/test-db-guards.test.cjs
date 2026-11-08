'use strict';
// T02 / V01-C — Guardas del helper de DB sin PostgreSQL real: cliente pg fake que cuenta conexiones.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../helpers/catalog-test-db.cjs');

const D = db.loadDescriptor();
const ID = `gha-1-1-${'a'.repeat(32)}`;
const URL_OK = `postgres://${D.admin_role}:pw@${D.host}:${D.port}/${D.admin_database}`;
const env = (extra = {}) => ({ CATALOG_TEST_ADMIN_URL: URL_OK, CATALOG_TEST_INSTANCE_ID: ID, ...extra });

// Simula una instancia: identidad configurable, catálogo de DBs/roles y marcadores.
function fakeInstance(over = {}) {
  const st = { connects: 0, queries: [], dbs: new Map(), sysid: '7000000000000000001', sentinel: ID, version: 160015, coll: 'en_US.utf8', ...over };
  const factory = (config) => ({
    async connect() { st.connects++; },
    async end() {},
    async query(text, params = []) {
      st.queries.push({ db: config.database, text });
      if (/current_setting\('server_version_num'\)/.test(text)) return { rows: [{ u: config.user, db: config.database, v: st.version, enc: 'UTF8', coll: st.coll, sysid: st.sysid }] };
      if (/FROM "catalog_lab"\."lab_identity"/.test(text)) return { rows: [{ id: st.sentinel }] };
      let m;
      if ((m = /^CREATE DATABASE "([a-z0-9_]+)" OWNER "([a-z0-9_]+)"/.exec(text))) { st.dbs.set(m[1], { owner: m[2], markers: new Set() }); return { rows: [] }; }
      if (/^INSERT INTO catalog_test_meta\.run_marker/.test(text)) { st.dbs.get(config.database).markers.add(params[0]); return { rows: [] }; }
      if (/FROM pg_database d JOIN pg_roles/.test(text)) { const x = st.dbs.get(params[0]); return { rows: x ? [{ rolname: st.ownerOverride || x.owner }] : [] }; }
      if (/FROM catalog_test_meta\.run_marker WHERE nonce/.test(text)) { const x = st.dbs.get(config.database); return { rows: [{ db: config.database, n: x && x.markers.has(params[0]) && !st.markerLost ? 1 : 0 }] }; }
      if ((m = /^DROP DATABASE "([a-z0-9_]+)"/.exec(text))) { st.dbs.delete(m[1]); return { rows: [] }; }
      if (/count\(\*\)::int AS n FROM pg_database/.test(text)) return { rows: [{ n: st.dbs.has(params[0]) ? 1 : 0 }] };
      return { rows: [] };
    },
  });
  return { st, factory };
}
const drops = (st) => st.queries.filter((q) => /^DROP /.test(q.text));

test('validateAdminTarget acepta solo el descriptor aprobado', () => {
  const v = db.validateAdminTarget({ env: env() });
  assert.equal(v.host, D.host); assert.equal(v.port, D.port);
  const bad = {
    'sin URL': [{ CATALOG_TEST_ADMIN_URL: undefined }, 'CATALOG_TEST_URL_MISSING'],
    localhost: [{ CATALOG_TEST_ADMIN_URL: `postgres://${D.admin_role}:pw@localhost:${D.port}/${D.admin_database}` }, 'CATALOG_TEST_URL_NOT_ALLOWLISTED'],
    'túnel 127.0.0.1': [{ CATALOG_TEST_ADMIN_URL: `postgres://${D.admin_role}:pw@127.0.0.1:${D.port}/${D.admin_database}` }, 'CATALOG_TEST_URL_NOT_ALLOWLISTED'],
    puerto: [{ CATALOG_TEST_ADMIN_URL: `postgres://${D.admin_role}:pw@${D.host}:5433/${D.admin_database}` }, 'CATALOG_TEST_URL_NOT_ALLOWLISTED'],
    rol: [{ CATALOG_TEST_ADMIN_URL: `postgres://postgres:pw@${D.host}:${D.port}/${D.admin_database}` }, 'CATALOG_TEST_URL_NOT_ALLOWLISTED'],
    base: [{ CATALOG_TEST_ADMIN_URL: `postgres://${D.admin_role}:pw@${D.host}:${D.port}/beatgaler` }, 'CATALOG_TEST_URL_NOT_ALLOWLISTED'],
    params: [{ CATALOG_TEST_ADMIN_URL: `${URL_OK}?host=/tmp` }, 'CATALOG_TEST_URL_NOT_ALLOWLISTED'],
    protocolo: [{ CATALOG_TEST_ADMIN_URL: `mysql://${D.admin_role}:pw@${D.host}:${D.port}/${D.admin_database}` }, 'CATALOG_TEST_URL_NOT_ALLOWLISTED'],
    'sin instance id': [{ CATALOG_TEST_INSTANCE_ID: undefined }, 'CATALOG_TEST_INSTANCE_ID_MISSING'],
    'instance id libre': [{ CATALOG_TEST_INSTANCE_ID: 'mi-db-local' }, 'CATALOG_TEST_INSTANCE_ID_INVALID'],
    'DATABASE_URL heredado': [{ DATABASE_URL: 'postgres://x' }, 'CATALOG_TEST_ENV_CONTAMINATED'],
    'RESTORE_DATABASE_URL heredado': [{ RESTORE_DATABASE_URL: 'postgres://x' }, 'CATALOG_TEST_ENV_CONTAMINATED'],
    'PGHOST heredado': [{ PGHOST: 'prod' }, 'CATALOG_TEST_ENV_CONTAMINATED'],
  };
  for (const [name, [extra, code]] of Object.entries(bad)) {
    const e = env(extra); for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    assert.throws(() => db.validateAdminTarget({ env: e }), (err) => err.code === code, name);
  }
});

test('sin conexión antes de validar destino', async () => {
  const { st, factory } = fakeInstance();
  await assert.rejects(db.createCatalogTestDb({ env: env({ CATALOG_TEST_ADMIN_URL: URL_OK.replace(D.host, 'prod-db.example') }), clientFactory: factory }), { code: 'CATALOG_TEST_URL_NOT_ALLOWLISTED' });
  await assert.rejects(db.createCatalogTestDb({ env: env({ DATABASE_URL: 'postgres://x' }), clientFactory: factory }), { code: 'CATALOG_TEST_ENV_CONTAMINATED' });
  assert.equal(st.connects, 0);
});

test('identidad de instancia distinta => rechazo sin crear nada', async () => {
  for (const over of [{ sentinel: `gha-9-9-${'b'.repeat(32)}` }, { version: 180001 }, { coll: 'C' }]) {
    const { st, factory } = fakeInstance(over);
    await assert.rejects(db.createCatalogTestDb({ env: env(), clientFactory: factory }), { code: 'CATALOG_TEST_INSTANCE_MISMATCH' });
    assert.equal(st.queries.filter((q) => /^CREATE /.test(q.text)).length, 0, JSON.stringify(over));
  }
});

test('crea DB/rol nuevos con prefijo y marcador; cleanup borra solo esa DB', async () => {
  const { st, factory } = fakeInstance();
  const h = await db.createCatalogTestDb({ env: env(), clientFactory: factory });
  assert.match(h.name, /^beatgaler_catalog_test_[0-9a-f]{16}$/);
  assert.match(h.role, /^catalog_test_[0-9a-f]{16}$/);
  assert.equal(h.config.user, h.role);
  assert.ok(st.dbs.get(h.name).markers.has(h.nonce));
  const r = await h.cleanup();
  assert.equal(r.dropped, h.name);
  assert.deepEqual(drops(st).map((q) => q.text), [`DROP DATABASE "${h.name}" WITH (FORCE)`, `DROP ROLE "${h.role}"`]);
  await assert.rejects(h.cleanup(), { code: 'CATALOG_TEST_DB_CLEANUP_REFUSED' }, 'doble cleanup');
});

test('cleanup de DB ajena o con verificación fallida se rechaza sin DROP', async () => {
  const { st, factory } = fakeInstance();
  st.dbs.set('beatgaler_catalog_test_ffffffffffffffff', { owner: 'catalog_test_ffffffffffffffff', markers: new Set(['n']) });
  await assert.rejects(db.cleanupCatalogTestDb({ name: 'beatgaler_catalog_test_ffffffffffffffff', role: 'catalog_test_ffffffffffffffff', nonce: 'n' }), { code: 'CATALOG_TEST_DB_CLEANUP_REFUSED' });
  await assert.rejects(db.cleanupCatalogTestDb({ name: 'beatgaler', role: 'postgres', nonce: 'x' }), { code: 'CATALOG_TEST_DB_CLEANUP_REFUSED' });
  const connectsBefore = st.connects;
  assert.equal(drops(st).length, 0); assert.equal(st.connects, connectsBefore);

  const cases = [['system_identifier', (s) => { s.sysid = '7999'; }], ['owner', (s) => { s.ownerOverride = 'postgres'; }], ['marcador', (s) => { s.markerLost = true; }], ['sentinel', (s) => { s.sentinel = `gha-2-2-${'c'.repeat(32)}`; }]];
  for (const [label, mutate] of cases) {
    const inst = fakeInstance();
    const h = await db.createCatalogTestDb({ env: env(), clientFactory: inst.factory });
    mutate(inst.st);
    await assert.rejects(h.cleanup(), (e) => ['CATALOG_TEST_DB_CLEANUP_REFUSED', 'CATALOG_TEST_INSTANCE_MISMATCH'].includes(e.code), label);
    assert.equal(drops(inst.st).length, 0, label);
  }
});

test('instrumentPool cuenta clientes y transacciones por operación', async () => {
  const fakePool = { async connect() { return { async query() { return { rows: [] }; }, release() {} }; } };
  const ip = db.instrumentPool(fakePool);
  await ip.operation('patch', async () => {
    const c = await ip.pool.connect();
    await c.query('BEGIN'); await c.query('SELECT 1'); await c.query('COMMIT'); c.release(); c.release();
  });
  await ip.operation('trash', async () => { const c = await ip.pool.connect(); await c.query('begin'); await c.query('ROLLBACK'); });
  const s = ip.stats();
  assert.equal(s.acquired, 2); assert.equal(s.released, 1); assert.equal(s.open, 1);
  assert.deepEqual([s.begin, s.commit, s.rollback], [2, 1, 1]);
  assert.deepEqual(s.byOperation.patch, { acquired: 1, queries: 3, begin: 1, commit: 1, released: 1 });
  assert.equal(s.byOperation.trash.released, undefined, 'fuga de cliente visible por operación');
});
