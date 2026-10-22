'use strict';

const crypto = require('node:crypto');

const SEND_ROUTES = new Set([
  '/auth/register',
  '/auth/email/verification/request',
  '/auth/password/reset/request',
  '/auth/email/change/start',
  '/auth/email/change/resend',
]);

const PROTECTED_ROUTES = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/password/change',
  '/auth/password/reset/request',
  '/auth/password/reset/complete',
  '/auth/email/verification/request',
  '/auth/email/verification/confirm',
  '/auth/email/change/start',
  '/auth/email/change/resend',
  '/auth/email/change/confirm',
  '/auth/reauth',
  '/auth/oauth/start',
  '/auth/oauth/poll',
  '/auth/oauth/disconnect',
  '/auth/mfa/enable',
  '/auth/mfa/disable',
]);

function normalized(value) {
  return String(value || '').trim().toLowerCase().slice(0, 320);
}

function opaque(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function requestIp(req) {
  return String(req?.ip || req?.socket?.remoteAddress || 'unknown');
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function routePolicy(routePath, env = process.env) {
  const route = String(routePath || '');
  const minute = positiveInt(env.BEATGALER_AUTH_DURABLE_WINDOW_MS, 60_000);
  const sendWindow = positiveInt(env.BEATGALER_AUTH_SEND_WINDOW_MS, 10 * 60_000);
  const globalWindow = positiveInt(env.BEATGALER_AUTH_GLOBAL_SEND_WINDOW_MS, 60 * 60_000);
  const genericIp = positiveInt(env.BEATGALER_AUTH_DURABLE_IP_MAX, 60);
  const genericTarget = positiveInt(env.BEATGALER_AUTH_DURABLE_TARGET_MAX, 20);

  if (route === '/auth/login' || route === '/auth/reauth') {
    return { windowMs: minute, ipMax: positiveInt(env.BEATGALER_AUTH_LOGIN_IP_MAX, 30), targetMax: positiveInt(env.BEATGALER_AUTH_LOGIN_TARGET_MAX, 12) };
  }
  if (SEND_ROUTES.has(route)) {
    return {
      windowMs: sendWindow,
      ipMax: positiveInt(env.BEATGALER_AUTH_SEND_IP_MAX, 30),
      targetMax: positiveInt(env.BEATGALER_AUTH_SEND_TARGET_MAX, 5),
      globalWindowMs: globalWindow,
      globalMax: positiveInt(env.BEATGALER_AUTH_GLOBAL_SEND_MAX, 1000),
    };
  }
  if (route.startsWith('/auth/oauth/')) {
    return { windowMs: sendWindow, ipMax: positiveInt(env.BEATGALER_AUTH_OAUTH_IP_MAX, 40), targetMax: positiveInt(env.BEATGALER_AUTH_OAUTH_ACCOUNT_MAX, 20) };
  }
  return { windowMs: minute, ipMax: genericIp, targetMax: genericTarget };
}

function targetIdentity(req, runtime) {
  try {
    const info = runtime?._test?.sessionInfoFromRequest?.(req);
    if (info?.userId) return `user:${info.userId}`;
  } catch {}
  const body = req?.body || {};
  const value = normalized(body.email || body.identifier || body.username || body.beatgalerUserId || body.flowId || body.provider);
  return value ? `input:${value}` : '';
}

function createDurableRateLimitStore(pool, { now = () => Date.now() } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('Durable auth abuse controls require PostgreSQL.');

  async function consume(scope, key, limit, windowMs) {
    const keyHash = opaque(key);
    const result = await pool.query(`
      INSERT INTO auth_rate_limit_buckets(scope,key_hash,window_started_at,request_count,expires_at,updated_at)
      VALUES($1,$2,now(),1,now() + ($3::bigint * interval '1 millisecond'),now())
      ON CONFLICT(scope,key_hash) DO UPDATE SET
        window_started_at = CASE
          WHEN auth_rate_limit_buckets.window_started_at <= now() - ($3::bigint * interval '1 millisecond') THEN now()
          ELSE auth_rate_limit_buckets.window_started_at
        END,
        request_count = CASE
          WHEN auth_rate_limit_buckets.window_started_at <= now() - ($3::bigint * interval '1 millisecond') THEN 1
          ELSE auth_rate_limit_buckets.request_count + 1
        END,
        expires_at = CASE
          WHEN auth_rate_limit_buckets.window_started_at <= now() - ($3::bigint * interval '1 millisecond') THEN now() + ($3::bigint * interval '1 millisecond')
          ELSE auth_rate_limit_buckets.window_started_at + ($3::bigint * interval '1 millisecond')
        END,
        updated_at = now()
      RETURNING request_count,window_started_at,expires_at
    `, [String(scope), keyHash, Number(windowMs)]);
    const row = result.rows[0];
    const count = Number(row?.request_count || 0);
    const retryAt = new Date(row?.expires_at || now() + windowMs).getTime();
    return {
      allowed: count <= Number(limit),
      count,
      remaining: Math.max(0, Number(limit) - count),
      retryAfterMs: Math.max(1000, retryAt - now()),
    };
  }

  async function cleanupExpired() {
    await pool.query('DELETE FROM auth_rate_limit_buckets WHERE expires_at < now() - interval \'1 hour\'');
  }

  return { consume, cleanupExpired };
}

function createDurableAuthAbuseControls({ pool, runtime = null, env = process.env, now = () => Date.now() } = {}) {
  const store = createDurableRateLimitStore(pool, { now });
  let cleanupCounter = 0;

  async function middlewareFor(routePath, req, res, next) {
    const policy = routePolicy(routePath, env);
    const ipKey = `ip:${requestIp(req)}`;
    const target = targetIdentity(req, runtime);
    const checks = [
      store.consume(`${routePath}:ip`, ipKey, policy.ipMax, policy.windowMs),
      ...(target ? [store.consume(`${routePath}:target`, target, policy.targetMax, policy.windowMs)] : []),
      ...(policy.globalMax ? [store.consume('auth-email-send:global', 'global', policy.globalMax, policy.globalWindowMs)] : []),
    ];
    let results;
    try {
      results = await Promise.all(checks);
      cleanupCounter += 1;
      if (cleanupCounter % 500 === 0) void store.cleanupExpired().catch(() => {});
    } catch (error) {
      console.error('[auth-abuse] durable rate limit store unavailable:', error?.message || String(error));
      return res.status(503).json({ error: 'Authentication service is temporarily unavailable.', code: 'AUTH_RATE_LIMIT_STORE_UNAVAILABLE' });
    }
    const blocked = results.find(result => !result.allowed);
    if (blocked) {
      res.setHeader?.('Retry-After', String(Math.max(1, Math.ceil(blocked.retryAfterMs / 1000))));
      return res.status(429).json({ error: 'Too many authentication attempts. Please retry later.', code: 'AUTH_RATE_LIMITED' });
    }
    return next();
  }

  return { middlewareFor, store, routePolicy: route => routePolicy(route, env) };
}

function installDurableAuthAbuseControls(express, options = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerDurableAuthAbuseInstalled || !options.pool) return null;
  application.__beatgalerDurableAuthAbuseInstalled = true;
  const controls = createDurableAuthAbuseControls(options);
  const previousPost = application.post;
  application.post = function durableAuthAbusePost(routePath, ...handlers) {
    const pathName = String(routePath || '');
    if (!PROTECTED_ROUTES.has(pathName)) return previousPost.call(this, routePath, ...handlers);
    return previousPost.call(this, routePath, (req, res, next) => {
      void controls.middlewareFor(pathName, req, res, next);
    }, ...handlers);
  };
  return controls;
}

module.exports = {
  SEND_ROUTES,
  PROTECTED_ROUTES,
  normalized,
  opaque,
  requestIp,
  routePolicy,
  targetIdentity,
  createDurableRateLimitStore,
  createDurableAuthAbuseControls,
  installDurableAuthAbuseControls,
};
