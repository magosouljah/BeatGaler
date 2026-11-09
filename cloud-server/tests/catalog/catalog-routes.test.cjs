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
  const call = async (method, p, { token = 'tok-a', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
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
