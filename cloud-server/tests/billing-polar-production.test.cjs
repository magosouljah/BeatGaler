'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readPolarProductionConfig,
  createProductionCommercialCatalog,
  createPolarProductionAdapter,
  createPinnedPolarClient,
} = require('../billing-polar-sandbox');
const { createPolarProductionLifecycleAdapter } = require('../billing-polar-lifecycle-adapter');
const { createWebBillingRuntime } = require('../billing-web-runtime');

function environment() {
  return {
    BILLING_PROVIDER_ENVIRONMENT: 'production',
    POLAR_PRODUCTION_ACCESS_TOKEN: 'production-token-fixture',
    POLAR_PRODUCTION_WEBHOOK_SECRET: 'production-secret-fixture',
    POLAR_PRODUCTION_ORGANIZATION_ID: 'production-org-fixture',
    POLAR_PRODUCTION_PAID_ENTRY_MONTHLY_PRODUCT_ID: 'production-entry-product',
    POLAR_PRODUCTION_PAID_ENTRY_MONTHLY_PRICE_ID: 'production-entry-price',
    POLAR_PRODUCTION_HIGHEST_PAID_MONTHLY_PRODUCT_ID: 'production-high-product',
    POLAR_PRODUCTION_HIGHEST_PAID_MONTHLY_PRICE_ID: 'production-high-price',
  };
}

function client(calls) {
  return {
    products: {
      list: async () => ({ items: [] }),
      get: async id => {
        calls.products.push(id);
        return {
          id,
          organization_id: 'production-org-fixture',
          recurring_interval: 'month',
          prices: [{
            id: id === 'production-entry-product' ? 'production-entry-price' : 'production-high-price',
            amount_type: 'fixed',
            price_currency: 'usd',
            price_amount: id === 'production-entry-product' ? 699 : 1199,
          }],
        };
      },
    },
    checkouts: {
      create: async () => { throw Error('No checkout in read-only test'); },
      get: async id => ({ id }),
    },
    customerSessions: { create: async () => { throw Error('No portal mutation in read-only test'); } },
    customers: { get: async id => ({ id }), getExternal: async id => ({ external_id: id }) },
    subscriptions: {
      get: async id => ({ id }),
      list: async () => ({ items: [] }),
      update: async () => { throw Error('No update in read-only test'); },
      revoke: async () => { throw Error('No revoke in read-only test'); },
    },
    payments: { get: async id => ({ id }) },
    orders: { get: async id => ({ id }), list: async () => ({ items: [] }) },
    refunds: { create: async () => { throw Error('No refund in read-only test'); } },
  };
}

test('production config requires all independent private values and rejects known Sandbox reuse', () => {
  const values = environment();
  const config = readPolarProductionConfig(values);
  assert.equal(config.environment, 'production');
  assert.equal(config.providerMappings.highest_paid_monthly_v1.priceId, 'production-high-price');
  for (const key of Object.keys(values).filter(key => key.startsWith('POLAR_PRODUCTION_'))) {
    assert.throws(() => readPolarProductionConfig({ ...values, [key]: '' }));
    const sandboxKey = key.replace('POLAR_PRODUCTION_', 'POLAR_SANDBOX_');
    assert.throws(() => readPolarProductionConfig({ ...values, [sandboxKey]: values[key] }),
      { code: 'POLAR_PRODUCTION_SANDBOX_VALUE' });
  }
  assert.equal(JSON.stringify(config).includes('POLAR_SANDBOX_'), false);
});

test('pinned 2026-04 SDK receives the production endpoint selection explicitly', () => {
  let input;
  createPinnedPolarClient({
    config: readPolarProductionConfig(environment()),
    sdk: { createPolar: options => (input = options, {}) },
  });
  assert.deepEqual(input, {
    accessToken: 'production-token-fixture',
    environment: 'production',
    version: '2026-04',
  });
});

test('production adapter rejects a Sandbox config or catalog before any provider request', () => {
  const config = readPolarProductionConfig(environment());
  const catalog = createProductionCommercialCatalog(config);
  assert.throws(() => createPolarProductionAdapter({
    config: { ...config, environment: 'sandbox' }, catalog, client: client({ products: [] }), webhooks: {},
  }), { code: 'POLAR_CONFIG_ENVIRONMENT_MISMATCH' });
  assert.throws(() => createPolarProductionLifecycleAdapter({
    config, catalog: { ...catalog, providerEnvironment: 'sandbox' }, client: client({ products: [] }), webhooks: {},
  }), { code: 'POLAR_CONFIG_ENVIRONMENT_MISMATCH' });
  const changed = { ...catalog, offers: { ...catalog.offers, paid_entry_monthly_v1: {
    ...catalog.offers.paid_entry_monthly_v1,
    providerMapping: { productId: 'sandbox-product', priceId: 'sandbox-price' },
  } } };
  assert.throws(() => createPolarProductionAdapter({
    config, catalog: changed, client: client({ products: [] }), webhooks: {},
  }), { code: 'POLAR_CONFIG_MAPPING_MISMATCH' });
});

