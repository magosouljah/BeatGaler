'use strict';

const assert = require('assert');
const { listMigrations, applyMigrations, MIGRATION_LOCK_KEY } = require('../postgres-migrations.js');

function makePool(seed = {}) {
  const ledger = new Map(Object.entries(seed));
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      const text = String(sql).trim();
      calls.push({ text, params });
      if (text.startsWith('SELECT checksum_sha256 FROM schema_migrations')) {
        const value = ledger.get(String(params[0]));
        return { rows: value ? [{ checksum_sha256: value }] : [] };
      }
      if (text.startsWith('INSERT INTO schema_migrations')) {
        ledger.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  return {
    pool: { async connect() { return client; } },
    ledger,
    calls,
    get released() { return released; },
  };
}

(async () => {
  const migrations = listMigrations();
  const first = makePool();
  const result1 = await applyMigrations(first.pool, migrations);
  assert.deepEqual(result1.applied, migrations.map(item => item.version));
  assert.deepEqual(result1.skipped, []);
  assert.equal(first.released, true);
  assert(first.calls.some(call => call.text.includes('pg_advisory_lock') && call.params[0] === MIGRATION_LOCK_KEY));
  assert(first.calls.some(call => call.text === 'BEGIN'));
  assert(first.calls.some(call => call.text === 'COMMIT'));
  assert(first.calls.some(call => call.text.includes('pg_advisory_unlock')));

  const second = makePool(Object.fromEntries(migrations.map(item => [item.version, item.checksumSha256])));
  const result2 = await applyMigrations(second.pool, migrations);
  assert.deepEqual(result2.applied, []);
  assert.deepEqual(result2.skipped, migrations.map(item => item.version));
  assert.equal(second.released, true);

  const mismatch = makePool({ [migrations[0].version]: '0'.repeat(64) });
  await assert.rejects(() => applyMigrations(mismatch.pool, migrations), /checksum mismatch/);
  assert.equal(mismatch.released, true);

  console.log('PASS PostgreSQL migration runner: lock, transaction, idempotency, checksum guard');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
