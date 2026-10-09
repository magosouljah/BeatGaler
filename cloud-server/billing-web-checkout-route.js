'use strict';

const { PersistentCheckoutError } = require('./billing-checkout-persistent');

function checkoutError(res, error) {
  if (!(error instanceof PersistentCheckoutError)) {
    return res.status(503).json({ error: 'Checkout is unavailable.', code: 'BILLING_CHECKOUT_UNAVAILABLE' });
  }
  const code = error.code;
  const status = code === 'BILLING_CHECKOUT_INVALID_REQUEST' || code === 'BILLING_OFFER_UNKNOWN' ||
    code === 'BILLING_OFFER_DISABLED' ? 400
    : code === 'BILLING_CHECKOUT_REQUEST_CONFLICT' || code === 'BILLING_CHECKOUT_AMBIGUOUS' ||
      code === 'BILLING_CHECKOUT_UNRESOLVED_EXISTS' || code === 'BILLING_CHECKOUT_SUBSCRIBER_PORTAL_REQUIRED' ||
      code === 'BILLING_CHECKOUT_CUSTOMER_OWNERSHIP_MISMATCH' ? 409 : 503;
  const details = error.details && typeof error.details === 'object'
    ? { requestId: error.details.requestId, state: error.details.state } : {};
  return res.status(status).json({ error: error.message, code, ...details });
}

function createCheckoutHandlers({ getUser, currentCheckout }) {
  async function create(req, res) {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['offerId', 'requestId'].includes(key)) ||
        typeof body.offerId !== 'string' || typeof body.requestId !== 'string') {
      return res.status(400).json({ error: 'Only offerId and requestId are accepted.', code: 'BILLING_CHECKOUT_INVALID_REQUEST' });
    }
    const runtime = currentCheckout();
    if (!runtime) return res.status(503).json({ error: 'Checkout is unavailable.', code: 'BILLING_CHECKOUT_UNAVAILABLE' });
    try {
      const result = await runtime.service.createSession({
        user: { id: user.id, email: user.email }, request: body, ...runtime.callbackUrls,
      });
      return res.json({ ok: true, checkout: result });
    } catch (error) { return checkoutError(res, error); }
  }

  async function get(req, res) {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    const runtime = currentCheckout();
    if (!runtime) return res.status(503).json({ error: 'Checkout is unavailable.', code: 'BILLING_CHECKOUT_UNAVAILABLE' });
    try {
      const checkout = await runtime.service.getRequest({ userId: user.id, requestId: req.params.requestId });
      return checkout ? res.json({ ok: true, checkout }) : res.status(404).json({ error: 'Checkout not found.' });
    } catch (error) { return checkoutError(res, error); }
  }

  return Object.freeze({ create, get });
}

module.exports = { createCheckoutHandlers };
