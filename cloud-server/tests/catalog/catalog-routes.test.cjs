'use strict';
// T06 — Rutas HTTP /catalog/v1 con autoridad y consultas falsas, servidor en 127.0.0.1 (política loopback). Sin DB ni Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const express = require(path.join(__dirname, '..', '..', 'node_modules', 'express'));
const { createCatalogRouter, API_LIMITS } = require('../../catalog/routes.js');
const { CatalogAuthorityError } = require('../../catalog/authority.js');
const { CatalogQueryError } = require('../../catalog/cursor.js');

function fakeOperations(calls) {
  const op = { operationId: 'top-1', kind: 'IMPORT', status: 'PREPARED', created: true, parts: [{ partKey: 'm0', dispatchState: 'PENDING' }] };
  return {
    async createOperation(a) { calls.push(['t-create', a]); if (a.intent.kind === 'PURGE') throw new CatalogQueryError('NOT_IMPLEMENTED', 501, 'T15', {}); return op; },
    async getOperation(a) { calls.push(['t-get', a]); return { ...op, status: 'VERIFYING' }; },
    async putReceipt(a) { calls.push(['t-receipt', a]); if (a.receipt.messageId === 2) throw new CatalogQueryError('RECEIPT_CONFLICT', 409, 'x', {}); return { ...op, status: 'VERIFYING' }; },
    async commitOperation(a) { calls.push(['t-commit', a]); return a.operationId === 'top-ready' ? { status: 200, operation: { ...op, status: 'COMMITTED' } } : { status: 202, operation: { ...op, pending: ['m0'] } }; },
    async cancelOperation(a) { calls.push(['t-cancel', a]); return { ...op, status: 'RECONCILE' }; },
    async renewReservation(a) { calls.push(['t-renew', a]); return { ...op, renewed: true }; },
    async readmitReservation(a) { calls.push(['t-readmit', a]); return { ...op, readmitted: true }; },
    async markDispatched(a) { calls.push(['t-dispatch', a]); return { operationId: a.operationId, partKey: a.partKey, randomId: '-42' }; },
  };
}

function fakeCommands(calls) {
  const sel = { selectionId: 'sel-1', status: 'ACTIVE', selectionVersion: '1', count: 3 };
  return {
    async patchBeat(a) { calls.push(['patch', a]); if (a.expectedVersion === '9') throw new CatalogQueryError('VERSION_CONFLICT', 409, 'v', { current_version: '2' }); return { noop: false, beat: { id: a.beatId, version: '2' }, revision: '3', operationId: 'op-1', replay: false }; },
    async trashBeats(a) { calls.push(['trash', a]); return { items: a.items, revision: '4', operationId: 'op-2', replay: false }; },
    async restoreBeats(a) { calls.push(['restore', a]); return { items: a.items, revision: '5', operationId: 'op-3', replay: false }; },
    async createSelection(a) { calls.push(['sel-create', a]); return { ...sel, created: true }; },
    async getSelection(a) { calls.push(['sel-get', a]); return { ...sel, flags: Object.fromEntries((a.beatIds || []).map((b) => [b, true])) }; },
    async applySelectionOp(a) { calls.push(['sel-op', a]); return { ...sel, selectionVersion: '2' }; },
    async releaseSelection(a) { calls.push(['sel-release', a]); return { ...sel, status: 'RELEASED' }; },
    async previewTagRename(a) { calls.push(['rename-preview', a]); return { from: a.from, to: a.to, countActive: 1, countTrash: 0 }; },
    async createOperation(a) { calls.push(['op-create', a]); return { operationId: 'op-9', kind: a.kind, status: 'QUEUED', created: true }; },
    async getOperation(a) { calls.push(['op-get', a]); return { operationId: a.operationId, status: 'RUNNING' }; },
    async cancelOperation(a) { calls.push(['op-cancel', a]); return { operationId: a.operationId, status: 'CANCELLING' }; },
    async resumeOperation(a) { calls.push(['op-resume', a]); return { operationId: a.operationId, status: 'RUNNING' }; },
    async listChanges(a) { calls.push(['changes', a]); return { events: [], next: a.query.after }; },
  };
}

