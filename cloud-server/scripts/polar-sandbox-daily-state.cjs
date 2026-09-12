'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MODE, check } = require('./polar-sandbox-daily-config.cjs');
const STATE_KEYS = new Set(['schemaVersion','mode','provider','environment','runId','commitSha','databaseName','organizationId',
  'products','userId','requestId','checkoutId','subscriptionId','customerId','initialOrder','expectedRenewalAt',
  'initialPaymentCount','preRenewal','startedAt','updatedAt','result','checkpoint','lastErrorCode','renewalOrder','verification','scenarios']);
function databaseName(runId) { check(/^[0-9]{14}_[a-f0-9]{8}$/.test(runId), 'DAILY_RUN_ID_INVALID'); return `beatgaler_billing_e2e_daily_${runId}`; }
function sanitize(value, secrets = []) {
  const encoded = JSON.stringify(value);
  check(!secrets.filter(Boolean).some(secret => encoded.includes(secret)), 'DAILY_SECRET_IN_ARTIFACT');
  check(!/polar_oat_|whsec_|polar_whs_|https?:\/\/|postgres(?:ql)?:\/\//i.test(encoded), 'DAILY_SENSITIVE_VALUE_IN_ARTIFACT');
  function walk(v) {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      check(!/token|secret|password|cookie|headers|rawBody|payload|email|card|url/i.test(k), 'DAILY_SENSITIVE_FIELD_IN_ARTIFACT');
      walk(x);
    }
  }
  walk(value); return value;
}
function identity(state) {
  return { runId: state.runId, commitSha: state.commitSha, databaseName: state.databaseName,
    organizationId: state.organizationId, products: state.products, userId: state.userId, startedAt: state.startedAt };
}
function validateState(state, expected) {
  check(state?.schemaVersion === 1 && state.mode === MODE && state.provider === 'polar' && state.environment === 'sandbox', 'DAILY_STATE_INVALID');
  check(Object.keys(state).every(k => STATE_KEYS.has(k)), 'DAILY_STATE_UNKNOWN_FIELD');
  check(/^[a-f0-9]{40}$/.test(state.commitSha), 'DAILY_HEAD_INVALID');
  check(state.databaseName === databaseName(state.runId) && state.userId === `daily_${state.runId}`, 'DAILY_STATE_BINDING_INVALID');
  for (const k of ['runId','commitSha','databaseName']) check(state[k] === expected[k], `DAILY_RESUME_${k.toUpperCase()}_MISMATCH`);
  sanitize(state); return state;
}
async function writeState(file, state, secrets = []) {
  validateState(state, state); sanitize(state, secrets);
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const body = JSON.stringify(state);
  const envelope = { sha256: crypto.createHash('sha256').update(body).digest('hex'), state };
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, file);
}
async function readState(file, expected) {
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  check(envelope.sha256 === crypto.createHash('sha256').update(JSON.stringify(envelope.state)).digest('hex'), 'DAILY_STATE_DIGEST_MISMATCH');
  return validateState(envelope.state, expected);
}
function orderEvidence(order) {
  const iso = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const item = order?.items?.find(i => i.start_timestamp && i.end_timestamp && (!order.product_price_id || !i.product_price_id || i.product_price_id === order.product_price_id));
  return { id: order?.id ?? null, subscriptionId: order?.subscription_id ?? null, customerId: order?.customer_id ?? null,
    productId: order?.product_id ?? null, priceId: order?.product_price_id ?? order?.items?.[0]?.product_price_id ?? null,
    billingReason: order?.billing_reason ?? null, status: order?.status ?? null, paid: order?.paid === true,
    amountMinor: order?.net_amount ?? order?.total_amount ?? null, currency: order?.currency ?? null,
    refundedAmountMinor: order?.refunded_amount ?? 0, createdAt: iso(order?.created_at),
    periodStart: iso(item?.start_timestamp), periodEnd: iso(item?.end_timestamp),
    payments: (order?.financialPayments || []).map(p => ({id:p.id,orderId:p.orderId,status:p.status,amountMinor:p.amountMinor,
      currency:p.currency,processor:p.processor,trigger:p.trigger,createdAt:iso(p.createdAt)})) };
}
function assertPaidOrder(order) {
  check(order?.paid === true && order.status === 'paid' && order.amountMinor > 0 && order.currency === 'usd'
    && order.refundedAmountMinor === 0, 'DAILY_REAL_PAID_ORDER_REQUIRED');
  check(Number.isFinite(Date.parse(order.periodStart)) && Date.parse(order.periodEnd) > Date.parse(order.periodStart), 'DAILY_ORDER_OWN_PERIOD_REQUIRED');
  check(order.payments?.some(p => p.orderId===order.id && p.status==='succeeded' && p.amountMinor>=order.amountMinor
    && p.currency==='usd' && p.processor==='stripe'), 'DAILY_SUCCESSFUL_PAYMENT_REQUIRED');
}
function assertBefore(snapshot, initialOrderId) {
  check(snapshot.effectivePlanId === 'paid_entry' && snapshot.nextPlanId === 'highest_paid', 'DAILY_HIGHEST_GRANTED_EARLY');
  check(snapshot.payments.length === 1 && snapshot.payments[0].orderId === initialOrderId
    && snapshot.payments[0].status === 'succeeded', 'DAILY_PRE_RENEWAL_PAYMENT_MISMATCH');
}
function proveRenewal({ state, order, subscription, after, webhookProofs }) {
  assertPaidOrder(state.initialOrder); assertPaidOrder(order); assertBefore(state.preRenewal, state.initialOrder.id);
  check(order.id !== state.initialOrder.id && order.subscriptionId === state.subscriptionId
    && order.customerId === state.customerId && subscription.id === state.subscriptionId, 'DAILY_SECOND_ORDER_REQUIRED');
  check(order.billingReason === 'subscription_cycle', 'DAILY_NATURAL_CYCLE_REQUIRED');
  check(order.payments.some(p => p.status==='succeeded' && p.trigger==='subscription_cycle'
    && !state.initialOrder.payments.some(a => a.id===p.id)), 'DAILY_DISTINCT_RECURRING_PAYMENT_REQUIRED');
  check(Date.parse(order.createdAt) >= Date.parse(state.expectedRenewalAt)
    && Date.parse(order.periodStart) >= Date.parse(state.initialOrder.periodEnd)
    && Date.parse(order.periodEnd) > Date.parse(state.initialOrder.periodEnd)
    && Date.parse(subscription.current_period_end) >= Date.parse(order.periodEnd), 'DAILY_NEW_PERIOD_REQUIRED');
  const high = state.products.find(p => p.planId === 'highest_paid');
  check(order.productId === high.productId && order.priceId === high.priceId && order.amountMinor === high.amountMinor, 'DAILY_RENEWAL_MAPPING_MISMATCH');
  check(after.effectivePlanId === 'highest_paid' && Date.parse(after.paidThrough) >= Date.parse(order.periodEnd)
    && after.payments.some(p => p.orderId === order.id && p.status === 'succeeded' && p.periodEnd === order.periodEnd), 'DAILY_HIGHEST_AFTER_PAYMENT_REQUIRED');
  check(webhookProofs.some(p => p.eventType === 'order.paid' && p.subjectId === order.id && p.state === 'PROCESSED'
    && p.signatureVerified === true && p.replayDeduplicated === true), 'DAILY_REAL_RENEWAL_WEBHOOK_REQUIRED');
  return { result: 'PASS', initialOrderId: state.initialOrder.id, renewalOrderId: order.id };
}
module.exports = { databaseName, sanitize, identity, validateState, writeState, readState, orderEvidence, assertPaidOrder, assertBefore, proveRenewal };
