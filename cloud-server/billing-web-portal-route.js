'use strict';

const { callbackOrigin } = require('./billing-web-checkout-runtime');

class PortalError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function portalUrl(value, environment) {
  if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value) {
    throw new PortalError('BILLING_PORTAL_URL_INVALID', 503);
  }
  let url;
  try { url = new URL(value); } catch { throw new PortalError('BILLING_PORTAL_URL_INVALID', 503); }
  const hostname = environment === 'production' ? 'polar.sh' : 'sandbox.polar.sh';
  if (url.protocol !== 'https:' || url.hostname !== hostname || url.username || url.password ||
      url.port || url.hash) {
    throw new PortalError('BILLING_PORTAL_URL_INVALID', 503);
  }
  return url.toString();
}

function createPortalService({ pool, adapter, env = process.env, now = Date.now }) {
  if (!pool || typeof pool.query !== 'function' || adapter?.provider !== 'polar' ||
      !['sandbox', 'production'].includes(adapter.environment) ||
      typeof adapter.getCustomerByExternalId !== 'function' ||
      typeof adapter.createCustomerPortal !== 'function') {
    throw new Error('BILLING_PORTAL_CONFIG_INVALID');
  }
  const returnUrl = `${callbackOrigin(env)}/?billing=portal-return`;

  async function subscription(userId) {
    const result = await pool.query(`
      SELECT s.provider_subscription_id, s.provider_customer_id, s.ended_at,
             c.provider_customer_id AS owned_customer_id, c.external_id AS owned_external_id
      FROM billing_subscription_state s
      LEFT JOIN billing_customers c
        ON c.user_id=s.user_id AND c.provider=s.provider AND c.provider_environment=s.provider_environment
      WHERE s.user_id=$1 AND s.provider=$2 AND s.provider_environment=$3
      LIMIT 1
    `, [userId, adapter.provider, adapter.environment]);
    const row = result.rows[0];
    if (!row?.provider_subscription_id || !row.provider_customer_id) return null;
    if (row.ended_at) {
      const endedAt = new Date(row.ended_at).getTime();
      if (!Number.isFinite(endedAt) || endedAt <= now()) return null;
    }
    if (row.owned_external_id && row.owned_external_id !== userId) {
      throw new PortalError('BILLING_PORTAL_CUSTOMER_MISMATCH', 409);
    }
    if (row.owned_customer_id && row.owned_customer_id !== row.provider_customer_id) {
      throw new PortalError('BILLING_PORTAL_CUSTOMER_MISMATCH', 409);
    }
    return row;
  }

  return Object.freeze({
    async available(userId) { return Boolean(await subscription(userId)); },
    async create(userId) {
      const row = await subscription(userId);
      if (!row) throw new PortalError('BILLING_PORTAL_NO_SUBSCRIPTION', 404);
      // The provider must resolve the same customer by the authenticated user's
      // external ID. A stale or cross-tenant local projection cannot open a session.
      const customer = await adapter.getCustomerByExternalId(userId);
      if (String(customer?.id || '') !== row.provider_customer_id ||
          (customer?.external_id != null && customer.external_id !== userId)) {
        throw new PortalError('BILLING_PORTAL_CUSTOMER_MISMATCH', 409);
      }
      const session = await adapter.createCustomerPortal({ userId, returnUrl });
      return { url: portalUrl(session?.url, adapter.environment), entitlementGranted: false };
    },
  });
}

function createPortalHandlers({ getUser, currentPortal }) {
  async function handle(req, res, create) {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    res.setHeader?.('Cache-Control', 'no-store');
    const service = currentPortal();
    if (!service) return res.status(503).json({ error: 'Subscriber management is unavailable.', code: 'BILLING_PORTAL_UNAVAILABLE' });
    if (create && req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
      return res.status(400).json({ error: 'No portal parameters are accepted.', code: 'BILLING_PORTAL_INVALID_REQUEST' });
    }
    try {
      return create
        ? res.json({ ok: true, portal: await service.create(user.id) })
        : res.json({ ok: true, available: await service.available(user.id) });
    } catch (error) {
      const status = error instanceof PortalError ? error.status : 503;
      const code = error instanceof PortalError ? error.code : 'BILLING_PORTAL_UNAVAILABLE';
      return res.status(status).json({ error: 'Subscriber management is unavailable.', code });
    }
  }
  return Object.freeze({
    availability: (req, res) => handle(req, res, false),
    create: (req, res) => handle(req, res, true),
  });
}

module.exports = { PortalError, portalUrl, createPortalService, createPortalHandlers };
