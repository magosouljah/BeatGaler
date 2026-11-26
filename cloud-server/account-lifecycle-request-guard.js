'use strict';

const { bearerTokenOptionalRequest: bearerToken } = require('./auth-helpers');

function installLifecycleRequestGuard(ctx, runtime) {
  if (!ctx?.entries || !runtime?.api?.session?.sessionInfoFromRequest || ctx.entries.lifecycleRequestGuard) return;
  ctx.entries.lifecycleRequestGuard = { runtime };
}

function wrapLifecycleRequestGuardUse(routePathOrHandlers, handlers) {
  const { app, next, ctx } = this;
  const runtime = ctx?.entries.lifecycleRequestGuard?.runtime;
  const state = ctx?.state.get(app) || {};
  if (runtime && !state.lifecycleRequestGuardAttached) {
    ctx.state.set(app, { ...state, lifecycleRequestGuardAttached: true });
    next((req, res, proceed) => {
      // SessionSecurity runs immediately before this guard and normalizes a
      // Web cookie/rotated alias back to the canonical account bearer.
      const token = bearerToken(req);
      if (!token) return proceed();
      if (runtime.api.session.sessionInfoFromRequest(req)) return proceed();
      return res.status(401).json({
        error: 'Session expired or revoked. Sign in again.',
        code: 'SESSION_REQUIRED',
      });
    });
  }
  return next(routePathOrHandlers, ...handlers);
}

module.exports = { installLifecycleRequestGuard, wrapLifecycleRequestGuardUse };
