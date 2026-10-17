'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveFailureProgress, verifyFailureRecovery, refreshFailureHeader } = require('../scripts/polar-sandbox-failure-progress.cjs');

// Synthetic fixtures test bookkeeping; they are never provider-real evidence.
const at = n => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
function fixture() {
  const payment = { id: 'initial-payment', orderId: 'initial-order', status: 'succeeded', amountMinor: 100,
    currency: 'usd', processor: 'stripe', trigger: 'purchase', createdAt: at(1) };
  const failed = { ...payment, id: 'failed-cycle', orderId: 'renewal-order', status: 'failed', trigger: 'subscription_cycle', createdAt: at(11) };
  const retry = { ...failed, id: 'failed-retry', trigger: 'retry_customer', createdAt: at(15) };
  const paid = { ...retry, id: 'paid-retry', status: 'succeeded', createdAt: at(20) };
  const initial = { providerStatus: 'active', commercialAccessState: 'paid', effectivePlanId: 'paid_entry',
    subscriptionId: 'sub', customerId: 'customer', paidThrough: at(10), pastDueAt: null, graceUntil: null,
    quotas: { max_beats: 100 }, capabilities: { early_access: false },
    payments: [{ orderId: payment.orderId, status: 'succeeded', periodEnd: at(10) }] };
  const grace = { ...initial, providerStatus: 'past_due', commercialAccessState: 'grace',
    pastDueAt: Date.parse(at(11)), graceUntil: Date.parse(at(11)) + 604800000 };
  const recovered = { ...initial, paidThrough: at(30), payments: [...initial.payments,
    { orderId: failed.orderId, status: 'succeeded', periodEnd: at(30) }] };
  const observations = [
    { at: at(2), financialPayments: [payment], snapshot: initial },
    { at: at(12), financialPayments: [failed, payment], snapshot: grace },
    { at: at(16), financialPayments: [retry, failed, payment], snapshot: grace },
    // API payment settlement can precede the local lifecycle projection.
    { at: at(21), financialPayments: [paid, retry, failed, payment], snapshot: grace },
    { at: at(22), financialPayments: [paid, retry, failed, payment], snapshot: recovered },
  ];
  const state = { runId: 'fixture', result: 'PARTIAL', checkpoint: 'INITIAL_PAID_OBSERVED',
    lastErrorCode: 'FAILURE_PROBE_FAILED', updatedAt: at(23), observations };
  return { state, financialOrder: { id: failed.orderId, subscriptionId: 'sub', customerId: 'customer', billingReason: 'subscription_cycle',
    paid: true, status: 'paid', amountMinor: 100, currency: 'usd', refundedAmountMinor: 0, periodStart: at(10), periodEnd: at(30), payments: [failed, retry, paid] },
  receipts: [{ eventType: 'subscription.past_due', subjectId: 'sub', state: 'PROCESSED', signatureVerified: true, replayDeduplicated: true },
    { eventType: 'order.paid', subjectId: 'renewal-order', state: 'PROCESSED', signatureVerified: true, replayDeduplicated: true }],
  reconciled: true, repeatRepaired: false, snapshot: recovered };
}

test('failed cycle and retry preserve grace; payment success alone is not recovery', () => {
  const { state } = fixture();
  assert.equal(deriveFailureProgress(state.observations.slice(0, 1)).checkpoint, 'INITIAL_PAID_OBSERVED');
  assert.equal(deriveFailureProgress(state.observations.slice(0, 2)).checkpoint, 'PAST_DUE_OBSERVED');
  assert.equal(deriveFailureProgress(state.observations.slice(0, 4)).checkpoint, 'PAST_DUE_OBSERVED');
  assert.equal(deriveFailureProgress(state.observations).checkpoint, 'RECOVERY_OBSERVED');
});

