'use strict';

const { readPolarProductionConfig, createProductionCommercialCatalog,
  createPolarProductionLifecycleAdapter } = require('./billing-polar-production');

const OFFERS = Object.freeze(['paid_entry_monthly_v1', 'highest_paid_monthly_v1']);

async function preflightPolarProduction({ env = process.env,
  adapterFactory = createPolarProductionLifecycleAdapter } = {}) {
  const config = readPolarProductionConfig(env);
  const catalog = createProductionCommercialCatalog(config);
  const adapter = adapterFactory({ config, catalog });
  if (adapter?.provider !== 'polar' || adapter.environment !== 'production' ||
      typeof adapter.validateOfferMapping !== 'function') throw new Error('POLAR_PRODUCTION_ADAPTER_INVALID');
  for (const offerId of OFFERS) {
    const expected = catalog.offers[offerId];
    const actual = await adapter.validateOfferMapping(offerId);
    if (actual?.offerId !== offerId || actual.productId !== expected.providerMapping.productId ||
        actual.priceId !== expected.providerMapping.priceId || actual.currency !== expected.currency ||
        actual.amountMinor !== expected.amountMinor || actual.interval !== expected.interval) {
      throw new Error('POLAR_PRODUCTION_MAPPING_MISMATCH');
    }
  }
  return Object.freeze({ provider: 'polar', environment: 'production', apiVersion: config.apiVersion,
    checkedOffers: OFFERS.slice(), checkoutCreated: false });
}

module.exports = { OFFERS, preflightPolarProduction };
