'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTag, validatePatch } = require('../../catalog/metadata-rules.js');
const { projectBeat } = require('../../catalog/beat-projection.js');
const { addTagsToDoc, removeTagsFromDoc } = require('../../catalog/commands.js');

const cases = [
  // Descripción, entrada, normalizeTag, normKey, aceptación en PATCH.
  ['espacios extremos', '  lo fi  ', 'lo fi', 'lo fi', false],
  ['espacios internos repetidos y mayúsculas', '  Lo   Fi  ', 'lo fi', 'lo   fi', false],
  ['tabulador interno', 'lo\tfi', 'lo fi', 'lo\tfi', false],
  ['espacio no separable interno', 'lo\u00a0fi', 'lo fi', 'lo\u00a0fi', false],
  ['mayúsculas', 'LOUD', 'loud', 'loud', false],
  ['acento NFC', 'CAF\u00c9', 'caf\u00e9', 'caf\u00e9', false],
  ['acento NFD', 'CAFE\u0301', 'cafe\u0301', 'cafe\u0301', false],
  ['eszett', 'STRAẞE', 'straße', 'straße', false],
  ['emoji', '🎵 BEAT', '🎵 beat', '🎵 beat', false],
  ['texto RTL', 'سلام BEAT', 'سلام beat', 'سلام beat', false],
  ['espacio simple', 'lo fi', 'lo fi', 'lo fi', true],
  ['guion y guion bajo', 'lo-fi_2', 'lo-fi_2', 'lo-fi_2', true],
  ['separadores adyacentes', 'lo-_fi', 'lo-_fi', 'lo-_fi', false],
  ['cadena vacía', '', '', '', false],
  ['solo espacios', ' \t ', '', '', false],
  ['null', null, 'null', undefined, false],
  ['undefined', undefined, 'undefined', undefined, false],
  ['número', 42, '42', undefined, false],
  ['número como cadena', '42', '42', '42', true],
];

for (const [description, value, normalized, normKey, patchOk] of cases) {
  test(`normalización de tags: ${description}`, () => {
    const projected = projectBeat({ tags: [value] }).tags;
    const patch = validatePatch({ tags: [value] });

    assert.equal(normalizeTag(value), normalized);
    assert.deepEqual(projected.map((tag) => tag.normKey), normKey === undefined ? [] : [normKey]);
    assert.equal(patch.ok, patchOk);
    assert.deepEqual(patch.set, patchOk ? { tags: [value] } : {});
  });
}

test('los comandos masivos comparan un tag guardado con espacios repetidos usando una clave distinta de la proyección', () => {
  const doc = { tags: ['Lo   Fi', 'ambient'] };

  assert.deepEqual(projectBeat(doc).tags.map((tag) => tag.normKey), ['lo   fi', 'ambient']);
  assert.equal(addTagsToDoc(doc, ['lo fi']), null);
  assert.deepEqual(removeTagsFromDoc(doc, ['lo fi']).tags, ['ambient']);
});
