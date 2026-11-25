'use strict';
// T25 (separada de catalog/catalog-contract.test.cjs en el cierre de fase 4): arranca el Cloud por loopback, así que la ejecuta
// run-cloud-tests y no la suite t03 de catalog-check (red denegada).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('T25: INDEX retirado del runtime — el Cloud arrancado no atiende rutas legacy de INDEX/transporte/bytes ni carga módulos INDEX', async () => {
  const { account, withCloud } = require('./helpers/composition-cloud.cjs');
  const root = path.join(__dirname, '..');
  const RETIRED = ['/transport/index/', '/transport/project/', '/transport/session/', '/transport/operation/', '/transport/quota/', '/transport/topic/',
    '/transport/trash/', '/transport/upload/', '/transport/routing/', '/library/upsert', '/library/get', '/library/artwork', '/library/move-to-trash-batch',
    '/library/cleanup-garbage', '/metadata/upsert', '/metadata/artwork', '/beats/upload', '/beats/download', '/beats/stream', '/beats/delete-topic',
    '/cloud-files/upload', '/projects/upload'];
  const MODULES = ['library-index-publication', 'vault-index-pointer-store', 'startup-routing-index', 'atomic-library-index', 'direct-index-pin-authority',
    'project-upload-route', 'project-upload-admission', 'project-upload-authority', 'library-beat-quota', 'library-trash-assets'];
  for (const m of MODULES) assert.equal(fs.existsSync(path.join(root, `${m}.js`)), false, `${m}.js debe estar eliminado`);
  const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1', host: '127.0.0.1' };
  await withCloud(async (_app, send) => {
    // El arranque real no importa módulos INDEX ni el módulo de operador, y no intenta ninguna red
    // (el guard de red de withCloud falla si arranque/rutas llamasen a Telegram, p. ej. UpdatePinnedMessage).
    const loaded = Object.keys(require.cache).map((f) => path.basename(f, '.js'));
    for (const m of [...MODULES, 'telegram-file-io']) assert.equal(loaded.includes(m), false, `el runtime no debe cargar ${m}`);

    const login = await send('POST', '/auth/login', {
      headers: browser, body: { email: account.email, password: account.password, beatgalerUserId: account.beatgalerUserId },
    });
    assert.equal(login.status, 200);
    const session = {
      ...browser,
      cookie: login.headers['set-cookie'].map((c) => c.split(';', 1)[0]).join('; '),
      'x-beatgaler-csrf': JSON.parse(login.data).csrf_token,
      'x-beatgaler-installation-id': account.beatgalerUserId,
    };
    const outcome = async (method, url, headers) => {
      const r = await send(method, url, { headers, body: method === 'POST' ? {} : undefined });
      return { status: r.status, type: r.headers['content-type'], body: r.headers['content-type']?.startsWith('application/json') ? r.data : 'text' };
    };
    // Una ruta retirada responde igual que una ruta que nunca existió (mismo guard y mismo fallback).
    for (const [label, headers] of [['sin sesión', browser], ['con sesión', session]]) {
      for (const method of ['GET', 'POST']) {
        const unknown = await outcome(method, '/zz-never-existed/x', headers);
        for (const r of RETIRED) {
          const url = r.endsWith('/') ? `${r}x` : r;
          assert.deepEqual(await outcome(method, url, headers), unknown, `${method} ${url} ${label} conserva un handler`);
        }
      }
    }
  });
});

