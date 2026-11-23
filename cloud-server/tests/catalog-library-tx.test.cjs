'use strict';

const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { createLibraryTx, decide } = require('../catalog/library-tx');
const { CatalogAuthorityError } = require('../catalog/authority');
const { CatalogQueryError } = require('../catalog/cursor');
const { PurgeStepError } = require('../catalog/purge');
const { createPrefixPacks } = require('../catalog/prefix-packs');
const { createCatalogMedia } = require('../catalog/media');
const { respondError } = require('../catalog/routes');
const baseline = require('./catalog/library-tx-baseline.cjs');

const headers = { era: '1', epoch: '2' };
const lib = { authority: 'POSTGRES', active_generation_id: 'gen', bot_id: 'bot', chat_id: 'chat' };
const errorBody = ({ code, status, message, detail }) => ({ code, status, message, detail });

function fake({ state = 'IDLE', quarantined = false, missing = false, queryError, releaseArgs = [] } = {}) {
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
    release(...args) { events.push('release'); assert.deepEqual(args, releaseArgs); },
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
const quarantineQuery = ['SELECT 1 FROM control_plane_flush_quarantine WHERE user_id = $1 AND resolved_at IS NULL LIMIT 1', ['u']];
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
  ['prefixPacks.read', false, false, 'BEGIN', 5000, null, true, false, false, false, 'commitFlag'],
  ['media.read', true, false, snapshot, 1000, null, true, false, false, false, 'commitFinally'],
  ['queries.read', true, true, snapshot, 1000, 2000, true, false, false, true, 'commitFinally'],
  ['queries.deriveWrite', true, false, 'BEGIN', 1000, null, true, false, false, true, 'rollback'],
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
    let expectedEvents = baseline[name];
    if (name === 'prefixPacks.read') expectedEvents = expectedEvents.toSpliced(3, 0, quarantineQuery);
    if (name === 'queries.deriveWrite') expectedEvents = expectedEvents.toSpliced(4, 0, quarantineQuery);
    assert.deepEqual(db.events, expectedEvents);
    assert.deepEqual(result, baseline[`${name}.result`] ?? 'value');
  });
}

// §A.3 con los cambios aprobados por D13.1/2 y D13.7.
const nativeCodes = ['BGL01', 'BGN04', 'BGA05', 'BGC02'];
const errorVariants = [
  ['commands', 'mutate', 'reason', 'statement'],
  ['operations', 'mutate', 'reason', 'statement'],
  ['purge', 'mutate', 'reason', 'statement'],
  ['direct', 'mutate', 'sqlstate', 'statement'],
  ['playback', 'mutate', 'reason', 'statement'],
  ['prefixPacks', 'mutate', 'sqlstate', 'statement'],
  ['media', 'read', 'reason', 'statement'],
  ['queries', 'read', 'reason', 'query'],
];
for (const [variant, intent, unavailable, timeoutNoun] of errorVariants) {
  test(`errores SQL: ${variant}`, (t) => {
    t.mock.method(console, 'error', () => {});
    const { errorMap } = decide(variant, { intent });
    for (const error of [new CatalogAuthorityError('AUTHORITY', 409, 'authority'), new CatalogQueryError('QUERY', 400, 'query')]) {
      assert.equal(errorMap(error), error);
    }
    const purgeError = new PurgeStepError('PURGE_PROVIDER_BUSY', 'busy');
    if (variant === 'purge') assert.equal(errorMap(purgeError), purgeError);
    else assert.equal(errorMap(purgeError).code, 'CATALOG_UNAVAILABLE');
    const message = 'pg'.repeat(110);
    for (const code of [...nativeCodes, 'BGR03', '40001', '40P01', '57014', undefined]) {
      const detail = { sqlstate: code || null };
      let expected;
      if (code === '57014') {
        expected = { code: 'CATALOG_QUERY_TIMEOUT', status: 503, message: `CATALOG_QUERY_TIMEOUT: catalog ${timeoutNoun} timed out`, detail };
      } else if (nativeCodes.includes(code)) {
        expected = { code: 'CATALOG_NATIVE_RULE', status: 409, message: 'CATALOG_NATIVE_RULE: database native rule rejected the mutation', detail };
      } else {
        if (unavailable !== 'sqlstate') detail.reason = 'SQL_ERROR';
        expected = { code: 'CATALOG_UNAVAILABLE', status: 503,
          message: unavailable === 'sqlstate' ? 'CATALOG_UNAVAILABLE: catalog database is unavailable' : 'CATALOG_UNAVAILABLE: catalog is unavailable (SQL_ERROR)', detail };
      }
      assert.deepEqual(errorBody(errorMap({ code, message, detail: 'native detail' })), expected, String(code));
    }
  });
}

test('D13.1/2: todas las variantes traducen las cuatro reglas nativas a 409', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [name] of policies) {
    const [variant, intent] = name.split('.');
    for (const code of nativeCodes) {
      const pg = Object.assign(new Error('native rule'), { code });
      const db = fake({ queryError(sql) { if (sql.startsWith('SET LOCAL')) throw pg; } });
      const tx = createLibraryTx({ ...db, variant });
      await assert.rejects(invoke(tx, intent, () => assert.fail('callback ran')), (error) => {
        assert.deepEqual([error.status, error.code, error.detail.sqlstate], [409, 'CATALOG_NATIVE_RULE', code], `${name}: ${code}`);
        return true;
      });
    }
  }
});

