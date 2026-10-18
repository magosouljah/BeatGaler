'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startPostgresControlPlane } = require('../postgres-bootstrap');

test('failed migration signals the condition and closes the disposable pool', async () => {
  let closed = false;
  let signalled = 0;
  class Pool { async end() { closed = true; } }
  await assert.rejects(startPostgresControlPlane({
    env: { BEATGALER_POSTGRES_ENABLED: 'true', DATABASE_URL: 'postgres://example.invalid/test',
      BEATGALER_POSTGRES_SSL_MODE: 'disable' },
    PoolCtor: Pool,
    apply: async () => { throw new Error('synthetic migration failure'); },
    onMigrationError: () => { signalled += 1; },
  }), /synthetic migration failure/);
  assert.equal(signalled, 1);
  assert.equal(closed, true);
});

test('a broken condition logger cannot hide the migration error or skip pool close', async () => {
  let closed = false;
  class Pool { async end() { closed = true; } }
  await assert.rejects(startPostgresControlPlane({
    env: { BEATGALER_POSTGRES_ENABLED: 'true', DATABASE_URL: 'postgres://example.invalid/test',
      BEATGALER_POSTGRES_SSL_MODE: 'disable' },
    PoolCtor: Pool,
    apply: async () => { throw new Error('original migration error'); },
    onMigrationError: () => { throw new Error('logger error'); },
  }), /original migration error/);
  assert.equal(closed, true);
});
