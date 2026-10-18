'use strict';

const { structuredEvent, createMetrics, alertRoute } = require('./operations-observability');

function createOperationsRuntime({ env = process.env, logger = console, now = () => Date.now() } = {}) {
  const metrics = createMetrics();
  const windows = new Map();
  let postgresUnavailable = false;
  let poolExhausted = false;

  function emit(level, event, fields) {
    try { logger.log(JSON.stringify(structuredEvent(level, event, fields, () => new Date(now())))); }
    catch (_) { /* Observability must not turn a completed request into a process failure. */ }
  }

  function recordCondition(condition, fields = {}) {
    const route = alertRoute(condition, env);
    metrics.increment(`condition.${condition}`);
    // Route values can contain secret-bearing webhook URLs, so log only presence.
    emit('error', 'operations.condition', { condition, routeConfigured: route.routable,
      count: Number.isSafeInteger(fields.count) ? fields.count : undefined,
      windowMs: Number.isSafeInteger(fields.windowMs) ? fields.windowMs : undefined });
  }

  function spike(condition, threshold, windowMs) {
    const current = now();
    const previous = windows.get(condition);
    const window = !previous || current - previous.start >= windowMs
      ? { start: current, count: 0 } : previous;
    window.count = Math.min(threshold + 1, window.count + 1);
    windows.set(condition, window);
    if (window.count === threshold) recordCondition(condition, { count: window.count, windowMs });
  }

  function recordHttp({ statusCode, durationMs, authRoute = false, path = '' } = {}) {
    const statusClass = `${Math.floor(Number(statusCode) / 100)}xx`;
    metrics.increment('http.response', { statusClass });
    if (Number(statusCode) >= 500) spike('api_error_spike', 5, 60_000);
    if (authRoute && [401, 403].includes(Number(statusCode))) spike('auth_failure_spike', 10, 60_000);
    const upload = ['/transport/project/upload', '/projects/upload', '/beats/upload', '/cloud-files/upload'].includes(path);
    if (!upload && Number(durationMs) >= 5000) spike('api_latency_spike', 3, 60_000);
    if (Number(statusCode) >= 500) {
      if (path === '/transport/project/upload' || path === '/projects/upload') recordCondition('project_failure');
      else if (path === '/beats/upload' || path === '/cloud-files/upload') recordCondition('master_upload_failure');
      else if (path === '/transport/index/commit' || path === '/transport/index/publish') recordCondition('index_publish_failure');
      else if (path === '/webhooks/polar') recordCondition('billing_webhook_failure');
      else if (path === '/transport/status' || path.startsWith('/transport/session/')) recordCondition('direct_unavailable');
    }
    if (Number(statusCode) >= 500) emit('error', 'http.error', {
      statusCode: Number(statusCode), durationMs: Math.max(0, Math.floor(Number(durationMs) || 0)),
    });
  }

  function recordReadiness(snapshot) {
    const unavailable = snapshot?.dependencies?.postgres === 'unavailable' ||
      snapshot?.dependencies?.postgres === 'missing';
    if (unavailable && !postgresUnavailable) recordCondition('postgres_unavailable');
    postgresUnavailable = unavailable;
  }

  function recordPool(pool) {
    const maximum = Number(pool?.options?.max);
    const exhausted = Number.isInteger(maximum) && maximum > 0 &&
      Number(pool?.totalCount) >= maximum && Number(pool?.idleCount) === 0 &&
      Number(pool?.waitingCount) > 0;
    if (exhausted && !poolExhausted) recordCondition('pool_exhausted');
    poolExhausted = exhausted;
  }

  return Object.freeze({ recordHttp, recordReadiness, recordPool, recordCondition, snapshot: () => metrics.snapshot() });
}

const operationsRuntime = createOperationsRuntime();
module.exports = { createOperationsRuntime, operationsRuntime };
