'use strict';

// Evidence bookkeeping only. This module never grants access or writes Billing.
const { isDeepStrictEqual } = require('node:util');
const { check } = require('./polar-sandbox-daily-config.cjs');
const time = value => value == null ? NaN : typeof value === 'number' ? value : Date.parse(value);
const successful = p => p.status === 'succeeded' && p.amountMinor > 0 && p.currency === 'usd' && p.processor === 'stripe';

function deriveFailureProgress(observations) {
  let initial, grace, recovery, initialFailure;
  let lastTime = -Infinity;
  for (const o of observations || []) {
    check(Number.isFinite(time(o.at)) && time(o.at) >= lastTime, 'FAILURE_TIMELINE_ORDER_INVALID');
    lastTime = time(o.at);
    const s = o.snapshot || {}, payments = o.financialPayments || [];
    if (!initial && payments.some(p => p.status === 'failed' && p.trigger === 'purchase') &&
        !payments.some(successful) && s.effectivePlanId === 'free') initialFailure = o;
    if (!initial && s.providerStatus === 'active' && s.commercialAccessState === 'paid') {
      const payment = payments.find(p => successful(p) && p.trigger === 'purchase' &&
        s.payments?.some(local => local.orderId === p.orderId && local.status === 'succeeded'));
      if (payment && s.subscriptionId && s.customerId && Number.isFinite(time(s.paidThrough))) initial = { observation: o, payment };
    }
    if (!initial) continue;
    const before = initial.observation.snapshot;
    // A timeline must never use another customer's observation as recovery.
    if (s.subscriptionId) check(s.subscriptionId === before.subscriptionId && s.customerId === before.customerId, 'FAILURE_TIMELINE_OWNER_CHANGED');
    if (!grace && s.providerStatus === 'past_due' && s.commercialAccessState === 'grace') {
      const failed = payments.find(p => p.status === 'failed' && p.trigger === 'subscription_cycle' &&
        p.orderId && p.orderId !== initial.payment.orderId && p.amountMinor > 0 && p.processor === 'stripe' && p.currency === 'usd');
      if (failed) {
        check(Number.isFinite(time(s.pastDueAt)) && time(s.graceUntil) - time(s.pastDueAt) === 7 * 86400000,
          'FAILURE_GRACE_DURATION_INVALID');
        check(s.effectivePlanId === before.effectivePlanId && s.paidThrough === before.paidThrough,
          'FAILURE_GRACE_CHANGED_LAST_PAID_COVERAGE');
        check(isDeepStrictEqual(s.quotas, before.quotas) && isDeepStrictEqual(s.capabilities, before.capabilities),
          'FAILURE_GRACE_CHANGED_CAPABILITIES');
        grace = { observation: o, payment: failed };
      }
    }
    if (grace && !recovery && time(o.at) > time(grace.observation.at) && s.providerStatus === 'active' &&
        s.commercialAccessState === 'paid' && s.pastDueAt === null && s.graceUntil === null &&
        s.effectivePlanId === before.effectivePlanId && time(s.paidThrough) > time(before.paidThrough)) {
      const paid = payments.find(p => successful(p) && p.orderId === grace.payment.orderId &&
        p.id !== grace.payment.id && time(p.createdAt) > time(grace.payment.createdAt) &&
        s.payments?.some(local => local.orderId === p.orderId && local.status === 'succeeded' && local.periodEnd === s.paidThrough));
      if (paid) recovery = { observation: o, payment: paid };
    }
  }
  return { checkpoint: recovery ? 'RECOVERY_OBSERVED' : grace ? 'PAST_DUE_OBSERVED' : initial ? 'INITIAL_PAID_OBSERVED' :
    initialFailure ? 'INITIAL_FAILURE_OBSERVED' : 'CHECKOUT_OPEN', initial, grace, recovery };
}

function verifyFailureRecovery({ state, financialOrder, receipts, reconciled, repeatRepaired, snapshot }) {
  const progress = deriveFailureProgress(state.observations);
  check(progress.recovery, 'FAILURE_RECOVERY_OBSERVATION_REQUIRED');
  const { initial, grace, recovery } = progress, order = financialOrder, sub = initial.observation.snapshot;
  check(order?.id === grace.payment.orderId && order.subscriptionId === sub.subscriptionId && order.customerId === sub.customerId &&
    order.billingReason === 'subscription_cycle' && order.paid === true && order.status === 'paid' &&
    order.currency === 'usd' && order.amountMinor > 0 && order.refundedAmountMinor === 0 &&
    time(order.periodStart) >= time(sub.paidThrough) && order.periodEnd === recovery.observation.snapshot.paidThrough,
  'FAILURE_RECOVERY_ORDER_REQUIRED');
  check(order.payments?.some(p => p.id === grace.payment.id && p.orderId === order.id && p.status === 'failed' && p.trigger === 'subscription_cycle') &&
    order.payments.some(p => p.id === recovery.payment.id && p.orderId === order.id && successful(p) && p.amountMinor >= order.amountMinor),
  'FAILURE_RECOVERY_PAYMENTS_REQUIRED');
  const receipt = (type, subject) => receipts?.some(p => p.eventType === type && p.subjectId === subject &&
    p.state === 'PROCESSED' && p.signatureVerified === true && p.replayDeduplicated === true);
  check(receipt('subscription.past_due', sub.subscriptionId) && receipt('order.paid', order.id), 'FAILURE_REAL_RECEIPTS_REQUIRED');
  check(reconciled === true && repeatRepaired === false, 'FAILURE_STABLE_RECONCILIATION_REQUIRED');
  check(snapshot?.subscriptionId === sub.subscriptionId && snapshot.customerId === sub.customerId &&
    snapshot.effectivePlanId === sub.effectivePlanId && snapshot.providerStatus === 'active' && snapshot.commercialAccessState === 'paid' &&
    snapshot.pastDueAt === null && snapshot.graceUntil === null && snapshot.paidThrough === order.periodEnd,
  'FAILURE_RECOVERED_ACCESS_REQUIRED');
  return { result: 'PASS', checkpoint: 'RECOVERY_VERIFIED', scope: 'failed_renewal_grace_recovery_only',
    initialOrderId: initial.payment.orderId, renewalOrderId: order.id, failedPaymentId: grace.payment.id,
    recoveryPaymentId: recovery.payment.id, recoveredPaidThrough: order.periodEnd };
}

function refreshFailureHeader(state, observedAt) {
  const progress = deriveFailureProgress(state.observations);
  // PASS requires a separately verified provider/receipt/reconciliation proof.
  // A previous verification remains a historical milestone after cancellation.
  const verified = state.recoveryVerification?.result === 'PASS' && progress.recovery &&
    state.recoveryVerification.renewalOrderId === progress.grace.payment.orderId &&
    state.recoveryVerification.recoveryPaymentId === progress.recovery.payment.id;
  const checkpoint = verified ? 'RECOVERY_VERIFIED' : progress.checkpoint;
  const result = verified ? 'PASS' : 'PARTIAL';
  const changed = state.checkpoint !== checkpoint || state.result !== result || !!state.lastErrorCode;
  if (state.lastErrorCode) {
    state.observationErrors ||= [];
    state.observationErrors.push({ code: state.lastErrorCode, lastObservedAt: state.updatedAt || null, clearedAt: observedAt });
    delete state.lastErrorCode;
  }
  state.checkpoint = checkpoint;
  state.result = result;
  return changed;
}

module.exports = { deriveFailureProgress, verifyFailureRecovery, refreshFailureHeader };
