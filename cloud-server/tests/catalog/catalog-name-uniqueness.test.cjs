'use strict';
// Unicidad de nombres de beats ACTIVOS: normalización del contrato (trim + toLowerCase) y error NAME_TAKEN 409. La serialización concurrente la dan
// los locks de biblioteca (mutationTx) y se prueba contra PostgreSQL real en el LAB (`scripts/catalog-lab/probe-name-uniqueness.mjs`).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nameKey, findNameOwner, assertNameFree } = require('../../catalog/name-uniqueness');

test('nameKey: misma normalización que legacy-codec (trim + minúsculas; vacío → untitled)', () => {
  const codec = require('../../catalog/legacy-codec');
  for (const n of ['  Mi Beat  ', 'ÁRBOL', 'x', '   ', '']) assert.equal(nameKey(n), codec.projectBeat({ id: 'b', name: n, tags: [] }).nameSearch.toLowerCase());
  assert.equal(nameKey('  Mi Beat '), nameKey('mi beat')); assert.notEqual(nameKey('mi beat'), nameKey('mi  beat'));
  assert.equal(nameKey(undefined), 'untitled');
});

function fakeClient(owner) { const calls = []; return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: owner ? [{ beat_id: owner }] : [] }; } }; }

test('findNameOwner consulta solo beats ACTIVE de la biblioteca, por la clave normalizada y excluyendo el propio beat', async () => {
  const c = fakeClient('b-9'); const r = await findNameOwner(c, 'u1', 'g1', '  Hola ', 'b-1');
  assert.equal(r, 'b-9'); assert.deepEqual(c.calls[0].params, ['u1', 'g1', 'hola', 'b-1']); assert.match(c.calls[0].sql, /state = 'ACTIVE'/); assert.match(c.calls[0].sql, /name_search = \$3/);
});

test('assertNameFree: libre no lanza; ocupado lanza NAME_TAKEN 409 con el nombre', async () => {
  await assertNameFree(fakeClient(null), 'u', 'g', 'Libre');
  await assert.rejects(() => assertNameFree(fakeClient('b-2'), 'u', 'g', ' Ocupado '), (e) => e.code === 'NAME_TAKEN' && e.status === 409 && e.detail.name === 'Ocupado' && e.detail.beatId === 'b-2');
});
