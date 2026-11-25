"use strict";

function installSecurityHeaders(express) {
  express.application.__beatgalerSecurityHeadersEnabled = true;
}

function wrapSecurityHeadersUse(routePathOrHandlers, handlers) {
  const { app, next } = this;
  if (app.__beatgalerSecurityHeadersEnabled && !app.__beatgalerSecurityHeadersInstalled) {
    app.__beatgalerSecurityHeadersInstalled = true;
    next((req, res, proceed) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      if (/^\/(auth|transport)(?:\/|$)/.test(String(req.path || req.url || ""))) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
      }
      proceed();
    });
  }
  return next(routePathOrHandlers, ...handlers);
}

module.exports = { installSecurityHeaders, wrapSecurityHeadersUse };
