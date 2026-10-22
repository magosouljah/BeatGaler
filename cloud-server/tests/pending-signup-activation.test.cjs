'use strict';

const assert = require('node:assert/strict');
const { createPendingSignupActivation } = require('../pending-signup-activation');

assert.throws(
  () => createPendingSignupActivation(),
  error => error?.code === 'LEGACY_SIGNUP_ACTIVATION_DISABLED',
  'legacy handler re-entry must remain permanently disabled',
);

console.log('legacy pending-signup activation shim: DISABLED');
