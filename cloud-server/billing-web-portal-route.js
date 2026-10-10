'use strict';

const { BillingPortalError } = require('./billing-web-portal-runtime');

function createPortalHandler({ getUser, currentPortal }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) {
      return res.status(400).json({ error: 'Request body must be empty.', code: 'BILLING_PORTAL_INVALID_REQUEST' });
    }
    const portal = currentPortal();
    if (!portal) return res.status(503).json({ error: 'Billing portal is unavailable.', code: 'BILLING_PORTAL_UNAVAILABLE' });
    try {
      return res.json({ ok: true, portal: await portal.createSession(user.id) });
    } catch (error) {
      const code = error instanceof BillingPortalError ? error.code : 'BILLING_PORTAL_UNAVAILABLE';
      const status = code === 'BILLING_PORTAL_CUSTOMER_NOT_FOUND' ? 404
        : code === 'BILLING_PORTAL_CUSTOMER_MISMATCH' ? 409 : 503;
      return res.status(status).json({ error: 'Billing portal is unavailable.', code });
    }
  };
}

module.exports = { createPortalHandler };
