'use strict';

const crypto = require('crypto');
const { BillingLifecycleError, createBillingLifecycle, resolveOffer, orderProjection } = require('./billing-lifecycle');
const { createBillingSafeLogger, safeErrorCode, sanitizeState, writeBillingAuditEvent } = require('./billing-safe-log');

const DEFAULT_PENDING_LIMIT = 50;
const DEFAULT_SWEEP_LIMIT = 100;
const MAX_SWEEP_LIMIT = 500;
const LIVE = new Set(['trialing','active','past_due','unpaid','incomplete','paused']);
const RANK = Object.freeze({ free: 0, paid_entry: 1, highest_paid: 2 });

class BillingReconciliationError extends Error {
  constructor(message, code = 'BILLING_RECONCILIATION_FAILED', cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BillingReconciliationError';
    this.code = code;
    if (cause && this.cause == null) this.cause = cause;
  }
}

function requiredText(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new BillingReconciliationError(`${label} is required.`, 'BILLING_RECONCILIATION_INVALID');
  return text;
}
function optionalText(value) { const text = String(value == null ? '' : value).trim(); return text || null; }
function iso(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function key(prefix, ...parts) {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40)}`;
}
function normalizeListResult(raw, label) {
  if (Array.isArray(raw)) return { items: raw, truncated: false };
  const items = raw?.items || raw?.result?.items || raw?.data?.items;
  if (Array.isArray(items)) return { items, truncated: raw.truncated === true };
  throw new BillingReconciliationError(`${label} list response is invalid.`, 'BILLING_PROVIDER_SNAPSHOT_INVALID');
}
function subId(row) { return optionalText(row?.id || row?.subscription_id); }
function customerId(row) { return optionalText(row?.customer_id || row?.customerId); }
function status(row) { return String(row?.status || '').trim().toLowerCase(); }
function isCurrent(row, nowIso) {
  if (LIVE.has(status(row))) return true;
  const end = iso(row?.current_period_end || row?.ends_at);
  return Boolean(end && new Date(end) > new Date(nowIso));
}
function selectSubscription(rows, localId, nowIso) {
  const valid = rows.filter(row => subId(row));
  const current = valid.filter(row => isCurrent(row, nowIso));
  if (current.length > 1) return { ambiguous: true, reason: 'MULTIPLE_SUBSCRIPTIONS_UNEXPECTED', subscription: null };
  if (current.length === 1) return { ambiguous: false, subscription: current[0] };
  if (localId) {
    const exact = valid.filter(row => subId(row) === localId);
    if (exact.length > 1) return { ambiguous: true, reason: 'MULTIPLE_SUBSCRIPTIONS_UNEXPECTED', subscription: null };
    if (exact.length === 1) return { ambiguous: false, subscription: exact[0] };
  }
  if (valid.length === 1) return { ambiguous: false, subscription: valid[0] };
  return { ambiguous: false, subscription: null, historicalOnly: valid.length > 1 };
}

function safeSubscriptionSnapshot(row, catalog) {
  if (!row) return null;
  const offer = resolveOffer(catalog, row, 'reconciliation subscription');
  return {
    customerId: customerId(row), subscriptionId: subId(row), offerId: offer.id, planId: offer.planId,
    status: status(row), cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    currentPeriodStart: iso(row.current_period_start), currentPeriodEnd: iso(row.current_period_end),
    pastDueAt: iso(row.past_due_at), endedAt: iso(row.ended_at || row.ends_at),
  };
}
function safeOrderSnapshot(row, catalog) {
  const offer = resolveOffer(catalog, row, 'reconciliation order');
  const projection = orderProjection(row);
  const rawStatus = status(row);
  if (projection.refundedAmountMinor > projection.amountMinor || (rawStatus === 'refunded' && projection.refundedAmountMinor === 0)) {
    throw new BillingReconciliationError('Provider refund state is ambiguous.', 'BILLING_RECONCILIATION_REFUND_AMBIGUOUS');
  }
  return {
    customerId: customerId(row), subscriptionId: optionalText(row.subscription_id), checkoutId: optionalText(row.checkout_id),
    orderId: optionalText(row.id), offerId: offer.id, planId: offer.planId, status: projection.status,
    amountMinor: projection.amountMinor, refundedAmountMinor: projection.refundedAmountMinor, currency: projection.currency,
  };
}

async function readLocal(client, userId) {
  const customer = (await client.query(`SELECT provider_customer_id FROM billing_customers WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [userId])).rows[0] || null;
  const subscription = (await client.query('SELECT * FROM billing_subscription_state WHERE user_id=$1', [userId])).rows[0] || null;
  const payments = (await client.query(`
    SELECT provider_order_id,provider_subscription_id,offer_id,period_start,period_end,amount_minor,currency,status,
           refunded_amount_minor,invalidated_at,invalidation_reason
    FROM billing_payments WHERE user_id=$1 ORDER BY period_end NULLS FIRST,provider_order_id NULLS FIRST,id
  `, [userId])).rows;
  return { customer, subscription, payments };
}
function fingerprint(local) {
  if (!local.subscription) return JSON.stringify(local);
  // Projection writes refresh these bookkeeping fields even when provider facts
  // are unchanged. They cannot turn an idempotent reconciliation into a repair.
  const { local_version, updated_at, last_synced_at, ...subscription } = local.subscription;
  return JSON.stringify({ ...local, subscription });
}
function auditState(local) {
  const row = local?.subscription;
  return sanitizeState({
    customerId: local?.customer?.provider_customer_id, subscriptionId: row?.provider_subscription_id,
    offerId: row?.offer_id, planId: row?.plan_id || 'free', status: row?.status || 'inactive',
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end), currentPeriodStart: iso(row?.current_period_start),
    currentPeriodEnd: iso(row?.current_period_end), paidThrough: iso(row?.paid_through), pastDueAt: iso(row?.past_due_at),
    graceUntil: iso(row?.grace_until), endedAt: iso(row?.ended_at), count: local?.payments?.length || 0,
  });
}
function providerAudit(bundle) { return sanitizeState({ ...(bundle?.subscription || {}), count: bundle?.orders?.length || 0 }); }
function eventTime(row, fallback) { return iso(row?.modified_at || row?.updated_at || row?.created_at) || fallback; }
function context(userId, provider, environment, eventType, subjectId, timestamp) {
  return { provider, environment, resolvedUserId: userId, event: { eventType, subjectId, validatedPayload: { timestamp } } };
}
function orderTime(row) {
  const item = Array.isArray(row?.items) ? row.items.find(value => value?.start_timestamp || value?.end_timestamp) : null;
  const value = iso(item?.end_timestamp || item?.start_timestamp || row?.created_at || row?.modified_at);
  return value ? new Date(value).getTime() : 0;
}
function reasonFor(error) {
  if (error?.code === 'BILLING_LIFECYCLE_OFFER_MAPPING_AMBIGUOUS') return 'UNKNOWN_OR_AMBIGUOUS_OFFER';
  if (error?.code === 'BILLING_LIFECYCLE_MULTIPLE_SUBSCRIPTIONS') return 'MULTIPLE_SUBSCRIPTIONS_UNEXPECTED';
  if (error?.code === 'BILLING_RECONCILIATION_REFUND_AMBIGUOUS') return 'REFUND_INTERPRETATION_AMBIGUOUS';
  if (error instanceof BillingLifecycleError) return 'PROVIDER_STATE_AMBIGUOUS';
  return null;
}
function validLimit(value, fallback) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_SWEEP_LIMIT) throw new BillingReconciliationError('Reconciliation limit is invalid.', 'BILLING_RECONCILIATION_INVALID');
  return number;
}

