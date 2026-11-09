'use strict';
// T07 — Paridad exacta entre catalog/metadata-rules.js y src/lib/metadataValidation.ts (CONTRATO C5 "Validación de nuevos valores").
// Se ejecuta con `node --experimental-strip-types` para cargar el TS real del cliente; sin red ni DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const rules = require('../../catalog/metadata-rules.js');

const TS = pathToFileURL(path.join(__dirname, '..', '..', '..', 'src', 'lib', 'metadataValidation.ts')).href;

const TAGS = ['Trap', ' trap ', 'lo-fi', 'lo fi', 'lo__fi', 'a_b-c d', '', '   ', 'x'.repeat(40), 'x'.repeat(41), 'tag;', 'tag,1', 'a/b', '"q"', 'c:d', 'ñandú', 'TRAP  BEAT', '-lead', 'lead-', 'a--b', '123', 'é', 'tag (x)'];
const BPMS = ['', '  ', '120', '120.5', '120.55', '120.555', '60', '59.99', '300', '300.01', '0x80', '1e2', 'abc', '120 ', ' 95', '-120', '120.', '.5', '999', '100.10'];
const KEYS = ['', 'C', 'c', 'C#', 'Db', 'cm', 'c#m', 'abm', 'C major', 'c minor', 'C# maj', 'Ab min', 'C♯', 'B♭m', 'H', 'Cb#', 'c sharp', 'CM', 'Cmaj7', ' d ', 'G  Minor'];

test('validateTag / validateBpm / validateMusicKey: idéntico al TS del cliente para la tabla de casos', async () => {
  const ts = await import(TS);
  for (const v of TAGS) assert.deepEqual(rules.validateTag(v), ts.validateTag(v), `tag ${JSON.stringify(v)}`);
  for (const v of BPMS) assert.deepEqual(rules.validateBpm(v), ts.validateBpm(v), `bpm ${JSON.stringify(v)}`);
  for (const v of KEYS) assert.deepEqual(rules.validateMusicKey(v), ts.validateMusicKey(v), `key ${JSON.stringify(v)}`);
  assert.equal(rules.normalizeTag('  Lo   Fi '), ts.normalizeTag('  Lo   Fi '));
});

test('validatePatch: solo campos presentes, rechazo con detalle (sin cleanTags), tags normalizados y sin duplicados, rating 0–255, crop ratio', () => {
  const ok = rules.validatePatch({ name: ' Árbol ', bpm: '120.50', key: 'c minor', tags: ['trap', 'lo-fi'], rating: 255, color: '#666666', color2: '', crop: { x: 0, y: 0.25, w: 1, h: 0.5, unit: 'ratio' } });
  assert.deepEqual(ok, { ok: true, errors: [], set: { name: ' Árbol ', bpm: '120.5', key: 'cm', tags: ['trap', 'lo-fi'], rating: 255, color: '#666666', color2: '', crop: { x: 0, y: 0.25, w: 1, h: 0.5, unit: 'ratio' } } });
  const bad = rules.validatePatch({ name: '  ', bpm: '59', key: 'H', tags: ['Trap', 'a;b', 'dup', 'dup', 7], rating: 256, color: 'x'.repeat(65), crop: { x: 2, y: 0, w: 1, h: 1, unit: 'ratio' }, state: 'TRASH', userId: 'u2' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['bpm', 'color', 'crop', 'key', 'name', 'rating', 'state', 'tags[0]', 'tags[1]', 'tags[3]', 'tags[4]', 'userId'].sort());
  assert.match(bad.errors.find((e) => e.field === 'tags[0]').reason, /normalized as "trap"/);
  assert.equal(bad.errors.find((e) => e.field === 'tags[3]').reason, 'duplicate tag');
  assert.deepEqual(rules.validatePatch({}).errors, [{ field: '$', reason: 'patch has no fields' }]);
  assert.equal(rules.validatePatch({ tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }).errors[0].reason, 'at most 30 tags');
  assert.deepEqual(rules.validatePatch({ crop: null, bpm: '' , key: '' }).set, { crop: null, bpm: '', key: '' });
  assert.equal(rules.validatePatch({ rating: 2.5 }).ok, false);
  assert.equal(rules.validatePatch({ name: 'a\u0000b' }).ok, false, 'NUL rechazado');
  assert.equal(rules.validatePatch(null).ok, false); assert.equal(rules.validatePatch([]).ok, false);
});
