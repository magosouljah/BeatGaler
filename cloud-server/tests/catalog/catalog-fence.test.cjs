'use strict';
// T16 — Unidad: capa 2 de sesión (matriz pura + guard con pool falso), guarda de compatibilidad hacia delante (schema_migrations con
// versiones desconocidas → no arranca), bootstrap que invoca la guarda, montaje completo del router con todos los módulos (T06–T15) y
// el handler real de session/start (vm) con el guard rechazando/aceptando. Sin DB ni Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const express = require(path.join(__dirname, '..', '..', 'node_modules', 'express'));
const guard = require('../../catalog/session-guard.js');
const { CATALOG_SESSION_PROTOCOL } = require('../../catalog/authority.js');
const mig = require('../../postgres-migrations.js');
const { startPostgresControlPlane } = require('../../postgres-bootstrap.js');
const { createCatalogRouter } = require('../../catalog/routes.js');
const { respondLegacyFence, CatalogLegacyFenceError } = require('../../catalog/legacy-fence.js');

test('evaluateSessionProtocol: sin catálogo → LEGACY; con catálogo y flag apagado → FLAG_OFF (capa 1 decide); flag encendido exige catalog-v1 (cualquier otro → REJECT)', () => {
  assert.deepEqual(guard.evaluateSessionProtocol({ hasCatalog: false, nativeEnabled: true, protocol: null }), { outcome: 'LEGACY', catalog: false });
  assert.deepEqual(guard.evaluateSessionProtocol({ hasCatalog: true, nativeEnabled: false, protocol: null }), { outcome: 'FLAG_OFF', catalog: true });
  assert.deepEqual(guard.evaluateSessionProtocol({ hasCatalog: true, nativeEnabled: true, protocol: CATALOG_SESSION_PROTOCOL }), { outcome: 'CATALOG', catalog: true });
  for (const p of [null, '', 'direct-v4', 'catalog-v0', ' catalog-v1x']) assert.deepEqual(guard.evaluateSessionProtocol({ hasCatalog: true, nativeEnabled: true, protocol: p }), { outcome: 'REJECT', catalog: true, required: CATALOG_SESSION_PROTOCOL, declared: p && p.trim() ? p.trim() : null });
});

test('createCatalogSessionGuard: consulta la fila por usuario; 410 LEGACY_CLIENT_UNSUPPORTED (by protocol) solo para dueños nativos con flag encendido; la respuesta catalog-v1 lleva era/época y nunca credenciales', async () => {
  const libs = new Map([['native', { authority: 'POSTGRES', era: 'e1', epoch: '7', migration_state: 'IDLE' }]]);
  const pool = { async query(sql, params) { assert.match(sql, /catalog-session-guard/); const row = libs.get(params[0]); return { rows: row ? [row] : [] }; } };
  const on = guard.createCatalogSessionGuard({ pool, authority: { config: { nativeEnabled: true } } });
  const off = guard.createCatalogSessionGuard({ pool, authority: { config: { nativeEnabled: false } } });
  assert.deepEqual(await on.assertProtocol({ userId: 'legacy-user', protocol: null }), { catalog: false, outcome: 'LEGACY' });
  await assert.rejects(on.assertProtocol({ userId: 'native', protocol: null }), (e) => e instanceof CatalogLegacyFenceError && e.status === 410 && e.detail.by === 'protocol' && e.detail.required === CATALOG_SESSION_PROTOCOL);
  await assert.rejects(on.assertProtocol({ userId: 'native', protocol: 'direct-v4' }), (e) => e.code === 'LEGACY_CLIENT_UNSUPPORTED' && e.detail.declared === 'direct-v4');
  const ok = await on.assertProtocol({ userId: 'native', protocol: CATALOG_SESSION_PROTOCOL });
  assert.deepEqual(ok, { catalog: true, outcome: 'CATALOG', protocol: CATALOG_SESSION_PROTOCOL, authority: 'POSTGRES', authority_era: 'e1', authority_epoch: '7', migration_state: 'IDLE' });
  assert.ok(!/token|api_id|api_hash/i.test(JSON.stringify(ok)));
  assert.deepEqual((await off.assertProtocol({ userId: 'native', protocol: null })).outcome, 'FLAG_OFF', 'interruptor no destructivo: con el flag apagado la capa 2 no rechaza (la capa 1 cerca cada entrada C10)');
  assert.deepEqual(await guard.assertCatalogSessionProtocolIfConfigured({ userId: 'native' }), { catalog: false, outcome: 'UNCONFIGURED' });
  guard.configureCatalogSessionGuard({ pool, authority: { config: { nativeEnabled: true } } });
  await assert.rejects(guard.assertCatalogSessionProtocolIfConfigured({ userId: 'native', protocol: null }), (e) => e.status === 410);
  guard.configureCatalogSessionGuard(null);
});