function createBillingReconciliationService({ pool, adapter, lifecycle = null, logger = null } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new BillingReconciliationError('PostgreSQL pool is required.', 'BILLING_RECONCILIATION_CONFIG_INVALID');
  if (!adapter || typeof adapter.listSubscriptionsForUser !== 'function' || typeof adapter.listOrdersForUser !== 'function') {
    throw new BillingReconciliationError('Provider discovery primitives are required.', 'BILLING_RECONCILIATION_CONFIG_INVALID');
  }
  const billingLifecycle = lifecycle || createBillingLifecycle({ adapter });
  const provider = requiredText(adapter.provider, 'adapter provider');
  const environment = requiredText(adapter.environment, 'adapter environment');
  const catalog = adapter.catalog;
  const safeLogger = logger || createBillingSafeLogger();

  async function exception({ userId, operationId, reason, providerSnapshot = {}, localSnapshot = {}, errorCode = null }) {
    const exceptionKey = key('billing_reconcile_exception', provider, environment, userId, reason);
    const scoped = { provider, environment, ...providerSnapshot };
    const lastError = errorCode ? `code:${safeErrorCode({ code: errorCode })}` : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing-reconcile:${userId}`]);
      await client.query(`
        INSERT INTO billing_reconciliation_exceptions(
          exception_key,user_id,provider_customer_id,provider_subscription_id,reason,provider_snapshot,local_snapshot,
          state,attempt_count,last_error,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'OPEN',1,$8,now(),now())
        ON CONFLICT(exception_key) DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id,
          provider_subscription_id=EXCLUDED.provider_subscription_id,reason=EXCLUDED.reason,
          provider_snapshot=EXCLUDED.provider_snapshot,local_snapshot=EXCLUDED.local_snapshot,state='OPEN',
          attempt_count=billing_reconciliation_exceptions.attempt_count+1,last_error=EXCLUDED.last_error,
          resolved_at=NULL,updated_at=now()
      `, [exceptionKey, userId, providerSnapshot?.subscription?.customerId || null,
        providerSnapshot?.subscription?.subscriptionId || null, reason, JSON.stringify(scoped), JSON.stringify(localSnapshot), lastError]);
      const details = { userId, operationId, provider, environment, reason, errorCode, exceptionKey,
        previousState: auditState(localSnapshot), nextState: providerAudit(providerSnapshot) };
      await writeBillingAuditEvent(client, 'reconciliation_mismatch', details);
      await client.query('COMMIT');
      safeLogger.emit('reconciliation_mismatch', details);
      return exceptionKey;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function resolveExceptions(client, userId) {
    await client.query(`
      UPDATE billing_reconciliation_exceptions SET state='RESOLVED',resolved_at=now(),last_error=NULL,updated_at=now()
      WHERE user_id=$1 AND provider_snapshot->>'provider'=$2 AND provider_snapshot->>'environment'=$3 AND state='OPEN'
    `, [userId, provider, environment]);
  }

  async function reconcileUser({ userId, reconciliationId, mode = 'manual', now = new Date() } = {}) {
    const uid = requiredText(userId, 'userId');
    const operationId = requiredText(reconciliationId, 'reconciliationId');
    const started = Date.now();
    const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
    let rawSubscriptions;
    let rawOrders;
    try {
      [rawSubscriptions, rawOrders] = await Promise.all([
        adapter.listSubscriptionsForUser({ userId: uid, limit: 100 }),
        adapter.listOrdersForUser({ userId: uid, limit: 100 }),
      ]);
    } catch (error) {
      const errorCode = safeErrorCode(error, 'BILLING_PROVIDER_UNAVAILABLE');
      const details = { userId: uid, operationId, provider, environment, mode, reason: 'PROVIDER_UNAVAILABLE', errorCode, durationMs: Date.now() - started };
      const client = await pool.connect();
      try { await writeBillingAuditEvent(client, 'reconciliation_failed', details); } finally { client.release(); }
      safeLogger.emit('reconciliation_failed', details);
      throw new BillingReconciliationError('Provider reconciliation lookup failed.', 'BILLING_PROVIDER_UNAVAILABLE', error);
    }

    let subscriptions;
    let orders;
    try {
      const a = normalizeListResult(rawSubscriptions, 'Subscription');
      const b = normalizeListResult(rawOrders, 'Order');
      if (a.truncated || b.truncated) throw new BillingReconciliationError('Provider result was truncated.', 'BILLING_PROVIDER_RESULT_TRUNCATED');
      subscriptions = a.items;
      orders = b.items;
    } catch (error) {
      const client = await pool.connect();
      let local;
      try { local = await readLocal(client, uid); } finally { client.release(); }
      const errorCode = safeErrorCode(error, 'BILLING_PROVIDER_SNAPSHOT_INVALID');
      const why = error?.code === 'BILLING_PROVIDER_RESULT_TRUNCATED' ? 'PROVIDER_RESULT_TRUNCATED' : 'PROVIDER_STATE_AMBIGUOUS';
      const exceptionKey = await exception({ userId: uid, operationId, reason: why, localSnapshot: local, errorCode });
      return { reconciled: false, divergent: true, repairable: false, reason: why, exceptionKey, entitlementGranted: false };
    }

    const reader = await pool.connect();
    let localBefore;
    try { localBefore = await readLocal(reader, uid); } finally { reader.release(); }
    const localSubId = optionalText(localBefore.subscription?.provider_subscription_id);
    const selected = selectSubscription(subscriptions, localSubId, nowIso);
    if (selected.ambiguous) {
      const exceptionKey = await exception({ userId: uid, operationId, reason: selected.reason,
        providerSnapshot: { subscription: null, orders: [], count: subscriptions.length }, localSnapshot: localBefore });
      return { reconciled: false, divergent: true, repairable: false, reason: selected.reason, exceptionKey, entitlementGranted: false };
    }
    if (!selected.subscription) {
      if (localSubId) {
        const why = 'PROVIDER_SUBSCRIPTION_MISSING';
        const exceptionKey = await exception({ userId: uid, operationId, reason: why,
          providerSnapshot: { subscription: null, orders: [], count: subscriptions.length }, localSnapshot: localBefore });
        return { reconciled: false, divergent: true, repairable: false, reason: why, exceptionKey, entitlementGranted: false };
      }
      const client = await pool.connect();
      try { await client.query('BEGIN'); await resolveExceptions(client, uid); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
      return { reconciled: true, divergent: false, repaired: false, accessChanged: false, entitlementGranted: false };
    }

    const chosenId = subId(selected.subscription);
    const relevantOrders = orders.filter(order => optionalText(order?.subscription_id) === chosenId).sort((a, b) => orderTime(a) - orderTime(b));
    let bundle;
    try {
      bundle = { subscription: safeSubscriptionSnapshot(selected.subscription, catalog), orders: relevantOrders.map(order => safeOrderSnapshot(order, catalog)) };
    } catch (error) {
      const why = reasonFor(error) || 'PROVIDER_STATE_AMBIGUOUS';
      const exceptionKey = await exception({ userId: uid, operationId, reason: why, localSnapshot: localBefore,
        errorCode: safeErrorCode(error, 'BILLING_PROVIDER_SNAPSHOT_INVALID') });
      return { reconciled: false, divergent: true, repairable: false, reason: why, exceptionKey, entitlementGranted: false };
    }

    const incomingCustomer = bundle.subscription?.customerId;
    const localCustomer = optionalText(localBefore.customer?.provider_customer_id || localBefore.subscription?.provider_customer_id);
    const orderBindingConflict = bundle.orders.some(order => order.customerId && incomingCustomer && order.customerId !== incomingCustomer);
    if (orderBindingConflict || (localCustomer && incomingCustomer && localCustomer !== incomingCustomer)) {
      const why = 'BINDING_CONTRADICTION';
      const exceptionKey = await exception({ userId: uid, operationId, reason: why, providerSnapshot: bundle, localSnapshot: localBefore });
      return { reconciled: false, divergent: true, repairable: false, reason: why, exceptionKey, entitlementGranted: false };
    }

    const client = await pool.connect();
    let before;
    let after;
    let accessBefore;
    let accessAfter;
    let repaired = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing-reconcile:${uid}`]);
      if (incomingCustomer) {
        const owner = (await client.query(`SELECT user_id FROM billing_customers WHERE provider=$1 AND provider_environment=$2 AND provider_customer_id=$3 LIMIT 1`, [provider, environment, incomingCustomer])).rows[0];
        if (owner && owner.user_id !== uid) throw new BillingReconciliationError('Provider binding belongs to another user.', 'BILLING_RECONCILIATION_BINDING_CONFLICT');
      }
      before = await readLocal(client, uid);
      accessBefore = await billingLifecycle.resolveUserAccess(client, uid, nowIso);
      const beforeFingerprint = fingerprint(before);
      await billingLifecycle.handlers['subscription.updated'].apply(client,
        context(uid, provider, environment, 'subscription.updated', chosenId, eventTime(selected.subscription, nowIso)), selected.subscription);
      for (const order of relevantOrders) {
        const orderId = requiredText(order?.id, 'provider order id');
        await billingLifecycle.handlers['order.updated'].apply(client,
          context(uid, provider, environment, 'order.updated', orderId, eventTime(order, nowIso)), { order, subscription: selected.subscription });
      }
      after = await readLocal(client, uid);
      accessAfter = await billingLifecycle.resolveUserAccess(client, uid, nowIso);
      repaired = beforeFingerprint !== fingerprint(after);
      if (repaired) {
        const details = { userId: uid, operationId, provider, environment, mode, reason: 'PROVIDER_FACTS_DIFFERED',
          repairKind: 'AUTHORITATIVE_PROVIDER_PROJECTION', previousState: auditState(before), nextState: auditState(after), durationMs: Date.now() - started };
        await writeBillingAuditEvent(client, 'reconciliation_mismatch', details);
        await writeBillingAuditEvent(client, 'reconciliation_repaired', details);
      }
      await resolveExceptions(client, uid);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      const why = error?.code === 'BILLING_RECONCILIATION_BINDING_CONFLICT' ? 'BINDING_CONTRADICTION' : (reasonFor(error) || 'PROVIDER_STATE_AMBIGUOUS');
      const exceptionKey = await exception({ userId: uid, operationId, reason: why, providerSnapshot: bundle, localSnapshot: before || localBefore,
        errorCode: safeErrorCode(error, 'BILLING_RECONCILIATION_APPLY_FAILED') });
      return { reconciled: false, divergent: true, repairable: false, reason: why, exceptionKey, entitlementGranted: false };
    } finally { client.release(); }

    if (repaired) {
      const details = { userId: uid, operationId, provider, environment, mode, reason: 'PROVIDER_FACTS_DIFFERED',
        repairKind: 'AUTHORITATIVE_PROVIDER_PROJECTION', previousState: auditState(before), nextState: auditState(after), durationMs: Date.now() - started };
      safeLogger.emit('reconciliation_mismatch', details);
      safeLogger.emit('reconciliation_repaired', details);
    }
    const beforeRank = RANK[accessBefore?.effectivePlanId] ?? 0;
    const afterRank = RANK[accessAfter?.effectivePlanId] ?? 0;
    return { reconciled: true, divergent: repaired, repaired, accessChanged: accessBefore?.effectivePlanId !== accessAfter?.effectivePlanId,
      effectivePlanBefore: accessBefore?.effectivePlanId || 'free', effectivePlanAfter: accessAfter?.effectivePlanId || 'free', entitlementGranted: afterRank > beforeRank };
  }

  async function runSweep(candidates, runId, mode) {
    const summary = { checkedCount: 0, repairedCount: 0, exceptionCount: 0, failedCount: 0 };
    for (const uid of candidates) {
      try {
        const result = await reconcileUser({ userId: uid, reconciliationId: `${runId}:${uid}`, mode });
        summary.checkedCount += 1;
        if (result.repaired) summary.repairedCount += 1;
        if (result.divergent && !result.repaired) summary.exceptionCount += 1;
      } catch (_) { summary.checkedCount += 1; summary.failedCount += 1; }
    }
    safeLogger.emit('reconciliation_sweep_completed', { operationId: runId, provider, environment, mode, ...summary });
    return summary;
  }

  async function runPendingSweep({ limit = DEFAULT_PENDING_LIMIT, sweepId = null } = {}) {
    const max = validLimit(limit, DEFAULT_PENDING_LIMIT);
    const runId = optionalText(sweepId) || key('billing_pending_sweep', provider, environment, new Date().toISOString());
    const candidates = (await pool.query(`
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM billing_checkout_requests WHERE provider=$1 AND provider_environment=$2 AND state IN ('CREATING','OPEN','AMBIGUOUS')
        UNION SELECT user_id FROM billing_subscription_state WHERE provider=$1 AND provider_environment=$2 AND status IN ('past_due','unpaid','incomplete')
        UNION SELECT resolved_user_id AS user_id FROM billing_webhook_events WHERE provider=$1 AND provider_environment=$2 AND state='FAILED' AND resolved_user_id IS NOT NULL
      ) q WHERE user_id IS NOT NULL ORDER BY user_id LIMIT $3
    `, [provider, environment, max])).rows.map(row => row.user_id);
    return Object.freeze({ sweepId: runId, ...(await runSweep(candidates, runId, 'pending')) });
  }

  async function runCommercialSweep({ cursor = null, limit = DEFAULT_SWEEP_LIMIT, sweepId = null } = {}) {
    const max = validLimit(limit, DEFAULT_SWEEP_LIMIT);
    const after = optionalText(cursor) || '';
    const runId = optionalText(sweepId) || key('billing_commercial_sweep', provider, environment, new Date().toISOString());
    const rows = (await pool.query(`SELECT user_id FROM billing_customers WHERE provider=$1 AND provider_environment=$2 AND user_id>$3 ORDER BY user_id LIMIT $4`, [provider, environment, after, max])).rows;
    const summary = await runSweep(rows.map(row => row.user_id), runId, 'daily');
    return Object.freeze({ sweepId: runId, nextCursor: rows.length === max ? rows.at(-1)?.user_id || null : null, ...summary });
  }

  return Object.freeze({ provider, environment, reconcile: reconcileUser, reconcileUser, runPendingSweep, runCommercialSweep });
}

module.exports = {
  DEFAULT_PENDING_LIMIT,
  DEFAULT_SWEEP_LIMIT,
  MAX_SWEEP_LIMIT,
  BillingReconciliationError,
  normalizeListResult,
  selectSubscription,
  safeSubscriptionSnapshot,
  safeOrderSnapshot,
  createBillingReconciliationService,
};
