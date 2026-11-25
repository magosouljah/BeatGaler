'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const express = require('express');
const { CatalogAuthorityError } = require('../catalog/authority');
const { configureCatalogBoot, mountCatalog, assertVaultRebindAllowedIfConfigured } = require('../catalog-boot');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

const authenticate = (req, res) => {
  if (req.get('authorization') === 'Bearer fixture') return { id: 'catalog-user' };
  res.status(401).json({ code: 'UNAUTHENTICATED' });
  return null;
};

async function mount(t) {
  const app = express();
  const guard = mountCatalog(app, authenticate);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const get = path => fetch(`http://127.0.0.1:${server.address().port}/catalog/v1/${path}`, {
    headers: { Authorization: 'Bearer fixture' },
  });
  return { get, guard };
}

test('el arranque real monta el router con los servicios ensamblados y autentica las rutas', async (t) => {
  const authority = { resolveContext: async ({ userId }) => ({ library_id: `library-${userId}` }) };
  const queries = {
    listBeats: async ({ userId, query }) => ({ items: [{ id: `${userId}-${query.limit}` }] }),
    createQuerySet: async ({ userId, query }) => ({ created: true, title: `${userId}-${query.title}` }),
  };
  await withCloud(async (_app, send) => {
    const prefix = '/catalog/v1';
    const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' };
    const anonymous = await send('GET', `${prefix}/context`, { headers: browser });
    assert.equal(anonymous.status, 401);
    const login = await send('POST', '/auth/login', {
      headers: browser,
      body: { email: account.email, password: account.password, beatgalerUserId: account.beatgalerUserId },
    });
    assert.equal(login.status, 200);
    const headers = {
      ...browser,
      cookie: login.headers['set-cookie'].map(cookie => cookie.split(';', 1)[0]).join('; '),
      'x-beatgaler-csrf': JSON.parse(login.data).csrf_token,
      'x-beatgaler-installation-id': account.beatgalerUserId,
    };
    const context = await send('GET', `${prefix}/context`, { headers });
    assert.equal(context.status, 200);
    assert.equal(context.headers['cache-control'], 'no-store');
    assert.equal(context.headers['access-control-allow-origin'], browser.origin);
    assert.equal(JSON.parse(context.data).library_id, `library-${account.id}`);

    const beats = await send('GET', `${prefix}/beats?limit=1`, { headers });
    assert.equal(beats.status, 200);
    assert.deepEqual(JSON.parse(beats.data), { items: [{ id: `${account.id}-1` }] });
    const set = await send('POST', `${prefix}/query-sets`, { headers, body: { query: { title: 'fixture' } } });
    assert.equal(set.status, 201);
    assert.deepEqual(JSON.parse(set.data), { created: true, title: `${account.id}-fixture` });
  }, {
    prepare() {
      const assembly = require('../catalog-assembly');
      const { assembleServerCatalog } = assembly;
      t.mock.method(assembly, 'assembleServerCatalog', async options => ({
        ...await assembleServerCatalog(options), authority, queries,
      }));
    },
  });
});

test('sin servicios, autoridad o consultas, conserva la respuesta 503', async (t) => {
  for (const services of [undefined, { queries: {} }, { authority: {} }]) {
    if (services) configureCatalogBoot(services);
    const { get } = await mount(t);
    const response = await get('context');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'catalog is unavailable (NOT_MOUNTED)', code: 'CATALOG_UNAVAILABLE', detail: { reason: 'NOT_MOUNTED' },
    });
  }
});

test('la guarda montada delega en la autoridad que recibió y propaga su rechazo', async (t) => {
  const input = { userId: 'catalog-user', currentChatId: '-1001' };
  const refusal = new CatalogAuthorityError('CATALOG_VAULT_REBIND_FORBIDDEN', 409, 'rebind');
  const authority = {
    async assertVaultRebindAllowed(received) {
      assert.equal(this, authority);
      assert.equal(received, input);
      throw refusal;
    },
  };
  configureCatalogBoot({ authority }, value => assertVaultRebindAllowedIfConfigured(authority, value));
  const mounted = await mount(t);
  const unconfigured = await mount(t);
  await assert.rejects(mounted.guard(input), error => error === refusal);
  assert.deepEqual(await unconfigured.guard(input), { native: false, configured: false });
});