const USERS = { 'tok-a': { id: 'ua' }, 'tok-b': { id: 'ub' } };
function authenticate(req, res) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const u = m && USERS[m[1]];
  if (!u) { res.status(401).json({ error: 'Session expired. Sign in again.' }); return null; }
  return u;
}
function fakeAuthority(calls) {
  return {
    async resolveContext({ userId }) { calls.push(['context', userId]); if (userId === 'ub') throw new CatalogAuthorityError('LIBRARY_NOT_PROVISIONED', 404, 'not provisioned', { provision: 'POST /catalog/v1/library/provision' }); return { authority: 'POSTGRES', user_id: userId, revision: '1' }; },
    async provisionLibrary({ userId }) { calls.push(['provision', userId]); return { created: userId === 'ub', context: { authority: 'POSTGRES', user_id: userId } }; },
    availability: async () => ({}),
  };
}
function fakeQueries(calls) {
  return {
    async listBeats({ userId, query }) { calls.push(['list', userId, query]); if (query.cursor === 'stale') throw new CatalogQueryError('CURSOR_STALE', 409, 'stale', { current_revision: '9' }); if (query.limit === '999') throw new CatalogQueryError('INPUT_INVALID', 400, 'bad', { reason: 'LIMIT' }); if (query.q === 'boom') throw new Error('unexpected'); return { items: [{ id: 'b1' }], startOrdinal: 0 }; },
    async getBeat({ userId, beatId }) { calls.push(['get', userId, beatId]); if (beatId === 'missing') throw new CatalogQueryError('NOT_FOUND', 404, 'no', {}); return { id: beatId, version: '3', etag: `W/"${beatId.length}-3"` }; },
    async listBeatFiles({ userId, beatId, query }) { calls.push(['files', userId, beatId, query]); return { items: [], nextAfter: null }; },
    async resolveLegacyNavigation({ userId, query }) { calls.push(['legacy', userId, query]); return { items: [], resolution: 'empty' }; },
    async listFacets({ userId, query }) { calls.push(['facets', userId, query]); return { items: [] }; },
    async activeFacets({ userId, keys }, scope) { calls.push(['active', userId, keys, scope]); return { items: [], missing: keys }; },
    async createQuerySet({ userId, query, consumer }) { calls.push(['qs-create', userId, query, consumer]); return { setId: 'qs-1', status: 'BUILDING', created: true }; },
    async getQuerySet({ userId, setId }) { calls.push(['qs-get', userId, setId]); return { setId, status: 'BUILDING' }; },
    async cancelQuerySet({ userId, setId }) { calls.push(['qs-cancel', userId, setId]); return { setId, status: 'CANCELLED' }; },
    async releaseQuerySet({ userId, setId }) { calls.push(['qs-release', userId, setId]); return { setId, status: 'RELEASED' }; },
  };
}
async function serve(router) {
  const app = express(); app.use(express.json({ limit: '256kb' })); app.use(router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = server.address().port;
  const call = async (method, p, { token = 'tok-a', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { call, port, close: () => new Promise((r) => server.close(r)) };
}

test('autenticación server-side, contexto, provision 201/200 y mapeo estable de errores; el tenant es el usuario autenticado, nunca la query', async () => {
  const calls = [];
  const s = await serve(createCatalogRouter({ authority: fakeAuthority(calls), queries: fakeQueries(calls), authenticate }));
  try {
    assert.equal((await s.call('GET', '/catalog/v1/context', { token: null })).status, 401);
    assert.equal((await s.call('GET', '/catalog/v1/beats', { token: 'nope' })).status, 401);
    const ctx = await s.call('GET', '/catalog/v1/context');
    assert.equal(ctx.status, 200); assert.equal(ctx.body.user_id, 'ua'); assert.deepEqual(ctx.body.limits, API_LIMITS); assert.equal(ctx.headers.get('cache-control'), 'no-store');
    const nf = await s.call('GET', '/catalog/v1/context', { token: 'tok-b' });
    assert.deepEqual([nf.status, nf.body.code, nf.body.detail.provision], [404, 'LIBRARY_NOT_PROVISIONED', 'POST /catalog/v1/library/provision']);
    assert.equal((await s.call('POST', '/catalog/v1/library/provision', { token: 'tok-b' })).status, 201);
    const again = await s.call('POST', '/catalog/v1/library/provision');
    assert.deepEqual([again.status, again.body.created], [200, false]);
    const list = await s.call('GET', '/catalog/v1/beats?sort=name&includeTag=a&includeTag=b&userId=ub&vaultId=vx');
    assert.equal(list.status, 200);
    const listCall = calls.find((c) => c[0] === 'list');
    assert.equal(listCall[1], 'ua', 'tenant del token, no de la query');
    assert.deepEqual(listCall[2].includeTag, ['a', 'b']);
    assert.deepEqual((await s.call('GET', '/catalog/v1/beats?cursor=stale')).status, 409);
    const bad = await s.call('GET', '/catalog/v1/beats?limit=999');
    assert.deepEqual([bad.status, bad.body.code, bad.body.detail.reason], [400, 'INPUT_INVALID', 'LIMIT']);
    const boom = await s.call('GET', '/catalog/v1/beats?q=boom');
    assert.deepEqual([boom.status, boom.body.code], [500, 'CATALOG_INTERNAL_ERROR'], 'error inesperado nunca es 200 ni lista vacía');
    const beat = await s.call('GET', '/catalog/v1/beats/b%2F1');
    assert.deepEqual([beat.status, beat.body.id, beat.headers.get('etag')], [200, 'b/1', 'W/"3-3"']);
    assert.equal((await s.call('GET', '/catalog/v1/beats/missing')).status, 404);
    assert.equal((await s.call('GET', '/catalog/v1/beats/b1/files?limit=5')).status, 200);
    assert.equal((await s.call('GET', '/catalog/v1/navigation/legacy?offset=240')).status, 200);
    assert.equal((await s.call('GET', '/catalog/v1/facets?scope=ACTIVE')).status, 200);
    const act = await s.call('GET', '/catalog/v1/facets/active?key=trap&key=dark&scope=TRASH');
    assert.equal(act.status, 200); assert.deepEqual(calls.find((c) => c[0] === 'active').slice(2), [['trap', 'dark'], 'TRASH']);
    const qs = await s.call('POST', '/catalog/v1/query-sets', { body: { query: { q: 'x' }, consumer: { id: 'c1', kind: 'SHUFFLE' } } });
    assert.deepEqual([qs.status, qs.body.setId], [201, 'qs-1']);
    assert.equal((await s.call('GET', '/catalog/v1/query-sets/qs-1')).status, 200);
    assert.equal((await s.call('POST', '/catalog/v1/query-sets/qs-1/cancel')).status, 200);
    assert.equal((await s.call('POST', '/catalog/v1/query-sets/qs-1/release')).status, 200);
    const ni = await s.call('PATCH', '/catalog/v1/beats/b1', { body: { name: 'x' } });
    assert.deepEqual([ni.status, ni.body.code], [501, 'NOT_IMPLEMENTED'], 'contrato T07 sin implementar: 501 explícito, nunca éxito ficticio');
    assert.equal((await s.call('POST', '/catalog/v1/operations')).status, 501);
    assert.ok(calls.every((c) => c[1] === 'ua' || c[1] === 'ub'));
  } finally { await s.close(); }
});

test('T07: rutas de escritura exigen Idempotency-Key + X-Catalog-Era + X-Catalog-Epoch (428), pasan cabeceras y cuerpo, mapean 409 y exponen ETag; kinds no implementados → 501', async () => {
  const calls = [];
  const s = await serve(createCatalogRouter({ authority: fakeAuthority(calls), queries: fakeQueries(calls), commands: fakeCommands(calls), authenticate }));
  const W = { 'idempotency-key': 'k-1', 'x-catalog-era': 'era-1', 'x-catalog-epoch': '1' };
  const E = { 'x-catalog-era': 'era-1', 'x-catalog-epoch': '1' };
  const callH = async (method, p, headers, body) => {
    const res = await fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { authorization: 'Bearer tok-a', 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  try {
    const missing = await callH('PATCH', '/catalog/v1/beats/b1', {}, { expectedVersion: '1', patch: { name: 'x' } });
    assert.deepEqual([missing.status, missing.body.code, missing.body.detail.missing], [428, 'PRECONDITION_REQUIRED', ['Idempotency-Key', 'X-Catalog-Era', 'X-Catalog-Epoch']]);
    assert.ok(!calls.some((c) => c[0] === 'patch'), 'sin cabeceras no se invoca el comando');
    const ok = await callH('PATCH', '/catalog/v1/beats/b1', { ...W, 'if-match': 'W/"2-1"' }, { expectedVersion: '1', patch: { name: 'x' } });
    assert.deepEqual([ok.status, ok.headers.get('etag'), ok.body.revision], [200, 'W/"2-2"', '3']);
    const p = calls.find((c) => c[0] === 'patch')[1];
    assert.deepEqual([p.userId, p.beatId, p.idempotencyKey, p.era, p.epoch, p.expectedVersion, p.ifMatch, p.patch], ['ua', 'b1', 'k-1', 'era-1', '1', '1', 'W/"2-1"', { name: 'x' }]);
    const conflict = await callH('PATCH', '/catalog/v1/beats/b1', W, { expectedVersion: '9', patch: { name: 'x' } });
    assert.deepEqual([conflict.status, conflict.body.code, conflict.body.detail.current_version], [409, 'VERSION_CONFLICT', '2']);
    assert.equal((await callH('POST', '/catalog/v1/beats/trash', W, { items: [{ beatId: 'b1', expectedVersion: '1' }] })).status, 200);
    assert.equal((await callH('POST', '/catalog/v1/beats/restore', W, { items: [{ beatId: 'b1', expectedVersion: '2' }] })).status, 200);
    assert.equal((await callH('POST', '/catalog/v1/selections', E, { setId: 'qs-1', sort: 'manual', defaultSelected: true, consumerId: 'tab' })).status, 201);
    assert.equal((await callH('POST', '/catalog/v1/selections', {}, { setId: 'qs-1' })).status, 428);
    const flags = await callH('GET', '/catalog/v1/selections/sel-1?beatId=a&beatId=b', {});
    assert.deepEqual([flags.status, flags.body.flags], [200, { a: true, b: true }]);
    assert.equal((await callH('POST', '/catalog/v1/selections/sel-1/ops', W, { selectionVersion: '1', op: { kind: 'CLEAR' } })).body.selectionVersion, '2');
    assert.equal((await callH('POST', '/catalog/v1/selections/sel-1/release', E)).body.status, 'RELEASED');
    assert.equal((await callH('POST', '/catalog/v1/tags/rename/preview', {}, { from: 'a', to: 'b' })).body.countActive, 1);
    assert.equal((await callH('POST', '/catalog/v1/tags/rename', W, { from: 'a', to: 'b' })).status, 201);
    const notImpl = await callH('POST', '/catalog/v1/operations', W, { kind: 'IMPORT' });
    assert.deepEqual([notImpl.status, notImpl.body.code], [501, 'NOT_IMPLEMENTED']);
    assert.equal((await callH('POST', '/catalog/v1/operations', W, { kind: 'BULK_TRASH', selectionId: 'sel-1', selectionVersion: '1' })).status, 201);
    assert.equal((await callH('GET', '/catalog/v1/operations/op-9?detailsAfter=1:b', {})).status, 200);
    assert.equal((await callH('POST', '/catalog/v1/operations/op-9/cancel', E)).body.status, 'CANCELLING');
    assert.equal((await callH('POST', '/catalog/v1/operations/op-9/resume', E, { revision: '4' })).body.status, 'RUNNING');
    assert.equal((await callH('GET', '/catalog/v1/changes?after=0', {})).status, 200);
    assert.ok(calls.filter((c) => c[1] && c[1].userId).every((c) => c[1].userId === 'ua'), 'tenant siempre del token');
  } finally { await s.close(); }
});

test('T09: operaciones de transferencia por prefijo top-, recibo PUT, commit 202/200, reserva renew/readmit, dispatch; PURGE → 501; cabeceras obligatorias', async () => {
  const calls = [];
  const s = await serve(createCatalogRouter({ authority: fakeAuthority(calls), queries: fakeQueries(calls), commands: fakeCommands(calls), operations: fakeOperations(calls), authenticate }));
  const W = { 'idempotency-key': 'k-9', 'x-catalog-era': 'era-1', 'x-catalog-epoch': '1' };
  const E = { 'x-catalog-era': 'era-1', 'x-catalog-epoch': '1' };
  const callH = async (method, p, headers, body) => {
    const res = await fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { authorization: 'Bearer tok-a', 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const created = await callH('POST', '/catalog/v1/operations', W, { kind: 'IMPORT', parts: [{ slotKey: 'MASTER', role: 'MASTER', size: 10 }], metadata: { name: 'x' } });
    assert.deepEqual([created.status, created.body.operationId], [201, 'top-1']);
    const tc = calls.find((c) => c[0] === 't-create')[1];
    assert.deepEqual([tc.userId, tc.idempotencyKey, tc.era, tc.epoch, tc.intent.kind], ['ua', 'k-9', 'era-1', '1', 'IMPORT']);
    assert.equal((await callH('POST', '/catalog/v1/operations', {}, { kind: 'IMPORT' })).status, 428);
    assert.deepEqual((await callH('POST', '/catalog/v1/operations', W, { kind: 'PURGE' })).status, 501);
    assert.deepEqual((await callH('POST', '/catalog/v1/operations', W, { kind: 'NOPE' })).body.code, 'INPUT_INVALID');
    assert.equal((await callH('GET', '/catalog/v1/operations/top-1', {})).body.status, 'VERIFYING');
    assert.equal((await callH('GET', '/catalog/v1/operations/op-9', {})).body.status, 'RUNNING', 'op- sigue en comandos bulk');
    const rc = await callH('PUT', '/catalog/v1/operations/top-1/parts/m0/receipt', E, { messageId: 1, size: 10 });
    assert.equal(rc.status, 200);
    assert.deepEqual([(await callH('PUT', '/catalog/v1/operations/top-1/parts/m0/receipt', E, { messageId: 2, size: 10 })).status, (await callH('PUT', '/catalog/v1/operations/top-1/parts/m0/receipt', {}, { messageId: 1, size: 10 })).status], [409, 428]);
    assert.equal((await callH('POST', '/catalog/v1/operations/top-1/commit', E)).status, 202);
    assert.equal((await callH('POST', '/catalog/v1/operations/top-ready/commit', E)).status, 200);
    assert.equal((await callH('POST', '/catalog/v1/operations/top-1/cancel', E)).body.status, 'RECONCILE');
    assert.equal((await callH('POST', '/catalog/v1/operations/op-9/cancel', E)).body.status, 'CANCELLING', 'cancel bulk intacto');
    assert.equal((await callH('POST', '/catalog/v1/operations/top-1/reservation/renew', E)).body.renewed, true);
    assert.equal((await callH('POST', '/catalog/v1/operations/top-1/reservation/readmit', E)).body.readmitted, true);
    assert.equal((await callH('POST', '/catalog/v1/operations/top-1/parts/m0/dispatch', E)).body.randomId, '-42');
    assert.ok(calls.filter((c) => c[1] && c[1].userId).every((c) => c[1].userId === 'ua'));
  } finally { await s.close(); }
});

test('sin autoridad montada toda la API responde 503 CATALOG_UNAVAILABLE; el módulo de rutas no carga transporte', async () => {
  const s = await serve(createCatalogRouter({ authority: null, queries: null, authenticate }));
  try {
    for (const p of ['/catalog/v1/context', '/catalog/v1/beats', '/catalog/v1/beats/x', '/catalog/v1/library/provision']) {
      const r = await s.call(p.endsWith('provision') ? 'POST' : 'GET', p);
      assert.deepEqual([r.status, r.body.code, r.body.detail.reason], [503, 'CATALOG_UNAVAILABLE', 'NOT_MOUNTED'], p);
    }
  } finally { await s.close(); }
  const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
  assert.ok(!loaded.some((k) => /direct-transport-control|telegram|master-storage|library-index-publication/.test(k)), 'rutas de catálogo sin transporte');
  assert.throws(() => createCatalogRouter({}), /authenticate/);
});
