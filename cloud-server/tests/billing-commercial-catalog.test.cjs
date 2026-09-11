'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BILLING_CURRENCY,
  BILLING_PROVIDER,
  OFFER_DEFINITIONS,
  BillingCatalogConfigError,
  createCommercialCatalog,
  getCheckoutReadyOffer,
} = require('../billing-commercial-catalog');

test('V1 monthly offers use approved USD prices and annual remains pending', () => {
  assert.equal(BILLING_PROVIDER, 'polar');
  assert.equal(BILLING_CURRENCY, 'usd');
  assert.equal(OFFER_DEFINITIONS.paid_entry_monthly_v1.amountMinor, 699);
  assert.equal(OFFER_DEFINITIONS.highest_paid_monthly_v1.amountMinor, 1199);
  assert.equal(OFFER_DEFINITIONS.paid_entry_monthly_v1.salesEnabled, true);
  assert.equal(OFFER_DEFINITIONS.highest_paid_monthly_v1.salesEnabled, true);
  assert.equal(OFFER_DEFINITIONS.paid_entry_annual_v1.amountMinor, null);
  assert.equal(OFFER_DEFINITIONS.highest_paid_annual_v1.amountMinor, null);
  assert.equal(OFFER_DEFINITIONS.paid_entry_annual_v1.salesEnabled, false);
  assert.equal(OFFER_DEFINITIONS.highest_paid_annual_v1.salesEnabled, false);
});

test('provider mapping is server-side and makes only enabled monthly offers checkout-ready', () => {
  const catalog = createCommercialCatalog({
    provider: 'polar',
    environment: 'sandbox',
    providerMappings: {
      paid_entry_monthly_v1: { productId: 'prod_paid_sandbox', priceId: 'price_paid_sandbox' },
      paid_entry_annual_v1: { productId: 'prod_paid_annual_sandbox', priceId: 'price_paid_annual_sandbox' },
    },
  });

  assert.equal(catalog.providerEnvironment, 'sandbox');
  assert.equal(catalog.offers.paid_entry_monthly_v1.providerConfigured, true);
  assert.equal(catalog.offers.paid_entry_monthly_v1.checkoutReady, true);
  assert.equal(catalog.offers.paid_entry_annual_v1.providerConfigured, true);
  assert.equal(catalog.offers.paid_entry_annual_v1.checkoutReady, false);
});

test('approved offer without provider mapping is not checkout-ready', () => {
  const catalog = createCommercialCatalog({ environment: 'sandbox' });
  assert.equal(catalog.offers.highest_paid_monthly_v1.salesEnabled, true);
  assert.equal(catalog.offers.highest_paid_monthly_v1.providerConfigured, false);
  assert.equal(catalog.offers.highest_paid_monthly_v1.checkoutReady, false);
  assert.throws(
    () => getCheckoutReadyOffer(catalog, 'highest_paid_monthly_v1'),
    error => error instanceof BillingCatalogConfigError && error.code === 'BILLING_OFFER_PROVIDER_UNCONFIGURED',
  );
});

test('annual offer cannot become sellable merely by configuring provider IDs', () => {
  const catalog = createCommercialCatalog({
    environment: 'production',
    providerMappings: {
      highest_paid_annual_v1: { productId: 'prod_high_annual_prod', priceId: 'price_high_annual_prod' },
    },
  });
  assert.equal(catalog.offers.highest_paid_annual_v1.providerConfigured, true);
  assert.equal(catalog.offers.highest_paid_annual_v1.salesEnabled, false);
  assert.throws(
    () => getCheckoutReadyOffer(catalog, 'highest_paid_annual_v1'),
    error => error instanceof BillingCatalogConfigError && error.code === 'BILLING_OFFER_DISABLED',
  );
});

test('unknown provider mappings and invalid environment fail closed', () => {
  assert.throws(
    () => createCommercialCatalog({
      environment: 'sandbox',
      providerMappings: { attacker_offer: { productId: 'prod_x', priceId: 'price_x' } },
    }),
    error => error instanceof BillingCatalogConfigError,
  );
  assert.throws(
    () => createCommercialCatalog({ environment: 'test' }),
    error => error instanceof BillingCatalogConfigError,
  );
});
