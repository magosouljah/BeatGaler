'use strict';
// T07 — Comandos: transformación del documento canónico, precondiciones y contratos con pool falso. Sin red ni DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../../catalog/commands.js');
const authority = require('../../catalog/authority.js');

function fakePool({ lib = null, onQuery = null } = {}) {
  const statements = [];
  const client = {
    async query(sql, params) {
      const text = String(sql); statements.push({ sql: text, params: params || [] });
      const custom = onQuery && onQuery(text, params);
      if (custom) return custom;
      if (/FROM control_plane_flush_quarantine/.test(text)) return { rows: [] };
      if (/FROM catalog_native_activation/.test(text)) return { rows: [{ environment_id: 'lab', run_id: 'r', transport_bot_ids: '["Bot20"]', direct_token_exposure: 'FRESH_BOTS', activated_at: new Date() }] };
      if (/FROM catalog_libraries l\s+LEFT JOIN catalog_generations/.test(text)) return { rows: lib ? [lib] : [] };
      return { rows: [] };
    },
    release() { client.released = (client.released || 0) + 1; },
  };
  return { statements, client, connect: async () => client, query: client.query };
}
const LIB = { user_id: 'u1', vault_id: 'v1', authority: 'POSTGRES', migration_state: 'IDLE', authority_era: 'era-1', authority_epoch: '1', revision: '5', active_generation_id: 'native-g',
  active_count: '3', trash_count: '0', purging_count: '0', pending_count: '0', cleanup_enabled: false, restore_hold: true, generation_origin: 'NATIVE', generation_status: 'ACTIVE', current_chat_id: '-1' };
const make = (pool) => commands.createCatalogCommands({ pool, authority: authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' }) });
const H = { era: 'era-1', epoch: '1', idempotencyKey: 'k-1' };

test('applyPatchToDoc conserva claves no editadas y su orden; docChanged detecta no-op y cambios (incluido crop null vs ausente)', () => {
  const doc = { id: 'b1', sort_order: 3, name: 'Old', bpm: '90', key: 'C', tags: ['a'], rating: 1, artwork: { telegram_message_id: 5 }, extra: { keep: true } };
  const after = commands.applyPatchToDoc(doc, { name: 'New', tags: ['x', 'y'], crop: { x: 0, y: 0, w: 1, h: 1, unit: 'ratio' } });
  assert.deepEqual(Object.keys(after), ['id', 'sort_order', 'name', 'bpm', 'key', 'tags', 'rating', 'artwork', 'extra', 'image_crop']);
  assert.deepEqual([after.name, after.tags, after.bpm, after.artwork, after.extra], ['New', ['x', 'y'], '90', { telegram_message_id: 5 }, { keep: true }]);
  assert.equal(commands.docChanged(doc, commands.applyPatchToDoc(doc, { name: 'Old', tags: ['a'] })), false, 'misma intención = no-op');
  assert.equal(commands.docChanged(doc, commands.applyPatchToDoc(doc, { crop: null })), true, 'image_crop ausente → null es un cambio de documento');
  assert.equal(commands.docChanged(doc, commands.applyPatchToDoc(doc, { rating: 1 })), false);
  assert.notEqual(after.tags, doc.tags, 'copia, no alias');
});

test('addTagsToDoc/removeTagsFromDoc (T16/V09 bulk tagsOp): añade preservando orden y dedupe por norm_key, quita por norm_key, no-op si no cambia nada', () => {
  const doc = { id: 'b1', tags: ['Even', 't0'] };
  const added = commands.addTagsToDoc(doc, ['NEW', 'even']); // "even" ya existe (case-insensitive) → no duplica
  assert.deepEqual(added.tags, ['Even', 't0', 'NEW']);
  assert.equal(commands.addTagsToDoc(doc, ['even', 'T0']), null, 'todo ya presente (norm_key) → no-op');
  const removed = commands.removeTagsFromDoc(doc, ['EVEN']);
  assert.deepEqual(removed.tags, ['t0']);
  assert.equal(commands.removeTagsFromDoc(doc, ['nope']), null, 'nada que quitar → no-op');
  assert.equal(commands.removeTagsFromDoc({ id: 'b2' }, ['x']), null, 'sin array de tags → no-op');
});

test('precondiciones antes de la transacción: patch inválido, versión, lote > 50, cuerpo > 64 KiB, clave de idempotencia; nada toca la DB', async () => {
  const pool = fakePool({ lib: LIB });
  const c = make(pool);
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { rating: 999 } }), (e) => e.code === 'INPUT_INVALID' && e.detail.errors[0].field === 'rating');
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', ...H, patch: { name: 'x' } }), (e) => e.code === 'PRECONDITION_REQUIRED' && e.status === 428);
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '2', ifMatch: 'W/"2-3"', patch: { name: 'x' } }), (e) => e.code === 'INPUT_INVALID' && e.detail.reason === 'IF_MATCH_MISMATCH');
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '0', patch: { name: 'x' } }), (e) => e.detail.reason === 'EXPECTED_VERSION');
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { name: 'x'.repeat(70000) } }), (e) => e.code === 'PAYLOAD_TOO_LARGE' && e.status === 413);
  await assert.rejects(c.trashBeats({ userId: 'u1', ...H, items: Array.from({ length: 51 }, (_, i) => ({ beatId: `b${i}`, expectedVersion: '1' })) }), (e) => e.detail.reason === 'BATCH_TOO_LARGE');
  await assert.rejects(c.trashBeats({ userId: 'u1', ...H, items: [{ beatId: 'b1', expectedVersion: '1' }, { beatId: 'b1', expectedVersion: '1' }] }), (e) => e.detail.reason === 'BATCH_DUPLICATE');
  await assert.rejects(c.restoreBeats({ userId: 'u1', ...H, items: [] }), (e) => e.detail.reason === 'BATCH_EMPTY');
  await assert.rejects(c.createOperation({ userId: 'u1', ...H, kind: 'IMPORT' }), (e) => e.detail.reason === 'OPERATION_KIND');
  await assert.rejects(c.createOperation({ userId: 'u1', ...H, kind: 'BULK_PATCH', selectionId: 'sel-1', selectionVersion: '0', patch: { tags: ['a'] } }), (e) => e.detail.reason === 'BULK_PATCH_TAGS');
  // T16/V09 — bulk añadir/quitar tags (tagsOp): precondiciones antes de tocar la DB, sin reemplazar nunca el set.
  await assert.rejects(c.createOperation({ userId: 'u1', ...H, kind: 'BULK_PATCH', selectionId: 'sel-1', selectionVersion: '0', patch: {}, tagsOp: { op: 'replace', tags: ['a'] } }), (e) => e.code === 'INPUT_INVALID' && e.detail.reason === 'BULK_TAGS_OP');
  await assert.rejects(c.createOperation({ userId: 'u1', ...H, kind: 'BULK_PATCH', selectionId: 'sel-1', selectionVersion: '0', patch: {}, tagsOp: { op: 'add', tags: [] } }), (e) => e.detail.reason === 'BULK_TAGS_OP');
  await assert.rejects(c.createOperation({ userId: 'u1', ...H, kind: 'BULK_PATCH', selectionId: 'sel-1', selectionVersion: '0', patch: {} }), (e) => e.detail.reason === 'PATCH', 'sin tagsOp y sin campos: sigue requiriendo un patch no vacío');
  await assert.rejects(c.createOperation({ userId: 'u1', ...H, kind: 'BULK_TRASH', selectionId: 'sel-1', selectionVersion: '0', tagsOp: { op: 'add', tags: ['a'] } }), (e) => e.detail.reason === 'BULK_TAGS_OP', 'tagsOp solo aplica a BULK_PATCH');
  await assert.rejects(c.applySelectionOp({ userId: 'u1', ...H, selectionId: 'sel-1', selectionVersion: '0', op: { kind: 'INCLUDE_IDS', beatIds: [] } }), (e) => e.detail.reason === 'SELECTION_IDS');
  await assert.rejects(c.listChanges({ userId: 'u1', query: { after: '-1' } }), (e) => e.detail.reason === 'AFTER');
  assert.equal(pool.statements.length, 0, 'ninguna sentencia SQL antes de validar');
  // Clave de idempotencia inválida se detecta dentro de la transacción, antes de cualquier escritura
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', era: 'era-1', epoch: '1', idempotencyKey: 'bad key!', expectedVersion: '1', patch: { name: 'x' } }), (e) => e.detail.reason === 'IDEMPOTENCY_KEY');
  assert.ok(!pool.statements.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql.trim())), 'sin escrituras');
  assert.ok(pool.statements.some((s) => /ROLLBACK/.test(s.sql)));
});

