'use strict';

const { sha256String: sha256, bearerTokenOptionalRequest: bearerToken } = require('./auth-helpers');

const SENSITIVE_ROUTES = new Map([
  ['/auth/logout', 'logout'],
  ['/auth/password/change', 'password_change'],
  ['/auth/account/delete', 'account_delete'],
]);

function installSensitiveAuthCapabilityRevocation(express, { store } = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerSensitiveCapabilityRevocationInstalled) return;
  application.__beatgalerSensitiveCapabilityRevocationInstalled = true;
  application.__beatgalerSensitiveCapabilityRevocationStore = store;
}

function wrapSensitiveAuthCapabilityRevocationPost(routePath, handlers) {
  const { app, next } = this;
  if (!app.__beatgalerSensitiveCapabilityRevocationInstalled) return next(routePath, ...handlers);
  const store = app.__beatgalerSensitiveCapabilityRevocationStore;
  const reason = SENSITIVE_ROUTES.get(routePath);
  if (!reason) return next(routePath, ...handlers);

  async function revokeBeforeMutation(req, res, next) {
    const token = bearerToken(req);
    if (!token) return next();
    if (!store || typeof store.revokeAuthSession !== 'function') {
      return res.status(503).json({
        error: 'DIRECT_CAPABILITY_REVOKE_FAILED: capability revocation store is unavailable.',
        code: 'DIRECT_CAPABILITY_REVOKE_FAILED',
      });
    }
    try {
      await store.revokeAuthSession({ authSessionHash: sha256(token), reason });
    } catch {
      return res.status(503).json({
        error: 'DIRECT_CAPABILITY_REVOKE_FAILED: session capability revocation could not be committed.',
        code: 'DIRECT_CAPABILITY_REVOKE_FAILED',
      });
    }
    return next();
  }

  return next(routePath, revokeBeforeMutation, ...handlers);
}

module.exports = {
  installSensitiveAuthCapabilityRevocation,
  wrapSensitiveAuthCapabilityRevocationPost,
};
