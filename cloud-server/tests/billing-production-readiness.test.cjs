'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPinnedSandboxClient } = require('../billing-polar-sandbox');
const { readPolarProductionConfig, createPolarProductionLifecycleAdapter } = require('../billing-polar-production');
const { readPolarSandboxConfig } = require('../billing-polar-sandbox');
const { createWebBillingRuntime } = require('../billing-web-runtime');
const { createPersistentCheckoutService } = require('../billing-checkout-persistent');
const { createBillingPortalService } = require('../billing-web-portal-runtime');
const { createLifecycleWorker } = require('../billing-lifecycle-runtime');
const { createReconciliationRuntime } = require('../billing-reconciliation-runtime');
const webhookRuntime = require('../billing-webhook-runtime');
const { assertProductionBillingIsolation, currentSellableCheckout } = require('../billing-production-isolation');
const { preflightPolarProduction } = require('../billing-production-preflight');

function productionEnv() {
  return {
    NODE_ENV: 'production', BEATGALER_DEPLOYMENT_ENV: 'production',
    BILLING_PROVIDER_ENVIRONMENT: 'production', BILLING_PRODUCTION_SALES_ENABLED: 'true',
    POLAR_PRODUCTION_ACCESS_TOKEN: 'live_fixture_only',
    POLAR_PRODUCTION_WEBHOOK_SECRET: 'whsec_live_fixture_only',
    POLAR_PRODUCTION_ORGANIZATION_ID: 'org_live',
    POLAR_PRODUCTION_PAID_ENTRY_MONTHLY_PRODUCT_ID: 'product_live_entry',
    POLAR_PRODUCTION_PAID_ENTRY_MONTHLY_PRICE_ID: 'price_live_entry',
    POLAR_PRODUCTION_HIGHEST_PAID_MONTHLY_PRODUCT_ID: 'product_live_high',
    POLAR_PRODUCTION_HIGHEST_PAID_MONTHLY_PRICE_ID: 'price_live_high',
  };
}

function client(checkoutUrl = 'https://polar.sh/checkout/co_live') {
  return {
    products: {
      list: async () => ({ items: [] }),
      get: async id => {
        const high = id === 'product_live_high';
        return { id, organization_id: 'org_live', recurring_interval: 'month',
          prices: [{ id: high ? 'price_live_high' : 'price_live_entry', amount_type: 'fixed',
            price_currency: 'usd', price_amount: high ? 1199 : 699 }] };
      },
    },
    checkouts: { create: async () => ({ id: 'co_live', url: checkoutUrl }), get: async id => ({ id }) },
    customerSessions: { create: async () => ({ customer_portal_url: 'https://polar.sh/portal/session' }) },
    customers: { get: async id => ({ id }), getExternal: async id => ({ id: 'cus_live', external_id: id }) },
    subscriptions: { get: async id => ({ id }), list: async () => ({ items: [] }),
      update: async id => ({ id }), revoke: async id => ({ id }) },
    payments: { get: async id => ({ id }) },
    orders: { get: async id => ({ id }), list: async () => ({ items: [] }) },
    refunds: { create: async () => ({ id: 'refund_fixture' }) },
  };
}

test('live configuration is separate, complete, and pinned to production SDK endpoint', () => {
  const config = readPolarProductionConfig(productionEnv());
  assert.equal(config.environment, 'production');
  let sdkOptions;
  createPinnedSandboxClient({ config, sdk: { createPolar: input => (sdkOptions = input, {}) } });
  assert.equal(sdkOptions.environment, 'production');
  assert.equal(sdkOptions.version, '2026-04');
  assert.throws(() => readPolarProductionConfig({ ...productionEnv(), POLAR_PRODUCTION_WEBHOOK_SECRET: '' }));
  assert.throws(() => readPolarProductionConfig({ ...productionEnv(), POLAR_SANDBOX_ACCESS_TOKEN: 'live_fixture_only' }));
});

test('read-only Live preflight validates mappings without enabling sale or creating checkout', async () => {
  let checkoutCalls = 0;
  const result = await preflightPolarProduction({ env: { ...productionEnv(), BILLING_PRODUCTION_SALES_ENABLED: 'false' },
    adapterFactory: ({ catalog }) => ({ provider: 'polar', environment: 'production',
      createCheckout() { checkoutCalls++; },
      validateOfferMapping: async id => {
        const offer = catalog.offers[id];
        return { offerId: id, productId: offer.providerMapping.productId, priceId: offer.providerMapping.priceId,
          currency: offer.currency, amountMinor: offer.amountMinor, interval: offer.interval };
      } }),
  });
  assert.equal(result.checkoutCreated, false);
  assert.equal(checkoutCalls, 0);
  assert.equal(result.checkedOffers.length, 2);
});

