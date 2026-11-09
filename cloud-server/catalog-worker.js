'use strict';
// T10 — Runner separado del worker del catálogo (TAREAS §T10.1). DESHABILITADO por defecto: exige BEATGALER_CATALOG_WORKER_ENABLED=true,
// control-plane postgres, BEATGALER_CATALOG_NATIVE_ENABLED=true y activación nativa. Sin transporte configurado (gateway T11) solo
// ejecuta jobs SQL (conjuntos, lotes bulk, commits); los de verificación/reconciliación quedan en reintento acotado.
// SIGTERM/SIGINT: deja de reclamar, termina los handlers en curso y sale; leases y checkpoints quedan durables (no borra jobs).
require('dotenv').config({ quiet: true });
const { startPostgresControlPlane } = require('./postgres-bootstrap');
const { prepareControlPlaneCutover } = require('./control-plane-cutover-runtime');
const catalogAuthority = require('./catalog/authority');
const catalogQueries = require('./catalog/queries');
const catalogCommands = require('./catalog/commands');
const catalogOperations = require('./catalog/operations');
const { createCatalogWorker } = require('./catalog/worker');
const catalogPurge = require('./catalog/purge');
const { createFileDeletionJournal } = require('./catalog-deletion-journal');
const accessRuntime = require('./access-runtime');

const WORKER_FLAG = 'BEATGALER_CATALOG_WORKER_ENABLED';

async function main() {
  if (String(process.env[WORKER_FLAG] || '').toLowerCase() !== 'true') { console.log(`[catalog-worker] disabled (${WORKER_FLAG} != true)`); return 0; }
  const started = await startPostgresControlPlane({});
  const pool = started.pool;
  const cutover = await prepareControlPlaneCutover({ pool, env: process.env });
  if (cutover.authority !== 'postgres') { console.error('[catalog-worker] refused: control-plane authority is not postgres'); await pool.end(); return 2; }
  const authority = catalogAuthority.configureCatalogAuthority({ pool, env: process.env, controlPlaneAuthority: cutover.authority });
  if (!authority || !authority.config.nativeEnabled) { console.error('[catalog-worker] refused: native catalog flag is off'); await pool.end(); return 2; }
  await authority.availability(); // activación nativa presente o 503 → salimos
  accessRuntime.configure({ pool });
  const queries = catalogQueries.configureCatalogQueries({ pool, authority, env: process.env });
  const commands = catalogCommands.configureCatalogCommands({ pool, authority });
  const operations = catalogOperations.configureCatalogOperations({ pool, authority, resolveAccess: async (userId) => { const a = await accessRuntime.resolveUserAccess({ id: userId }); const max = a && a.quotas ? a.quotas.max_beats : null; return { maxBeats: max === undefined ? null : max }; } });
  const journalDir = String(process.env.BEATGALER_CATALOG_JOURNAL_DIR || '').trim();
  // T16: purge durable montado sin gateway real: los pasos de borrado quedan en reintento/bloqueo explícito; cleanup real sigue apagado.
  const purge = catalogPurge.configureCatalogPurge({ pool, authority, gateway: null, journal: journalDir ? createFileDeletionJournal({ dir: journalDir }) : null });
  const worker = createCatalogWorker({ pool, operations, queries, commands, transport: null, purge, log: (...a) => console.warn(...a), options: { pollMs: Number(process.env.BEATGALER_CATALOG_WORKER_POLL_MS || 1000) } });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return; shuttingDown = true;
    console.log(`[catalog-worker] ${signal}: stopping (leases and checkpoints stay durable)`);
    await worker.stop();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  worker.start();
  console.log(`[catalog-worker] started owner=${worker.owner} claimMax=${worker.options.claimMax} lease=${worker.options.leaseMs}ms concurrency=${worker.options.globalConcurrency}/${worker.options.perLibraryConcurrency}`);
  setInterval(() => { worker.health().then((h) => console.log('[catalog-worker] health', JSON.stringify(h))).catch(() => {}); }, Number(process.env.BEATGALER_CATALOG_WORKER_HEALTH_MS || 60_000)).unref();
  return null;
}

if (require.main === module) {
  main().then((code) => { if (code !== null && code !== undefined) process.exit(code); }).catch((error) => { console.error('[catalog-worker] fatal', error?.message || error); process.exit(1); });
}
module.exports = { WORKER_FLAG, main };
