'use strict';

const KNOWN_STATUSES = new Set(['inactive','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']);
const KNOWN_PLANS = new Set(['free','paid_entry','highest_paid']);

class BillingReconciliationError extends Error {
  constructor(message, code = 'BILLING_RECONCILIATION_FAILED') {
    super(message); this.name = 'BillingReconciliationError'; this.code = code;
  }
}

function normalizeProviderSubscription(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new BillingReconciliationError('Provider subscription snapshot is required.', 'BILLING_PROVIDER_SNAPSHOT_INVALID');
  const customerId = String(snapshot.customerId || snapshot.customer_id || '').trim();
  const subscriptionId = String(snapshot.subscriptionId || snapshot.subscription_id || '').trim();
  const status = String(snapshot.status || '').trim();
  const planId = String(snapshot.planId || snapshot.plan_id || '').trim();
  if (!customerId || !subscriptionId || !KNOWN_STATUSES.has(status) || !KNOWN_PLANS.has(planId)) {
    throw new BillingReconciliationError('Provider subscription snapshot is incomplete or unknown.', 'BILLING_PROVIDER_SNAPSHOT_INVALID');
  }
  return Object.freeze({ customerId, subscriptionId, status, planId });
}

function sameSubscription(local, provider) {
  return Boolean(local) && String(local.provider_customer_id || '') === provider.customerId &&
    String(local.provider_subscription_id || '') === provider.subscriptionId &&
    String(local.status || '') === provider.status && String(local.plan_id || '') === provider.planId;
}

function createBillingReconciliationService({ pool, provider }) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is required.');
  if (!provider || typeof provider.fetchSubscription !== 'function') throw new Error('Billing provider reconciliation adapter is required.');
  return Object.freeze({
    async reconcile({ userId, reconciliationId }) {
      const uid = String(userId || '').trim();
      const key = String(reconciliationId || '').trim();
      if (!uid || !key) throw new BillingReconciliationError('User and reconciliation identity are required.', 'BILLING_RECONCILIATION_INVALID');
      let providerSnapshot;
      try { providerSnapshot = normalizeProviderSubscription(await provider.fetchSubscription({ userId: uid })); }
      catch (error) {
        if (error instanceof BillingReconciliationError) throw error;
        throw new BillingReconciliationError('Provider reconciliation lookup failed.', 'BILLING_PROVIDER_UNAVAILABLE');
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing-reconcile:${uid}`]);
        const local = (await client.query('SELECT provider_customer_id,provider_subscription_id,plan_id,status FROM billing_subscription_state WHERE user_id=$1 FOR UPDATE', [uid])).rows[0] || null;
        if (sameSubscription(local, providerSnapshot)) {
          await client.query("UPDATE billing_reconciliation_exceptions SET state='RESOLVED',resolved_at=now(),updated_at=now() WHERE exception_key=$1 AND state='OPEN'", [key]);
          await client.query('COMMIT');
          return { reconciled: true, divergent: false, entitlementGranted: false };
        }
        const localSnapshot = local || { missing: true };
        await client.query(`INSERT INTO billing_reconciliation_exceptions(
          exception_key,user_id,provider_customer_id,provider_subscription_id,reason,provider_snapshot,local_snapshot,state,attempt_count,created_at,updated_at)
          VALUES($1,$2,$3,$4,'STATE_DIVERGENCE',$5::jsonb,$6::jsonb,'OPEN',1,now(),now())
          ON CONFLICT(exception_key) DO UPDATE SET
            provider_customer_id=EXCLUDED.provider_customer_id,provider_subscription_id=EXCLUDED.provider_subscription_id,
            provider_snapshot=EXCLUDED.provider_snapshot,local_snapshot=EXCLUDED.local_snapshot,state='OPEN',
            attempt_count=billing_reconciliation_exceptions.attempt_count+1,last_error=NULL,resolved_at=NULL,updated_at=now()`,
          [key,uid,providerSnapshot.customerId,providerSnapshot.subscriptionId,JSON.stringify(providerSnapshot),JSON.stringify(localSnapshot)]);
        await client.query('COMMIT');
        return { reconciled: false, divergent: true, exceptionKey: key, entitlementGranted: false };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        try { await pool.query("UPDATE billing_reconciliation_exceptions SET last_error=$2,updated_at=now() WHERE exception_key=$1", [key,String(error?.message || error).slice(0,500)]); } catch (_) {}
        throw new BillingReconciliationError();
      } finally { client.release(); }
    },
  });
}

module.exports = { BillingReconciliationError, normalizeProviderSubscription, sameSubscription, createBillingReconciliationService };
