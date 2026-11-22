'use strict';
// T10 — Runner separado del worker del catálogo (TAREAS §T10.1). DESHABILITADO por defecto: exige BEATGALER_CATALOG_WORKER_ENABLED=true,
// control-plane postgres, BEATGALER_CATALOG_NATIVE_ENABLED=true y activación nativa. Sin gateway (BEATGALER_CATALOG_GATEWAY_ENABLED) solo
// ejecuta jobs SQL (conjuntos, lotes bulk, commits); los de verificación/reconciliación quedan en reintento acotado.
// SIGTERM/SIGINT: deja de reclamar, termina los handlers en curso y sale; leases y checkpoints quedan durables (no borra jobs).
require('dotenv').config({ quiet: true });
const { startPostgresControlPlane } = require('./postgres-bootstrap');
const { assembleWorkerCatalog } = require('./catalog-assembly');

const WORKER_FLAG = 'BEATGALER_CATALOG_WORKER_ENABLED';

async function main() {
  if (String(process.env[WORKER_FLAG] || '').toLowerCase() !== 'true') { console.log(`[catalog-worker] disabled (${WORKER_FLAG} != true)`); return 0; }
  const started = await startPostgresControlPlane({});
  const pool = started.pool;
  const catalog = await assembleWorkerCatalog({ pool, env: process.env });
  if (!catalog) return 2;
  const { worker, gatewayRuntime, mediaGateway } = catalog;
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return; shuttingDown = true;
    console.log(`[catalog-worker] ${signal}: stopping (leases and checkpoints stay durable)`);
    await worker.stop();
    await gatewayRuntime?.close?.();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  worker.start();
  console.log(`[catalog-worker] started owner=${worker.owner} gateway=${mediaGateway ? 'bot-router(lazy)' : 'none'} claimMax=${worker.options.claimMax} lease=${worker.options.leaseMs}ms concurrency=${worker.options.globalConcurrency}/${worker.options.perLibraryConcurrency}`);
  setInterval(() => { worker.health().then((h) => console.log('[catalog-worker] health', JSON.stringify(h))).catch(() => {}); }, Number(process.env.BEATGALER_CATALOG_WORKER_HEALTH_MS || 60_000)).unref();
  return null;
}

if (require.main === module) {
  main().then((code) => { if (code !== null && code !== undefined) process.exit(code); }).catch((error) => { console.error('[catalog-worker] fatal', error?.message || error); process.exit(1); });
}
module.exports = { WORKER_FLAG, main };
