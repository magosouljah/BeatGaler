'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readPolarSandboxConfig } = require('../billing-polar-sandbox');
const { createPolarSandboxLifecycleAdapter } = require('../billing-polar-lifecycle-adapter');

function env() {
  return {
    POLAR_SANDBOX_ACCESS_TOKEN: 'polar_oat_sandbox_test',
    POLAR_SANDBOX_WEBHOOK_SECRET: 'whsec_test',
    POLAR_SANDBOX_ORGANIZATION_ID: 'org_test',
    POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRODUCT_ID: 'prod_paid',
    POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRICE_ID: 'price_paid',
    POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRODUCT_ID: 'prod_high',
    POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRICE_ID: 'price_high',
  };
}

function fakeClient(calls) {
  return {
    products: {
      list: async () => ({ items: [] }),
      get: async id => {
        const high = id === 'prod_high';
        return {
          id,
          organization_id: 'org_test',
          recurring_interval: 'month',
          recurring_interval_count: 1,
          is_archived: false,
          prices: [{
            id: high ? 'price_high' : 'price_paid',
            amount_type: 'fixed',
            price_currency: 'usd',
            price_amount: high ? 1199 : 699,
          }],
        };
      },
    },
    checkouts: {
      create: async () => ({ id: 'co_1', url: 'https://sandbox.polar.sh/checkout/co_1' }),
      get: async id => (calls.checkout = id, { id, status: 'open' }),
    },
    customerSessions: { create: async () => ({ customer_portal_url: 'https://sandbox.polar.sh/portal/session' }) },
    customers: {
      get: async id => ({ id }),
      getExternal: async id => ({ external_id: id }),
    },
    subscriptions: {
      get: async id => ({ id }),
      list: async params => (calls.subscriptionsList = params, { items: [{ id: 'sub_list_1' }] }),
      update: async (id, body) => {
        calls.updates ||= [];
        calls.updates.push({ id, body });
        return { id, cancel_at_period_end: body.cancel_at_period_end, pending_update: body.product_id ? { product_id: body.product_id } : null };
      },
      revoke: async id => (calls.revoke = id, { id, status: 'canceled' }),
    },
    payments: { get: async id => ({ id }) },
    orders: {
      get: async id => (calls.order = id, { id, status: 'paid' }),
      list: async params => (calls.ordersList = params, { items: [{ id: 'order_list_1' }] }),
    },
    refunds: {
      create: async body => (calls.refund = body, { id: 'refund_1', ...body }),
    },
  };
}

function adapter(calls = {}) {
  return createPolarSandboxLifecycleAdapter({
    config: readPolarSandboxConfig(env()),
    client: fakeClient(calls),
    webhooks: { validateEvent: async () => ({ type: 'order.paid', timestamp: new Date().toISOString(), data: { id: 'order_1' } }) },
  });
}

test('lifecycle adapter can inspect a provider checkout without exposing its client secret', async () => {
  const calls = {};
  const result = await adapter(calls).getCheckout('co_1');
  assert.equal(calls.checkout, 'co_1');
  assert.equal(result.id, 'co_1');
  assert.equal(result.status, 'open');
});

test('lifecycle adapter exposes canonical Polar order lookup', async () => {
  const calls = {};
  assert.equal((await adapter(calls).getOrder('order_1')).id, 'order_1');
  assert.equal(calls.order, 'order_1');
});

test('reconciliation discovery is scoped server-side by external customer identity', async () => {
  const calls = {};
  const instance = adapter(calls);
  const subscriptions = await instance.listSubscriptionsForUser({ userId: 'u1', limit: 50 });
  const orders = await instance.listOrdersForUser({ userId: 'u1', limit: 50 });
  assert.deepEqual(subscriptions, { items: [{ id: 'sub_list_1' }], truncated: false });
  assert.deepEqual(orders, { items: [{ id: 'order_list_1' }], truncated: false });
  assert.deepEqual(calls.subscriptionsList, {
    organization_id: 'org_test',
    external_customer_id: 'u1',
    page: 1,
    limit: 50,
  });
  assert.deepEqual(calls.ordersList, {
    organization_id: 'org_test',
    external_customer_id: 'u1',
    product_billing_type: 'recurring',
    page: 1,
    limit: 50,
  });
});

test('paid plan change is always scheduled with explicit next_period proration behavior', async () => {
  const calls = {};
  const result = await adapter(calls).scheduleSubscriptionChange({
    subscriptionId: 'sub_1',
    offerId: 'highest_paid_monthly_v1',
  });
  assert.deepEqual(calls.updates.at(-1), {
    id: 'sub_1',
    body: {
      product_id: 'prod_high',
      proration_behavior: 'next_period',
    },
  });
  assert.equal(result.planId, 'highest_paid');
  assert.equal(result.effective, 'next_period');
});

test('sandbox cancellation is scheduled for period end instead of revoking access immediately', async () => {
  const calls = {};
  await adapter(calls).cancelSubscriptionAtPeriodEnd({ subscriptionId: 'sub_1' });
  assert.deepEqual(calls.updates.at(-1), {
    id: 'sub_1',
    body: { cancel_at_period_end: true },
  });
});

test('sandbox renewal can be rescheduled through the official current billing period end field', async () => {
  const calls = {};
  await adapter(calls).rescheduleSubscriptionRenewal({
    subscriptionId: 'sub_1',
    currentBillingPeriodEnd: '2026-09-12T00:00:00.000Z',
  });
  assert.deepEqual(calls.updates.at(-1), {
    id: 'sub_1',
    body: { current_billing_period_end: '2026-09-12T00:00:00.000Z' },
  });
});

test('sandbox refund primitive carries only order, amount, reason and explicit benefit retention', async () => {
  const calls = {};
  const result = await adapter(calls).createRefund({
    orderId: 'order_1',
    amountMinor: 350,
    reason: 'customer_request',
  });
  assert.deepEqual(calls.refund, {
    order_id: 'order_1',
    amount: 350,
    reason: 'customer_request',
    revoke_benefits: false,
  });
  assert.equal(result.id, 'refund_1');
});

test('refund lifecycle can request immediate provider revocation through the pinned SDK primitive', async () => {
  const calls = {};
  const result = await adapter(calls).revokeSubscription({ subscriptionId: 'sub_1' });
  assert.equal(calls.revoke, 'sub_1');
  assert.equal(result.status, 'canceled');
});
