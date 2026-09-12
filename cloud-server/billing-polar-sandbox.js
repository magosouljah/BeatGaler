'use strict';

const {
  createCommercialCatalog,
  getCheckoutReadyOffer,
} = require('./billing-commercial-catalog');

const POLAR_PROVIDER = 'polar';
const POLAR_ENVIRONMENT = 'sandbox';
const POLAR_API_VERSION = '2026-04';
const POLAR_SDK_PACKAGE = '@polar-sh/sdk';
const POLAR_SDK_VERSION = '1.0.0-alpha.20';
const POLAR_SDK_ENTRY = '@polar-sh/sdk/2026-04';

const ENV = Object.freeze({
  accessToken: 'POLAR_SANDBOX_ACCESS_TOKEN',
  webhookSecret: 'POLAR_SANDBOX_WEBHOOK_SECRET',
  organizationId: 'POLAR_SANDBOX_ORGANIZATION_ID',
  paidEntryProductId: 'POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRODUCT_ID',
  paidEntryPriceId: 'POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRICE_ID',
  highestPaidProductId: 'POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRODUCT_ID',
  highestPaidPriceId: 'POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRICE_ID',
});

class PolarSandboxConfigError extends Error {
  constructor(message, code = 'POLAR_SANDBOX_CONFIG_INVALID') {
    super(message);
    this.name = 'PolarSandboxConfigError';
    this.code = code;
  }
}

class PolarSandboxAdapterError extends Error {
  constructor(message, code = 'POLAR_SANDBOX_REQUEST_FAILED', cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PolarSandboxAdapterError';
    this.code = code;
    if (cause && this.cause == null) this.cause = cause;
  }
}

function requiredText(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new PolarSandboxConfigError(`${label} is required.`);
  return text;
}

