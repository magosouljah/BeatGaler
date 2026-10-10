'use strict';

const { callbackOrigin } = require('./billing-web-checkout-runtime');

class BillingPortalError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function providerCall(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new BillingPortalError('BILLING_PORTAL_UNAVAILABLE')), 10_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function createBillingPortalService({ pool, adapter, env = process.env }) {
  if (!pool || typeof pool.query !== 'function' || adapter?.provider !== 'polar' ||
      adapter.environment !== 'sandbox' || typeof adapter.getCustomerByExternalId !== 'function' ||
      typeof adapter.createCustomerPortal !== 'function') {
    throw new BillingPortalError('BILLING_PORTAL_UNAVAILABLE');
  }
  const returnUrl = `${callbackOrigin(env)}/?billing=return`;

  return Object.freeze({
    async createSession(userId) {
      if (typeof userId !== 'string' || !userId.trim()) {
        throw new BillingPortalError('BILLING_PORTAL_UNAVAILABLE');
      }
      const result = await pool.query(`
        SELECT provider_customer_id, external_id
        FROM billing_customers
        WHERE user_id=$1 AND provider='polar' AND provider_environment='sandbox'
      `, [userId]);
      const customer = result.rows[0];
      if (!customer || customer.external_id !== userId || !customer.provider_customer_id) {
        throw new BillingPortalError('BILLING_PORTAL_CUSTOMER_NOT_FOUND');
      }
      let remote;
      try { remote = await providerCall(adapter.getCustomerByExternalId(userId)); }
      catch { throw new BillingPortalError('BILLING_PORTAL_UNAVAILABLE'); }
      if (remote?.id !== customer.provider_customer_id || remote?.external_id !== userId) {
        throw new BillingPortalError('BILLING_PORTAL_CUSTOMER_MISMATCH');
      }
      let session;
      try { session = await providerCall(adapter.createCustomerPortal({ userId, returnUrl })); }
      catch { throw new BillingPortalError('BILLING_PORTAL_UNAVAILABLE'); }
      let url;
      try { url = new URL(session?.url); }
      catch { throw new BillingPortalError('BILLING_PORTAL_UNAVAILABLE'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'sandbox.polar.sh') {
        throw new BillingPortalError('BILLING_PORTAL_UNAVAILABLE');
      }
      return Object.freeze({ url: url.toString() });
    },
  });
}

let service = null;
function configure(options) {
  try { service = createBillingPortalService(options); }
  catch { service = null; }
  return { ready: Boolean(service) };
}
function current() { return service; }

module.exports = { BillingPortalError, createBillingPortalService, configure, current };
