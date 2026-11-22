'use strict';
// T09 — Unidad: random_id int64, validación de intención C7, backoff C8 y precondiciones sin DB. Sin red.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const ops = require('../../catalog/operations.js');

test('IMPORT y REPLACE conservan sus sentencias, parámetros y respuesta de commit', async (t) => {
  const cases = [
    { kind: 'IMPORT', metadata: { name: 'Écho', tags: ['trap'] }, version: '1', golden: 'f71779d556e2a582b69fa65d85bbe4d1a7f9b119c2c1e737e2d7bf0bfea48960' },
    { kind: 'REPLACE', metadata: { rating: 5 }, version: '2', golden: '0ee5d1642af0d1488263494d05376ce8a98269f575c53e423a0b1445cce90ac9' },
    { kind: 'REPLACE', metadata: null, version: '2', golden: '978736c8a5d2d2c298ec61f5308966136f49902fda98af201f8d58feccd810e2' },
  ];
  for (const { kind, metadata, version, golden } of cases) {
    await t.test(`${kind} ${JSON.stringify(metadata)}`, async () => {
      const trace = [];
      const operation = { operation_id: 'op-fixed-1', kind, status: 'READY', beat_id: 'b1', generation_id: 'g1', authority_epoch: '1',
        expected_version: '1', intent_json: JSON.stringify({ metadata }) };
      const rows = [
        [/FROM catalog_transfer_operations o/, [operation]],
        [/FROM catalog_operation_parts p/, [{ slot_key: 'MASTER', role: 'MASTER', part_index: 0, dispatch_state: 'VERIFIED', verified_size: '10', chat_id: '-1', provider_message_id: '2' }]],
        [/SELECT state, expires_at <=/, [{ state: 'HELD', expired: false }]],
        [/active_count::int AS a/, [{ a: 0, t: 0, p: 0, n: 1 }]],
        [/min\(manual_rank\)/, [{ r: '1000' }]],
        [/SELECT state, version::text/, [{ state: 'ACTIVE', version: '1' }]],
        [/SELECT legacy_json FROM catalog_beats/, [{ legacy_json: '{"name":"Écho","tags":[" Old  Tag "],"rating":5}' }]],
        [/RETURNING version::text AS v/, [{ v: '2' }]],
        [/RETURNING revision::text/, [{ revision: '8' }]],
        [/max\(event_seq\)/, [{ seq: '2' }]],
      ];
      const client = { async query(sql, args = []) {
        trace.push([sql, args]);
        if (sql.startsWith("UPDATE catalog_transfer_operations SET status = 'COMMITTED'")) {
          operation.status = 'COMMITTED';
          operation.result_json = args[2];
        }
        return { rows: rows.find(([pattern]) => pattern.test(sql))?.[1] ?? [] };
      }, release() {} };
      const authority = { availability: async () => {}, requireLibraryForMutation: async () => ({ migration_state: 'IDLE', generation_id: 'g1', authority_epoch: '1' }) };
      const service = ops.createCatalogOperations({ pool: { connect: async () => client }, authority, resolveAccess: async () => ({ maxBeats: null }) });
      const response = await service.commitOperation({ userId: 'u1', era: 'era-1', epoch: '1', operationId: operation.operation_id });
      assert.equal(response.status, 200);
      assert.equal(response.operation.result.version, version);
      // Huella de la traza completa (texto SQL, parámetros, orden) y del JSON enviado antes de M4.2.
      assert.equal(createHash('sha256').update(JSON.stringify([trace, response])).digest('hex'), golden);
    });
  }
});

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

test('validateIntent: IMPORT exige MASTER y name, REPLACE exige beatId + expectedVersion, PURGE → 400 PURGE_ROUTE (lo atiende catalog/purge.js desde T15), partes acotadas y sin duplicados; tamaños/hashes/roles estrictos', () => {
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
  assert.throws(() => ops.validateIntent({ kind: 'PURGE', parts: [master] }), (e) => e.code === 'INPUT_INVALID' && e.detail.reason === 'PURGE_ROUTE');
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

test('IMPORT/REPLACE: metadata.name de más de 50 caracteres → INPUT_INVALID (no se recorta); 50 se acepta tal cual', () => {
  const master = { partKey: 'm0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: 10, sha256: 'a'.repeat(64), filename: 'beat.mp3', mime: 'audio/mpeg' };
  assert.throws(() => ops.validateIntent({ kind: 'IMPORT', parts: [master], metadata: { name: 'ñ'.repeat(51) } }), (e) => e.code === 'INPUT_INVALID');
  const ok = ops.validateIntent({ kind: 'IMPORT', parts: [master], metadata: { name: 'ñ'.repeat(50) } });
  assert.equal(ok.metadata.name, 'ñ'.repeat(50));
});
