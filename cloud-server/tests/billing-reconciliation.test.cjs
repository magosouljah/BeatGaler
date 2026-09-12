'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeListResult,
  selectSubscription,
  BillingReconciliationError,
} = require('../billing-reconciliation');
const {
  createBillingLogEntry,
  sanitizeDetails,
  safeErrorCode,
} = require('../billing-safe-log');

const NOW = '2026-09-15T00:00:00.000Z';

function sub(id, status = 'active', end = '2026-10-01T00:00:00.000Z') {
  return { id, status, current_period_end: end };
}

test('provider discovery accepts arrays and explicit item envelopes but rejects unknown shapes', () => {
  assert.deepEqual(normalizeListResult([sub('sub_1')], 'Subscription').items.map(item => item.id), ['sub_1']);
  assert.deepEqual(normalizeListResult({ items: [sub('sub_2')], truncated: true }, 'Subscription'), {
    items: [sub('sub_2')],
    truncated: true,
  });
  assert.throws(
    () => normalizeListResult({ surprise: [] }, 'Subscription'),
    error => error instanceof BillingReconciliationError && error.code === 'BILLING_PROVIDER_SNAPSHOT_INVALID',
  );
});

test('one current provider subscription is selected while multiple live subscriptions fail closed', () => {
  assert.equal(selectSubscription([sub('sub_1')], null, NOW).subscription.id, 'sub_1');
  const ambiguous = selectSubscription([sub('sub_1'), sub('sub_2', 'past_due')], null, NOW);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.reason, 'MULTIPLE_SUBSCRIPTIONS_UNEXPECTED');
});

test('historical provider subscriptions do not fabricate a current subscription', () => {
  const result = selectSubscription([
    sub('old_1', 'canceled', '2026-07-01T00:00:00.000Z'),
    sub('old_2', 'canceled', '2026-08-01T00:00:00.000Z'),
  ], null, NOW);
  assert.equal(result.subscription, null);
  assert.equal(result.historicalOnly, true);
});

test('safe billing logs are allowlisted and cannot leak tokens, signed URLs, card fields or raw provider payloads', () => {
  const details = sanitizeDetails({
    userId: 'u1',
    provider: 'polar',
    environment: 'sandbox',
    reason: 'PROVIDER_UNAVAILABLE',
    errorCode: 'POLAR_TIMEOUT',
    token: 'polar_oat_secret',
    url: 'https://signed.example.invalid/path?token=secret',
    cardNumber: '4242424242424242',
    rawPayload: { card: 'secret' },
    previousState: { planId: 'paid_entry', status: 'active', accessToken: 'secret' },
  });
  const serialized = JSON.stringify(details);
  assert.match(serialized, /paid_entry/);
  for (const forbidden of ['polar_oat_secret', 'signed.example.invalid', '4242424242424242', 'rawPayload', 'accessToken']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('unsafe error messages are reduced to a bounded code before logging', () => {
  const error = Object.assign(new Error('secret https://signed.example.invalid'), { code: 'polar-timeout' });
  assert.equal(safeErrorCode(error), 'POLAR-TIMEOUT');
  const entry = createBillingLogEntry('reconciliation_failed', {
    userId: 'u1',
    errorCode: safeErrorCode(error),
    message: error.message,
  }, new Date(NOW));
  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes('signed.example.invalid'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.match(serialized, /POLAR-TIMEOUT/);
});
