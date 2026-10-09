'use strict';

const { createPersistentCheckoutService } = require('./billing-checkout-persistent');
// Canonical Web host from deploy/web/beatgaler.com.conf.
const DEFAULT_WEB_ORIGIN = 'https://beatgaler.com';

let service = null;
let callbackUrls = null;
let failureCode = 'BILLING_CHECKOUT_NOT_INITIALIZED';

function callbackOrigin(env) {
  const configured = String(env.BILLING_WEB_ORIGIN || DEFAULT_WEB_ORIGIN).trim();
  let url;
  try { url = new URL(configured); } catch { throw new Error('BILLING_CHECKOUT_ORIGIN_INVALID'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  const canonical = url.origin === DEFAULT_WEB_ORIGIN;
  if (!(canonical || (env.NODE_ENV !== 'production' && local && ['http:', 'https:'].includes(url.protocol))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BILLING_CHECKOUT_ORIGIN_INVALID');
  }
  return url.origin;
}

function configure({ pool, adapter, env = process.env }) {
  service = null;
  callbackUrls = null;
  failureCode = 'BILLING_CHECKOUT_UNAVAILABLE';
  try {
    const origin = callbackOrigin(env);
    const checkout = createPersistentCheckoutService({
      pool, adapter, allowedCallbackOrigins: [origin],
    });
    callbackUrls = Object.freeze({
      successUrl: `${origin}/?billing=success`,
      returnUrl: `${origin}/?billing=return`,
    });
    service = checkout;
    failureCode = null;
  } catch (error) {
    failureCode = error?.message === 'BILLING_CHECKOUT_ORIGIN_INVALID'
      ? 'BILLING_CHECKOUT_ORIGIN_INVALID' : 'BILLING_CHECKOUT_UNAVAILABLE';
  }
  return status();
}

function status() { return Object.freeze({ ready: Boolean(service), failureCode }); }
function current() { return service ? { service, callbackUrls } : null; }

module.exports = { callbackOrigin, configure, status, current };