test('guarda hacia delante: versiones conocidas → ok; una versión desconocida en schema_migrations → CATALOG_SCHEMA_AHEAD; el bootstrap la invoca tras aplicar y cierra el pool al fallar', async () => {
  const known = mig.listMigrations();
  const okPool = { async query() { return { rows: known.map((m) => ({ version: m.version })) }; } };
  assert.deepEqual(await mig.assertKnownMigrations(okPool), { known: known.length, applied: known.length, unknown: [] });
  const aheadPool = { async query() { return { rows: [...known.map((m) => ({ version: m.version })), { version: '0099' }] }; } };
  await assert.rejects(mig.assertKnownMigrations(aheadPool), (e) => e.code === 'CATALOG_SCHEMA_AHEAD' && e.unknown[0] === '0099');
  // bootstrap con pool falso: apply → guard (rechaza) → onMigrationError + pool.end
  let ended = 0; let errors = 0;
  class FakePool { constructor() { this.query = async () => ({ rows: [{ version: '0099' }] }); } async end() { ended++; } }
  const env = { BEATGALER_POSTGRES_ENABLED: 'true', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' };
  await assert.rejects(startPostgresControlPlane({ env, PoolCtor: FakePool, apply: async () => ({ applied: [], skipped: [] }), onMigrationError: () => { errors++; } }), (e) => e.code === 'CATALOG_SCHEMA_AHEAD');
  assert.deepEqual([ended, errors], [1, 1]);
  const okStart = await startPostgresControlPlane({ env, PoolCtor: class { constructor() { this.query = async () => ({ rows: [] }); } async end() {} }, apply: async () => ({ applied: ['0001'], skipped: [] }) });
  assert.deepEqual(okStart.migrations, { applied: ['0001'], skipped: [] });
});

// ---------- router con todos los módulos (T06–T15) montados ----------
function listen(router) { const app = express(); app.use(express.json()); app.use(router); return new Promise((resolve) => { const server = http.createServer(app); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); }); }
function raw(port, method, p, { headers = {}, body = null } = {}) { return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null })); }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); }); }
const anyAsync = () => new Proxy({}, { get: () => async () => ({}) });

test('montaje completo: con operations+transport+playback+media+purge inyectados, las rutas T09/T12/T14/T15 responden (no 501); sin autoridad → 503 NOT_MOUNTED en todo /catalog/v1', async () => {
  const calls = [];
  const router = createCatalogRouter({
    authority: {}, queries: {}, commands: anyAsync(),
    operations: { async createOperation(a) { calls.push('transfer'); return { operationId: 'top-1', created: true }; }, async getOperation() { return { operationId: 'top-1' }; } },
    transport: { async issueUploadCapability() { calls.push('capability'); return { token: 'T'.repeat(43) }; }, async uploadPart() { return { status: 200, body: {} }; }, async uploadProjectPart() { return { status: 200, body: {} }; }, async listAttempts() { return { attempts: [] }; } },
    playback: { async startRound() { calls.push('round'); return { roundId: 'rnd-1' }; }, async nextInRound() { return {}; }, async consumeInRound() { return {}; }, async rebuildRound() { return {}; }, async releaseRound() { return {}; }, async getRound() { return {}; }, async neighbor() { return {}; } },
    media: { async issueAccess() { calls.push('access'); return { parts: [] }; }, async stream() {} },
    purge: { async requestPurge() { calls.push('purge'); return { operationId: 'op-purge-1', created: true, status: 'ENUMERATING' }; }, async getPurge() { return {}; }, async cancelPurge() { return {}; }, async releaseRestoreHold() { return { restoreHold: false }; } },
    authenticate: () => ({ id: 'u1' }),
  });
  const { server, port } = await listen(router);
  try {
    const W = { 'idempotency-key': 'k', 'x-catalog-era': 'e', 'x-catalog-epoch': '1', 'content-type': 'application/json' };
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations', { headers: W, body: { kind: 'IMPORT' } })).status, 201);
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/capability', { headers: W })).status, 201);
    assert.equal((await raw(port, 'POST', '/catalog/v1/playback/rounds', { headers: W, body: { setId: 's' } })).status, 201);
    assert.equal((await raw(port, 'POST', '/catalog/v1/files/f-1/access', { headers: W })).status, 201);
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations', { headers: W, body: { kind: 'PURGE' } })).status, 202);
    assert.equal((await raw(port, 'POST', '/catalog/v1/library/restore-hold/release', { headers: W })).status, 200);
    assert.deepEqual(calls, ['transfer', 'capability', 'round', 'access', 'purge']);
  } finally { server.close(); }
  const off = createCatalogRouter({ authority: null, queries: null, authenticate: () => ({ id: 'u1' }) });
  const s2 = await listen(off);
  try { const r = await raw(s2.port, 'GET', '/catalog/v1/context'); assert.deepEqual([r.status, r.body.code, r.body.detail.reason], [503, 'CATALOG_UNAVAILABLE', 'NOT_MOUNTED']); } finally { s2.server.close(); }
});

