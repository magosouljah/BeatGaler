'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLibraryTx, decide } = require('../catalog/library-tx');
const { CatalogAuthorityError } = require('../catalog/authority');
const { CatalogQueryError } = require('../catalog/cursor');
const { PurgeStepError } = require('../catalog/purge');
const { createPrefixPacks } = require('../catalog/prefix-packs');
const { createCatalogMedia } = require('../catalog/media');
const baseline = require('./catalog/library-tx-baseline.cjs');

const headers = { era: '1', epoch: '2' };
const lib = { authority: 'POSTGRES', active_generation_id: 'gen', bot_id: 'bot', chat_id: 'chat' };
const errorBody = ({ code, status, message, detail }) => ({ code, status, message, detail });

function fake({ state = 'IDLE', quarantined = false, missing = false, queryError } = {}) {
  const events = [];
  const ctx = { migration_state: state };
  const client = {
    async query(sql, params) {
      events.push(params ? [sql, params] : sql);
      if (queryError) await queryError(sql);
      if (sql.includes('control_plane_flush_quarantine')) return { rows: quarantined ? [{}] : [] };
      if (sql.includes('FROM catalog_libraries')) return { rows: missing ? [] : [lib] };
      if (sql.includes('FROM catalog_file_parts')) return { rows: [{ size_bytes: '1', status: 'VERIFIED' }] };
      return { rows: [] };
    },
    release(...args) { events.push('release'); assert.deepEqual(args, []); },
  };
  const pool = { async connect() { events.push('connect'); return client; } };
  const authority = {
    async availability() { events.push('availability'); },
    async requireLibraryForMutation(locked, request) {
      assert.equal(locked, client);
      events.push(['requireLibraryForMutation', request]);
      return ctx;
    },
    async resolveContext(request) { events.push(['resolveContext', request]); },
  };
  return { events, pool, authority, client, ctx };
}

function invoke(tx, intent, fn) {
  return intent === 'mutate' || intent === 'continuePurge' ? tx[intent]('u', headers, fn) : tx[intent]('u', fn);
}

const snapshot = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
// §A.1–A.2: availability, pool check, BEGIN, statement/total budgets, quarantine, lock, frozen, context lookup, finish.
const policies = [
  ['commands.mutate', true, true, 'BEGIN', 1000, null, true, true, true, false, 'commitFlag'],
  ['commands.read', true, false, snapshot, 1000, null, false, false, false, false, 'commitFinally'],
  ['operations.mutate', true, false, 'BEGIN', 1000, null, true, true, true, false, 'commitFlag'],
  ['operations.read', true, false, snapshot, 1000, null, false, false, false, false, 'commitFinally'],
  ['purge.mutate', true, false, 'BEGIN', 1000, null, true, true, true, false, 'commitFlag'],
  ['purge.continuePurge', true, false, 'BEGIN', 1000, null, true, true, false, false, 'commitFlag'],
  ['purge.read', true, false, snapshot, 1000, null, false, false, false, false, 'commitFinally'],
  ['direct.mutate', true, false, 'BEGIN', 1000, null, true, true, true, false, 'commitFlag'],
  ['playback.mutate', true, false, 'BEGIN', 1000, null, true, true, false, false, 'commitFlag'],
  ['playback.read', true, false, snapshot, 1000, null, false, false, false, false, 'commitFinally'],
  ['prefixPacks.mutate', true, false, 'BEGIN', 5000, null, true, true, true, false, 'commitFlag'],
  ['prefixPacks.read', false, false, 'BEGIN', 5000, null, false, false, false, false, 'commitFlag'],
  ['media.read', true, false, snapshot, 1000, null, true, false, false, false, 'commitFinally'],
  ['queries.read', true, true, snapshot, 1000, 2000, true, false, false, true, 'commitFinally'],
  ['queries.deriveWrite', true, false, 'BEGIN', 1000, null, false, false, false, true, 'rollback'],
];