test('la transacción de mutación bloquea la biblioteca y exige era/época; era vieja → 409 sin escrituras; biblioteca no IDLE → LIBRARY_FROZEN; cuarentena → 409', async () => {
  const pool = fakePool({ lib: LIB });
  const c = make(pool);
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', era: 'era-0', epoch: '1', idempotencyKey: 'k', expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'CATALOG_ERA_MISMATCH' && e.status === 409);
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', era: 'era-1', epoch: '9', idempotencyKey: 'k', expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'CATALOG_EPOCH_STALE');
  assert.ok(pool.statements.some((s) => /FROM catalog_libraries l[\s\S]*FOR UPDATE OF l/.test(s.sql)), 'catalog_libraries FOR UPDATE');
  assert.ok(!pool.statements.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql.trim())));
  const frozen = make(fakePool({ lib: { ...LIB, migration_state: 'REVIEW' } }));
  await assert.rejects(frozen.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'LIBRARY_FROZEN' && e.status === 409);
  const q = make(fakePool({ lib: LIB, onQuery: (sql) => (/FROM control_plane_flush_quarantine/.test(sql) ? { rows: [{ ok: 1 }] } : null) }));
  await assert.rejects(q.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'VAULT_QUARANTINED');
  const noLib = make(fakePool({ lib: null }));
  await assert.rejects(noLib.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'LIBRARY_RESET_REQUIRED');
  const sqlErr = make(fakePool({ lib: LIB, onQuery: (sql) => { if (/FROM catalog_operations WHERE user_id = \$1 AND idempotency_key/.test(sql)) throw Object.assign(new Error('x'), { code: '57014' }); } }));
  await assert.rejects(sqlErr.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'CATALOG_QUERY_TIMEOUT' && e.status === 503);
  const native = make(fakePool({ lib: LIB, onQuery: (sql) => { if (/FROM catalog_operations WHERE user_id = \$1 AND idempotency_key/.test(sql)) throw Object.assign(new Error('fence'), { code: 'BGN04' }); } }));
  await assert.rejects(native.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'CATALOG_NATIVE_RULE' && e.status === 409);
});
