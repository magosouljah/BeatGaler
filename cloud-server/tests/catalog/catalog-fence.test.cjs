'use strict';
// T16 — Unidad: compatibilidad de schema_migrations, bootstrap y montaje del router. Sin DB ni Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const express = require(path.join(__dirname, '..', '..', 'node_modules', 'express'));
const mig = require('../../postgres-migrations.js');
const { startPostgresControlPlane } = require('../../postgres-bootstrap.js');
const { createCatalogRouter } = require('../../catalog/routes.js');

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

test('montaje completo: con operations+direct+playback+media+purge inyectados, las rutas T09/Direct B/T14/T15 responden (no 501); sin autoridad → 503 NOT_MOUNTED en todo /catalog/v1', async () => {
  const calls = [];
  const router = createCatalogRouter({
    authority: {}, queries: {}, commands: anyAsync(),
    operations: { async createOperation(a) { calls.push('transfer'); return { operationId: 'top-1', created: true }; }, async getOperation() { return { operationId: 'top-1' }; } },
    direct: { async issueSendTicket() { calls.push('ticket'); return { randomId: '-1' }; }, async listAttempts() { return { attempts: [] }; } },
    playback: { async startRound() { calls.push('round'); return { roundId: 'rnd-1' }; }, async nextInRound() { return {}; }, async consumeInRound() { return {}; }, async rebuildRound() { return {}; }, async releaseRound() { return {}; }, async getRound() { return {}; }, async neighbor() { return {}; } },
    media: { async issueAccess() { calls.push('access'); return { parts: [] }; } },
    purge: { async requestPurge() { calls.push('purge'); return { operationId: 'op-purge-1', created: true, status: 'ENUMERATING' }; }, async getPurge() { return {}; }, async cancelPurge() { return {}; }, async releaseRestoreHold() { return { restoreHold: false }; } },
    authenticate: () => ({ id: 'u1' }),
  });
  const { server, port } = await listen(router);
  try {
    const W = { 'idempotency-key': 'k', 'x-catalog-era': 'e', 'x-catalog-epoch': '1', 'content-type': 'application/json' };
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations', { headers: W, body: { kind: 'IMPORT' } })).status, 201);
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/send-ticket', { headers: W })).status, 201);
    assert.equal((await raw(port, 'POST', '/catalog/v1/playback/rounds', { headers: W, body: { setId: 's' } })).status, 201);
    assert.equal((await raw(port, 'POST', '/catalog/v1/files/f-1/access', { headers: W })).status, 201);
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations', { headers: W, body: { kind: 'PURGE' } })).status, 202);
    assert.equal((await raw(port, 'POST', '/catalog/v1/library/restore-hold/release', { headers: W })).status, 200);
    assert.deepEqual(calls, ['transfer', 'ticket', 'round', 'access', 'purge']);
  } finally { server.close(); }
  const off = createCatalogRouter({ authority: null, queries: null, authenticate: () => ({ id: 'u1' }) });
  const s2 = await listen(off);
  try { const r = await raw(s2.port, 'GET', '/catalog/v1/context'); assert.deepEqual([r.status, r.body.code, r.body.detail.reason], [503, 'CATALOG_UNAVAILABLE', 'NOT_MOUNTED']); } finally { s2.server.close(); }
});