for (const [name, availability, checkPool, begin, timeoutMs, deadlineMs, quarantine, lock, rejectsFrozen, queryContext, onError] of policies) {
  const [variant, intent] = name.split('.');
  test(`política pura: ${name}`, () => {
    const { frozenError, errorMap, ...policy } = decide(variant, { intent });
    assert.deepEqual(policy, { availability, checkPool, begin, timeoutMs, deadlineMs, quarantine, lock, queryContext, onError });
    assert.equal(frozenError({ migration_state: 'IDLE' }), null);
    const error = frozenError({ migration_state: 'FROZEN' });
    assert.deepEqual(error && errorBody(error), rejectsFrozen ? {
      code: 'LIBRARY_FROZEN', status: 409, message: 'LIBRARY_FROZEN: library is not accepting mutations', detail: { migration_state: 'FROZEN' },
    } : null);
  });

  test(`secuencia base: ${name}`, async () => {
    const db = fake({ state: intent === 'continuePurge' ? 'FROZEN' : 'IDLE' });
    let result;
    if (variant === 'prefixPacks') {
      const prefix = createPrefixPacks(db);
      result = intent === 'read' ? await prefix.manifest({ userId: 'u' })
        : await prefix.cancelMain({ userId: 'u', ...headers, packId: 'pk-12345678' });
    } else if (variant === 'media') {
      result = await createCatalogMedia(db).confirmBytes({ userId: 'u', fileId: 'file', partIndex: 0, sha256: 'a'.repeat(64), size: 1 });
    } else {
      const library = createLibraryTx({ ...db, variant });
      result = await invoke(library, intent, (tx) => {
        db.events.push('body');
        assert.deepEqual(Object.keys(tx).sort(), ['client', 'ctx', 'uid']);
        assert.equal(tx.client, db.client);
        assert.equal(tx.uid, 'u');
        assert.equal(tx.ctx, queryContext ? lib : lock ? db.ctx : undefined);
        return 'value';
      });
      assert.equal(typeof library.continuePurge, variant === 'purge' ? 'function' : 'undefined');
    }
    assert.deepEqual(db.events, baseline[name]);
    assert.deepEqual(result, baseline[`${name}.result`] ?? 'value');
  });
}

// §A.3: native rule coverage, native detail, unclassified detail and exact timeout text.
for (const [variant, intent, nativeCodes, withDetail, unavailable, timeoutNoun] of [
  ['commands', 'mutate', ['BGL01', 'BGN04', 'BGA05'], true, 'sqlMessage', 'statement'],
  ['operations', 'mutate', ['BGL01', 'BGN04', 'BGA05', 'BGC02'], true, 'sqlMessage', 'statement'],
  ['purge', 'mutate', ['BGL01', 'BGN04', 'BGA05', 'BGC02'], true, 'sqlMessage', 'statement'],
  ['direct', 'mutate', ['BGL01', 'BGN04', 'BGA05', 'BGC02'], true, 'sqlstate', 'statement'],
  ['playback', 'mutate', ['BGL01', 'BGN04', 'BGA05', 'BGC02'], false, 'sqlMessage', 'statement'],
  ['prefixPacks', 'mutate', [], false, 'sqlstate', 'statement'],
  ['media', 'read', [], false, 'sqlMessage', 'statement'],
  ['queries', 'read', [], false, 'reason', 'query'],
]) {
  test(`errores SQL: ${variant}`, () => {
    const { errorMap } = decide(variant, { intent });
    for (const error of [new CatalogAuthorityError('AUTHORITY', 409, 'authority'), new CatalogQueryError('QUERY', 400, 'query')]) {
      assert.equal(errorMap(error), error);
    }
    const purgeError = new PurgeStepError('PURGE_PROVIDER_BUSY', 'busy');
    if (variant === 'purge') assert.equal(errorMap(purgeError), purgeError);
    else assert.equal(errorMap(purgeError).code, 'CATALOG_UNAVAILABLE');
    const message = 'pg'.repeat(110);
    for (const code of ['BGL01', 'BGN04', 'BGA05', 'BGC02', 'BGR03', '40001', '40P01', '57014', undefined]) {
      const detail = { sqlstate: code || null };
      let expected;
      if (code === '57014') {
        expected = { code: 'CATALOG_QUERY_TIMEOUT', status: 503, message: `CATALOG_QUERY_TIMEOUT: catalog ${timeoutNoun} timed out`, detail };
      } else if (nativeCodes.includes(code)) {
        if (withDetail) detail.detail = 'native detail';
        expected = { code: 'CATALOG_NATIVE_RULE', status: 409, message: 'CATALOG_NATIVE_RULE: database native rule rejected the mutation', detail };
      } else {
        if (unavailable !== 'sqlstate') detail.reason = 'SQL_ERROR';
        if (unavailable === 'sqlMessage') detail.sql_message = code ? message.slice(0, 200) : null;
        expected = { code: 'CATALOG_UNAVAILABLE', status: 503,
          message: unavailable === 'sqlstate' ? 'CATALOG_UNAVAILABLE: catalog database is unavailable' : 'CATALOG_UNAVAILABLE: catalog is unavailable (SQL_ERROR)', detail };
      }
      assert.deepEqual(errorBody(errorMap({ code, message, detail: 'native detail' })), expected, String(code));
    }
  });
}

