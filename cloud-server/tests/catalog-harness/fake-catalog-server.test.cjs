'use strict';
// T02 / V01-B — Pruebas del servidor fake de catálogo (política de red loopback).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createFakeCatalogServer, block, digest, BLOCK_MAX } = require('../helpers/catalog-fake-server.cjs');

const FIX = path.join(__dirname, '..', 'fixtures', 'catalog');
const fixture = (id) => JSON.parse(fs.readFileSync(path.join(FIX, `${id}.json`), 'utf8'));

test('bloques coinciden con los oráculos de ventana V01-A (N=0,1,239,240,241)', () => {
  for (const n of [0, 1, 239, 240, 241]) {
    const oracle = fixture(`v01a-window-n${n}`);
    const got = [];
    for (let start = 0; start < n; start += BLOCK_MAX) { const b = block(n, start, BLOCK_MAX); got.push({ start: b.start, end: b.end, forward_boundary: b.forward_boundary, backward_boundary: b.backward_boundary }); assert.equal(b.items.length, b.end - b.start); }
    assert.deepEqual(got, oracle.blocks, `N=${n}`);
    if (n) assert.equal(block(n, n - 1, 1).items[0].ordinal, oracle.ordinal_of.last);
  }
});

test('limit se acota a 240 y bloques fuera de rango quedan vacíos', () => {
  assert.equal(block(100000, 0, 5000).items.length, 240);
  assert.deepEqual(block(5, 10, 240).items, []);
  assert.throws(() => block(-1, 0, 1), /inválidos/);
});

test('digest incremental reproduce v01a-big-generator (100.000)', () => {
  const big = fixture('v01a-big-generator');
  assert.equal(digest(100000), big.digests['100000']);
});

test('servidor solo en 127.0.0.1, con auth simulada, fixtures y contadores', async () => {
  assert.throws(() => createFakeCatalogServer({ host: '0.0.0.0' }), /127\.0\.0\.1/);
  const s = createFakeCatalogServer();
  const port = await s.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/auth/session`)).status, 401);
    assert.equal((await fetch(`${base}/beatgaler-api/auth/login`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/auth/session`)).status, 200);
    const b = await (await fetch(`${base}/__catalog/block?n=241&start=240&limit=240`)).json();
    assert.deepEqual([b.start, b.end, b.items.length, b.forward_boundary, b.backward_boundary], [240, 241, 1, false, true]);
    const man = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));
    const f = man.fixtures.find((x) => x.id === 'c12-f02-search');
    const r = await fetch(`${base}/__catalog/fixtures/c12-f02-search`);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), f.sha256);
    assert.equal((await fetch(`${base}/__catalog/fixtures/t01-over-rollback-budget`)).status, 404, 'on-demand no se sirve');
    assert.equal((await fetch(`${base}/library/get`)).status, 404);
    const c = s.counters();
    assert.equal(c.UNHANDLED, 1); assert.equal(c['GET /__catalog/block'], 1); assert.equal(c['GET /__catalog/fixtures/:id'], 2);
  } finally { await s.close(); }
});
