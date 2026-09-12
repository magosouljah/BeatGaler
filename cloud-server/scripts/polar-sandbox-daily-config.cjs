'use strict';

// Task 11 only. Never imported by the server or the normal commercial catalog.
const { createCommercialCatalog } = require('../billing-commercial-catalog');
const { validateProviderProductForOffer, createPinnedSandboxClient, POLAR_SDK_ENTRY } = require('../billing-polar-sandbox');
const { createPolarSandboxLifecycleAdapter } = require('../billing-polar-lifecycle-adapter');
const MODE = 'daily_natural_sandbox';
const ENTRY = 'e2e_daily_paid_entry_v1';
const HIGHEST = 'e2e_daily_highest_paid_v1';
const ENV = Object.freeze({
  mode: 'POLAR_SANDBOX_E2E_MODE', provider: 'BILLING_E2E_PROVIDER', environment: 'BILLING_E2E_PROVIDER_ENVIRONMENT',
  entryProduct: 'POLAR_SANDBOX_E2E_DAILY_PAID_ENTRY_PRODUCT_ID',
  entryPrice: 'POLAR_SANDBOX_E2E_DAILY_PAID_ENTRY_PRICE_ID',
  entryAmount: 'POLAR_SANDBOX_E2E_DAILY_PAID_ENTRY_AMOUNT_MINOR',
  highestProduct: 'POLAR_SANDBOX_E2E_DAILY_HIGHEST_PAID_PRODUCT_ID',
  highestPrice: 'POLAR_SANDBOX_E2E_DAILY_HIGHEST_PAID_PRICE_ID',
  highestAmount: 'POLAR_SANDBOX_E2E_DAILY_HIGHEST_PAID_AMOUNT_MINOR',
});
function check(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
function text(env, name) { const value = String(env[name] || '').trim(); check(value, `DAILY_REQUIRED_${name}`); return value; }
function readConfig(env = process.env) {
  check(env[ENV.mode] === MODE && env[ENV.provider] === 'polar' && env[ENV.environment] === 'sandbox'
    && env.NODE_ENV !== 'production', 'DAILY_SANDBOX_ONLY');
  const config = { mode: MODE, provider: 'polar', environment: 'sandbox',
    accessToken: text(env, 'POLAR_SANDBOX_ACCESS_TOKEN'), webhookSecret: text(env, 'POLAR_SANDBOX_WEBHOOK_SECRET'),
    organizationId: text(env, 'POLAR_SANDBOX_ORGANIZATION_ID'), providerMappings: {}, amounts: {} };
  for (const [id, prefix] of [[ENTRY, 'entry'], [HIGHEST, 'highest']]) {
    config.providerMappings[id] = { productId: text(env, ENV[`${prefix}Product`]), priceId: text(env, ENV[`${prefix}Price`]) };
    const amount = Number(text(env, ENV[`${prefix}Amount`]));
    check(Number.isSafeInteger(amount) && amount > 0, 'DAILY_INVALID_AMOUNT'); config.amounts[id] = amount;
  }
  check(config.providerMappings[ENTRY].productId !== config.providerMappings[HIGHEST].productId
    && config.providerMappings[ENTRY].priceId !== config.providerMappings[HIGHEST].priceId, 'DAILY_DUPLICATE_MAPPING');
  return config;
}
function createCatalog(config) {
  check(config.mode === MODE && config.provider === 'polar' && config.environment === 'sandbox', 'DAILY_SANDBOX_ONLY');
  const normal = createCommercialCatalog();
  const offers = {};
  for (const [id, source] of [[ENTRY, 'paid_entry_monthly_v1'], [HIGHEST, 'highest_paid_monthly_v1']]) {
    offers[id] = Object.freeze({ ...normal.offers[source], id, commercialEquivalent: source,
      // The internal V1 interval and DB constraint remain monthly. Only Polar's test cadence is daily.
      providerInterval: 'day', providerIntervalCount: 1, e2eMode: MODE,
      amountMinor: config.amounts[id], providerMapping: Object.freeze({ ...config.providerMappings[id] }),
      providerConfigured: true, checkoutReady: true });
  }
  return Object.freeze({ ...normal, e2eMode: MODE, offers: Object.freeze(offers) });
}
function validateDailyProduct({ product, offer, organizationId }) {
  check(offer.e2eMode === MODE && offer.provider === 'polar' && offer.providerEnvironment === 'sandbox', 'DAILY_SANDBOX_ONLY');
  check(organizationId && product?.organization_id === organizationId, 'DAILY_ORGANIZATION_MISMATCH');
  check(product?.is_archived === false, 'DAILY_PRODUCT_UNUSABLE');
  const price = product?.prices?.find(p => p.id === offer.providerMapping.priceId);
  check(price?.is_archived === false, 'DAILY_PRICE_UNUSABLE');
  check(product.recurring_interval === 'day' && product.recurring_interval_count === 1
    && (!price.recurring_interval || price.recurring_interval === 'day')
    && (price.recurring_interval_count == null || price.recurring_interval_count === 1), 'DAILY_INTERVAL_MISMATCH');
  return { ...validateProviderProductForOffer({ product, offer: { ...offer, interval: 'day' }, organizationId }),
    mode: MODE, commercialEquivalent: offer.commercialEquivalent, domainInterval: offer.interval, intervalCount: 1 };
}
function createAdapter(config) {
  const catalog = createCatalog(config);
  const adapter = createPolarSandboxLifecycleAdapter({ config, catalog, validateProduct: validateDailyProduct });
  // The natural runner cannot access the historical time mutation primitive.
  const { rescheduleSubscriptionRenewal: unused, ...natural } = adapter;
  const client = createPinnedSandboxClient({ config, sdk: require(POLAR_SDK_ENTRY) });
  return Object.freeze({ ...natural,
    async getFinancialOrder(orderId) {
      const order = await adapter.getOrder(orderId);
      const page = await client.payments.list({ order_id: orderId, organization_id: config.organizationId, limit: 100 });
      check(Array.isArray(page.items) && page.items.length < 100, 'DAILY_PAYMENT_DISCOVERY_INVALID');
      const financialPayments = page.items.map(p => {
        check(p.order_id === orderId && p.organization_id === config.organizationId, 'DAILY_PAYMENT_BINDING_MISMATCH');
        return { id:p.id, orderId:p.order_id, status:p.status, amountMinor:p.amount, currency:p.currency,
          processor:p.processor, trigger:p.trigger, createdAt:p.created_at };
      });
      return { ...order, financialPayments };
    },
  });
}
module.exports = { MODE, ENTRY, HIGHEST, ENV, check, text, readConfig, createCatalog, validateDailyProduct, createAdapter };
