'use strict';
// T04 — Codec INDEX ⇄ filas sobre todos los fixtures T01 (sin DB). Oráculo independiente del exportador:
// la tabla EXPECT fija, por fixture, elegibilidad, códigos REVIEW y flags según C4 + reglas T01-B.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const codec = require('../../catalog/legacy-codec.js');
const { decompose, compose, budgetFromRows } = require('../../catalog/migration.js');

const DIR = path.join(__dirname, '..', 'fixtures', 'catalog');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const CHAT = '-1001';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// parse: códigos del parser estricto; review/flags: conjuntos exactos de códigos; deltas: authoritative-export.
const EXPECT = {
  't01-empty-certified': {}, 't01-beat-minimal': {}, 't01-all-slots': {}, 't01-null-vs-absent': {}, 't01-unicode-tags': {},
  't01-id-256': { review: ['BEAT_ID_UTF16_LENGTH', 'BEAT_ID_CODEPOINT_LENGTH'], flags: ['DIRECT_SCOPE_INCOMPATIBLE'] },
  't01-id-collisions': { review: ['BEAT_ID_EDGE_WHITESPACE', 'BEAT_ID_NOT_STRING', 'ID_DUPLICATE'] },
  't01-metadata-message-id': {}, 't01-multipart': {}, 't01-repeated-unknown-files': {},
  't01-trash-deleted-garbage': {},
  't01-trash-unwrapped': { flags: ['TRASH_UNWRAPPED'] },
  't01-shared-reference': { flags: ['SHARED_REFERENCE'] },
  't01-unknown-fields': {},
  't01-v1-implicit': { flags: ['VERSION_IMPLICIT_V1'], deltas: ['V1_TO_V2', 'V1_TO_V2'] },
  't01-version-null': { review: ['VERSION_UNSUPPORTED'] },
  't01-version-future': { review: ['VERSION_UNSUPPORTED'] },
  't01-source-order-ne-sort': {},
  't01-tombstone-sql-only': { deltas: ['SQL_ONLY_TOMBSTONE', 'SQL_ONLY_TOMBSTONE'] },
  't01-invalid-json': { parse: ['INVALID_JSON'] },
  't01-duplicate-keys': { parse: ['DUPLICATE_KEY', 'DUPLICATE_KEY'] },
  't01-unsafe-int': { parse: ['UNSAFE_INTEGER'] },
  't01-nul-surrogates': { review: ['PROJECTED_UNREPRESENTABLE'] },
  't01-size-zero': { flags: ['SIZE_ZERO'] },
  't01-botapi-file-id': { flags: ['OPAQUE_LOCATOR'] },
  't01-garbage-intersects-live': { review: ['GARBAGE_INTERSECTS_LIVE'] },
  't01-topic-map-mismatch': { review: ['TOPIC_MAP_MISMATCH'] },
  't01-topic-map-link-ambiguous': { review: ['TOPIC_MAP_LINK_AMBIGUOUS'] },
  't01-id-trim-unpaired': { review: ['BEAT_ID_EDGE_WHITESPACE'] },
  't01-id-astral': { review: ['BEAT_ID_UTF16_LENGTH'], flags: ['DIRECT_SCOPE_INCOMPATIBLE'] },
  't01-trash-beat-nonobject': { review: ['TRASH_BEAT_NOT_OBJECT'] },
  't01-deleted-alias-conflict': { review: ['DELETED_KEY_CONFLICT', 'DELETED_KEY_MISSING'] },
  't01-live-vs-tombstone': { review: ['LIVE_VS_TOMBSTONE'] },
  't01-manifest-toplevel-ref': { review: ['MANIFEST_REF_UNREPRESENTED'] }, // C4 referencias inconsistentes => REVIEW (aprobado 2026-11-08)
  't01-uploaded-files-beat-mismatch': { review: ['UPLOADED_FILES_BEAT_MISMATCH'] },
  't01-message-redirect-stale': { review: ['MESSAGE_REDIRECT_STALE'] },
  't01-nul-unprojected': {},
  'c12-u01-names': { review: ['ID_DUPLICATE'] },
  'c12-n01-bpm': {}, 'c12-f01-tags': {}, 'c12-f02-search': {}, 'v01a-long-metadata': {},
};

function load(id) {
  const f = manifest.fixtures.find((x) => x.id === id);
  return fs.readFileSync(path.join(DIR, f.file));
}
function sources(id, value) {
  // Fixture con INDEX directo o envuelto con evidencia SQL/cloud-data.
  if (value && value.beats) return [{ index: value, ctx: { chatId: CHAT } }];
  if (value && value.index) return [{ index: value.index, ctx: { chatId: CHAT, sqlTombstones: value.sql_tombstones, cloudData: value.cloud_data, link: value.link, links: value.links, importingUser: value.importing_user } }];
  if (value && value.orderA) return [{ index: value.orderA, ctx: { chatId: CHAT } }, { index: value.orderB, ctx: { chatId: CHAT } }];
  return [];
}
const codes = (list) => [...new Set(list.map((x) => x.code))].sort();