test('D13.5: MAIN bloquea lectura y mutación en cuarentena', async () => {
  for (const [call, before] of [
    [(prefix) => prefix.manifest({ userId: 'u' }), []],
    [(prefix) => prefix.cancelMain({ userId: 'u', ...headers, packId: 'pk-12345678' }), ['availability']],
  ]) {
    const db = fake({ quarantined: true });
    await assert.rejects(call(createPrefixPacks(db)), { code: 'VAULT_QUARANTINED', status: 409 });
    assert.deepEqual(db.events, [...before, 'connect', 'BEGIN', 'SET LOCAL statement_timeout = 5000', quarantineQuery, 'ROLLBACK', 'release']);
  }
});

test('D13.6: deriveWrite en cuarentena termina antes de consultar el contexto', async () => {
  const db = fake({ quarantined: true });
  const tx = createLibraryTx({ ...db, variant: 'queries' });
  await assert.rejects(tx.deriveWrite('u', () => 'written'), { code: 'VAULT_QUARANTINED', status: 409 });
  assert.deepEqual(db.events, ['availability', 'connect', 'BEGIN', 'SET LOCAL statement_timeout = 1000', quarantineQuery, 'ROLLBACK', 'release']);
});

test('D13.7: el JSON HTTP omite el texto de PostgreSQL y el log conserva el SQLSTATE', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  for (const [variant, intent, unavailable] of errorVariants) {
    for (const sqlstate of ['40001', 'BGL01']) {
      const native = sqlstate === 'BGL01';
      const pg = Object.assign(new Error('internal constraint name'), { code: sqlstate, detail: 'internal row detail' });
      const db = fake({ queryError(sql) { if (sql.startsWith('SET LOCAL')) throw pg; } });
      const tx = createLibraryTx({ ...db, variant });
      await assert.rejects(invoke(tx, intent, () => assert.fail('callback ran')), (error) => {
        let status;
        const body = respondError({ status(code) { status = code; return this; }, json(value) { return value; } }, error);
        assert.equal(status, native ? 409 : 503, variant);
        assert.equal(body.code, native ? 'CATALOG_NATIVE_RULE' : 'CATALOG_UNAVAILABLE', variant);
        assert.doesNotMatch(JSON.stringify(body), /internal constraint name|internal row detail/, variant);
        assert.deepEqual(body.detail, !native && unavailable === 'reason' ? { sqlstate, reason: 'SQL_ERROR' } : { sqlstate }, variant);
        assert.deepEqual(log.mock.calls.at(-1)?.arguments[1], { variant, sqlstate, message: pg.message, detail: pg.detail });
        return true;
      });
    }
  }
  assert.equal(log.mock.callCount(), errorVariants.length * 2);
});

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

test('plazo total de queries destruye la conexión e impide consultas tardías', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const lateFailure of [false, true]) {
    const { promise: started, resolve: start } = Promise.withResolvers();
    const { promise: pending, resolve: complete, reject: fail } = Promise.withResolvers();
    const db = fake({
      releaseArgs: [true],
      queryError(sql) {
        if (sql === 'SELECT first') {
          start();
          return pending;
        }
      },
    });
    const tx = createLibraryTx({ ...db, variant: 'queries' });
    let continued = false;
    const read = tx.read('u', async ({ client }) => {
      await client.query('SELECT first');
      continued = true;
      await client.query('SELECT second');
    });
    const timedOut = assert.rejects(read, {
      code: 'CATALOG_QUERY_TIMEOUT', status: 503, message: 'CATALOG_QUERY_TIMEOUT: catalog request exceeded the total time budget', detail: { budget_ms: 2000 },
    });
    await started;
    t.mock.timers.tick(2000);
    await timedOut;
    assert.deepEqual(db.events.slice(-2), ['SELECT first', 'release']);

    if (lateFailure) fail(new Error('connection closed'));
    else complete();
    // node:test falla ante un rechazo no gestionado cuando termina este turno.
    await nextTurn();
    assert.equal(continued, !lateFailure);
    assert.deepEqual(db.events.slice(-2), ['SELECT first', 'release']);
  }
});

test('begin fallido se traduce y libera sin finalizar una transacción', async () => {
  const db = fake({ queryError(sql) { if (sql === 'BEGIN') throw Object.assign(new Error('statement timeout'), { code: '57014' }); } });
  await assert.rejects(createLibraryTx({ ...db, variant: 'commands' }).mutate('u', headers, () => assert.fail('callback ran')), {
    code: 'CATALOG_QUERY_TIMEOUT', status: 503, message: 'CATALOG_QUERY_TIMEOUT: catalog statement timed out',
  });
  assert.deepEqual(db.events, ['availability', 'connect', 'BEGIN', 'release']);
});
