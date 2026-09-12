'use strict';

// BeatGaler Billing V1 commercial catalog.
// Pure configuration/domain module only: it does not call a billing provider,
// mutate subscriptions, grant access, or touch transport/runtime wiring.

const { BILLING_V1_ACCESS_CATALOG } = require('./billing-access-resolver');

const BILLING_CURRENCY = 'usd';
const BILLING_PROVIDER = 'polar';
const PROVIDER_ENVIRONMENTS = Object.freeze(['sandbox', 'production']);
const BILLING_INTERVALS = Object.freeze(['month', 'year']);

const OFFER_DEFINITIONS = Object.freeze({
  paid_entry_monthly_v1: Object.freeze({
    id: 'paid_entry_monthly_v1',
    planId: 'paid_entry',
    interval: 'month',
    currency: BILLING_CURRENCY,
    amountMinor: 699,
    salesEnabled: true,
    pendingReason: null,
  }),
  highest_paid_monthly_v1: Object.freeze({
    id: 'highest_paid_monthly_v1',
    planId: 'highest_paid',
    interval: 'month',
    currency: BILLING_CURRENCY,
    amountMinor: 1199,
    salesEnabled: true,
    pendingReason: null,
  }),
  paid_entry_annual_v1: Object.freeze({
    id: 'paid_entry_annual_v1',
    planId: 'paid_entry',
    interval: 'year',
    currency: BILLING_CURRENCY,
    amountMinor: null,
    salesEnabled: false,
    pendingReason: 'ANNUAL_PRICE_AND_LAUNCH_PENDING',
  }),
  highest_paid_annual_v1: Object.freeze({
    id: 'highest_paid_annual_v1',
    planId: 'highest_paid',
    interval: 'year',
    currency: BILLING_CURRENCY,
    amountMinor: null,
    salesEnabled: false,
    pendingReason: 'ANNUAL_PRICE_AND_LAUNCH_PENDING',
  }),
});

class BillingCatalogConfigError extends Error {
  constructor(message, code = 'BILLING_CATALOG_INVALID_CONFIG') {
    super(message);
    this.name = 'BillingCatalogConfigError';
    this.code = code;
  }
}

function requiredId(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new BillingCatalogConfigError(`${label} is required.`);
  if (!/^[A-Za-z0-9_:-]+$/.test(text)) {
    throw new BillingCatalogConfigError(`${label} is invalid.`);
  }
  return text;
}

function normalizeEnvironment(value) {
  const environment = String(value || '').trim().toLowerCase();
  if (!PROVIDER_ENVIRONMENTS.includes(environment)) {
    throw new BillingCatalogConfigError('Provider environment must be sandbox or production.');
  }
  return environment;
}

function validateOfferDefinition(offer) {
  if (!offer || typeof offer !== 'object') {
    throw new BillingCatalogConfigError('Offer definition is required.');
  }
  if (!BILLING_V1_ACCESS_CATALOG[offer.planId] || offer.planId === 'free') {
    throw new BillingCatalogConfigError(`Offer ${offer.id} maps to an unknown or non-purchasable plan.`);
  }
  if (!BILLING_INTERVALS.includes(offer.interval)) {
    throw new BillingCatalogConfigError(`Offer ${offer.id} has an unsupported interval.`);
  }
  if (offer.currency !== BILLING_CURRENCY) {
    throw new BillingCatalogConfigError(`Offer ${offer.id} must use ${BILLING_CURRENCY}.`);
  }
  if (offer.salesEnabled) {
    if (!Number.isInteger(offer.amountMinor) || offer.amountMinor <= 0) {
      throw new BillingCatalogConfigError(`Enabled offer ${offer.id} requires a positive amountMinor.`);
    }
    if (offer.pendingReason) {
      throw new BillingCatalogConfigError(`Enabled offer ${offer.id} cannot have a pendingReason.`);
    }
  } else if (offer.amountMinor !== null && (!Number.isInteger(offer.amountMinor) || offer.amountMinor <= 0)) {
    throw new BillingCatalogConfigError(`Disabled offer ${offer.id} has an invalid amountMinor.`);
  }
}

function normalizeProviderMapping(mapping, offerId) {
  if (mapping == null) return null;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new BillingCatalogConfigError(`Provider mapping for ${offerId} is invalid.`);
  }
  return Object.freeze({
    productId: requiredId(mapping.productId, `${offerId}.productId`),
    priceId: requiredId(mapping.priceId, `${offerId}.priceId`),
  });
}

function createCommercialCatalog({
  provider = BILLING_PROVIDER,
  environment = 'sandbox',
  providerMappings = {},
} = {}) {
  const providerId = String(provider || '').trim().toLowerCase();
  if (providerId !== BILLING_PROVIDER) {
    throw new BillingCatalogConfigError(`Billing V1 provider must be ${BILLING_PROVIDER}.`);
  }
  const providerEnvironment = normalizeEnvironment(environment);
  if (!providerMappings || typeof providerMappings !== 'object' || Array.isArray(providerMappings)) {
    throw new BillingCatalogConfigError('providerMappings must be an object.');
  }

  for (const offerId of Object.keys(providerMappings)) {
    if (!OFFER_DEFINITIONS[offerId]) {
      throw new BillingCatalogConfigError(`Unknown provider mapping offer: ${offerId}.`);
    }
  }

  const offers = {};
  for (const [offerId, definition] of Object.entries(OFFER_DEFINITIONS)) {
    validateOfferDefinition(definition);
    const providerMapping = normalizeProviderMapping(providerMappings[offerId], offerId);
    offers[offerId] = Object.freeze({
      ...definition,
      provider: providerId,
      providerEnvironment,
      providerMapping,
      providerConfigured: Boolean(providerMapping),
      checkoutReady: Boolean(definition.salesEnabled && providerMapping),
    });
  }

  return Object.freeze({
    version: 1,
    provider: providerId,
    providerEnvironment,
    currency: BILLING_CURRENCY,
    offers: Object.freeze(offers),
  });
}

function getOffer(catalog, offerId) {
  const id = String(offerId || '').trim();
  const offer = catalog?.offers?.[id];
  if (!offer) throw new BillingCatalogConfigError('Unknown billing offer.', 'BILLING_OFFER_UNKNOWN');
  return offer;
}

function getCheckoutReadyOffer(catalog, offerId) {
  const offer = getOffer(catalog, offerId);
  if (!offer.salesEnabled) {
    throw new BillingCatalogConfigError('Billing offer is not enabled for sale.', 'BILLING_OFFER_DISABLED');
  }
  if (!offer.providerConfigured) {
    throw new BillingCatalogConfigError('Billing offer has no provider mapping.', 'BILLING_OFFER_PROVIDER_UNCONFIGURED');
  }
  return offer;
}

module.exports = {
  BILLING_CURRENCY,
  BILLING_PROVIDER,
  PROVIDER_ENVIRONMENTS,
  BILLING_INTERVALS,
  OFFER_DEFINITIONS,
  BillingCatalogConfigError,
  createCommercialCatalog,
  getOffer,
  getCheckoutReadyOffer,
};
