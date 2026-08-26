'use strict';

function integerEnv(value, fallback, { min, max, name }) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function postgresConfig(env = process.env) {
  const enabled = String(env.BEATGALER_POSTGRES_ENABLED || '').toLowerCase() === 'true';
  const connectionString = String(env.DATABASE_URL || '').trim();
  if (enabled && !connectionString) {
    throw new Error('BEATGALER_POSTGRES_ENABLED=true requires DATABASE_URL.');
  }
  const sslMode = String(env.BEATGALER_POSTGRES_SSL_MODE || 'require').toLowerCase();
  if (!['disable', 'require'].includes(sslMode)) {
    throw new Error('BEATGALER_POSTGRES_SSL_MODE must be disable or require.');
  }
  return Object.freeze({
    enabled,
    connectionString: enabled ? connectionString : '',
    max: integerEnv(env.BEATGALER_POSTGRES_POOL_MAX, 10, { min: 1, max: 100, name: 'BEATGALER_POSTGRES_POOL_MAX' }),
    connectionTimeoutMillis: integerEnv(env.BEATGALER_POSTGRES_CONNECT_TIMEOUT_MS, 5000, { min: 100, max: 60000, name: 'BEATGALER_POSTGRES_CONNECT_TIMEOUT_MS' }),
    idleTimeoutMillis: integerEnv(env.BEATGALER_POSTGRES_IDLE_TIMEOUT_MS, 30000, { min: 1000, max: 600000, name: 'BEATGALER_POSTGRES_IDLE_TIMEOUT_MS' }),
    statementTimeoutMillis: integerEnv(env.BEATGALER_POSTGRES_STATEMENT_TIMEOUT_MS, 15000, { min: 100, max: 300000, name: 'BEATGALER_POSTGRES_STATEMENT_TIMEOUT_MS' }),
    ssl: enabled && sslMode === 'require' ? { rejectUnauthorized: true } : false,
  });
}

function createPostgresPool(Pool, env = process.env) {
  if (typeof Pool !== 'function') throw new Error('A PostgreSQL Pool constructor is required.');
  const config = postgresConfig(env);
  if (!config.enabled) return null;
  return new Pool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    ssl: config.ssl,
    application_name: 'beatgaler-cloud',
  });
}

module.exports = { postgresConfig, createPostgresPool };
