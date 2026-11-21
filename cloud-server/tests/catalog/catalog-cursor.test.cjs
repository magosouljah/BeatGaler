'use strict';
// T06 — Cursores firmados (C12 §4.2): firma, canonicidad, kid, tamaño, claves del entorno. Sin red ni DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const cursor = require('../../catalog/cursor.js');

const K1 = { kid: 'k1', secret: crypto.randomBytes(32) };
const K0 = { kid: 'k0', secret: crypto.randomBytes(32), retired: true };
const payload = { kind: 'beats', tenantId: 'u1', vaultId: 'v1', generationId: 'g', era: 'e', epoch: '1', revision: '7', searchProfile: 'search-js-v1', sortProfile: 'catalog-order-v1',
  filterHash: 'f', sort: 'rating', limit: 240, direction: 'forward', boundary: { tuple: ['250', '12', 'beat-1'], inclusive: false }, startOrdinal: 240, totalMatched: 1000 };

test('firma y verificación: roundtrip canónico, formato base64url.base64url, v y kid incluidos', () => {
  const s = cursor.createCursorSigner({ keys: [K1] });
  const token = s.sign(payload);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const { payload: back, kid } = s.verify(token);
  assert.equal(kid, 'k1');
  assert.deepEqual(back, { ...payload, v: 1, kid: 'k1' });
  // Mismo payload en otro orden de claves → mismo token (canónico)
  assert.equal(s.sign({ totalMatched: 1000, startOrdinal: 240, ...payload }), token);
});

test('alteraciones: payload tocado, firma tocada, re-serialización no canónica, otra clave, formato → 400 CURSOR_INVALID', () => {
  const s = cursor.createCursorSigner({ keys: [K1] });
  const token = s.sign(payload);
  const [p, sig] = token.split('.');
  const bad = (t, reason) => assert.throws(() => s.verify(t), (e) => e.code === 'CURSOR_INVALID' && e.status === 400 && (!reason || e.detail.reason === reason), `${reason}: ${t.slice(0, 20)}`);
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), tenantId: 'u2' })).toString('base64url');
  bad(`${tampered}.${sig}`, undefined); // tenant cambiado: firma no coincide (o no canónico)
  // Se altera un carácter central: el último solo aporta 2 bits y su cambio puede decodificar a los mismos bytes.
  bad(`${p}.${sig.slice(0, 10)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`, 'SIGNATURE');
  const noncanon = Buffer.from(JSON.stringify({ v: 1, kid: 'k1', ...payload })).toString('base64url'); // orden distinto al canónico
  const sigNc = crypto.createHmac('sha256', K1.secret).update(Buffer.from(noncanon, 'base64url')).digest('base64url');
  bad(`${noncanon}.${sigNc}`, 'NOT_CANONICAL');
  const other = cursor.createCursorSigner({ keys: [{ kid: 'k1', secret: crypto.randomBytes(32) }] });
  bad(other.sign(payload), 'SIGNATURE');
  const unknownKid = cursor.createCursorSigner({ keys: [{ kid: 'zz', secret: crypto.randomBytes(32) }] }).sign(payload);
  bad(unknownKid, 'UNKNOWN_KEY');
  bad('', 'FORMAT'); bad('abc', 'FORMAT'); bad('a.b.c', 'FORMAT'); bad(`${p}.${'A'.repeat(43)}`, 'SIGNATURE');
  bad(`${Buffer.from('[1]').toString('base64url')}.${'A'.repeat(43)}`, 'FORMAT');
  bad(`${Buffer.from(JSON.stringify({ v: 2, kid: 'k1' })).toString('base64url')}.${'A'.repeat(43)}`, 'VERSION');
  bad(`${'A'.repeat(17 * 1024)}.${'A'.repeat(43)}`, 'TOO_LARGE');
});

test('clave retirada conocida con firma válida → 409 CURSOR_STALE (no se confunde con firma falsa)', () => {
  const old = cursor.createCursorSigner({ keys: [{ ...K0, retired: false }] });
  const token = old.sign(payload);
  const ring = cursor.createCursorSigner({ keys: [K1, K0] });
  assert.equal(ring.activeKid, 'k1');
  assert.throws(() => ring.verify(token), (e) => e.code === 'CURSOR_STALE' && e.status === 409 && e.detail.reason === 'KEY_RETIRED');
  assert.throws(() => cursor.createCursorSigner({ keys: [K0] }), /active/);
  assert.throws(() => cursor.createCursorSigner({ keys: [{ kid: 'short', secret: 'x' }] }), /32 bytes/);
  assert.throws(() => cursor.createCursorSigner({ keys: [K1, { kid: 'k1', secret: crypto.randomBytes(32) }] }), /unique/);
});

test('límite de 16 KiB al firmar y claves del entorno (JSON) o efímeras', () => {
  const s = cursor.createCursorSigner({ keys: [K1] });
  assert.throws(() => s.sign({ ...payload, boundary: { tuple: ['x'.repeat(17000)], inclusive: false } }), (e) => e.code === 'CURSOR_TOO_LARGE');
  const hex = crypto.randomBytes(32).toString('hex');
  const fromEnv = cursor.keysFromEnv({ BEATGALER_CATALOG_CURSOR_KEYS: JSON.stringify([{ kid: 'env1', secret: hex }, { kid: 'old', secret: hex, retired: true }]) });
  assert.equal(fromEnv.source, 'env'); assert.deepEqual(fromEnv.keys.map((k) => [k.kid, k.retired]), [['env1', false], ['old', true]]);
  assert.equal(fromEnv.keys[0].secret.length, 32, 'hex de 64 chars → 32 bytes');
  const eph = cursor.keysFromEnv({});
  assert.equal(eph.source, 'ephemeral'); assert.equal(eph.keys[0].kid, 'ephemeral');
  assert.throws(() => cursor.keysFromEnv({}, { allowEphemeral: false }), /required/);
  assert.throws(() => cursor.keysFromEnv({ BEATGALER_CATALOG_CURSOR_KEYS: 'nope' }), /JSON array/);
});
