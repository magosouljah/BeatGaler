'use strict';

function bearerToken(req) {
  const raw = String(req?.headers?.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function installLifecycleRequestGuard(express, runtime) {
  const application = express?.application;
  if (!application || !runtime?._test?.sessionInfoFromRequest || application.__beatgalerLifecycleRequestGuardRuntime) return;
  application.__beatgalerLifecycleRequestGuardRuntime = runtime;
}

function wrapLifecycleRequestGuardUse(routePathOrHandlers, handlers) {
  const { app, next } = this;
  const runtime = app.__beatgalerLifecycleRequestGuardRuntime;
  if (runtime && !app.__beatgalerLifecycleRequestGuardAttached) {
    app.__beatgalerLifecycleRequestGuardAttached = true;
    next((req, res, proceed) => {
      // SessionSecurity runs immediately before this guard and normalizes a
      // Web cookie/rotated alias back to the canonical account bearer.
      const token = bearerToken(req);
      if (!token) return proceed();
      if (runtime._test.sessionInfoFromRequest(req)) return proceed();
      return res.status(401).json({
        error: 'Session expired or revoked. Sign in again.',
        code: 'SESSION_REQUIRED',
      });
    });
  }
  return next(routePathOrHandlers, ...handlers);
}

module.exports = { installLifecycleRequestGuard, wrapLifecycleRequestGuardUse };
