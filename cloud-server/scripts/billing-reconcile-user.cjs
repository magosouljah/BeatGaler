'use strict';

const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { controlPlaneAuthorityConfig } = require('../control-plane-authority');
const { createPostgresPool } = require('../postgres-runtime-config');
const { createWebBillingRuntime } = require('../billing-web-runtime');
const { createReconciliationRuntime } = require('../billing-reconciliation-runtime');
const { safeErrorCode } = require('../billing-safe-log');

async function reconcileManualUser({ pool, adapter, userId, logger } = {}) {
  const runtime = createReconciliationRuntime({ pool, adapter, authority: 'postgres', logger });
  return runtime.reconcileUser({ userId, reconciliationId: `manual_${crypto.randomUUID()}`, mode: 'manual' });
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run billing:reconcile -- --user-id <BeatGaler user ID>');
    return;
  }
  if (args.length !== 2 || args[0] !== '--user-id' || !String(args[1]).trim()) {
    throw Object.assign(new Error('User ID is required.'), { code: 'BILLING_RECONCILIATION_INVALID' });
  }
  require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  const config = controlPlaneAuthorityConfig(process.env);
  if (config.authority !== 'postgres') throw Object.assign(new Error('PostgreSQL authority is required.'), { code: 'BILLING_RECONCILIATION_AUTHORITY_REQUIRED' });
  const pool = createPostgresPool(Pool);
  try {
    const marker = (await pool.query("SELECT snapshot_sha256,state FROM control_plane_cutovers WHERE id='legacy-json-v1'")).rows[0];
    if (marker?.state !== 'READY' || marker.snapshot_sha256 !== config.expectedSnapshotSha256) {
      throw Object.assign(new Error('PostgreSQL cutover is not ready.'), { code: 'BILLING_RECONCILIATION_AUTHORITY_REQUIRED' });
    }
    const billing = createWebBillingRuntime();
    if (!(await billing.initialize()).ready) throw Object.assign(new Error('Billing is unavailable.'), { code: 'BILLING_RECONCILIATION_UNAVAILABLE' });
    const result = await reconcileManualUser({ pool, adapter: billing.provider(), userId: args[1].trim() });
    console.log(JSON.stringify({ reconciled: result.reconciled, repaired: Boolean(result.repaired),
      reason: result.reason || null, effectivePlanBefore: result.effectivePlanBefore || null,
      effectivePlanAfter: result.effectivePlanAfter || null, entitlementGranted: result.entitlementGranted }));
    if (!result.reconciled) process.exitCode = 2;
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => {
  console.error(`[billing-reconcile] FAIL ${safeErrorCode(error)}`);
  process.exitCode = 1;
});
module.exports = { reconcileManualUser, main };
