'use strict';

require('dotenv').config({ quiet: true });
const { preflightPolarProduction } = require('../billing-production-preflight');

preflightPolarProduction().then(result => {
  console.log(`[polar-production-preflight] PASS api=${result.apiVersion} offers=${result.checkedOffers.join(',')} checkout_created=false`);
}).catch(error => {
  const code = /^(POLAR_PRODUCTION|BILLING)_[A-Z0-9_]{1,70}$/.test(error?.code || error?.message || '')
    ? (error.code || error.message) : 'POLAR_PRODUCTION_PREFLIGHT_FAILED';
  console.error(`[polar-production-preflight] FAIL ${code}`);
  process.exitCode = 1;
});
