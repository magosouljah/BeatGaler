"use strict";

function installSecurityHeaders(ctx) {
  ctx.entries.securityHeaders ||= { enabled: true };
}

function wrapSecurityHeadersUse(routePathOrHandlers, handlers) {
  const { app, next, ctx } = this;
  const state = ctx?.state.get(app) || {};
  if (ctx?.entries.securityHeaders?.enabled && !state.securityHeadersInstalled) {
    ctx.state.set(app, { ...state, securityHeadersInstalled: true });
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