function optionalText(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function requiredUrl(value, label) {
  const text = requiredText(value, label);
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    throw new PolarSandboxConfigError(`${label} must be a valid absolute URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new PolarSandboxConfigError(`${label} must use http or https.`);
  }
  return url.toString();
}

function readPolarSandboxConfig(env = process.env) {
  if (!env || typeof env !== 'object') {
    throw new PolarSandboxConfigError('Sandbox environment configuration is required.');
  }

  const config = {
    provider: POLAR_PROVIDER,
    environment: POLAR_ENVIRONMENT,
    apiVersion: POLAR_API_VERSION,
    sdkPackage: POLAR_SDK_PACKAGE,
    sdkVersion: POLAR_SDK_VERSION,
    accessToken: requiredText(env[ENV.accessToken], ENV.accessToken),
    webhookSecret: requiredText(env[ENV.webhookSecret], ENV.webhookSecret),
    organizationId: optionalText(env[ENV.organizationId]),
    providerMappings: {
      paid_entry_monthly_v1: {
        productId: requiredText(env[ENV.paidEntryProductId], ENV.paidEntryProductId),
        priceId: requiredText(env[ENV.paidEntryPriceId], ENV.paidEntryPriceId),
      },
      highest_paid_monthly_v1: {
        productId: requiredText(env[ENV.highestPaidProductId], ENV.highestPaidProductId),
        priceId: requiredText(env[ENV.highestPaidPriceId], ENV.highestPaidPriceId),
      },
    },
  };

  return Object.freeze({
    ...config,
    providerMappings: Object.freeze({
      paid_entry_monthly_v1: Object.freeze({ ...config.providerMappings.paid_entry_monthly_v1 }),
      highest_paid_monthly_v1: Object.freeze({ ...config.providerMappings.highest_paid_monthly_v1 }),
    }),
  });
}

function createSandboxCommercialCatalog(config) {
  if (!config || config.environment !== POLAR_ENVIRONMENT || config.provider !== POLAR_PROVIDER) {
    throw new PolarSandboxConfigError('Polar sandbox adapter requires provider=polar and environment=sandbox.');
  }
  return createCommercialCatalog({
    provider: POLAR_PROVIDER,
    environment: POLAR_ENVIRONMENT,
    providerMappings: config.providerMappings,
  });
}

function validateProviderProductForOffer({ product, offer, organizationId = null }) {
  if (!product || typeof product !== 'object') {
    throw new PolarSandboxConfigError(
      `Polar product for ${offer?.id || 'offer'} is missing.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }
  if (!offer?.providerMapping) {
    throw new PolarSandboxConfigError(
      'Checkout-ready offer requires a Polar provider mapping.',
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }
  if (String(product.id || '') !== offer.providerMapping.productId) {
    throw new PolarSandboxConfigError(
      `Polar product ID does not match ${offer.id}.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }
  if (product.is_archived === true) {
    throw new PolarSandboxConfigError(
      `Polar product for ${offer.id} is archived.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }
  if (organizationId && product.organization_id && String(product.organization_id) !== organizationId) {
    throw new PolarSandboxConfigError(
      `Polar product for ${offer.id} belongs to a different organization.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }

  const prices = Array.isArray(product.prices) ? product.prices : [];
  const price = prices.find(candidate => String(candidate?.id || '') === offer.providerMapping.priceId);
  if (!price) {
    throw new PolarSandboxConfigError(
      `Polar price for ${offer.id} was not found on the configured product.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }
  if (price.amount_type !== 'fixed') {
    throw new PolarSandboxConfigError(
      `Polar price for ${offer.id} must be fixed.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }
  if (String(price.price_currency || '').toLowerCase() !== offer.currency) {
    throw new PolarSandboxConfigError(
      `Polar price currency for ${offer.id} does not match BeatGaler.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }
  if (price.price_amount !== offer.amountMinor) {
    throw new PolarSandboxConfigError(
      `Polar price amount for ${offer.id} does not match BeatGaler.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }

  const recurringInterval = price.recurring_interval || product.recurring_interval || null;
  if (recurringInterval !== offer.interval) {
    throw new PolarSandboxConfigError(
      `Polar recurring interval for ${offer.id} does not match BeatGaler.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }
  const intervalCount = price.recurring_interval_count ?? product.recurring_interval_count ?? 1;
  if (intervalCount !== 1) {
    throw new PolarSandboxConfigError(
      `Polar recurring interval count for ${offer.id} must be 1.`,
      'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH',
    );
  }

  return Object.freeze({
    offerId: offer.id,
    planId: offer.planId,
    productId: offer.providerMapping.productId,
    priceId: offer.providerMapping.priceId,
    currency: offer.currency,
    amountMinor: offer.amountMinor,
    interval: offer.interval,
  });
}

function loadPinnedPolarSdk() {
  try {
    return require(POLAR_SDK_ENTRY);
  } catch (error) {
    throw new PolarSandboxConfigError(
      `Pinned Polar SDK ${POLAR_SDK_PACKAGE}@${POLAR_SDK_VERSION} is not installed.`,
      'POLAR_SANDBOX_SDK_MISSING',
    );
  }
}

function createPinnedSandboxClient({ config, sdk }) {
  if (!sdk || typeof sdk.createPolar !== 'function') {
    throw new PolarSandboxConfigError('Polar SDK createPolar() is unavailable.');
  }
  return sdk.createPolar({
    accessToken: config.accessToken,
    environment: POLAR_ENVIRONMENT,
    version: POLAR_API_VERSION,
  });
}

function assertService(client, serviceName, methodName) {
  const method = client?.[serviceName]?.[methodName];
  if (typeof method !== 'function') {
    throw new PolarSandboxConfigError(`Polar SDK service ${serviceName}.${methodName}() is unavailable.`);
  }
  return method.bind(client[serviceName]);
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    throw new PolarSandboxConfigError('Webhook headers are required.');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    normalized[String(key).toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return normalized;
}

function normalizeRawBody(rawBody) {
  if (typeof rawBody === 'string') return rawBody;
  if (Buffer.isBuffer(rawBody)) return new Uint8Array(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  throw new PolarSandboxConfigError('Webhook raw body must be an unmodified string, Buffer, or Uint8Array.');
}

function createPolarSandboxAdapter(options = {}) {
  const config = options.config || readPolarSandboxConfig(options.env || process.env);
  const catalog = options.catalog || createSandboxCommercialCatalog(config);
  const sdk = options.sdk || (options.client && options.webhooks ? null : loadPinnedPolarSdk());
  const client = options.client || createPinnedSandboxClient({ config, sdk });
  const webhookApi = options.webhooks || sdk?.webhooks;

  const productsList = assertService(client, 'products', 'list');
  const productsGet = assertService(client, 'products', 'get');
  const checkoutCreate = assertService(client, 'checkouts', 'create');
  const customerSessionCreate = assertService(client, 'customerSessions', 'create');
  const customerGet = assertService(client, 'customers', 'get');
  const customerGetExternal = assertService(client, 'customers', 'getExternal');
  const subscriptionGet = assertService(client, 'subscriptions', 'get');
  const paymentGet = assertService(client, 'payments', 'get');

  if (!webhookApi || typeof webhookApi.validateEvent !== 'function') {
    throw new PolarSandboxConfigError('Polar SDK webhooks.validateEvent() is unavailable.');
  }

  async function call(code, action) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof PolarSandboxConfigError || error instanceof PolarSandboxAdapterError) throw error;
      throw new PolarSandboxAdapterError('Polar sandbox request failed.', code, error);
    }
  }

  async function validateOffer(offer) {
    const product = await call('POLAR_SANDBOX_PRODUCT_GET_FAILED', () => productsGet(offer.providerMapping.productId));
    return (options.validateProduct || validateProviderProductForOffer)({ product, offer, organizationId: config.organizationId });
  }

  return Object.freeze({
    provider: POLAR_PROVIDER,
    environment: POLAR_ENVIRONMENT,
    apiVersion: POLAR_API_VERSION,
    sdkVersion: POLAR_SDK_VERSION,
    catalog,

    getCheckoutOffer(offerId) {
      return getCheckoutReadyOffer(catalog, requiredText(offerId, 'offerId'));
    },

    async listProducts({ page = 1, limit = 100 } = {}) {
      if (!Number.isInteger(page) || page < 1) throw new PolarSandboxConfigError('page must be a positive integer.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PolarSandboxConfigError('limit must be between 1 and 100.');
      return call('POLAR_SANDBOX_PRODUCTS_LIST_FAILED', () => productsList({
        organization_id: config.organizationId || undefined,
        page,
        limit,
      }));
    },

    async validateOfferMapping(offerId) {
      const offer = getCheckoutReadyOffer(catalog, requiredText(offerId, 'offerId'));
      return validateOffer(offer);
    },

    async createCheckout({ offerId, userId, email = null, successUrl, returnUrl }) {
      const offer = getCheckoutReadyOffer(catalog, requiredText(offerId, 'offerId'));
      await validateOffer(offer);
      const externalCustomerId = requiredText(userId, 'userId');
      const body = {
        product_price_id: offer.providerMapping.priceId,
        external_customer_id: externalCustomerId,
        customer_email: optionalText(email) || undefined,
        success_url: requiredUrl(successUrl, 'successUrl'),
        return_url: requiredUrl(returnUrl, 'returnUrl'),
        allow_trial: false,
        metadata: {
          beatgaler_user_id: externalCustomerId,
          beatgaler_offer_id: offer.id,
          beatgaler_plan_id: offer.planId,
          beatgaler_provider_product_id: offer.providerMapping.productId,
          beatgaler_provider_price_id: offer.providerMapping.priceId,
        },
      };
      const checkout = await call('POLAR_SANDBOX_CHECKOUT_CREATE_FAILED', () => checkoutCreate(body));
      const id = requiredText(checkout?.id, 'Polar checkout id');
      const url = requiredUrl(checkout?.url, 'Polar checkout url');
      return Object.freeze({
        id,
        url,
        offerId: offer.id,
        planId: offer.planId,
        providerProductId: offer.providerMapping.productId,
        providerPriceId: offer.providerMapping.priceId,
        entitlementGranted: false,
      });
    },

    async createCustomerPortal({ userId, returnUrl }) {
      const externalCustomerId = requiredText(userId, 'userId');
      const session = await call('POLAR_SANDBOX_PORTAL_CREATE_FAILED', () => customerSessionCreate({
        external_customer_id: externalCustomerId,
        return_url: requiredUrl(returnUrl, 'returnUrl'),
      }));
      return Object.freeze({
        url: requiredUrl(session?.customer_portal_url, 'Polar customer portal url'),
      });
    },

    async getCustomer(customerId) {
      return call('POLAR_SANDBOX_CUSTOMER_GET_FAILED', () => customerGet(requiredText(customerId, 'customerId')));
    },

    async getCustomerByExternalId(userId) {
      return call('POLAR_SANDBOX_CUSTOMER_GET_FAILED', () => customerGetExternal(requiredText(userId, 'userId')));
    },

    async getSubscription(subscriptionId) {
      return call('POLAR_SANDBOX_SUBSCRIPTION_GET_FAILED', () => subscriptionGet(requiredText(subscriptionId, 'subscriptionId')));
    },

    async getPayment(paymentId) {
      return call('POLAR_SANDBOX_PAYMENT_GET_FAILED', () => paymentGet(requiredText(paymentId, 'paymentId')));
    },

    async verifyWebhook({ rawBody, headers }) {
      const body = normalizeRawBody(rawBody);
      const normalizedHeaders = normalizeHeaders(headers);
      try {
        return await webhookApi.validateEvent(body, normalizedHeaders, config.webhookSecret);
      } catch (error) {
        throw new PolarSandboxAdapterError(
          'Polar sandbox webhook signature is invalid.',
          'POLAR_SANDBOX_WEBHOOK_INVALID',
          error,
        );
      }
    },
  });
}

module.exports = {
  POLAR_PROVIDER,
  POLAR_ENVIRONMENT,
  POLAR_API_VERSION,
  POLAR_SDK_PACKAGE,
  POLAR_SDK_VERSION,
  POLAR_SDK_ENTRY,
  ENV,
  PolarSandboxConfigError,
  PolarSandboxAdapterError,
  readPolarSandboxConfig,
  createSandboxCommercialCatalog,
  createPinnedSandboxClient,
  validateProviderProductForOffer,
  createPolarSandboxAdapter,
};
