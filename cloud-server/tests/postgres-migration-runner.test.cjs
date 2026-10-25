'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listMigrations, applyMigrations, MIGRATION_LOCK_KEY } = require('../postgres-migrations.js');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

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
  const lfSql = 'BEGIN;\nSELECT 1;\nCOMMIT;\n';
  const crlfSql = lfSql.replace(/\n/g, '\r\n');
  const canonicalChecksum = sha256(lfSql);
  const crlfChecksum = sha256(crlfSql);
  assert.notEqual(canonicalChecksum, crlfChecksum);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-migration-runner-'));
  let lfMigration;
  let crlfMigration;
  try {
    const filePath = path.join(tempDir, '0001_example.sql');
    fs.writeFileSync(filePath, lfSql);
    [lfMigration] = listMigrations(tempDir);
    fs.writeFileSync(filePath, crlfSql);
    [crlfMigration] = listMigrations(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  assert.equal(lfMigration.checksumSha256, canonicalChecksum);
  assert.equal(crlfMigration.checksumSha256, canonicalChecksum);

  const historicalCrlf = makePool({ '0001': crlfChecksum });
  assert.deepEqual(await applyMigrations(historicalCrlf.pool, [lfMigration]), {
    applied: [], skipped: ['0001'],
  });
  const historicalLf = makePool({ '0001': canonicalChecksum });
  assert.deepEqual(await applyMigrations(historicalLf.pool, [crlfMigration]), {
    applied: [], skipped: ['0001'],
  });

  const changedSql = 'BEGIN;\nSELECT 2;\nCOMMIT;\n';
  const changed = makePool({ '0001': canonicalChecksum });
  await assert.rejects(
    () => applyMigrations(changed.pool, [{ ...lfMigration, sql: changedSql }]),
    /checksum mismatch/,
  );
  assert.equal(changed.released, true);

  const fresh = makePool();
  assert.deepEqual(await applyMigrations(fresh.pool, [crlfMigration]), {
    applied: ['0001'], skipped: [],
  });
  assert.equal(fresh.ledger.get('0001'), canonicalChecksum);

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
