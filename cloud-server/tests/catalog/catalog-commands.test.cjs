'use strict';
// T07 — Comandos: transformación del documento canónico, precondiciones y contratos con pool falso. Sin red ni DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const commands = require('../../catalog/commands.js');
const authority = require('../../catalog/authority.js');
const { beatRowsFromDoc, patchBeatDto } = require('../../catalog/beat-projection');

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
const make = (pool, options = {}) => commands.createCatalogCommands({ pool, authority: authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' }), ...options });
const H = { era: 'era-1', epoch: '1', idempotencyKey: 'k-1' };

test('rechaza un job de reanudación de 65 caracteres antes de consultar SQL', async () => {
  const pool = fakePool();
  const operationId = 'o'.repeat(32);
  const revision = '123456789012345678';
  await assert.rejects(make(pool).resumeOperation({ ...H, userId: 'u1', operationId, revision }), {
    status: 400, code: 'INPUT_INVALID', detail: { reason: 'OPERATION_ID' },
  });
  assert.equal(pool.statements.length, 0);
});

test('reanuda con el mismo job id cuando mide exactamente 64 caracteres', async () => {
  const operationId = 'o'.repeat(31);
  const revision = '123456789012345678';
  const jobId = `job-op-${operationId}-resume-${revision}`;
  const library = { ...LIB, revision };
  const operation = { operation_id: operationId, status: 'CONFLICT', total_frozen: '3', confirmed: '1', not_executed: '0' };
  const jobs = [];
  const pool = fakePool({ lib: library, onQuery(sql, params) {
    if (sql.includes('FROM catalog_operations o')) return { rows: [operation] };
    if (sql.startsWith("UPDATE catalog_operations SET status = 'RUNNING'")) operation.status = 'RUNNING';
    if (sql.startsWith('INSERT INTO catalog_jobs')) jobs.push(params);
    if (sql.includes('FROM catalog_jobs')) {
      assert.match(sql, /job_id = \$1 AND user_id = \$2 AND operation_id = \$3/);
      return { rows: jobs.filter((job) => job[0] === params[0] && job[1] === params[1] && job[3] === params[2]) };
    }
  } });
  const service = make(pool);
  const input = { ...H, userId: 'u1', operationId, revision };

  const result = await service.resumeOperation(input);

  assert.equal(result.status, 'RUNNING');
  assert.equal(result.resumed, true);
  assert.deepEqual(jobs.map(([id]) => id), [jobId]);

  const sinceResume = pool.statements.length;
  assert.deepEqual(await service.resumeOperation(input), { ...result, replay: true });
  const newRevision = '123456789012345679';
  library.revision = newRevision;
  await assert.rejects(service.resumeOperation({ ...input, revision: newRevision }), {
    status: 409, code: 'OPERATION_TRANSITION_INVALID', detail: { status: 'RUNNING' },
  });

  operation.status = 'COMPLETED';
  operation.confirmed = operation.total_frozen;
  const replay = await service.resumeOperation(input);
  assert.deepEqual([replay.status, replay.progress.confirmed, replay.resumed, replay.replay], ['COMPLETED', 3, true, true]);
  assert.deepEqual(jobs.map(([id]) => id), [jobId]);
  assert.deepEqual(pool.statements.slice(sinceResume).filter(({ sql }) => /^(UPDATE|INSERT|DELETE)\b/.test(sql)), []);
});

test('una operación BLOCKED se puede cancelar y rechaza la reanudación con 409', async () => {
  const operation = { operation_id: 'op1', status: 'BLOCKED', total_frozen: '3', confirmed: '1', not_executed: '0' };
  const pool = fakePool({ lib: LIB, onQuery(sql, params) {
    if (sql.includes('FROM catalog_operations o')) return { rows: [operation] };
    if (sql.startsWith("UPDATE catalog_operations SET status = 'CANCELLED'")) {
      operation.status = 'CANCELLED';
      operation.cancelled = params[2];
      return { rows: [] };
    }
  } });
  const service = make(pool);
  const input = { ...H, userId: 'u1', operationId: 'op1' };
  await assert.rejects(service.resumeOperation({ ...input, revision: '5' }), {
    status: 409, code: 'OPERATION_TRANSITION_INVALID', detail: { status: 'BLOCKED' },
  });
  const cancelled = await service.cancelOperation(input);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.progress.cancelled, 2);
});

test('PATCH conserva la forma y el orden del beat en la respuesta', async (t) => {
  const cases = [
    { name: 'tags y portada ausente', tags: ['Trap'], has_artwork: false, wire: '{"id":"b1","version":"1","state":"ACTIVE","name":"Beat","bpm":"120","key":"Cm","tags":["Trap"],"rating":5,"color":null,"color2":null,"hasArtwork":false}' },
    { name: 'valores nulos del lector', tags: null, has_artwork: null, wire: '{"id":"b1","version":"1","state":"ACTIVE","name":"Beat","bpm":"120","key":"Cm","tags":null,"rating":5,"color":null,"color2":null,"hasArtwork":null}' },
  ];
  for (const { name, tags, has_artwork, wire } of cases) {
    await t.test(name, async () => {
      const row = { id: 'b1', version: '1', state: 'ACTIVE', name: 'Beat', bpm: '120', key: 'Cm', tags, rating: 5, color: null, color2: null, has_artwork };
      assert.equal(JSON.stringify(patchBeatDto(row)), wire);
      const pool = fakePool({ lib: LIB, onQuery(sql) {
        if (sql.includes('SELECT beat_id, state')) return { rows: [{ state: 'ACTIVE', version: '1', legacy_json: '{"rating":5}' }] };
        if (sql.includes('SELECT b.beat_id AS id')) return { rows: [row] };
      } });
      const result = await make(pool).patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { rating: 5 } });
      assert.equal(JSON.stringify(result.beat), wire);
    });
  }
});