test('live adapter validates monthly catalog and rejects non-Polar checkout URLs', async () => {
  const options = { config: readPolarProductionConfig(productionEnv()), client: client(),
    webhooks: { validateEvent: async () => ({ type: 'order.paid', data: { id: 'o1' } }) } };
  const adapter = createPolarProductionLifecycleAdapter(options);
  assert.equal(adapter.provider, 'polar');
  assert.equal(adapter.environment, 'production');
  assert.equal((await adapter.validateOfferMapping('paid_entry_monthly_v1')).amountMinor, 699);
  const input = { offerId: 'paid_entry_monthly_v1', userId: 'u1',
    successUrl: 'https://beatgaler.com/?billing=success', returnUrl: 'https://beatgaler.com/?billing=return' };
  assert.equal((await adapter.createCheckout(input)).url, 'https://polar.sh/checkout/co_live');
  const forged = createPolarProductionLifecycleAdapter({ ...options, client: client('https://sandbox.polar.sh/checkout/co_live') });
  await assert.rejects(forged.createCheckout(input), { code: 'POLAR_PRODUCTION_CHECKOUT_URL_INVALID' });
});

test('Live webhook verification uses its own secret and rejects Sandbox signatures', async () => {
  const liveKey = Buffer.from('beatgaler-live-fixture-key');
  const sandboxKey = Buffer.from('beatgaler-sandbox-fixture-key');
  const config = readPolarProductionConfig({ ...productionEnv(),
    POLAR_PRODUCTION_WEBHOOK_SECRET: `whsec_${liveKey.toString('base64')}` });
  const adapter = createPolarProductionLifecycleAdapter({ config, client: client(),
    webhooks: require('@polar-sh/sdk/2026-04').webhooks });
  const rawBody = Buffer.from(JSON.stringify({ type: 'product.created',
    timestamp: new Date().toISOString(), data: {} }));
  const webhookId = 'msg_live_fixture';
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = key => ({ 'webhook-id': webhookId, 'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${crypto.createHmac('sha256', key)
      .update(`${webhookId}.${timestamp}.${rawBody.toString('utf8')}`).digest('base64')}` });
  assert.equal((await adapter.verifyWebhook({ rawBody, headers: headers(liveKey) })).type, 'product.created');
  await assert.rejects(adapter.verifyWebhook({ rawBody, headers: headers(sandboxKey) }));
});

test('live sale remains closed until explicit flags and verified mappings', async () => {
  const fakeAdapter = ({ catalog }) => ({ provider: 'polar', environment: 'production',
    createCheckout() {}, getCheckoutOffer() {},
    validateOfferMapping: async offerId => {
      const offer = catalog.offers[offerId];
      return { offerId, productId: offer.providerMapping.productId, priceId: offer.providerMapping.priceId,
        currency: offer.currency, amountMinor: offer.amountMinor, interval: offer.interval };
    } });
  for (const removed of ['NODE_ENV', 'BEATGALER_DEPLOYMENT_ENV',
    'POLAR_PRODUCTION_ACCESS_TOKEN', 'POLAR_PRODUCTION_WEBHOOK_SECRET']) {
    const env = productionEnv(); delete env[removed];
    assert.equal((await createWebBillingRuntime({ env, adapterFactory: fakeAdapter }).initialize()).ready, false, removed);
  }
  const runtime = createWebBillingRuntime({ env: productionEnv(), adapterFactory: fakeAdapter });
  assert.equal((await runtime.initialize()).ready, true);
  assert.equal(runtime.provider().environment, 'production');
  assert.equal(JSON.stringify(runtime.planCatalog()).includes('product_live_entry'), false);
  const maintenanceEnv = { ...productionEnv(), BILLING_PRODUCTION_SALES_ENABLED: 'false' };
  const maintenance = createWebBillingRuntime({ env: maintenanceEnv, adapterFactory: fakeAdapter });
  assert.equal((await maintenance.initialize()).ready, true);
  assert.deepEqual(maintenance.planCatalog().map(plan => plan.checkout_available), [false, false, false]);
});

test('a productive deployment cannot expose Sandbox checkout', async () => {
  const env = { ...productionEnv(), BILLING_PROVIDER_ENVIRONMENT: 'sandbox',
    POLAR_SANDBOX_ACCESS_TOKEN: 'sandbox_fixture',
    POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRODUCT_ID: 'sandbox_entry',
    POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRICE_ID: 'sandbox_entry_price',
    POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRODUCT_ID: 'sandbox_high',
    POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRICE_ID: 'sandbox_high_price' };
  assert.equal(readPolarSandboxConfig(env).environment, 'sandbox');
  const runtime = createWebBillingRuntime({ env });
  assert.deepEqual(await runtime.initialize(), {
    ready: false, failureCode: 'WEB_BILLING_SANDBOX_ON_PRODUCTION',
  });
  assert.deepEqual(runtime.planCatalog().map(plan => plan.checkout_available), [false, false, false]);
});

test('live checkout, webhook, workers, and portal keep the same environment', async () => {
  const adapter = createPolarProductionLifecycleAdapter({ config: readPolarProductionConfig(productionEnv()),
    client: client(), webhooks: { validateEvent: async () => ({}) } });
  const pool = { connect() {}, query: async () => ({ rows: [{ provider_customer_id: 'cus_live', external_id: 'u1' }] }) };
  assert.ok(createPersistentCheckoutService({ pool, adapter, allowedCallbackOrigins: ['https://beatgaler.com'] }));
  const portal = createBillingPortalService({ pool, adapter, env: productionEnv() });
  assert.equal((await portal.createSession('u1')).url, 'https://polar.sh/portal/session');
  assert.equal(webhookRuntime.configure({ pool, adapter, env: productionEnv() }).ready, true);
  const inbox = webhookRuntime.current();
  assert.equal(inbox.environment, 'production');
  assert.ok(createLifecycleWorker({ pool, adapter, inbox,
    lifecycleFactory: () => ({ handlers: {} }), actionWorkerFactory: () => ({ processNext() {} }) }));
  assert.ok(createReconciliationRuntime({ pool, adapter, authority: 'postgres',
    serviceFactory: () => ({ runPendingSweep() {}, runCommercialSweep() {} }) }));
});

test('a stored Sandbox checkout cannot be returned as a Live checkout', async () => {
  let providerCalls = 0;
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM billing_customers')) return { rows: [] };
      if (sql.includes('FROM billing_subscription_state')) return { rows: [] };
      if (sql.includes('SELECT *') && sql.includes('FROM billing_checkout_requests')) {
        return { rows: [{ provider: 'polar', provider_environment: 'sandbox',
          state: 'OPEN', checkout_url: 'https://sandbox.polar.sh/checkout/old' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: client.query };
  const adapter = { provider: 'polar', environment: 'production',
    getCheckoutOffer: id => ({ id }), createCheckout: async () => { providerCalls++; } };
  const service = createPersistentCheckoutService({ pool, adapter, allowedCallbackOrigins: ['https://beatgaler.com'] });
  await assert.rejects(service.createSession({ user: { id: 'u1' },
    request: { offerId: 'paid_entry_monthly_v1', requestId: 'request_12345' },
    successUrl: 'https://beatgaler.com/?billing=success', returnUrl: 'https://beatgaler.com/?billing=return',
  }), { code: 'BILLING_CHECKOUT_REQUEST_CONFLICT' });
  assert.equal(providerCalls, 0);
});

test('productive database refuses sandbox financial state and unknown inspection results', async () => {
  let sql;
  await assertProductionBillingIsolation({ query: async text => (sql = text, { rows: [{ mixed_billing_environment: false }] }) });
  for (const table of ['billing_subscription_state', 'billing_customers', 'billing_checkout_requests',
    'billing_payments', 'billing_webhook_events', 'billing_provider_actions']) assert.match(sql, new RegExp(table));
  await assert.rejects(assertProductionBillingIsolation({ query: async () => ({ rows: [{ mixed_billing_environment: true }] }) }));
  await assert.rejects(assertProductionBillingIsolation({ query: async () => ({ rows: [] }) }));
});

test('live checkout closes again if webhook or financial workers stop', () => {
  const input = { environment: 'production', salesEnabled: true, currentCheckout: () => ({ ready: true }),
    webhookStatus: () => ({ ready: true }), lifecycleStatus: () => ({ running: true, healthy: true }),
    reconciliationStatus: () => ({ running: true, healthy: true }) };
  assert.deepEqual(currentSellableCheckout(input), { ready: true });
  assert.equal(currentSellableCheckout({ ...input, webhookStatus: () => ({ ready: false }) }), null);
  assert.equal(currentSellableCheckout({ ...input, lifecycleStatus: () => ({ running: false }) }), null);
  assert.equal(currentSellableCheckout({ ...input, reconciliationStatus: () => ({ running: false }) }), null);
  assert.equal(currentSellableCheckout({ ...input, lifecycleStatus: () => ({ running: true, healthy: false }) }), null);
  assert.equal(currentSellableCheckout({ ...input, reconciliationStatus: () => ({ running: true, healthy: false }) }), null);
  assert.equal(currentSellableCheckout({ ...input, salesEnabled: false }), null);
  assert.deepEqual(currentSellableCheckout({ ...input, environment: 'sandbox',
    lifecycleStatus: () => ({ running: false }) }), { ready: true });
});

test('a failing lifecycle pump closes live sale until a successful retry', async () => {
  let fail = true;
  const worker = createLifecycleWorker({ pool: {}, adapter: { provider: 'polar', environment: 'production' },
    inbox: { provider: 'polar', environment: 'production',
      processNext: async () => { if (fail) throw new Error('provider failure'); return null; } },
    lifecycleFactory: () => ({ handlers: {} }),
    actionWorkerFactory: () => ({ processNext: async () => null }), pollMs: 10_000 });
  worker.start();
  try {
    await worker.pumpOnce();
    assert.equal(worker.status().healthy, false);
    fail = false;
    await worker.pumpOnce();
    assert.equal(worker.status().healthy, true);
  } finally { await worker.stop(); }
});
