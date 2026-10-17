'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPersistentCheckoutService } = require('../billing-checkout-persistent');
const { createLifecycleWorker } = require('../billing-lifecycle-runtime');
const { createReconciliationRuntime } = require('../billing-reconciliation-runtime');
const webhookRuntime = require('../billing-webhook-runtime');

const productionAdapter = {
  provider: 'polar', environment: 'production',
  catalog: { providerEnvironment: 'production' },
  getCheckoutOffer: id => ({ id }),
  createCheckout: async () => { throw new Error('provider must not be called'); },
  verifyWebhook() {},
};

test('production checkout scopes customer lookup and refuses a Sandbox request record', async () => {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('FROM billing_checkout_requests') && sql.includes('request_id=$2')) {
        return { rows: [{ provider: 'polar', provider_environment: 'sandbox' }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: client.query.bind(client) };
  const checkout = createPersistentCheckoutService({ pool, adapter: productionAdapter,
    allowedCallbackOrigins: ['https://app.example.test'] });
  await assert.rejects(checkout.createSession({
    user: { id: 'user-a', email: 'a@example.test' },
    request: { requestId: 'request-123', offerId: 'paid_entry_monthly_v1' },
    successUrl: 'https://app.example.test/success',
    returnUrl: 'https://app.example.test/settings',
  }), { code: 'BILLING_CHECKOUT_ENVIRONMENT_MISMATCH' });
  const customerLookup = queries.find(({ sql }) => sql.includes('FROM billing_customers'));
  assert.equal(customerLookup.values[2], 'production');
});

test('checkout rejects adapter/catalog environment disagreement', () => {
  assert.throws(() => createPersistentCheckoutService({
    pool: { connect() {}, query() {} },
    adapter: { ...productionAdapter, catalog: { providerEnvironment: 'sandbox' } },
    allowedCallbackOrigins: ['https://app.example.test'],
  }), { code: 'BILLING_CHECKOUT_CONFIG_INVALID' });
});

test('webhook runtime selects the production secret and keeps inbox environment isolated', () => {
  const pool = { connect() {}, query() {} };
  assert.deepEqual(webhookRuntime.configure({ pool, adapter: productionAdapter,
    env: { BILLING_PROVIDER_ENVIRONMENT: 'production', POLAR_SANDBOX_WEBHOOK_SECRET: 'sandbox-secret' } }),
  { ready: false, failureCode: 'WEBHOOK_SECRET_MISSING' });
  assert.deepEqual(webhookRuntime.configure({ pool, adapter: productionAdapter,
    env: { BILLING_PROVIDER_ENVIRONMENT: 'sandbox', POLAR_PRODUCTION_WEBHOOK_SECRET: 'production-secret' } }),
  { ready: false, failureCode: 'WEBHOOK_ADAPTER_INVALID' });
  assert.equal(webhookRuntime.configure({ pool, adapter: productionAdapter,
    env: { BILLING_PROVIDER_ENVIRONMENT: 'production', POLAR_PRODUCTION_WEBHOOK_SECRET: 'production-secret' } }).ready, true);
  assert.equal(webhookRuntime.current().environment, 'production');
});

test('lifecycle worker only accepts an inbox from its provider environment', () => {
  const base = { pool: {}, adapter: productionAdapter, inbox: { provider: 'polar', environment: 'production' },
    lifecycleFactory: () => ({ handlers: {} }), actionWorkerFactory: () => ({ processNext() {} }) };
  const worker = createLifecycleWorker(base);
  assert.equal(worker.status().running, false);
  assert.throws(() => createLifecycleWorker({ ...base,
    inbox: { provider: 'polar', environment: 'sandbox' } }), /BILLING_LIFECYCLE_RUNTIME_CONFIG_INVALID/);
});

test('reconciliation accepts the selected production adapter', () => {
  const runtime = createReconciliationRuntime({ pool: {}, adapter: productionAdapter, authority: 'postgres',
    serviceFactory: () => ({ reconcileUser() {} }) });
  assert.equal(runtime.status().running, false);
});
