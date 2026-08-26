'use strict';

const { postgresConfig, createPostgresPool } = require('./postgres-runtime-config');
const { applyMigrations } = require('./postgres-migrations');

async function startPostgresControlPlane({ env = process.env, PoolCtor, apply = applyMigrations } = {}) {
  const config = postgresConfig(env);
  if (!config.enabled) return Object.freeze({ enabled: false, pool: null, migrations: null });

  const Pool = PoolCtor || require('pg').Pool;
  const pool = createPostgresPool(Pool, env);
  try {
    const migrations = await apply(pool);
    return Object.freeze({ enabled: true, pool, migrations });
  } catch (error) {
    try { await pool.end(); } catch (_) {}
    throw error;
  }
}

function installPostgresShutdown(pool, processLike = process) {
  if (!pool || typeof pool.end !== 'function') return () => {};
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await pool.end(); } catch (_) {}
  };
  const onSignal = () => { void close(); };
  processLike.once('SIGINT', onSignal);
  processLike.once('SIGTERM', onSignal);
  return close;
}

module.exports = { startPostgresControlPlane, installPostgresShutdown };