// ---------- handler real de session/start (vm) con la capa 2 ----------
test('session/start real: dueño nativo sin catalog-v1 → 410 antes de migrateLegacyProjects/startSession; con catalog-v1 → sesión con bloque catalog{era,epoch} y sin credenciales; usuario legacy → como hoy', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server-core.js'), 'utf8');
  const a = source.indexOf('app.post("/transport/session/start",'); const b = source.indexOf('app.post("/transport/session/activate",', a);
  const routeSource = source.slice(a, b);
  async function run({ guardResult, protocol }) {
    const calls = { migrate: 0, start: 0, outcomes: [] }; let handler;
    const context = {
      app: { post(_r, cb) { handler = cb; } }, criticalPathTrace: { write() {}, step(_q, _s, op) { return op(); } },
      authenticatedTransportAccount() { return { beatgalerUserId: 'inst', user: { id: 'u1' }, account: { beatgalerAccountId: 'acc' } }; },
      storageChatId() { return '-100123'; }, createDirectStartupTrace() { return { mark() {}, publish(_r, o) { calls.outcomes.push(o); } }; },
      libraryIndexPublication: { async migrateLegacyProjects() { calls.migrate++; } },
      directTransport: { async startSession(input) { calls.start++; return { session_id: 's1', protocol: input.protocol, bot_token: input.protocol === CATALOG_SESSION_PROTOCOL ? undefined : 'x' }; } },
      vaultIndexPointers: { async getForChat() { return null; } }, wrapWebTransportSession(s) { return s; }, respondLegacyFence,
      assertCatalogSessionProtocolIfConfigured: async () => { if (guardResult instanceof Error) throw guardResult; return guardResult; },
      console: { warn() {}, error() {} },
    };
    vm.runInNewContext(routeSource, context, { filename: 'server-core.js' });
    const res = { statusCode: 200, locals: {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
    await handler({ body: { protocol } }, res);
    return { calls, res };
  }
  const rejected = await run({ guardResult: new CatalogLegacyFenceError('session/start requires protocol catalog-v1', { entry: 'session/start', by: 'protocol' }), protocol: null });
  assert.deepEqual([rejected.res.statusCode, rejected.res.payload.code, rejected.calls.migrate, rejected.calls.start, rejected.calls.outcomes], [410, 'LEGACY_CLIENT_UNSUPPORTED', 0, 0, ['legacy_fenced']], 'rechazo antes de cualquier efecto Direct/legacy');
  const accepted = await run({ guardResult: { catalog: true, outcome: 'CATALOG', protocol: CATALOG_SESSION_PROTOCOL, authority_era: 'e1', authority_epoch: '7' }, protocol: CATALOG_SESSION_PROTOCOL });
  assert.equal(accepted.res.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(accepted.res.payload.catalog)), { protocol: CATALOG_SESSION_PROTOCOL, authority_era: 'e1', authority_epoch: '7' }); // objeto del realm vm: comparar por valor
  assert.equal(accepted.res.payload.bot_token, undefined); assert.equal(accepted.calls.start, 1);
  const legacy = await run({ guardResult: { catalog: false, outcome: 'LEGACY' }, protocol: null });
  assert.deepEqual([legacy.res.statusCode, legacy.res.payload.catalog, legacy.calls.migrate, legacy.calls.start], [200, undefined, 1, 1]);
});
