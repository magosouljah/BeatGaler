'use strict';

const REAL_RENEWAL_PROOF = Object.freeze({
  strategy: 'monthly_accelerated',
  provider: 'polar',
  environment: 'sandbox',
  sdkEntry: '@polar-sh/sdk/2026-04',
  sdkVersion: '1.0.0-alpha.20',
  supported: false,
  code: 'BILLING_E2E_REAL_RENEWAL_ACCELERATION_UNAVAILABLE',
  reason: 'Polar Sandbox can reschedule current_billing_period_end, but the real Task 11 run proved that an accelerated cycle can occur without a new renewal Order or payment when the existing paid coverage has not naturally elapsed. Trial conversion, pause/resume, and manual off-session Orders are different commercial events and are not accepted as renewal evidence.',
});

// Implementation support is not an E2E PASS. Only a new paid Order plus a real
// verified webhook and persistent projection can satisfy the daily proof.
const DAILY_NATURAL_PROOF = Object.freeze({
  strategy: 'daily_natural_sandbox', provider: 'polar', environment: 'sandbox',
  supported: true, requires: Object.freeze(['explicit_daily_config', 'validated_day_1_products',
    'isolated_persistent_database', 'second_paid_cycle_order', 'real_signed_webhook', 'deferred_access', 'reconciliation']),
});

class BillingRealRenewalProofError extends Error {
  constructor(message = REAL_RENEWAL_PROOF.reason) {
    super(message);
    this.name = 'BillingRealRenewalProofError';
    this.code = REAL_RENEWAL_PROOF.code;
  }
}

function assertRealRenewalAccelerationAvailable() {
  if (!REAL_RENEWAL_PROOF.supported) {
    throw new BillingRealRenewalProofError();
  }
  return REAL_RENEWAL_PROOF;
}

module.exports = {
  REAL_RENEWAL_PROOF,
  DAILY_NATURAL_PROOF,
  BillingRealRenewalProofError,
  assertRealRenewalAccelerationAvailable,
};
