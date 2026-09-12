'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  POLAR_API_VERSION,
  POLAR_SDK_VERSION,
  PolarSandboxConfigError,
  PolarSandboxAdapterError,
  readPolarSandboxConfig,
  createPinnedSandboxClient,
  createPolarSandboxAdapter,
} = require('../billing-polar-sandbox');

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
      list: async input => (calls.products = input, { items: [] }),
      get: async id => {
        calls.productGet = id;
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
    checkouts: { create: async input => (calls.checkout = input, { id: 'co_1', url: 'https://sandbox.polar.sh/checkout/co_1' }) },
    customerSessions: { create: async input => (calls.portal = input, { customer_portal_url: 'https://sandbox.polar.sh/portal/session' }) },
    customers: {
      get: async id => ({ id }),
      getExternal: async id => ({ external_id: id }),
    },
    subscriptions: { get: async id => ({ id }) },
    payments: { get: async id => ({ id }) },
  };
}

function adapter(calls = {}) {
  return createPolarSandboxAdapter({
    config: readPolarSandboxConfig(env()),
    client: fakeClient(calls),
    webhooks: { validateEvent: async (body, headers, secret) => (calls.webhook = { body, headers, secret }, { type: 'order.paid', data: { id: 'order_1' } }) },
  });
}

test('pins Polar SDK and API version for sandbox', () => {
  assert.equal(POLAR_SDK_VERSION, '1.0.0-alpha.20');
  assert.equal(POLAR_API_VERSION, '2026-04');
});

test('pinned client is always created against Polar sandbox and API 2026-04', () => {
  let options = null;
  const sdk = { createPolar: input => (options = input, { ok: true }) };
  const config = readPolarSandboxConfig(env());
  createPinnedSandboxClient({ config, sdk });
  assert.equal(options.environment, 'sandbox');
  assert.equal(options.version, '2026-04');
  assert.equal(options.accessToken, 'polar_oat_sandbox_test');
});

test('sandbox config uses sandbox-only credential names and requires both monthly mappings', () => {
  const config = readPolarSandboxConfig(env());
  assert.equal(config.environment, 'sandbox');
  assert.equal(config.providerMappings.paid_entry_monthly_v1.productId, 'prod_paid');
  assert.throws(() => readPolarSandboxConfig({ ...env(), POLAR_SANDBOX_ACCESS_TOKEN: '' }), PolarSandboxConfigError);
  assert.throws(() => readPolarSandboxConfig({ ...env(), POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRICE_ID: '' }), PolarSandboxConfigError);
});

test('checkout resolves Polar product server-side and never grants access from redirect', async () => {
  const calls = {};
  const result = await adapter(calls).createCheckout({
    offerId: 'paid_entry_monthly_v1',
    userId: 'user_123',
    email: 'user@example.com',
    successUrl: 'https://app.example.com/billing/success',
    returnUrl: 'https://app.example.com/settings',
    productId: 'attacker_product',
    priceId: 'attacker_price',
  });
  assert.equal(calls.productGet, 'prod_paid');
  assert.equal(calls.checkout.product_price_id, 'price_paid');
  assert.equal(calls.checkout.products, undefined);
  assert.equal(calls.checkout.external_customer_id, 'user_123');
  assert.equal(calls.checkout.allow_trial, false);
  assert.equal(calls.checkout.metadata.beatgaler_provider_price_id, 'price_paid');
  assert.equal(result.entitlementGranted, false);
  assert.equal(result.providerProductId, 'prod_paid');
});

test('checkout fails closed when Polar sandbox price no longer matches BeatGaler catalog', async () => {
  const calls = {};
  const client = fakeClient(calls);
  client.products.get = async id => ({
    id,
    organization_id: 'org_test',
    recurring_interval: 'month',
    prices: [{ id: 'price_paid', amount_type: 'fixed', price_currency: 'usd', price_amount: 700 }],
  });
  const a = createPolarSandboxAdapter({
    config: readPolarSandboxConfig(env()),
    client,
    webhooks: { validateEvent: async () => ({ type: 'order.paid' }) },
  });
  await assert.rejects(
    () => a.createCheckout({
      offerId: 'paid_entry_monthly_v1',
      userId: 'user_123',
      successUrl: 'https://app.example.com/billing/success',
      returnUrl: 'https://app.example.com/settings',
    }),
    error => error instanceof PolarSandboxConfigError && error.code === 'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
  );
  assert.equal(calls.checkout, undefined);
});

test('annual remains unavailable even when adapter exists', async () => {
  await assert.rejects(
    () => adapter({}).createCheckout({
      offerId: 'paid_entry_annual_v1',
      userId: 'user_123',
      successUrl: 'https://app.example.com/billing/success',
      returnUrl: 'https://app.example.com/settings',
    }),
  );
});

test('portal uses BeatGaler external user id and returns provider URL', async () => {
  const calls = {};
  const result = await adapter(calls).createCustomerPortal({ userId: 'user_123', returnUrl: 'https://app.example.com/settings' });
  assert.deepEqual(calls.portal, { external_customer_id: 'user_123', return_url: 'https://app.example.com/settings' });
  assert.equal(result.url, 'https://sandbox.polar.sh/portal/session');
});

test('products are queried in sandbox organization context', async () => {
  const calls = {};
  await adapter(calls).listProducts({ page: 2, limit: 50 });
  assert.deepEqual(calls.products, { organization_id: 'org_test', page: 2, limit: 50 });
});

test('webhook verification receives raw body, normalized headers and sandbox secret', async () => {
  const calls = {};
  const raw = Buffer.from('{"type":"order.paid"}');
  const result = await adapter(calls).verifyWebhook({
    rawBody: raw,
    headers: { 'Webhook-Id': 'msg_1', 'Webhook-Timestamp': '123', 'Webhook-Signature': 'v1,abc' },
  });
  assert.ok(calls.webhook.body instanceof Uint8Array);
  assert.equal(calls.webhook.headers['webhook-id'], 'msg_1');
  assert.equal(calls.webhook.secret, 'whsec_test');
  assert.equal(result.type, 'order.paid');
});

test('invalid webhook signature is fail-closed', async () => {
  const calls = {};
  const a = createPolarSandboxAdapter({
    config: readPolarSandboxConfig(env()),
    client: fakeClient(calls),
    webhooks: { validateEvent: async () => { throw new Error('bad signature'); } },
  });
  await assert.rejects(
    () => a.verifyWebhook({ rawBody: '{}', headers: { 'webhook-id':'x','webhook-timestamp':'1','webhook-signature':'x' } }),
    error => error instanceof PolarSandboxAdapterError && error.code === 'POLAR_SANDBOX_WEBHOOK_INVALID',
  );
});

test('customer, subscription and payment lookups expose narrow provider primitives', async () => {
  const a = adapter({});
  assert.equal((await a.getCustomer('cus_1')).id, 'cus_1');
  assert.equal((await a.getCustomerByExternalId('user_123')).external_id, 'user_123');
  assert.equal((await a.getSubscription('sub_1')).id, 'sub_1');
  assert.equal((await a.getPayment('pay_1')).id, 'pay_1');
});
