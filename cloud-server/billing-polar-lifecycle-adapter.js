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
  createPolarSandboxLifecycleAdapter,
};
