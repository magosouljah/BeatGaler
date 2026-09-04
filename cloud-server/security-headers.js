"use strict";

function installSecurityHeaders(express) {
  if (express.application.__beatgalerSecurityHeaderPatchInstalled) return;
  express.application.__beatgalerSecurityHeaderPatchInstalled = true;
  const originalUse = express.application.use;

  express.application.use = function patchedUse(...handlers) {
    if (!this.__beatgalerSecurityHeadersInstalled) {
      this.__beatgalerSecurityHeadersInstalled = true;
      originalUse.call(this, (req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        if (/^\/(auth|transport)(?:\/|$)/.test(String(req.path || req.url || ""))) {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Pragma", "no-cache");
        }
        next();
      });
    }
    return originalUse.apply(this, handlers);
  };
}

module.exports = { installSecurityHeaders };
