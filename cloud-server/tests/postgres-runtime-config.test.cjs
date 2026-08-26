'use strict';

const assert = require('assert');
const { postgresConfig, createPostgresPool } = require('../postgres-runtime-config.js');

assert.equal(postgresConfig({}).enabled, false);
assert.throws(() => postgresConfig({ BEATGALER_POSTGRES_ENABLED: 'true' }), /requires DATABASE_URL/);
assert.throws(() => postgresConfig({ BEATGALER_POSTGRES_SSL_MODE: 'prefer' }), /disable or require/);
assert.throws(() => postgresConfig({ BEATGALER_POSTGRES_POOL_MAX: '0' }), /between 1 and 100/);

class FakePool {
  constructor(options) { this.options = options; }
}

assert.equal(createPostgresPool(FakePool, {}), null);
const pool = createPostgresPool(FakePool, {
  BEATGALER_POSTGRES_ENABLED: 'true',
  DATABASE_URL: 'postgres://example.invalid/beatgaler',
  BEATGALER_POSTGRES_SSL_MODE: 'disable',
  BEATGALER_POSTGRES_POOL_MAX: '12',
  BEATGALER_POSTGRES_CONNECT_TIMEOUT_MS: '4000',
  BEATGALER_POSTGRES_IDLE_TIMEOUT_MS: '20000',
  BEATGALER_POSTGRES_STATEMENT_TIMEOUT_MS: '10000',
});
assert.equal(pool.options.max, 12);
assert.equal(pool.options.ssl, false);
assert.equal(pool.options.application_name, 'beatgaler-cloud');
assert.equal(pool.options.statement_timeout, 10000);

console.log('PASS PostgreSQL runtime config: opt-in, bounds, fail-closed');
