'use strict';

function bearerToken(req) {
  const raw = String(req?.headers?.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function installLifecycleRequestGuard(express, runtime) {
  const application = express?.application;
  if (!application || !runtime?._test?.sessionInfoFromRequest || application.__beatgalerLifecycleRequestGuardInstalled) return;
  application.__beatgalerLifecycleRequestGuardInstalled = true;
  const previousUse = application.use;

  application.use = function patchedLifecycleGuardUse(...handlers) {
    if (!this.__beatgalerLifecycleRequestGuardAttached) {
      this.__beatgalerLifecycleRequestGuardAttached = true;
      previousUse.call(this, (req, res, next) => {
        // SessionSecurity runs immediately before this guard and normalizes a
        // Web cookie/rotated alias back to the canonical account bearer.
        const token = bearerToken(req);
        if (!token) return next();
        if (runtime._test.sessionInfoFromRequest(req)) return next();
        return res.status(401).json({
          error: 'Session expired or revoked. Sign in again.',
          code: 'SESSION_REQUIRED',
        });
      });
    }
    return previousUse.call(this, ...handlers);
  };
}

module.exports = { installLifecycleRequestGuard };
