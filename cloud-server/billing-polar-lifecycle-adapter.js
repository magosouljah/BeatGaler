'use strict';

const {
  POLAR_SDK_ENTRY,
  PolarSandboxConfigError,
  PolarSandboxAdapterError,
  readPolarSandboxConfig,
  createSandboxCommercialCatalog,
  createPinnedSandboxClient,
  createPolarSandboxAdapter,
} = require('./billing-polar-sandbox');
const { getCheckoutReadyOffer } = require('./billing-commercial-catalog');

const DEFAULT_DISCOVERY_LIMIT = 100;
const MAX_DISCOVERY_ITEMS = 500;

function requiredText(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new PolarSandboxConfigError(`${label} is required.`);
  return text;
}

function assertService(client, serviceName, methodName) {
  const method = client?.[serviceName]?.[methodName];
  if (typeof method !== 'function') {
    throw new PolarSandboxConfigError(`Polar SDK service ${serviceName}.${methodName}() is unavailable.`);
  }
  return method.bind(client[serviceName]);
}

function loadSdk() {
  try {
    return require(POLAR_SDK_ENTRY);
  } catch (error) {
    throw new PolarSandboxConfigError(
      'Pinned Polar SDK lifecycle entry is unavailable.',
      'POLAR_SANDBOX_SDK_MISSING',
    );
  }
}

function validateDiscoveryLimit(value) {
  const number = value == null ? DEFAULT_DISCOVERY_LIMIT : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_DISCOVERY_ITEMS) {
    throw new PolarSandboxConfigError(`limit must be between 1 and ${MAX_DISCOVERY_ITEMS}.`);
  }
  return number;
}

function pageItems(page) {
  if (Array.isArray(page)) return page;
  if (!page || typeof page !== 'object') return null;
  if (Array.isArray(page.items)) return page.items;
  if (Array.isArray(page.result?.items)) return page.result.items;
  if (Array.isArray(page.data?.items)) return page.data.items;
  return null;
}

async function collectList(raw, maxItems) {
  if (raw && typeof raw[Symbol.asyncIterator] === 'function') {
    const items = [];
    let truncated = false;
    for await (const page of raw) {
      const batch = pageItems(page);
      if (!batch) {
        throw new PolarSandboxAdapterError(
          'Polar sandbox paginated response is invalid.',
          'POLAR_SANDBOX_LIST_INVALID',
        );
      }
      for (const item of batch) {
        if (items.length >= maxItems) {
          truncated = true;
          break;
        }
        items.push(item);
      }
      if (truncated) break;
    }
    return Object.freeze({ items: Object.freeze(items), truncated });
  }

  const direct = pageItems(raw);
  if (direct) {
    return Object.freeze({
      items: Object.freeze(direct.slice(0, maxItems)),
      truncated: direct.length > maxItems,
    });
  }

  throw new PolarSandboxAdapterError(
    'Polar sandbox list response is invalid.',
    'POLAR_SANDBOX_LIST_INVALID',
  );
}

function createPolarSandboxLifecycleAdapter(options = {}) {
  const config = options.config || readPolarSandboxConfig(options.env || process.env);
  const catalog = options.catalog || createSandboxCommercialCatalog(config);
  const sdk = options.sdk || (options.client && options.webhooks ? null : loadSdk());
  const client = options.client || createPinnedSandboxClient({ config, sdk });
  const webhooks = options.webhooks || sdk?.webhooks;

  const base = createPolarSandboxAdapter({
    config,
    catalog,
    client,
    webhooks,
  });

  const orderGet = assertService(client, 'orders', 'get');
  const ordersList = assertService(client, 'orders', 'list');
  const subscriptionsList = assertService(client, 'subscriptions', 'list');
  const subscriptionUpdate = assertService(client, 'subscriptions', 'update');
  const subscriptionRevoke = assertService(client, 'subscriptions', 'revoke');

  async function call(code, action) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof PolarSandboxConfigError || error instanceof PolarSandboxAdapterError) throw error;
      throw new PolarSandboxAdapterError('Polar sandbox lifecycle request failed.', code, error);
    }
  }

  return Object.freeze({
    ...base,

    async getOrder(orderId) {
      return call(
        'POLAR_SANDBOX_ORDER_GET_FAILED',
        () => orderGet(requiredText(orderId, 'orderId')),
      );
    },

    async listSubscriptionsForUser({ userId, limit = DEFAULT_DISCOVERY_LIMIT } = {}) {
      const externalCustomerId = requiredText(userId, 'userId');
      const maxItems = validateDiscoveryLimit(limit);
      const result = await call(
        'POLAR_SANDBOX_SUBSCRIPTIONS_LIST_FAILED',
        () => subscriptionsList({
          organization_id: config.organizationId || undefined,
          external_customer_id: externalCustomerId,
          page: 1,
          limit: Math.min(maxItems, 100),
        }),
      );
      return collectList(result, maxItems);
    },

    async listOrdersForUser({ userId, limit = DEFAULT_DISCOVERY_LIMIT } = {}) {
      const externalCustomerId = requiredText(userId, 'userId');
      const maxItems = validateDiscoveryLimit(limit);
      const result = await call(
        'POLAR_SANDBOX_ORDERS_LIST_FAILED',
        () => ordersList({
          organization_id: config.organizationId || undefined,
          external_customer_id: externalCustomerId,
          product_billing_type: 'recurring',
          page: 1,
          limit: Math.min(maxItems, 100),
        }),
      );
      return collectList(result, maxItems);
    },

    async scheduleSubscriptionChange({ subscriptionId, offerId }) {
      const id = requiredText(subscriptionId, 'subscriptionId');
      const offer = getCheckoutReadyOffer(catalog, requiredText(offerId, 'offerId'));
      await base.validateOfferMapping(offer.id);
      const subscription = await call(
        'POLAR_SANDBOX_SUBSCRIPTION_UPDATE_FAILED',
        () => subscriptionUpdate(id, {
          product_id: offer.providerMapping.productId,
          proration_behavior: 'next_period',
        }),
      );
      return Object.freeze({
        subscription,
        offerId: offer.id,
        planId: offer.planId,
        effective: 'next_period',
      });
    },

    async revokeSubscription({ subscriptionId }) {
      return call(
        'POLAR_SANDBOX_SUBSCRIPTION_REVOKE_FAILED',
        () => subscriptionRevoke(requiredText(subscriptionId, 'subscriptionId')),
      );
    },
  });
}

module.exports = {
  DEFAULT_DISCOVERY_LIMIT,
  MAX_DISCOVERY_ITEMS,
  collectList,
  createPolarSandboxLifecycleAdapter,
};