test('cierre ante error: commit estricto, rollback o commit en finally según la intención', async () => {
  for (const [name, , , , , , , , , , onError] of policies) {
    const [variant, intent] = name.split('.');
    for (const commit of [true, 'true', undefined]) {
      const db = fake();
      const tx = createLibraryTx({ ...db, variant });
      const error = Object.assign(new CatalogQueryError('TEST_ERROR', 409, 'test error'), { commit });
      await assert.rejects(invoke(tx, intent, () => { throw error; }), (found) => found === error);
      const close = onError === 'commitFinally' || (onError === 'commitFlag' && commit === true) ? 'COMMIT' : 'ROLLBACK';
      assert.deepEqual(db.events.slice(-2), [close, 'release'], `${name}: ${String(commit)}`);
    }
  }
});

test('cuarentena rechaza antes de bloquear y la lectura confirma en finally', async () => {
  for (const [name, , , , , , , , , , onError] of policies.filter((row) => row[6])) {
    const [variant, intent] = name.split('.');
    const db = fake({ quarantined: true });
    await assert.rejects(invoke(createLibraryTx({ ...db, variant }), intent, () => assert.fail('callback ran')), {
      code: 'VAULT_QUARANTINED', status: 409, message: 'VAULT_QUARANTINED: vault is quarantined by the control-plane flush', detail: {},
    });
    assert.ok(!db.events.some((event) => event[0] === 'requireLibraryForMutation'), name);
    assert.deepEqual(db.events.slice(-2), [onError === 'commitFinally' ? 'COMMIT' : 'ROLLBACK', 'release']);
  }
});

test('queries sin biblioteca conserva el orden de resolveContext y el segundo rollback', async () => {
  const lookup = ['resolveContext', { userId: 'u' }];
  for (const [intent, suffix] of [
    ['read', ['COMMIT', 'release', lookup]],
    ['deriveWrite', ['ROLLBACK', lookup, 'ROLLBACK', 'release']],
  ]) {
    const db = fake({ missing: true });
    const tx = createLibraryTx({ ...db, variant: 'queries' });
    await assert.rejects(invoke(tx, intent, () => assert.fail('callback ran')), {
      code: 'CATALOG_UNAVAILABLE', status: 503, detail: { reason: 'CONTEXT_RACE' },
    });
    assert.deepEqual(db.events.slice(-suffix.length), suffix);
  }
});

test('plazo total de queries libera la conexión aunque el callback siga pendiente', { timeout: 4000 }, async () => {
  const db = fake();
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const tx = createLibraryTx({ ...db, variant: 'queries' });
  try {
    await assert.rejects(tx.read('u', () => pending), {
      code: 'CATALOG_QUERY_TIMEOUT', status: 503, message: 'CATALOG_QUERY_TIMEOUT: catalog request exceeded the total time budget', detail: { budget_ms: 2000 },
    });
    assert.equal(db.events.at(-1), 'release');
    assert.ok(!db.events.includes('COMMIT'));
  } finally {
    complete();
  }
});

test('begin fallido se traduce y libera sin finalizar una transacción', async () => {
  const db = fake({ queryError(sql) { if (sql === 'BEGIN') throw Object.assign(new Error('statement timeout'), { code: '57014' }); } });
  await assert.rejects(createLibraryTx({ ...db, variant: 'commands' }).mutate('u', headers, () => assert.fail('callback ran')), {
    code: 'CATALOG_QUERY_TIMEOUT', status: 503, message: 'CATALOG_QUERY_TIMEOUT: catalog statement timed out',
  });
  assert.deepEqual(db.events, ['availability', 'connect', 'BEGIN', 'release']);
});