test('PATCH conserva escrituras y orden de facetas cuando cambian o se conservan los tags', async (t) => {
  const cases = [
    { patch: { rating: 5 }, tags: ['trap'], golden: '798df688e9d431af1f1be86b7418525a20b173f1e9b52aab554da2f8cd713aaa' },
    { patch: { rating: 5, tags: ['dark', 'trap'] }, tags: ['dark', 'trap'], golden: 'd7bd5ecaff105ce79e05da28e62427c498389549196d2980a1c7b45fccc591e4' },
  ];
  for (const { patch, tags, golden } of cases) {
    await t.test(JSON.stringify(patch), async () => {
      const pool = fakePool({ lib: LIB, onQuery(sql) {
        if (sql.includes('SELECT beat_id, state')) return { rows: [{ state: 'ACTIVE', version: '1', legacy_json: '{"name":"Écho","key":"Cm","rating":3,"tags":["trap"],"color":"#336699"}' }] };
        if (sql.includes('RETURNING version::text')) return { rows: [{ version: '2' }] };
        if (sql.includes('RETURNING revision::text')) return { rows: [{ revision: '6' }] };
        if (sql.includes('max(event_seq)')) return { rows: [{ seq: '2' }] };
        if (sql.includes('SELECT b.beat_id AS id')) return { rows: [{ id: 'b1', version: '2', state: 'ACTIVE', name: 'Écho', bpm: '', key: 'Cm', tags, rating: 5, color: '#336699', color2: null, has_artwork: false }] };
      } });
      const result = await make(pool, { randomUUID: () => 'patch-fixed' }).patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch });
      assert.equal(result.noop, false);
      // Huella de la traza completa (texto SQL, parámetros, orden) y del JSON enviado antes de M4.2.
      assert.equal(createHash('sha256').update(JSON.stringify([pool.statements, result])).digest('hex'), golden);
    });
  }
});

test('filas del documento: columna derivada de BPM y rating de presentación', () => {
  const cases = [
    { doc: { bpm: '-0', rating: '3.9' }, columns: [1, 0, null, 3] },
    { doc: { bpm: 'no-numérico', rating: 999 }, columns: [3, null, null, 255] },
    { doc: { bpm: '-Infinity', rating: 12 }, columns: [0, null, 12, 12] },
  ];
  for (const { doc, columns } of cases) {
    const row = beatRowsFromDoc(doc);
    assert.deepEqual([row.bpmSortClass, row.bpmSort, row.rating, row.ratingDisplay], columns);
  }
});

test('filas del documento: tags históricos conservan posición y espacios internos', () => {
  const row = beatRowsFromDoc({ tags: ['  Lo   Fi  ', null, 'CAFÉ'] });
  assert.deepEqual(row.tags, [
    { position: 0, label: '  Lo   Fi  ', normKey: 'lo   fi', searchKey: '  lo   fi  ' },
    { position: 2, label: 'CAFÉ', normKey: 'café', searchKey: 'café' },
  ]);
});

test('filas del documento: search_text conserva el separador y el orden de los campos', () => {
  const cases = [
    { doc: { name: ' Écho ', key: 'Cm', bpm: '120', tags: [' TRAP ', 'Dark'] }, searchText: 'écho\x1fcm\x1f120\x1f trap \x1fdark' },
    { doc: {}, searchText: 'untitled\x1f\x1f' },
  ];
  for (const { doc, searchText } of cases) assert.equal(beatRowsFromDoc(doc).searchText, searchText);
});

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

test('nombre > 50 caracteres: patch y bulk rechazados antes de la transacción con INPUT_INVALID/name; exactamente 50 pasa la validación', async () => {
  const pool = fakePool({ lib: LIB });
  const c = make(pool);
  const tooLong = (e) => e.code === 'INPUT_INVALID' && e.detail.errors.some((x) => x.field === 'name' && /exceeds 50 characters/.test(x.reason));
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { name: 'ñ'.repeat(51) } }), tooLong);
  await assert.rejects(c.patchBeat({ userId: 'u1', beatId: 'b1', ...H, expectedVersion: '1', patch: { name: 'x'.repeat(70000) } }), (e) => e.code === 'PAYLOAD_TOO_LARGE' || tooLong(e));
});
