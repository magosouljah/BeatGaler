'use strict';
// T02 — DB efímera de pruebas del catálogo, con guardas antes de conectar y antes de borrar.
// Reglas (TAREAS T02 §3–4, §6):
//  - Solo se acepta CATALOG_TEST_ADMIN_URL cuyo host/puerto/rol/base coinciden con el descriptor aprobado,
//    y CATALOG_TEST_INSTANCE_ID con el formato del descriptor. Se valida sin abrir conexión.
//  - Tras conectar se verifica la identidad: versión mayor, encoding, collation, current_user y sentinel
//    instance_id de la instancia (no basta localhost/nombre).
//  - Se crea DB nueva beatgaler_catalog_test_<hex>, rol nuevo y marcador aleatorio.
//  - cleanup solo borra una DB creada por este proceso y re-verificada (system_identifier, sentinel,
//    nombre, owner y marcador). Cualquier discrepancia => CATALOG_TEST_DB_CLEANUP_REFUSED, sin borrar nada.
//  - Entorno contaminado (DATABASE_URL, RESTORE_DATABASE_URL, PG*) => rechazo.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DESCRIPTOR_FILE = path.join(__dirname, 'catalog-test-descriptor.json');
const CONTAMINATION = /^(DATABASE_URL|RESTORE_DATABASE_URL|PG[A-Z]*)$/;
const created = new Map(); // name -> handle interno (solo este proceso)

class CatalogTestDbError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
const fail = (code, msg) => { throw new CatalogTestDbError(code, msg); };

function loadDescriptor(file = DESCRIPTOR_FILE) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (d.schema !== 'beatgaler.catalog-test-descriptor' || !d.host || !d.port || !d.admin_role || !d.admin_database) fail('CATALOG_TEST_DESCRIPTOR_INVALID', 'descriptor incompleto');
  return d;
}

function assertCleanEnv(env) {
  const bad = Object.keys(env).filter((k) => CONTAMINATION.test(k));
  if (bad.length) fail('CATALOG_TEST_ENV_CONTAMINATED', `variables no permitidas presentes: ${bad.sort().join(', ')}`);
}

