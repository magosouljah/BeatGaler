'use strict';
// T09 — Unidad: random_id int64, validación de intención C7, backoff C8 y precondiciones sin DB. Sin red.
const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../../catalog/operations.js');

test('random_id: entero firmado de 64 bits como texto, uniforme en todo el rango, con extremos exactos', () => {
  for (let i = 0; i < 2000; i++) assert.ok(ops.int64(ops.randomInt64String()), 'dentro del rango int64');
  const max = ops.randomInt64String(() => Buffer.from('7fffffffffffffff', 'hex'));
  const min = ops.randomInt64String(() => Buffer.from('8000000000000000', 'hex'));
  const neg1 = ops.randomInt64String(() => Buffer.from('ffffffffffffffff', 'hex'));
  assert.deepEqual([max, min, neg1], ['9223372036854775807', '-9223372036854775808', '-1']);
  assert.equal(ops.int64('9223372036854775808'), false); assert.equal(ops.int64('abc'), false); assert.equal(ops.int64(1), false);
  const sample = new Set(Array.from({ length: 500 }, () => ops.randomInt64String()));
  assert.equal(sample.size, 500, 'sin colisiones en 500 muestras');
  assert.ok([...sample].some((s) => s.startsWith('-')) && [...sample].some((s) => !s.startsWith('-')), 'ambos signos aparecen');
});

test('validateIntent: IMPORT exige MASTER y name, REPLACE exige beatId + expectedVersion, PURGE → 501, partes acotadas y sin duplicados; tamaños/hashes/roles estrictos', () => {
  const master = { partKey: 'm0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: 1000, sha256: 'a'.repeat(64), filename: 'beat.mp3', mime: 'audio/mpeg' };
  const ok = ops.validateIntent({ kind: 'IMPORT', parts: [master, { slotKey: 'ARTWORK', role: 'ARTWORK', size: 10 }], metadata: { name: 'New beat', tags: ['trap'], bpm: '120' } });
  assert.deepEqual([ok.kind, ok.parts.length, ok.parts[1].partKey, ok.metadata.bpm, ok.beatId], ['IMPORT', 2, 'ARTWORK:0', '120', null]);
  const bad = (intent, reason) => assert.throws(() => ops.validateIntent(intent), (e) => e.code === 'INPUT_INVALID' && e.detail.reason === reason, reason);
  bad({ kind: 'MOVE' }, 'OPERATION_KIND');
  bad({ kind: 'IMPORT', parts: [] }, 'PARTS_EMPTY');
  bad({ kind: 'IMPORT', parts: Array.from({ length: 65 }, (_, i) => ({ slotKey: `FILES:${i}`, role: 'WAV', size: 1 })) }, 'PARTS_TOO_MANY');
  bad({ kind: 'IMPORT', parts: [{ slotKey: 'ARTWORK', role: 'ARTWORK', size: 1 }], metadata: { name: 'x' } }, 'IMPORT_REQUIRES_MASTER');
  bad({ kind: 'IMPORT', parts: [master] }, 'IMPORT_REQUIRES_NAME');
  bad({ kind: 'IMPORT', parts: [master], metadata: { name: 'x', tags: ['Bad;'] } }, 'METADATA');
  bad({ kind: 'IMPORT', parts: [master, { ...master }], metadata: { name: 'x' } }, 'PART_KEY_DUPLICATE');
  bad({ kind: 'IMPORT', parts: [master, { slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: 5, partKey: 'other' }], metadata: { name: 'x' } }, 'PART_SLOT_DUPLICATE');
  bad({ kind: 'IMPORT', parts: [{ ...master, size: 0 }], metadata: { name: 'x' } }, 'PART_SIZE');
  bad({ kind: 'IMPORT', parts: [{ ...master, sha256: 'zz' }], metadata: { name: 'x' } }, 'PART_SHA256');
  bad({ kind: 'IMPORT', parts: [{ ...master, role: 'WAV' }], metadata: { name: 'x' } }, 'ROLE_SLOT_MISMATCH');
  bad({ kind: 'IMPORT', parts: [{ ...master, role: 'METADATA' }], metadata: { name: 'x' } }, 'ROLE');
  bad({ kind: 'IMPORT', parts: [{ ...master, slotKey: 'METADATA' }], metadata: { name: 'x' } }, 'SLOT_KEY');
  bad({ kind: 'REPLACE', parts: [master] }, 'BEAT_ID');
  bad({ kind: 'REPLACE', parts: [master], beatId: 'b1' }, 'EXPECTED_VERSION');
  const rep = ops.validateIntent({ kind: 'REPLACE', parts: [master], beatId: 'b1', expectedVersion: 3 });
  assert.deepEqual([rep.beatId, rep.expectedVersion, rep.metadata], ['b1', '3', null]);
  assert.throws(() => ops.validateIntent({ kind: 'PURGE', parts: [master] }), (e) => e.code === 'NOT_IMPLEMENTED' && e.status === 501);
  assert.throws(() => ops.validateIntent({ kind: 'IMPORT', parts: [{ ...master, filename: 'x'.repeat(60000) }], metadata: { name: 'x' } }), (e) => e.code === 'PAYLOAD_TOO_LARGE' || e.detail.reason === 'PART_FILENAME');
  const doc = ops.nativeBeatDocument('b-1', { name: 'N', tags: ['a'], crop: null });
  assert.deepEqual(doc, { id: 'b-1', name: 'N', bpm: '', key: '', tags: ['a'], rating: 0, color: '', color2: '', image_crop: null });
});

test('backoff C8: exponencial con jitter, tope 15 min, Retry-After mayor manda; createCatalogOperations exige autoridad y resolver Access', () => {
  const fake = { pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }, authority: { availability: async () => ({}), requireLibraryForMutation: async () => ({}) }, resolveAccess: async () => ({ maxBeats: null }) };
  const o = ops.createCatalogOperations(fake);
  assert.equal(o.backoffMs(0, 0, () => 1), 1000); assert.equal(o.backoffMs(0, 0, () => 0), 500);
  assert.equal(o.backoffMs(20, 0, () => 1), 15 * 60_000, 'tope 15 min');
  assert.equal(o.backoffMs(1, 60 * 60_000, () => 0), 60 * 60_000, 'FLOOD_WAIT / Retry-After mayor que el backoff manda');
  for (let a = 0; a < 12; a++) { const v = o.backoffMs(a, 0); assert.ok(v >= 500 && v <= 15 * 60_000); }
  assert.throws(() => ops.createCatalogOperations({ pool: fake.pool, authority: fake.authority }), /resolveAccess/);
  assert.throws(() => ops.createCatalogOperations({ pool: fake.pool, resolveAccess: fake.resolveAccess }), /authority/);
  assert.deepEqual(o.limits, { RESERVATION_TTL_MS: 900000, RESERVATION_MAX_MS: 86400000, JOB_LEASE_MS: 60000, JOB_CLAIM_MAX: 10, JOB_BACKOFF_MAX_MS: 900000, JOB_TRANSIENT_FAILURES_TO_BLOCK: 8, PARTS_MAX: 64 });
});
