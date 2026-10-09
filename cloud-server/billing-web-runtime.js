'use strict';

const { BILLING_V1_ACCESS_CATALOG } = require('./billing-access-resolver');
const { createCommercialCatalog, getCheckoutReadyOffer } = require('./billing-commercial-catalog');
const { readPolarSandboxConfig, createSandboxCommercialCatalog } = require('./billing-polar-sandbox');
const { createPolarSandboxLifecycleAdapter } = require('./billing-polar-lifecycle-adapter');

const MONTHLY_OFFERS = Object.freeze(['paid_entry_monthly_v1', 'highest_paid_monthly_v1']);
const OFFER_BY_PLAN = Object.freeze({
  paid_entry: MONTHLY_OFFERS[0],
  highest_paid: MONTHLY_OFFERS[1],
});

class WebBillingUnavailableError extends Error {
  constructor(code = 'WEB_BILLING_UNAVAILABLE') {
    super('Web billing is unavailable.');
    this.name = 'WebBillingUnavailableError';
    this.code = code;
  }
}

function publicPlanCatalog(catalog) {
  return Object.values(BILLING_V1_ACCESS_CATALOG).map(plan => {
    const offer = OFFER_BY_PLAN[plan.id] ? catalog.offers[OFFER_BY_PLAN[plan.id]] : null;
    return {
      id: plan.id,
      label: plan.label,
      entitlements: {
        upload_project: plan.capabilities.upload_project,
        early_access: plan.capabilities.early_access,
      },
      quotas: {
        max_beats: plan.quotas.max_beats,
        max_project_zip_bytes: plan.quotas.max_project_zip_bytes,
      },
      price: {
        amount_minor: offer?.amountMinor ?? 0,
        currency: catalog.currency,
        interval: offer?.interval ?? null,
        offer_id: offer?.id ?? null,
      },
    };
  });
}

function createWebBillingRuntime({ env = process.env, adapterFactory = createPolarSandboxLifecycleAdapter } = {}) {
  // The public V1 contract is available even if provider configuration is absent.
  let catalog = createCommercialCatalog({ environment: 'sandbox' });
  let adapter = null;
  let ready = false;
  let failureCode = 'WEB_BILLING_NOT_INITIALIZED';

  async function initialize() {
    ready = false;
    adapter = null;
    catalog = createCommercialCatalog({ environment: 'sandbox' });
    failureCode = 'WEB_BILLING_UNAVAILABLE';
    try {
      if (env.BILLING_PROVIDER_ENVIRONMENT !== 'sandbox') {
        throw new WebBillingUnavailableError('WEB_BILLING_ENVIRONMENT_UNSUPPORTED');
      }
      const config = readPolarSandboxConfig(env);
      const configuredCatalog = createSandboxCommercialCatalog(config);
      const entry = configuredCatalog.offers.paid_entry_monthly_v1.providerMapping;
      const highest = configuredCatalog.offers.highest_paid_monthly_v1.providerMapping;
      if (entry.productId === highest.productId || entry.priceId === highest.priceId) {
        throw new WebBillingUnavailableError('WEB_BILLING_MAPPING_DUPLICATE');
      }
      const provider = adapterFactory({ config, catalog: configuredCatalog });
      if (!provider || provider.environment !== 'sandbox' || typeof provider.validateOfferMapping !== 'function' ||
          typeof provider.createCheckout !== 'function' || typeof provider.getCheckoutOffer !== 'function') {
        throw new WebBillingUnavailableError('WEB_BILLING_PROVIDER_INVALID');
      }
      for (const offerId of MONTHLY_OFFERS) {
        const verified = await provider.validateOfferMapping(offerId);
        const expected = getCheckoutReadyOffer(configuredCatalog, offerId);
        if (verified?.offerId !== offerId || verified.productId !== expected.providerMapping.productId ||
            verified.priceId !== expected.providerMapping.priceId || verified.currency !== expected.currency ||
            verified.amountMinor !== expected.amountMinor || verified.interval !== expected.interval) {
          throw new WebBillingUnavailableError('WEB_BILLING_MAPPING_MISMATCH');
        }
      }
      catalog = configuredCatalog;
      adapter = provider;
      ready = true;
      failureCode = null;
    } catch (error) {
      // No provider exception or configuration value is exposed in logs or public responses.
      failureCode = /^(WEB_BILLING|POLAR_SANDBOX|BILLING)_[A-Z0-9_]{1,70}$/.test(error?.code || '')
        ? error.code : 'WEB_BILLING_UNAVAILABLE';
    }
    return { ready, failureCode };
  }

  function provider() {
    if (!ready || !adapter) throw new WebBillingUnavailableError(failureCode);
    return adapter;
  }

  function getCheckoutOffer(offerId) {
    if (typeof offerId !== 'string') throw new WebBillingUnavailableError('WEB_BILLING_OFFER_INVALID');
    const offer = getCheckoutReadyOffer(catalog, offerId);
    provider();
    return offer;
  }

  return Object.freeze({
    initialize,
    planCatalog: () => publicPlanCatalog(catalog),
    status: () => ({ ready, failureCode }),
    // STEP 8 can inject this exact validated adapter into the durable checkout service.
    provider,
    getCheckoutOffer,
  });
}

let runtime = createWebBillingRuntime();

module.exports = {
  MONTHLY_OFFERS,
  WebBillingUnavailableError,
  createWebBillingRuntime,
  publicPlanCatalog,
  configure: async options => {
    runtime = createWebBillingRuntime(options);
    return runtime.initialize();
  },
  planCatalog: () => runtime.planCatalog(),
  status: () => runtime.status(),
  provider: () => runtime.provider(),
  getCheckoutOffer: offerId => runtime.getCheckoutOffer(offerId),
};
