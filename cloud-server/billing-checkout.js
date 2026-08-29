'use strict';

const crypto = require('crypto');
const { PLAN_CATALOG } = require('./plans');

const INTERNAL_PRICE_IDS = Object.freeze({
  paid_entry: 'paid_entry_monthly_v1',
  highest_paid: 'highest_paid_monthly_v1',
});
const CLIENT_FORBIDDEN_BILLING_FIELDS = Object.freeze([
  'planId', 'priceId', 'providerPriceId', 'amount', 'unitAmount', 'currency',
  'trialDays', 'taxBehavior', 'taxMode', 'entitlements', 'metadata',
]);

class CheckoutValidationError extends Error {
  constructor(message, code = 'CHECKOUT_INVALID_REQUEST') {
    super(message);
    this.name = 'CheckoutValidationError';
    this.code = code;
  }
}

class CheckoutUnavailableError extends Error {
  constructor(message = 'Checkout provider is unavailable.') {
    super(message);
    this.name = 'CheckoutUnavailableError';
    this.code = 'CHECKOUT_PROVIDER_UNAVAILABLE';
  }
}

function requiredText(value, label, pattern = null) {
  const text = String(value || '').trim();
  if (!text) throw new CheckoutValidationError(`${label} is required.`);
  if (pattern && !pattern.test(text)) throw new CheckoutValidationError(`${label} is invalid.`);
  return text;
}

function createBillingCatalog(config) {
  if (!config || typeof config !== 'object') throw new CheckoutValidationError('Server billing configuration is required.');
  const products = {};
  for (const productId of Object.keys(INTERNAL_PRICE_IDS)) {
    const source = config[productId];
    if (!source || typeof source !== 'object') throw new CheckoutValidationError(`Server billing configuration missing ${productId}.`);
    if (!PLAN_CATALOG[productId]) throw new CheckoutValidationError(`Unknown plan mapping ${productId}.`);
    const currency = requiredText(source.currency, `${productId}.currency`, /^[a-z]{3}$/);
    const providerPriceId = requiredText(source.providerPriceId, `${productId}.providerPriceId`, /^[A-Za-z0-9_:-]+$/);
    const trialDays = Number(source.trialDays);
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) throw new CheckoutValidationError(`${productId}.trialDays is invalid.`);
    const taxMode = requiredText(source.taxMode, `${productId}.taxMode`);
    if (!['automatic', 'inclusive', 'exclusive'].includes(taxMode)) throw new CheckoutValidationError(`${productId}.taxMode is invalid.`);
    products[productId] = Object.freeze({
      productId,
      planId: productId,
      priceId: INTERNAL_PRICE_IDS[productId],
      providerPriceId,
      currency,
      trialDays,
      taxMode,
      interval: 'month',
    });
  }
  return Object.freeze(products);
}

function assertClientBillingRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new CheckoutValidationError('Checkout request body is required.');
  for (const field of CLIENT_FORBIDDEN_BILLING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(request, field)) {
      throw new CheckoutValidationError(`Client-controlled billing field is forbidden: ${field}.`, 'CHECKOUT_TAMPERING');
    }
  }
  return Object.freeze({
    productId: requiredText(request.product, 'product', /^[a-z0-9_]+$/),
    checkoutRequestId: requiredText(request.checkoutRequestId, 'checkoutRequestId', /^[A-Za-z0-9_-]{8,128}$/),
  });
}

function checkoutIdempotencyKey({ userId, productId, checkoutRequestId }) {
  const material = `${requiredText(userId, 'userId')}\n${requiredText(productId, 'productId')}\n${requiredText(checkoutRequestId, 'checkoutRequestId')}`;
  return `bg_checkout_${crypto.createHash('sha256').update(material).digest('hex')}`;
}

function createCheckoutService({ catalog, provider, allowedCurrencies = null }) {
  if (!catalog || typeof catalog !== 'object') throw new CheckoutValidationError('Billing catalog is required.');
  if (!provider || typeof provider.createCheckoutSession !== 'function') throw new CheckoutValidationError('Checkout provider adapter is required.');
  const allowed = allowedCurrencies ? new Set(Array.from(allowedCurrencies, value => String(value).toLowerCase())) : null;

  return Object.freeze({
    async createSession({ user, request, successUrl, cancelUrl }) {
      const userId = requiredText(user?.id, 'authenticated user id');
      const email = user?.email == null ? null : requiredText(user.email, 'authenticated user email');
      const parsed = assertClientBillingRequest(request);
      const product = catalog[parsed.productId];
      if (!product || product.planId === 'free') throw new CheckoutValidationError('Unsupported checkout product.', 'CHECKOUT_UNSUPPORTED_PRODUCT');
      if (allowed && !allowed.has(product.currency)) throw new CheckoutValidationError('Unsupported checkout currency.', 'CHECKOUT_UNSUPPORTED_CURRENCY');
      const idempotencyKey = checkoutIdempotencyKey({ userId, productId: product.productId, checkoutRequestId: parsed.checkoutRequestId });
      const metadata = Object.freeze({
        beatgaler_user_id: userId,
        beatgaler_product_id: product.productId,
        beatgaler_price_id: product.priceId,
      });
      const providerInput = Object.freeze({
        mode: 'subscription',
        providerPriceId: product.providerPriceId,
        quantity: 1,
        currency: product.currency,
        trialDays: product.trialDays,
        taxMode: product.taxMode,
        customerEmail: email,
        clientReferenceId: userId,
        metadata,
        successUrl: requiredText(successUrl, 'successUrl'),
        cancelUrl: requiredText(cancelUrl, 'cancelUrl'),
      });
      let session;
      try {
        session = await provider.createCheckoutSession(providerInput, { idempotencyKey });
      } catch (_) {
        throw new CheckoutUnavailableError();
      }
      const sessionId = requiredText(session?.id, 'provider checkout session id');
      const url = requiredText(session?.url, 'provider checkout session url');
      return Object.freeze({
        sessionId,
        url,
        productId: product.productId,
        priceId: product.priceId,
        // Deliberately no entitlement/plan mutation. Billing state is reconciled server-side later.
        entitlementGranted: false,
      });
    },
  });
}

module.exports = {
  INTERNAL_PRICE_IDS,
  CLIENT_FORBIDDEN_BILLING_FIELDS,
  CheckoutValidationError,
  CheckoutUnavailableError,
  createBillingCatalog,
  assertClientBillingRequest,
  checkoutIdempotencyKey,
  createCheckoutService,
};