test('cada fixture T01/C12/V01-A tiene expectativa y la cumple (parse, REVIEW, flags)', () => {
  const covered = new Set();
  for (const f of manifest.fixtures) {
    if (f.on_demand || !EXPECT[f.id]) continue;
    covered.add(f.id);
    const e = EXPECT[f.id];
    const p = codec.parseStrict(load(f.id));
    if (e.parse) { assert.equal(p.ok, false, f.id); assert.deepEqual(codes(p.issues), [...new Set(e.parse)].sort(), f.id); continue; }
    assert.equal(p.ok, true, `${f.id}: ${JSON.stringify(p.issues)}`);
    for (const s of sources(f.id, p.value)) {
      const v = codec.validateIndex(s.index, s.ctx);
      assert.deepEqual(codes(v.review), [...new Set(e.review || [])].sort(), `${f.id} review`);
      assert.deepEqual(codes(v.flags.filter((x) => x.code !== 'VERSION_IMPLICIT_V1' || e.flags)), [...new Set(e.flags || [])].sort(), `${f.id} flags`);
      assert.equal(v.eligible, !(e.review && e.review.length), `${f.id} eligible`);
    }
  }
  const indexFixtures = manifest.fixtures.filter((f) => /^index|oracle-input/.test(f.kind) && !f.on_demand && !['t01-pointer-absent-nonempty', 't01-beathash-key-order', 'v01a-big-generator', 'c12-u02-nfc-nfd'].includes(f.id));
  for (const f of indexFixtures) assert.ok(covered.has(f.id), `fixture sin expectativa: ${f.id}`);
});

test('roundtrip profundo de todos los INDEX elegibles: source exacto, authoritative con deltas listados', () => {
  let n = 0;
  for (const f of manifest.fixtures) {
    const e = EXPECT[f.id];
    if (f.on_demand || !e || e.parse || (e.review && e.review.length)) continue;
    for (const s of sources(f.id, codec.parseStrict(load(f.id)).value)) {
      const rows = decompose(s.index, s.ctx);
      const src = compose(rows, { mode: 'source-roundtrip' });
      assert.deepEqual(codec.deepDiff(s.index, src.doc), [], `${f.id} source-roundtrip`);
      assert.deepEqual(src.deltas, []);
      const auth = compose(rows, { mode: 'authoritative-export' });
      assert.deepEqual(auth.deltas.map((d) => d.kind), e.deltas || [], `${f.id} deltas`);
      if (!e.deltas) assert.deepEqual(codec.deepDiff(s.index, auth.doc), [], `${f.id} authoritative sin deltas`);
      // beatHash legacy = sha256(JSON.stringify(beat)) y legacy_json sin byte NUL
      for (const b of rows.beats) { assert.equal(b.legacySha256, sha(JSON.stringify(JSON.parse(b.legacyJson)))); assert.ok(!b.legacyJson.includes('\u0000')); }
      // presupuesto: cota >= bytes reales del export autoritativo
      const actual = Buffer.byteLength(JSON.stringify(auth.doc), 'utf8');
      assert.ok(budgetFromRows(rows) >= actual, `${f.id}: estimate ${budgetFromRows(rows)} < actual ${actual}`);
      n++;
    }
  }
  assert.ok(n >= 20, `roundtrips ejecutados: ${n}`);
});

test('el import rechaza ambigüedades antes de producir filas', () => {
  for (const id of ['t01-version-null', 't01-garbage-intersects-live', 't01-nul-surrogates', 't01-manifest-toplevel-ref']) {
    const v = codec.parseStrict(load(id)).value;
    const s = sources(id, v)[0];
    assert.throws(() => decompose(s.index, s.ctx), (err) => err.code === 'CATALOG_IMPORT_REVIEW' && err.review.length > 0, id);
  }
  const ptr = JSON.parse(load('t01-pointer-absent-nonempty'));
  assert.deepEqual(codes(codec.validateSource(ptr).review), ['POINTER_ABSENT_NONEMPTY']);
  assert.equal(codec.parseStrict(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])).issues[0].code, 'BOM');
  assert.equal(codec.parseStrict(Buffer.from([0x7b, 0xff, 0x7d])).issues[0].code, 'INVALID_UTF8');
  assert.deepEqual(codes(codec.parseStrict('{"a":1e400}').issues), ['NUMBER_OVERFLOW']);
  assert.deepEqual(codes(codec.parseStrict('{"__proto__":{"x":1}}').issues), []);
  assert.equal(Object.getPrototypeOf(codec.parseStrict('{"__proto__":{"x":1}}').value), Object.prototype, 'sin contaminación de prototipo');
});

