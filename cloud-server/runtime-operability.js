'use strict';

const DEFAULTS = Object.freeze({
  dependencyTimeoutMs: 1500,
  requestTimeoutMs: 30000,
  headersTimeoutMs: 10000,
  keepAliveTimeoutMs: 5000,
  socketTimeoutMs: 30000,
  shutdownGraceMs: 10000,
});

let runtimeDependencies = { pool: null, postgresRequired: false };
let draining = false;

function boundedInt(raw, fallback, min, max, name) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function runtimeConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase() || 'development';
  const deploymentEnv = String(env.BEATGALER_DEPLOYMENT_ENV || (nodeEnv === 'production' ? '' : 'development')).trim().toLowerCase();
  if (nodeEnv === 'production' && !['staging', 'production'].includes(deploymentEnv)) {
    throw new Error('Production NODE_ENV requires BEATGALER_DEPLOYMENT_ENV=staging or production.');
  }
  if (!['development', 'test', 'staging', 'production'].includes(deploymentEnv)) {
    throw new Error('BEATGALER_DEPLOYMENT_ENV must be development, test, staging, or production.');
  }
  const trustProxyHops = boundedInt(env.BEATGALER_TRUST_PROXY_HOPS, 0, 0, 4, 'BEATGALER_TRUST_PROXY_HOPS');
  const requestTimeoutMs = boundedInt(env.BEATGALER_HTTP_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, 1000, 120000, 'BEATGALER_HTTP_REQUEST_TIMEOUT_MS');
  return Object.freeze({
    nodeEnv,
    deploymentEnv,
    trustProxy: trustProxyHops === 0 ? false : trustProxyHops,
    dependencyTimeoutMs: boundedInt(env.BEATGALER_DEPENDENCY_TIMEOUT_MS, DEFAULTS.dependencyTimeoutMs, 100, 10000, 'BEATGALER_DEPENDENCY_TIMEOUT_MS'),
    requestTimeoutMs,
    headersTimeoutMs: Math.min(requestTimeoutMs, boundedInt(env.BEATGALER_HTTP_HEADERS_TIMEOUT_MS, DEFAULTS.headersTimeoutMs, 1000, 60000, 'BEATGALER_HTTP_HEADERS_TIMEOUT_MS')),
    keepAliveTimeoutMs: boundedInt(env.BEATGALER_HTTP_KEEPALIVE_TIMEOUT_MS, DEFAULTS.keepAliveTimeoutMs, 1000, 30000, 'BEATGALER_HTTP_KEEPALIVE_TIMEOUT_MS'),
    socketTimeoutMs: boundedInt(env.BEATGALER_HTTP_SOCKET_TIMEOUT_MS, DEFAULTS.socketTimeoutMs, 1000, 120000, 'BEATGALER_HTTP_SOCKET_TIMEOUT_MS'),
    shutdownGraceMs: boundedInt(env.BEATGALER_SHUTDOWN_GRACE_MS, DEFAULTS.shutdownGraceMs, 1000, 60000, 'BEATGALER_SHUTDOWN_GRACE_MS'),
  });
}

function configureRuntimeDependencies({ pool = null, postgresRequired = false } = {}) {
  runtimeDependencies = { pool, postgresRequired: Boolean(postgresRequired) };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readinessSnapshot({ config = runtimeConfig(), dependencies = runtimeDependencies } = {}) {
  if (draining) return { ok: false, status: 'draining', dependencies: { postgres: 'draining' } };
  const pool = dependencies.pool;
  if (dependencies.postgresRequired && (!pool || typeof pool.query !== 'function')) {
    return { ok: false, status: 'not-ready', dependencies: { postgres: 'missing' } };
  }
  if (pool && typeof pool.query === 'function') {
    try {
      await withTimeout(pool.query('SELECT 1'), config.dependencyTimeoutMs, 'PostgreSQL readiness check');
    } catch (_error) {
      return { ok: false, status: 'not-ready', dependencies: { postgres: 'unavailable' } };
    }
  }
  return { ok: true, status: 'ready', dependencies: { postgres: pool ? 'ready' : 'disabled' } };
}

function installRoutesAndProxy(app, config) {
  if (app.__beatgalerRuntimeRoutesInstalled) return;
  app.__beatgalerRuntimeRoutesInstalled = true;
  app.set('trust proxy', config.trustProxy);
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, status: draining ? 'draining' : 'live', environment: config.deploymentEnv });
  });
  app.get('/readyz', async (_req, res) => {
    const snapshot = await readinessSnapshot({ config });
    res.status(snapshot.ok ? 200 : 503).json({ ...snapshot, environment: config.deploymentEnv });
  });
}

function configureHttpServer(server, config) {
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  if (typeof server.setTimeout === 'function') server.setTimeout(config.socketTimeoutMs);
  return server;
}

function installGracefulShutdown(server, { processLike = process, config = runtimeConfig(), logger = console } = {}) {
  let closing = false;
  const close = signal => {
    if (closing) return;
    closing = true;
    draining = true;
    logger.log?.(`[runtime] ${signal} received; draining HTTP connections.`);
    const forceTimer = setTimeout(() => server.closeAllConnections?.(), config.shutdownGraceMs);
    forceTimer.unref?.();
    server.close(error => {
      clearTimeout(forceTimer);
      if (error) {
        logger.error?.('[runtime] HTTP shutdown failed:', error?.message || String(error));
        processLike.exitCode = 1;
      }
    });
    server.closeIdleConnections?.();
  };
  processLike.once('SIGINT', () => close('SIGINT'));
  processLike.once('SIGTERM', () => close('SIGTERM'));
  return close;
}

function installRuntimeOperability(express, { env = process.env, processLike = process, logger = console } = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerRuntimePatchInstalled) return;
  application.__beatgalerRuntimePatchInstalled = true;
  const config = runtimeConfig(env);
  const originalUse = application.use;
  const originalListen = application.listen;

  application.use = function runtimePatchedUse(...handlers) {
    installRoutesAndProxy(this, config);
    return originalUse.apply(this, handlers);
  };
  application.listen = function runtimePatchedListen(...args) {
    installRoutesAndProxy(this, config);
    const server = configureHttpServer(originalListen.apply(this, args), config);
    installGracefulShutdown(server, { processLike, config, logger });
    return server;
  };
}

function _resetForTests() {
  runtimeDependencies = { pool: null, postgresRequired: false };
  draining = false;
}

module.exports = {
  runtimeConfig,
  configureRuntimeDependencies,
  readinessSnapshot,
  installRoutesAndProxy,
  configureHttpServer,
  installGracefulShutdown,
  installRuntimeOperability,
  _resetForTests,
};
