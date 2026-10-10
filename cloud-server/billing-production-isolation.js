'use strict';

// Access resolves billing_subscription_state by user, so mixed Sandbox/Live
// financial rows in one productive database could grant test-paid access.
async function assertProductionBillingIsolation(pool) {
  if (!pool || typeof pool.query !== 'function') throw new Error('BILLING_PRODUCTION_ISOLATION_UNAVAILABLE');
  const result = await pool.query(`
    SELECT (
      EXISTS (SELECT 1 FROM billing_subscription_state
        WHERE (provider IS NOT NULL OR provider_environment IS NOT NULL OR
          plan_id <> 'free' OR status <> 'inactive' OR provider_customer_id IS NOT NULL OR
          provider_subscription_id IS NOT NULL OR paid_through IS NOT NULL OR grace_until IS NOT NULL)
          AND (provider IS DISTINCT FROM 'polar' OR provider_environment IS DISTINCT FROM 'production'))
      OR EXISTS (SELECT 1 FROM billing_customers
        WHERE provider IS DISTINCT FROM 'polar' OR provider_environment IS DISTINCT FROM 'production')
      OR EXISTS (SELECT 1 FROM billing_checkout_requests
        WHERE provider IS DISTINCT FROM 'polar' OR provider_environment IS DISTINCT FROM 'production')
      OR EXISTS (SELECT 1 FROM billing_payments
        WHERE provider IS DISTINCT FROM 'polar' OR provider_environment IS DISTINCT FROM 'production')
      OR EXISTS (SELECT 1 FROM billing_webhook_events
        WHERE provider IS DISTINCT FROM 'polar' OR provider_environment IS DISTINCT FROM 'production')
      OR EXISTS (SELECT 1 FROM billing_provider_actions
        WHERE provider IS DISTINCT FROM 'polar' OR provider_environment IS DISTINCT FROM 'production')
    ) AS mixed_billing_environment
  `);
  if (result.rows?.[0]?.mixed_billing_environment !== false) {
    throw new Error('BILLING_PRODUCTION_ISOLATION_FAILED');
  }
}

function currentSellableCheckout({ environment, salesEnabled = false, currentCheckout, webhookStatus,
  lifecycleStatus, reconciliationStatus }) {
  if (environment === 'production' &&
      (!salesEnabled || !webhookStatus().ready || !lifecycleStatus().running ||
        !lifecycleStatus().healthy || !reconciliationStatus().running || !reconciliationStatus().healthy)) return null;
  return currentCheckout();
}

module.exports = { assertProductionBillingIsolation, currentSellableCheckout };
