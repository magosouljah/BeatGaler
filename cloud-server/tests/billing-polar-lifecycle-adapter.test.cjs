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
    checkouts: { create: async () => ({ id: 'co_1', url: 'https://sandbox.polar.sh/checkout/co_1' }) },
    customerSessions: { create: async () => ({ customer_portal_url: 'https://sandbox.polar.sh/portal/session' }) },
    customers: {
      get: async id => ({ id }),
      getExternal: async id => ({ external_id: id }),
    },
    subscriptions: {
      get: async id => ({ id }),
      list: async params => (calls.subscriptionsList = params, { items: [{ id: 'sub_list_1' }] }),
      update: async (id, body) => (calls.update = { id, body }, { id, pending_update: { product_id: body.product_id } }),
      revoke: async id => (calls.revoke = id, { id, status: 'canceled' }),
    },
    payments: { get: async id => ({ id }) },
    orders: {
      get: async id => (calls.order = id, { id, status: 'paid' }),
      list: async params => (calls.ordersList = params, { items: [{ id: 'order_list_1' }] }),
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
  assert.deepEqual(calls.update, {
    id: 'sub_1',
    body: {
      product_id: 'prod_high',
      proration_behavior: 'next_period',
    },
  });
  assert.equal(result.planId, 'highest_paid');
  assert.equal(result.effective, 'next_period');
});

test('refund lifecycle can request immediate provider revocation through the pinned SDK primitive', async () => {
  const calls = {};
  const result = await adapter(calls).revokeSubscription({ subscriptionId: 'sub_1' });
  assert.equal(calls.revoke, 'sub_1');
  assert.equal(result.status, 'canceled');
});
