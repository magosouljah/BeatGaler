#!/usr/bin/env node
'use strict';

const {
  assertRealRenewalAccelerationAvailable,
} = require('../billing-polar-renewal-proof');

try {
  if (process.env.POLAR_SANDBOX_E2E_MODE === 'daily_natural_sandbox') {
    require('./polar-sandbox-daily-config.cjs').readConfig();
    require('./polar-sandbox-daily-e2e.cjs').main().catch(error => {
      const code = /^[A-Z0-9_:-]{1,160}$/.test(error?.code || '') ? error.code : 'DAILY_OPERATION_FAILED';
      console.error(`[billing-e2e] ${code}`);
      process.exitCode = 1;
    });
  } else {
    assertRealRenewalAccelerationAvailable();
  }
} catch (error) {
  const code = String(error?.code || 'BILLING_E2E_REAL_RENEWAL_ACCELERATION_UNAVAILABLE');
  console.error(`[billing-e2e] BLOCKED ${code}. No checkout, payment, webhook listener, PostgreSQL database, or Polar subscription mutation was started by this command.`);
  console.error('[billing-e2e] Task 11 remains PARCIAL until Polar exposes a supported way to produce a real billed renewal on demand, or a natural renewal is observed.');
  process.exitCode = 2;
}
