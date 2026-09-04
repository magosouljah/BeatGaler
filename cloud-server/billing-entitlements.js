'use strict';

const { PLAN_CATALOG } = require('./plans');

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['trialing', 'active']);
const KNOWN_SUBSCRIPTION_STATUSES = new Set(['inactive','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']);

class EntitlementDeniedError extends Error {
  constructor(message, code = 'ENTITLEMENT_DENIED') {
    super(message); this.name = 'EntitlementDeniedError'; this.code = code;
  }
}

function effectiveBillingPlan(subscription) {
  const status = String(subscription?.status || 'inactive');
  const planId = String(subscription?.plan_id || subscription?.planId || 'free');
  if (!KNOWN_SUBSCRIPTION_STATUSES.has(status)) return PLAN_CATALOG.free;
  if (!ACTIVE_SUBSCRIPTION_STATUSES.has(status)) return PLAN_CATALOG.free;
  return PLAN_CATALOG[planId] || PLAN_CATALOG.free;
}

function quotaFor(plan, resource) {
  const value = plan?.quotas?.[resource];
  if (value === undefined) throw new EntitlementDeniedError(`Unknown quota resource: ${resource}.`, 'ENTITLEMENT_UNKNOWN_RESOURCE');
  return value;
}

function createEntitlementService({ pool, portalProvider }) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is required.');
  return Object.freeze({
    async reserve({ userId, resource, amount = 1, reservationId }) {
      const uid = String(userId || '').trim();
      const rid = String(reservationId || '').trim();
      const qty = Number(amount);
      if (!uid || !rid || !resource || !Number.isInteger(qty) || qty <= 0) throw new EntitlementDeniedError('Invalid reservation request.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entitlement:${uid}:${resource}`]);
        const subscription = (await client.query('SELECT plan_id,status FROM billing_subscription_state WHERE user_id=$1 FOR UPDATE', [uid])).rows[0] || { plan_id: 'free', status: 'inactive' };
        const plan = effectiveBillingPlan(subscription);
        const limit = quotaFor(plan, resource);
        const existing = (await client.query("SELECT amount,state FROM entitlement_reservations WHERE reservation_id=$1 FOR UPDATE", [rid])).rows[0];
        if (existing) {
          if (Number(existing.amount) !== qty) throw new EntitlementDeniedError('Reservation identity collision.', 'ENTITLEMENT_RESERVATION_COLLISION');
          await client.query('COMMIT');
          return { reservationId: rid, state: existing.state, planId: plan.id, duplicate: true };
        }
        const used = Number((await client.query("SELECT COALESCE(SUM(amount),0) AS used FROM entitlement_reservations WHERE user_id=$1 AND resource=$2 AND state IN ('RESERVED','COMMITTED')", [uid, resource])).rows[0]?.used || 0);
        if (limit !== null && used + qty > limit) throw new EntitlementDeniedError('Server-side quota exceeded.', 'ENTITLEMENT_LIMIT_EXCEEDED');
        await client.query('INSERT INTO entitlement_reservations(reservation_id,user_id,resource,amount) VALUES($1,$2,$3,$4)', [rid, uid, resource, qty]);
        await client.query('COMMIT');
        return { reservationId: rid, state: 'RESERVED', planId: plan.id, duplicate: false };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
      } finally { client.release(); }
    },
    async createPortalSession({ userId, returnUrl }) {
      if (!portalProvider || typeof portalProvider.createPortalSession !== 'function') throw new EntitlementDeniedError('Billing portal unavailable.', 'BILLING_PORTAL_UNAVAILABLE');
      const uid = String(userId || '').trim();
      const row = (await pool.query('SELECT provider_customer_id,status,cancel_at_period_end,current_period_end FROM billing_subscription_state WHERE user_id=$1', [uid])).rows[0];
      if (!row?.provider_customer_id) throw new EntitlementDeniedError('No server-side billing customer.', 'BILLING_CUSTOMER_MISSING');
      const session = await portalProvider.createPortalSession({ customerId: row.provider_customer_id, returnUrl: String(returnUrl || '') });
      if (!session?.url) throw new EntitlementDeniedError('Billing portal unavailable.', 'BILLING_PORTAL_UNAVAILABLE');
      return { url: session.url, subscription: { status: row.status, cancelAtPeriodEnd: Boolean(row.cancel_at_period_end), currentPeriodEnd: row.current_period_end || null }, entitlementGranted: false };
    },
  });
}

module.exports = { ACTIVE_SUBSCRIPTION_STATUSES, KNOWN_SUBSCRIPTION_STATUSES, EntitlementDeniedError, effectiveBillingPlan, createEntitlementService };