test('production startup verifies both monthly offers and exposes one production lifecycle provider', async () => {
  const calls = { products: [] };
  const runtime = createWebBillingRuntime({
    env: environment(),
    adapterFactory: input => createPolarProductionLifecycleAdapter({ ...input, client: client(calls), webhooks: {
      validateEvent: async (body, headers, secret) => {
        calls.webhookSecret = secret;
        return { type: 'order.paid' };
      },
    } }),
  });
  assert.deepEqual(await runtime.initialize(), { ready: true, failureCode: null });
  assert.deepEqual(calls.products, ['production-entry-product', 'production-high-product']);
  const provider = runtime.provider();
  assert.equal(provider.provider, 'polar');
  assert.equal(provider.environment, 'production');
  assert.equal(provider.catalog.providerEnvironment, 'production');
  assert.equal(typeof provider.listOrdersForUser, 'function');
  assert.equal(typeof provider.getSubscription, 'function');
  await provider.verifyWebhook({ rawBody: '{}', headers: { 'webhook-id': 'test' } });
  assert.equal(calls.webhookSecret, 'production-secret-fixture');
  assert.equal(runtime.getCheckoutOffer('paid_entry_monthly_v1').providerEnvironment, 'production');
});

test('production checkout and discovery use the selected mappings and organization in a local fake', async () => {
  const calls = { products: [] };
  const fake = client(calls);
  fake.checkouts.create = async body => {
    calls.checkout = body;
    return { id: 'production-checkout-fixture', url: 'https://polar.sh/checkout/fixture' };
  };
  fake.orders.list = async query => (calls.ordersQuery = query, { items: [] });
  const provider = createPolarProductionLifecycleAdapter({
    config: readPolarProductionConfig(environment()), client: fake, webhooks: { validateEvent: async () => ({}) },
  });
  const checkout = await provider.createCheckout({
    offerId: 'paid_entry_monthly_v1', userId: 'fixture-user',
    successUrl: 'https://example.test/success', returnUrl: 'https://example.test/settings',
  });
  assert.equal(calls.checkout.product_price_id, 'production-entry-price');
  assert.equal(calls.checkout.external_customer_id, 'fixture-user');
  assert.equal(checkout.entitlementGranted, false);
  await provider.listOrdersForUser({ userId: 'fixture-user' });
  assert.equal(calls.ordersQuery.organization_id, 'production-org-fixture');
  assert.equal(calls.ordersQuery.external_customer_id, 'fixture-user');
});

test('production startup rejects remote product mismatch without exposing a provider or secrets', async () => {
  const calls = { products: [] };
  const fake = client(calls);
  fake.products.get = async id => (calls.products.push(id), {
    id,
    organization_id: 'production-org-fixture',
    recurring_interval: 'month',
    prices: [{ id: 'a-price-from-another-environment', amount_type: 'fixed', price_currency: 'usd', price_amount: 699 }],
  });
  const runtime = createWebBillingRuntime({
    env: environment(),
    adapterFactory: input => createPolarProductionLifecycleAdapter({ ...input, client: fake, webhooks: {} }),
  });
  assert.equal((await runtime.initialize()).ready, false);
  assert.throws(() => runtime.provider());
  assert.deepEqual(calls.products, ['production-entry-product']);
  assert.equal(JSON.stringify(runtime.status()).includes('production-token-fixture'), false);
  assert.deepEqual(runtime.planCatalog().map(plan => plan.checkout_available), [false, false, false]);
});

test('production startup fails closed on provider identity and remote mapping mismatch', async () => {
  const config = readPolarProductionConfig(environment());
  const catalog = createProductionCommercialCatalog(config);
  for (const override of [
    { provider: 'polar', environment: 'sandbox', catalog },
    { provider: 'polar', environment: 'production', catalog: { ...catalog, providerEnvironment: 'sandbox' } },
    { provider: 'other', environment: 'production', catalog },
  ]) {
    const runtime = createWebBillingRuntime({ env: environment(), adapterFactory: () => ({
      ...override,
      validateOfferMapping: async () => ({}),
      createCheckout: async () => ({}),
      getCheckoutOffer: () => ({}),
    }) });
    assert.deepEqual(await runtime.initialize(), { ready: false, failureCode: 'WEB_BILLING_PROVIDER_INVALID' });
    assert.throws(() => runtime.provider());
  }
  const runtime = createWebBillingRuntime({ env: environment(), adapterFactory: input => ({
    provider: 'polar', environment: 'production', catalog: input.catalog,
    createCheckout: async () => ({}), getCheckoutOffer: () => ({}),
    validateOfferMapping: async offerId => {
      const offer = input.catalog.offers[offerId];
      return { offerId, productId: offer.providerMapping.productId, priceId: offer.providerMapping.priceId,
        currency: offer.currency, amountMinor: offer.amountMinor - 1, interval: offer.interval };
    },
  }) });
  assert.deepEqual(await runtime.initialize(), { ready: false, failureCode: 'WEB_BILLING_MAPPING_MISMATCH' });
});