test('filas: proyecciones A2/D-04/D-10, archivos, partes y referencias', () => {
  const all = decompose(codec.parseStrict(load('t01-all-slots')).value, { chatId: CHAT });
  assert.deepEqual(all.current.map((c) => c.slotKey).sort(), ['ARTWORK', 'FILES:0', 'FILES:1', 'MASTER', 'METADATA', 'PROJECT']);
  assert.equal(all.parts.filter((p) => all.files.find((f) => f.fileId === p.fileId).role === 'PROJECT').length, 2);
  assert.ok(all.locations.every((l) => l.referenceClass === 'KNOWN' && l.objectId.startsWith(`tg:${CHAT}:`)));
  const nva = decompose(codec.parseStrict(load('t01-null-vs-absent')).value, { chatId: CHAT });
  assert.equal(nva.files.length, 0, 'artwork de nulls y null = ABSENT (D-04)');
  assert.ok(nva.beats.every((b) => b.hasArtwork === false));
  const sz = decompose(codec.parseStrict(load('t01-size-zero')).value, { chatId: CHAT });
  assert.equal(sz.files[0].sizeBytes, null, 'size 0 => NULL proyectado (D-10)');
  assert.match(sz.beats[0].legacyJson, /"size":0/, 'size 0 verbatim en legacy_json');
  const bot = decompose(codec.parseStrict(load('t01-botapi-file-id')).value, { chatId: CHAT });
  assert.deepEqual(bot.locations.map((l) => [l.referenceClass, l.objectId]), [['OPAQUE', null]], 'no se fabrica direct:<id>');
  const mp = decompose(codec.parseStrict(load('t01-multipart')).value, { chatId: CHAT });
  assert.equal(mp.parts.filter((p) => mp.files.find((f) => f.fileId === p.fileId).role === 'MASTER').length, 3, 'todas las partes');
  const bpm = decompose(codec.parseStrict(load('c12-n01-bpm')).value, { chatId: CHAT });
  const cls = Object.fromEntries(bpm.beats.map((b) => [b.beatId, [b.bpmSortClass, b.bpmSort]]));
  assert.deepEqual(cls.p0, [1, 0]); assert.deepEqual(cls.p1, [1, 0], 'número no-string => bpmDisplay vacío => 0');
  assert.deepEqual(cls.p5, [1, 128]); assert.deepEqual(cls.p6, [1, 100]); assert.deepEqual(cls.p7, [3, null]); assert.deepEqual(cls.p9, [2, null]); assert.deepEqual(cls.p10, [0, null]);
  const tags = decompose(codec.parseStrict(load('t01-unicode-tags')).value, { chatId: CHAT }).tags.filter((t) => t.beatId === 'b-u3');
  assert.deepEqual(tags.map((t) => [t.position, t.label]), [[3, 'ss']], 'tags no string quedan solo en legacy_json');
  const tomb = decompose(codec.parseStrict(load('t01-tombstone-sql-only')).value.index, { chatId: CHAT, sqlTombstones: codec.parseStrict(load('t01-tombstone-sql-only')).value.sql_tombstones });
  assert.deepEqual(tomb.tombstones.map((t) => [t.beatId, t.source, t.deletedAt]), [['b-purged', 'SQL', '2025-11-01T12:26:40.000Z'], ['b-legacy', 'SQL', null]], 'sin fecha => null, no fecha actual');
  const hk = JSON.parse(load('t01-beathash-key-order'));
  assert.notEqual(sha(JSON.stringify(hk.a)), sha(JSON.stringify(hk.b)), 'el orden de claves cambia beatHash: legacy_json conserva el de origen');
});

test('presupuesto: límite exacto, sort_order regenerado y capacidad excedida', () => {
  assert.equal(codec.checkBudget(100, 100), true);
  assert.throws(() => codec.checkBudget(101, 100), { code: 'ROLLBACK_CAPACITY_EXCEEDED' });
  for (const id of ['c12-f02-search', 't01-source-order-ne-sort', 't01-trash-deleted-garbage', 'v01a-long-metadata', 't01-nul-unprojected']) {
    const doc = codec.parseStrict(load(id)).value; const index = doc.index || doc;
    const rows = decompose(index, { chatId: CHAT });
    const est = budgetFromRows(rows);
    const out = compose(rows, { mode: 'authoritative-export' }).doc;
    let k = 0; // regenera sort_order contiguo (normalización permitida C4) y compara con la cota previa
    for (const b of out.beats) b.sort_order = k++;
    for (const t of out.trash || []) (t.beat || t).sort_order = k++;
    assert.ok(est >= Buffer.byteLength(JSON.stringify(out)), `${id}: ${est} < ${Buffer.byteLength(JSON.stringify(out))}`);
  }
  const v = codec.validateIndex({ schema: codec.SCHEMA, version: 2, beats: [] }, { exportBytes: codec.ROLLBACK_MAX_BYTES + 1 });
  assert.equal(v.eligible, false); assert.deepEqual(codes(v.flags), ['ROLLBACK_CAPACITY_EXCEEDED']);
  assert.equal(codec.validateIndex({ schema: codec.SCHEMA, version: 2, beats: [] }, { exportBytes: codec.ROLLBACK_MAX_BYTES }).eligible, true);
});
