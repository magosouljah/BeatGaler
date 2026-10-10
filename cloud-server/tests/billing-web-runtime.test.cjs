'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWebBillingRuntime, WebBillingUnavailableError } = require('../billing-web-runtime');
const { createPlanCatalogHandler } = require('../billing-plan-catalog-route');

function env() {
  return {
    BILLING_PROVIDER_ENVIRONMENT: 'sandbox',
    POLAR_SANDBOX_ACCESS_TOKEN: 'polar_oat_private_test',
    POLAR_SANDBOX_WEBHOOK_SECRET: 'whsec_private_test',
    POLAR_SANDBOX_ORGANIZATION_ID: 'org_test',
    POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRODUCT_ID: 'prod_entry',
    POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRICE_ID: 'price_entry',
    POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRODUCT_ID: 'prod_high',
    POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRICE_ID: 'price_high',
  };
}

function fakeAdapter({ catalog }, { mismatch = null, calls = [] } = {}) {
  return {
    environment: 'sandbox',
    getCheckoutOffer: offerId => catalog.offers[offerId],
    createCheckout: async () => ({ id: 'unused' }),
    validateOfferMapping: async offerId => {
      calls.push(offerId);
      const offer = catalog.offers[offerId];
      return {
        offerId,
        productId: offer.providerMapping.productId,
        priceId: offer.providerMapping.priceId,
        currency: offer.currency,
        amountMinor: mismatch === offerId ? 1 : offer.amountMinor,
        interval: offer.interval,
      };
    },
  };
}

test('Web catalog publishes the exact V1 prices and quotas without provider configuration or secrets', async () => {
  const runtime = createWebBillingRuntime({ env: {} });
  const result = await runtime.initialize();
  assert.equal(result.ready, false);
  const plans = runtime.planCatalog();
  assert.deepEqual(plans.map(plan => [plan.id, plan.price.amount_minor, plan.quotas.max_beats]), [
    ['free', 0, 20], ['paid_entry', 699, 100], ['highest_paid', 1199, null],
  ]);
  assert.deepEqual(plans.map(plan => plan.price.interval), [null, 'month', 'month']);
  assert.deepEqual(plans.map(plan => plan.checkout_available), [false, false, false]);
  assert.equal(JSON.stringify(plans).includes('productId'), false);
  assert.equal(JSON.stringify(plans).includes('priceId'), false);
  assert.equal(JSON.stringify(plans).includes('youtube'), false);
  assert.throws(() => runtime.provider(), WebBillingUnavailableError);
});

test('one validated sandbox adapter serves both monthly offers and cannot sell annual or arbitrary product IDs', async () => {
  const calls = [];
  let constructions = 0;
  const runtime = createWebBillingRuntime({
    env: env(),
    adapterFactory: input => { constructions += 1; return fakeAdapter(input, { calls }); },
  });
  assert.deepEqual(await runtime.initialize(), { ready: true, failureCode: null });
  assert.deepEqual(calls, ['paid_entry_monthly_v1', 'highest_paid_monthly_v1']);
  assert.equal(constructions, 1);
  assert.strictEqual(runtime.provider(), runtime.provider());
  assert.equal(runtime.getCheckoutOffer('paid_entry_monthly_v1').providerMapping.productId, 'prod_entry');
  assert.equal(runtime.getCheckoutOffer('highest_paid_monthly_v1').providerMapping.productId, 'prod_high');
  assert.throws(() => runtime.getCheckoutOffer('paid_entry_annual_v1'), { code: 'BILLING_OFFER_DISABLED' });
  assert.throws(() => runtime.getCheckoutOffer('unknown'), { code: 'BILLING_OFFER_UNKNOWN' });
  assert.throws(() => runtime.getCheckoutOffer({ offerId: 'paid_entry_monthly_v1', productId: 'attacker' }),
    { code: 'WEB_BILLING_OFFER_INVALID' });
  const plans = runtime.planCatalog();
  assert.deepEqual(plans.map(plan => plan.checkout_available), [false, true, true]);
  assert.equal(JSON.stringify(plans).includes('polar_oat_private_test'), false);
  assert.equal(JSON.stringify(plans).includes('prod_entry'), false);
  assert.equal(JSON.stringify(plans).includes('price_entry'), false);
});

test('organization filter is optional for Web startup', async () => {
  const runtime = createWebBillingRuntime({
    env: { ...env(), POLAR_SANDBOX_ORGANIZATION_ID: '' },
    adapterFactory: fakeAdapter,
  });
  assert.equal((await runtime.initialize()).ready, true);
});

test('Web commerce startup does not require the STEP 9 webhook secret', async () => {
  const runtime = createWebBillingRuntime({
    env: { ...env(), POLAR_SANDBOX_WEBHOOK_SECRET: '' },
    adapterFactory: fakeAdapter,
  });
  assert.equal((await runtime.initialize()).ready, true);
});

test('incomplete, duplicate, production, and mismatched sandbox mapping all fail closed', async () => {
  for (const testEnv of [
    { ...env(), POLAR_SANDBOX_ACCESS_TOKEN: '' },
    { ...env(), POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRODUCT_ID: '' },
    { ...env(), POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRODUCT_ID: 'prod_entry' },
    { ...env(), BILLING_PROVIDER_ENVIRONMENT: 'production' },
    { ...env(), BILLING_PROVIDER_ENVIRONMENT: '' },
  ]) {
    const runtime = createWebBillingRuntime({ env: testEnv, adapterFactory: fakeAdapter });
    assert.equal((await runtime.initialize()).ready, false);
    assert.throws(() => runtime.provider(), WebBillingUnavailableError);
  }
  const runtime = createWebBillingRuntime({
    env: env(),
    adapterFactory: input => fakeAdapter(input, { mismatch: 'highest_paid_monthly_v1' }),
  });
  assert.deepEqual(await runtime.initialize(), { ready: false, failureCode: 'WEB_BILLING_MAPPING_MISMATCH' });
  assert.throws(() => runtime.getCheckoutOffer('paid_entry_monthly_v1'));
});

test('/plans/catalog uses the server commercial catalog and exposes no private provider fields', async () => {
  const runtime = createWebBillingRuntime({ env: env(), adapterFactory: fakeAdapter });
  await runtime.initialize();
  const app = express();
  app.get('/plans/catalog', createPlanCatalogHandler({
    usesPostgresAccess: () => true,
    webPlanCatalog: runtime.planCatalog,
    legacyPlanCatalog: () => { throw new Error('legacy catalog must not serve Web PostgreSQL'); },
    codePolicy: { existing_user_default_days: 7, welcome: {}, code_types: [] },
  }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/plans/catalog`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.plans.map(plan => plan.price.amount_minor), [0, 699, 1199]);
    assert.deepEqual(body.plans.map(plan => plan.quotas.max_beats), [20, 100, null]);
    for (const forbidden of ['polar_oat_private_test', 'whsec_private_test', 'prod_entry', 'price_entry', 'providerMapping']) {
      assert.equal(JSON.stringify(body).includes(forbidden), false);
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
