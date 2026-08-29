'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CheckoutValidationError,
  CheckoutUnavailableError,
  createBillingCatalog,
  checkoutIdempotencyKey,
  createCheckoutService,
} = require('../billing-checkout');

function catalog() {
  return createBillingCatalog({
    paid_entry: { providerPriceId: 'price_paid_fixture', currency: 'mxn', trialDays: 7, taxMode: 'automatic' },
    highest_paid: { providerPriceId: 'price_high_fixture', currency: 'mxn', trialDays: 0, taxMode: 'automatic' },
  });
}

function providerHarness({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      async createCheckoutSession(input, options) {
        calls.push({ input, options });
        if (fail) throw new Error('timeout');
        return { id: 'cs_test_123', url: 'https://checkout.example.test/session' };
      },
    },
  };
}

const user = Object.freeze({ id: 'user-123', email: 'user@example.test' });
const urls = Object.freeze({ successUrl: 'https://app.example.test/billing/success', cancelUrl: 'https://app.example.test/billing/cancel' });


test('valid request uses server-owned product and price metadata', async () => {
  const h = providerHarness();
  const service = createCheckoutService({ catalog: catalog(), provider: h.provider, allowedCurrencies: ['mxn'] });
  const result = await service.createSession({ user, request: { product: 'paid_entry', checkoutRequestId: 'request_12345' }, ...urls });
  assert.equal(result.sessionId, 'cs_test_123');
  assert.equal(result.productId, 'paid_entry');
  assert.equal(result.priceId, 'paid_entry_monthly_v1');
  assert.equal(result.entitlementGranted, false);
  assert.equal(h.calls[0].input.providerPriceId, 'price_paid_fixture');
  assert.equal(h.calls[0].input.clientReferenceId, user.id);
  assert.equal(h.calls[0].input.metadata.beatgaler_user_id, user.id);
});

test('client price, plan, currency and trial tampering is rejected', async () => {
  const service = createCheckoutService({ catalog: catalog(), provider: providerHarness().provider });
  for (const injected of [
    { priceId: 'price_attacker' },
    { planId: 'highest_paid' },
    { currency: 'usd' },
    { trialDays: 365 },
    { amount: 1 },
  ]) {
    await assert.rejects(
      () => service.createSession({ user, request: { product: 'paid_entry', checkoutRequestId: 'request_12345', ...injected }, ...urls }),
      error => error instanceof CheckoutValidationError && error.code === 'CHECKOUT_TAMPERING',
    );
  }
});

test('same authenticated user/product/request retry produces same provider idempotency key', async () => {
  const h = providerHarness();
  const service = createCheckoutService({ catalog: catalog(), provider: h.provider });
  const request = { product: 'highest_paid', checkoutRequestId: 'retry_key_123' };
  await service.createSession({ user, request, ...urls });
  await service.createSession({ user, request, ...urls });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.idempotencyKey, h.calls[1].options.idempotencyKey);
  assert.equal(h.calls[0].options.idempotencyKey, checkoutIdempotencyKey({ userId: user.id, productId: 'highest_paid', checkoutRequestId: 'retry_key_123' }));
});

test('idempotency key is identity-bound and cannot cross users', () => {
  const a = checkoutIdempotencyKey({ userId: 'user-a', productId: 'paid_entry', checkoutRequestId: 'request_same' });
  const b = checkoutIdempotencyKey({ userId: 'user-b', productId: 'paid_entry', checkoutRequestId: 'request_same' });
  assert.notEqual(a, b);
});

test('unsupported product and configured currency fail closed before provider call', async () => {
  const h = providerHarness();
  const service = createCheckoutService({ catalog: catalog(), provider: h.provider, allowedCurrencies: ['usd'] });
  await assert.rejects(
    () => service.createSession({ user, request: { product: 'unknown', checkoutRequestId: 'request_12345' }, ...urls }),
    error => error.code === 'CHECKOUT_UNSUPPORTED_PRODUCT',
  );
  await assert.rejects(
    () => service.createSession({ user, request: { product: 'paid_entry', checkoutRequestId: 'request_12345' }, ...urls }),
    error => error.code === 'CHECKOUT_UNSUPPORTED_CURRENCY',
  );
  assert.equal(h.calls.length, 0);
});

test('provider timeout/error fails closed and never grants entitlement', async () => {
  const service = createCheckoutService({ catalog: catalog(), provider: providerHarness({ fail: true }).provider });
  await assert.rejects(
    () => service.createSession({ user, request: { product: 'paid_entry', checkoutRequestId: 'request_12345' }, ...urls }),
    error => error instanceof CheckoutUnavailableError,
  );
});

test('provider metadata and reference are always tied to authenticated user, not request body', async () => {
  const h = providerHarness();
  const service = createCheckoutService({ catalog: catalog(), provider: h.provider });
  await assert.rejects(
    () => service.createSession({ user, request: { product: 'paid_entry', checkoutRequestId: 'request_12345', metadata: { beatgaler_user_id: 'attacker' } }, ...urls }),
    error => error.code === 'CHECKOUT_TAMPERING',
  );
  await service.createSession({ user, request: { product: 'paid_entry', checkoutRequestId: 'request_67890' }, ...urls });
  assert.equal(h.calls[0].input.clientReferenceId, 'user-123');
  assert.deepEqual(h.calls[0].input.metadata, {
    beatgaler_user_id: 'user-123',
    beatgaler_product_id: 'paid_entry',
    beatgaler_price_id: 'paid_entry_monthly_v1',
  });
});