// Pura: no conecta. Devuelve destino validado.
function validateAdminTarget({ env = process.env, descriptor = loadDescriptor() } = {}) {
  assertCleanEnv(env);
  const raw = env.CATALOG_TEST_ADMIN_URL;
  if (!raw) fail('CATALOG_TEST_URL_MISSING', 'CATALOG_TEST_ADMIN_URL ausente');
  let u;
  try { u = new URL(raw); } catch { fail('CATALOG_TEST_URL_INVALID', 'URL no parseable'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) fail('CATALOG_TEST_URL_NOT_ALLOWLISTED', 'protocolo');
  const port = Number(u.port || 5432);
  const user = decodeURIComponent(u.username);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const mismatch = [];
  if (u.hostname.toLowerCase() !== String(descriptor.host).toLowerCase()) mismatch.push('host');
  if (port !== Number(descriptor.port)) mismatch.push('port');
  if (user !== descriptor.admin_role) mismatch.push('role');
  if (db !== descriptor.admin_database) mismatch.push('database');
  if ([...u.searchParams.keys()].some((k) => !['sslmode'].includes(k))) mismatch.push('params');
  if (mismatch.length) fail('CATALOG_TEST_URL_NOT_ALLOWLISTED', `no coincide con descriptor ${descriptor.id}: ${mismatch.join(',')}`);
  const instanceId = env[descriptor.sentinel.instance_id_env];
  if (!instanceId) fail('CATALOG_TEST_INSTANCE_ID_MISSING', `${descriptor.sentinel.instance_id_env} ausente`);
  if (!new RegExp(descriptor.sentinel.instance_id_pattern).test(instanceId)) fail('CATALOG_TEST_INSTANCE_ID_INVALID', 'formato no permitido');
  return Object.freeze({ host: u.hostname, port, user, database: db, password: decodeURIComponent(u.password), instanceId, descriptor });
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = (s) => { if (!IDENT.test(s)) fail('CATALOG_TEST_IDENT_INVALID', 'identificador inválido'); return `"${s}"`; };

function defaultClientFactory(config) {
  const { Client } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
  return new Client(config);
}

async function withClient(factory, config, fn) {
  const c = factory(config);
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

async function verifyIdentity(c, target) {
  const d = target.descriptor;
  const r = await c.query(`SELECT current_user AS u, current_database() AS db, current_setting('server_version_num')::int AS v,
    current_setting('server_encoding') AS enc, (SELECT datcollate FROM pg_database WHERE datname=current_database()) AS coll,
    (SELECT system_identifier::text FROM pg_control_system()) AS sysid`);
  const row = r.rows[0] || {};
  const bad = [];
  if (row.u !== d.admin_role) bad.push('current_user');
  if (row.db !== d.admin_database) bad.push('current_database');
  if (Math.floor(Number(row.v) / 10000) !== Number(d.server_version_major)) bad.push('server_version');
  if (row.enc !== d.server_encoding) bad.push('encoding');
  if (row.coll !== d.datcollate) bad.push('collation');
  const [schema, table] = d.sentinel.table.split('.');
  const s = await c.query(`SELECT ${ident(d.sentinel.column)} AS id FROM ${ident(schema)}.${ident(table)}`);
  if (s.rows.length !== 1 || s.rows[0].id !== target.instanceId) bad.push('sentinel');
  if (!row.sysid) bad.push('system_identifier');
  if (bad.length) fail('CATALOG_TEST_INSTANCE_MISMATCH', `identidad no verificada: ${bad.join(',')}`);
  return { systemIdentifier: row.sysid };
}

async function createCatalogTestDb({ env = process.env, descriptor, clientFactory = defaultClientFactory, random = crypto.randomBytes } = {}) {
  const target = validateAdminTarget({ env, descriptor: descriptor || loadDescriptor() }); // antes de cualquier conexión
  const d = target.descriptor;
  const admin = { host: target.host, port: target.port, user: target.user, password: target.password, database: target.database };
  const hex = random(8).toString('hex');
  const name = `${d.test_database_prefix}${hex}`;
  const role = `${d.test_role_prefix}${hex}`;
  const password = random(24).toString('hex');
  const nonce = random(16).toString('hex');
  const ident0 = await withClient(clientFactory, admin, async (c) => {
    const id = await verifyIdentity(c, target);
    await c.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await c.query(`CREATE DATABASE ${ident(name)} OWNER ${ident(role)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE '${d.datcollate}' LC_CTYPE '${d.datcollate}'`);
    return id;
  });
  await withClient(clientFactory, { ...admin, database: name }, async (c) => {
    await c.query(`CREATE SCHEMA catalog_test_meta AUTHORIZATION ${ident(role)}`);
    await c.query('CREATE TABLE catalog_test_meta.run_marker(nonce text PRIMARY KEY, run_id text, created_at timestamptz NOT NULL DEFAULT now())');
    await c.query('INSERT INTO catalog_test_meta.run_marker(nonce, run_id) VALUES($1,$2)', [nonce, String(env.CATALOG_CHECK_RUN_ID || 'adhoc')]);
  });
  const internal = { name, role, nonce, systemIdentifier: ident0.systemIdentifier, target, admin, clientFactory, cleaned: false };
  created.set(name, internal);
  return Object.freeze({
    name, role, nonce,
    config: Object.freeze({ host: target.host, port: target.port, user: role, password, database: name }),
    cleanup: () => cleanupCatalogTestDb({ name, role, nonce }),
  });
}

async function cleanupCatalogTestDb(handle) {
  const h = handle && created.get(handle.name);
  if (!h || h.role !== handle.role || h.nonce !== handle.nonce) fail('CATALOG_TEST_DB_CLEANUP_REFUSED', 'la DB no fue creada por este proceso');
  if (h.cleaned) fail('CATALOG_TEST_DB_CLEANUP_REFUSED', 'cleanup ya realizado');
  const d = h.target.descriptor;
  if (!h.name.startsWith(d.test_database_prefix) || !IDENT.test(h.name)) fail('CATALOG_TEST_DB_CLEANUP_REFUSED', 'nombre fuera de alcance');
  // 1) misma instancia
  await withClient(h.clientFactory, h.admin, async (c) => {
    const id = await verifyIdentity(c, h.target);
    if (id.systemIdentifier !== h.systemIdentifier) fail('CATALOG_TEST_DB_CLEANUP_REFUSED', 'system_identifier distinto');
    const own = await c.query('SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1', [h.name]);
    if (own.rows.length !== 1 || own.rows[0].rolname !== h.role) fail('CATALOG_TEST_DB_CLEANUP_REFUSED', 'owner no coincide');
  });
  // 2) marcador dentro de la DB
  await withClient(h.clientFactory, { ...h.admin, database: h.name }, async (c) => {
    const r = await c.query('SELECT current_database() AS db, (SELECT count(*)::int FROM catalog_test_meta.run_marker WHERE nonce=$1) AS n', [h.nonce]);
    if (r.rows[0]?.db !== h.name || r.rows[0]?.n !== 1) fail('CATALOG_TEST_DB_CLEANUP_REFUSED', 'marcador no coincide');
  });
  // 3) borrar solo lo verificado
  await withClient(h.clientFactory, h.admin, async (c) => {
    await c.query(`DROP DATABASE ${ident(h.name)} WITH (FORCE)`);
    await c.query(`DROP ROLE ${ident(h.role)}`);
    const left = await c.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [h.name]);
    if (left.rows[0].n !== 0) fail('CATALOG_TEST_DB_CLEANUP_INCOMPLETE', 'la DB sigue existiendo');
  });
  h.cleaned = true;
  created.delete(h.name);
  return { dropped: h.name };
}

// Instrumentación de cliente/transacción por operación (TAREAS T02 §5).
function instrumentPool(pool) {
  const stats = { acquired: 0, released: 0, begin: 0, commit: 0, rollback: 0, queries: 0, byOperation: {} };
  let current = null;
  const bump = (k) => { stats[k]++; if (current) current[k] = (current[k] || 0) + 1; };
  const origConnect = pool.connect.bind(pool);
  pool.connect = async (...a) => {
    const client = await origConnect(...a); bump('acquired');
    const origRelease = client.release.bind(client); let released = false;
    client.release = (...r) => { if (!released) { released = true; bump('released'); } return origRelease(...r); };
    const origQuery = client.query.bind(client);
    client.query = (text, ...rest) => {
      bump('queries');
      const t = typeof text === 'string' ? text.trim().toUpperCase() : '';
      if (/^BEGIN\b/.test(t)) bump('begin'); else if (/^COMMIT\b/.test(t)) bump('commit'); else if (/^ROLLBACK\b/.test(t)) bump('rollback');
      return origQuery(text, ...rest);
    };
    return client;
  };
  return {
    pool,
    stats: () => JSON.parse(JSON.stringify({ ...stats, open: stats.acquired - stats.released })),
    async operation(name, fn) {
      const prev = current; current = stats.byOperation[name] = stats.byOperation[name] || {};
      try { return await fn(); } finally { current = prev; }
    },
  };
}

module.exports = { CatalogTestDbError, loadDescriptor, assertCleanEnv, validateAdminTarget, createCatalogTestDb, cleanupCatalogTestDb, instrumentPool, DESCRIPTOR_FILE };
