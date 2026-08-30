'use strict';

const SAFE_LEVELS = new Set(['info', 'warn', 'error']);
const SWITCHES = Object.freeze(['billingWrites', 'directOperations', 'backgroundWorkers']);

function clean(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.slice(0, 256);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function structuredEvent(level, event, fields = {}, now = () => new Date()) {
  if (!SAFE_LEVELS.has(level)) throw new Error('Unsupported log level.');
  if (!/^[a-z0-9_.-]{1,80}$/.test(String(event || ''))) throw new Error('Invalid event name.');
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) continue;
    const sanitized = clean(value);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return { ts: now().toISOString(), level, event, ...safe };
}

function createMetrics() {
  const counters = new Map();
  return Object.freeze({
    increment(name, labels = {}) {
      if (!/^[a-z][a-z0-9_.-]{1,80}$/.test(String(name || ''))) throw new Error('Invalid metric name.');
      const key = `${name}|${JSON.stringify(labels)}`;
      counters.set(key, (counters.get(key) || 0) + 1);
    },
    snapshot() { return Object.fromEntries(counters); },
  });
}

function alertRoute(condition, env = process.env) {
  const routes = {
    auth_failure_spike: env.BEATGALER_ALERT_AUTH_ROUTE,
    api_error_spike: env.BEATGALER_ALERT_API_ROUTE,
    postgres_unavailable: env.BEATGALER_ALERT_DB_ROUTE,
    billing_reconciliation_exception: env.BEATGALER_ALERT_BILLING_ROUTE,
    provider_failure: env.BEATGALER_ALERT_PROVIDER_ROUTE,
    pool_exhausted: env.BEATGALER_ALERT_POOL_ROUTE,
    queue_backlog: env.BEATGALER_ALERT_QUEUE_ROUTE,
    release_failure: env.BEATGALER_ALERT_RELEASE_ROUTE,
    backup_failure: env.BACKUP_FAILURE_ALERT_ROUTE,
  };
  if (!(condition in routes)) throw new Error('Unknown alert condition.');
  const route = String(routes[condition] || '').trim();
  return route ? { condition, route, routable: true } : { condition, route: null, routable: false };
}

function killSwitches(env = process.env) {
  const result = {};
  for (const name of SWITCHES) {
    const key = `BEATGALER_KILL_${name.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
    const raw = String(env[key] || 'off').trim().toLowerCase();
    if (!['on', 'off'].includes(raw)) throw new Error(`${key} must be on or off.`);
    result[name] = raw === 'on';
  }
  return Object.freeze(result);
}

function assertOperationEnabled(operation, switches = killSwitches()) {
  if (!(operation in switches)) throw new Error('Unknown kill switch.');
  if (switches[operation]) {
    const error = new Error(`${operation} disabled by operational kill switch.`);
    error.code = 'OPERATION_KILLED';
    throw error;
  }
}

module.exports = { structuredEvent, createMetrics, alertRoute, killSwitches, assertOperationEnabled };
