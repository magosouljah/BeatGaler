'use strict';

const { createCommercialCatalog } = require('./billing-commercial-catalog');
const { createPolarSandboxLifecycleAdapter } = require('./billing-polar-lifecycle-adapter');

const FIELDS = Object.freeze({
  accessToken: 'POLAR_PRODUCTION_ACCESS_TOKEN',
  webhookSecret: 'POLAR_PRODUCTION_WEBHOOK_SECRET',
  organizationId: 'POLAR_PRODUCTION_ORGANIZATION_ID',
  paidEntryProductId: 'POLAR_PRODUCTION_PAID_ENTRY_MONTHLY_PRODUCT_ID',
  paidEntryPriceId: 'POLAR_PRODUCTION_PAID_ENTRY_MONTHLY_PRICE_ID',
  highestPaidProductId: 'POLAR_PRODUCTION_HIGHEST_PAID_MONTHLY_PRODUCT_ID',
  highestPaidPriceId: 'POLAR_PRODUCTION_HIGHEST_PAID_MONTHLY_PRICE_ID',
});

class PolarProductionConfigError extends Error {
  constructor(code = 'POLAR_PRODUCTION_CONFIG_INVALID') {
    super(code);
    this.code = code;
  }
}

function required(env, key) {
  const value = env?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new PolarProductionConfigError();
  return value.trim();
}

function readPolarProductionConfig(env = process.env) {
  const config = {
    provider: 'polar', environment: 'production', apiVersion: '2026-04',
    sdkPackage: '@polar-sh/sdk', sdkVersion: '1.0.0-alpha.20',
    accessToken: required(env, FIELDS.accessToken),
    webhookSecret: required(env, FIELDS.webhookSecret),
    organizationId: required(env, FIELDS.organizationId),
    providerMappings: {
      paid_entry_monthly_v1: {
        productId: required(env, FIELDS.paidEntryProductId),
        priceId: required(env, FIELDS.paidEntryPriceId),
      },
      highest_paid_monthly_v1: {
        productId: required(env, FIELDS.highestPaidProductId),
        priceId: required(env, FIELDS.highestPaidPriceId),
      },
    },
  };
  if (env.POLAR_SANDBOX_ACCESS_TOKEN && env.POLAR_SANDBOX_ACCESS_TOKEN === config.accessToken) {
    throw new PolarProductionConfigError('POLAR_PRODUCTION_TOKEN_REUSED');
  }
  return Object.freeze({ ...config, providerMappings: Object.freeze({
    paid_entry_monthly_v1: Object.freeze(config.providerMappings.paid_entry_monthly_v1),
    highest_paid_monthly_v1: Object.freeze(config.providerMappings.highest_paid_monthly_v1),
  }) });
}

function createProductionCommercialCatalog(config) {
  if (config?.provider !== 'polar' || config?.environment !== 'production') throw new PolarProductionConfigError();
  return createCommercialCatalog({ provider: 'polar', environment: 'production', providerMappings: config.providerMappings });
}

function createPolarProductionLifecycleAdapter(options = {}) {
  const config = options.config || readPolarProductionConfig(options.env || process.env);
  const catalog = options.catalog || createProductionCommercialCatalog(config);
  if (config.environment !== 'production' || catalog.providerEnvironment !== 'production') throw new PolarProductionConfigError();
  const adapter = createPolarSandboxLifecycleAdapter({ ...options, config, catalog, allowProduction: true });
  return Object.freeze({
    ...adapter,
    async createCheckout(input) {
      const checkout = await adapter.createCheckout(input);
      let url;
      try { url = new URL(checkout.url); } catch { throw new PolarProductionConfigError('POLAR_PRODUCTION_CHECKOUT_URL_INVALID'); }
      if (url.protocol !== 'https:' || url.username || url.password ||
          !(url.hostname === 'polar.sh' || (url.hostname.endsWith('.polar.sh') && !url.hostname.startsWith('sandbox.')))) {
        throw new PolarProductionConfigError('POLAR_PRODUCTION_CHECKOUT_URL_INVALID');
      }
      return checkout;
    },
  });
}

module.exports = { FIELDS, PolarProductionConfigError, readPolarProductionConfig,
  createProductionCommercialCatalog, createPolarProductionLifecycleAdapter };
