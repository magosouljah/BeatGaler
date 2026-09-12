'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  REAL_RENEWAL_PROOF,
  BillingRealRenewalProofError,
  assertRealRenewalAccelerationAvailable,
} = require('../billing-polar-renewal-proof');

test('Task 11 does not treat current_billing_period_end as a paid-renewal test clock', () => {
  assert.equal(REAL_RENEWAL_PROOF.provider, 'polar');
  assert.equal(REAL_RENEWAL_PROOF.environment, 'sandbox');
  assert.equal(REAL_RENEWAL_PROOF.sdkEntry, '@polar-sh/sdk/2026-04');
  assert.equal(REAL_RENEWAL_PROOF.sdkVersion, '1.0.0-alpha.20');
  assert.equal(REAL_RENEWAL_PROOF.supported, false);
  assert.throws(
    () => assertRealRenewalAccelerationAvailable(),
    error => error instanceof BillingRealRenewalProofError
      && error.code === 'BILLING_E2E_REAL_RENEWAL_ACCELERATION_UNAVAILABLE',
  );
});

test('official Task 11 command stops before external side effects while renewal acceleration is unsupported', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'polar-sandbox-e2e-guard.cjs')], {
    encoding: 'utf8',
    env: {},
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /BILLING_E2E_REAL_RENEWAL_ACCELERATION_UNAVAILABLE/);
  assert.match(result.stderr, /No checkout, payment, webhook listener, PostgreSQL database, or Polar subscription mutation was started/);
  assert.doesNotMatch(result.stderr, /polar_oat_|whsec_|postgresql:\/\/[^\s]+:[^\s]+@/i);
});