test('rebuild stale header without editing observations; clear active error even on unchanged snapshot', () => {
  const { state } = fixture(), original = structuredClone(state.observations);
  assert.equal(refreshFailureHeader(state, at(25)), true);
  assert.equal(state.checkpoint, 'RECOVERY_OBSERVED');
  assert.equal(state.result, 'PARTIAL'); // Observations alone do not certify the receipt.
  assert.equal(state.lastErrorCode, undefined);
  assert.equal(state.observationErrors[0].code, 'FAILURE_PROBE_FAILED');
  assert.deepEqual(state.observations, original);
  assert.equal(refreshFailureHeader(state, at(26)), false);
  state.lastErrorCode = 'TEMPORARY_QUERY_FAILURE';
  assert.equal(refreshFailureHeader(state, at(27)), true);
  assert.equal(state.observationErrors.length, 2);
});

test('verified recovery survives later polls and cancellation without regressing to initial paid', () => {
  const f = fixture();
  f.state.recoveryVerification = verifyFailureRecovery(f);
  refreshFailureHeader(f.state, at(25));
  assert.equal(f.state.checkpoint, 'RECOVERY_VERIFIED');
  assert.equal(f.state.result, 'PASS');
  f.state.observations.push({ ...f.state.observations.at(-1), at: at(28), snapshot: { ...f.snapshot, cancelAtPeriodEnd: true } });
  refreshFailureHeader(f.state, at(29));
  assert.equal(f.state.checkpoint, 'RECOVERY_VERIFIED');
  assert.equal(f.state.recoveryVerification.scope, 'failed_renewal_grace_recovery_only');
});

test('a paid new cycle without an observed failed cycle cannot certify failed-renewal recovery', () => {
  const f = fixture(); f.state.observations = [f.state.observations[0], f.state.observations.at(-1)];
  assert.equal(deriveFailureProgress(f.state.observations).checkpoint, 'INITIAL_PAID_OBSERVED');
  assert.throws(() => verifyFailureRecovery(f), { code: 'FAILURE_RECOVERY_OBSERVATION_REQUIRED' });
});

test('reject recovery with uncleared grace, another order, another owner or no coverage advancement', () => {
  for (const alter of [s => { s.graceUntil = Date.parse(at(30)); }, s => { s.paidThrough = at(10); },
    s => { s.payments[1].orderId = 'unrelated'; }]) {
    const f = fixture(); alter(f.state.observations.at(-1).snapshot);
    assert.equal(deriveFailureProgress(f.state.observations).checkpoint, 'PAST_DUE_OBSERVED');
  }
  const f = fixture(); f.state.observations.at(-1).snapshot.customerId = 'other';
  assert.throws(() => deriveFailureProgress(f.state.observations), { code: 'FAILURE_TIMELINE_OWNER_CHANGED' });
});

test('real receipt and stable reconciliation gates cannot be bypassed by the recovered header', () => {
  for (const alter of [f => { f.receipts.pop(); }, f => { f.receipts[1].signatureVerified = false; },
    f => { f.receipts[1].replayDeduplicated = false; }, f => { f.receipts[1].state = 'FAILED'; },
    f => { f.receipts[1].subjectId = 'another-order'; }]) {
    const f = fixture(); alter(f);
    assert.throws(() => verifyFailureRecovery(f), { code: 'FAILURE_REAL_RECEIPTS_REQUIRED' });
  }
  const f = fixture(); f.repeatRepaired = true;
  assert.throws(() => verifyFailureRecovery(f), { code: 'FAILURE_STABLE_RECONCILIATION_REQUIRED' });
});

test('fail closed on wrong grace duration, promotion during grace and out-of-order evidence', () => {
  const f = fixture(); f.state.observations[1].snapshot.graceUntil += 1000;
  assert.throws(() => deriveFailureProgress(f.state.observations), { code: 'FAILURE_GRACE_DURATION_INVALID' });
  const g = fixture(); g.state.observations[1].snapshot.effectivePlanId = 'highest_paid';
  assert.throws(() => deriveFailureProgress(g.state.observations), { code: 'FAILURE_GRACE_CHANGED_LAST_PAID_COVERAGE' });
  const h = fixture(); h.state.observations.reverse();
  assert.throws(() => deriveFailureProgress(h.state.observations), { code: 'FAILURE_TIMELINE_ORDER_INVALID' });
});
