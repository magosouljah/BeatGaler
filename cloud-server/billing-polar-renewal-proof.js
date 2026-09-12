'use strict';

const REAL_RENEWAL_PROOF = Object.freeze({
  provider: 'polar',
  environment: 'sandbox',
  sdkEntry: '@polar-sh/sdk/2026-04',
  sdkVersion: '1.0.0-alpha.20',
  supported: false,
  code: 'BILLING_E2E_REAL_RENEWAL_ACCELERATION_UNAVAILABLE',
  reason: 'Polar Sandbox can reschedule current_billing_period_end, but the real Task 11 run proved that an accelerated cycle can occur without a new renewal Order or payment when the existing paid coverage has not naturally elapsed. Trial conversion, pause/resume, and manual off-session Orders are different commercial events and are not accepted as renewal evidence.',
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
  BillingRealRenewalProofError,
  assertRealRenewalAccelerationAvailable,
};
