'use strict';

require('dotenv').config({ quiet: true });
const { createWebBillingRuntime } = require('../billing-web-runtime');

async function main() {
  const runtime = createWebBillingRuntime();
  const result = await runtime.initialize();
  if (!result.ready) {
    console.error(`[web-billing-preflight] FAIL ${result.failureCode}`);
    process.exitCode = 1;
    return;
  }
  console.log('[web-billing-preflight] PASS sandbox paid_entry_monthly_v1 highest_paid_monthly_v1');
}

main().catch(() => {
  console.error('[web-billing-preflight] FAIL WEB_BILLING_UNAVAILABLE');
  process.exitCode = 1;
});
