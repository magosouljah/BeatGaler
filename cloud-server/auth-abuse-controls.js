"use strict";

const crypto = require("crypto");

const AUTH_ROUTES = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/password/change",
]);

function normalized(value) {
  return String(value || "").trim().toLowerCase().slice(0, 320);
}

function requestIp(req) {
  // Use Express' resolved IP identity (or the socket fallback). Do not trust a
  // client-controlled X-Forwarded-For header unless Express itself is later
  // configured with an explicit trusted-proxy policy.
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function opaque(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function createAuthAbuseControls(options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const windowMs = Math.max(1_000, Number(env.BEATGALER_AUTH_RATE_WINDOW_MS || 60_000));
  const ipMax = Math.max(1, Number(env.BEATGALER_AUTH_RATE_IP_MAX || 30));
  const accountMax = Math.max(1, Number(env.BEATGALER_AUTH_RATE_ACCOUNT_MAX || 12));
  const tenantMax = Math.max(1, Number(env.BEATGALER_AUTH_RATE_TENANT_MAX || 60));
  const baseDelayMs = Math.max(0, Number(env.BEATGALER_AUTH_FAILURE_DELAY_MS || 125));
  const maxDelayMs = Math.max(baseDelayMs, Number(env.BEATGALER_AUTH_FAILURE_DELAY_MAX_MS || 2_000));
  const buckets = new Map();
  const failures = new Map();

  function consume(key, limit) {
    if (!key) return { allowed: true, remaining: limit };
    const stamp = now();
    let bucket = buckets.get(key);
    if (!bucket || stamp - bucket.startedAt >= windowMs) {
      bucket = { startedAt: stamp, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count) };
  }

  function dimensions(req) {
    const body = req.body || {};
    const account = normalized(body.identifier || body.email || body.username || body.beatgalerUserId);
    const tenant = normalized(body.tenantId || body.tenant_id || body.beatgalerUserId || req.headers?.["x-beatgaler-installation-id"]);
    return {
      ip: `ip:${opaque(requestIp(req))}`,
      account: account ? `account:${opaque(account)}` : "",
      tenant: tenant ? `tenant:${opaque(tenant)}` : "",
    };
  }

  function failureKey(req) {
    const dims = dimensions(req);
    return dims.account || dims.ip;
  }

  async function middleware(req, res, next) {
    const dims = dimensions(req);
    const checks = [
      consume(dims.ip, ipMax),
      consume(dims.account, accountMax),
      consume(dims.tenant, tenantMax),
    ];
    if (checks.some(check => !check.allowed)) {
      res.setHeader?.("Retry-After", String(Math.max(1, Math.ceil(windowMs / 1000))));
      return res.status(429).json({ error: "Too many authentication attempts. Please retry later." });
    }

    const key = failureKey(req);
    const streak = Number(failures.get(key) || 0);
    if (streak > 0 && baseDelayMs > 0) {
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(streak - 1, 8)));
      await sleep(delay);
    }

    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const code = Number(res.statusCode || 0);
      if (code === 401 || code === 403) failures.set(key, Math.min(16, streak + 1));
      else if (code >= 200 && code < 400) failures.delete(key);
    };
    res.once?.("finish", record);
    res.once?.("close", record);
    next();
  }

  return {
    middleware,
    dimensions,
    constants: { windowMs, ipMax, accountMax, tenantMax, baseDelayMs, maxDelayMs },
  };
}

function installAuthAbuseControls(express, options = {}) {
  if (express.application.__beatgalerAuthAbuseInstalled) return;
  express.application.__beatgalerAuthAbuseInstalled = true;
  const controls = createAuthAbuseControls(options);
  const originalPost = express.application.post;
  const originalJson = express.json;

  express.json = function patchedJson(...args) {
    const parser = originalJson.apply(this, args);
    return function guardedJson(req, res, next) {
      parser(req, res, error => {
        if (!error) return next();
        const status = Number(error.status || error.statusCode || 400);
        if (status === 413 || error.type === "entity.too.large") {
          return res.status(413).json({ error: "Request body is too large." });
        }
        return res.status(400).json({ error: "Malformed JSON body." });
      });
    };
  };

  express.application.post = function patchedPost(routePath, ...handlers) {
    if (AUTH_ROUTES.has(routePath)) {
      return originalPost.call(this, routePath, controls.middleware, ...handlers);
    }
    return originalPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  AUTH_ROUTES,
  createAuthAbuseControls,
  installAuthAbuseControls,
};
