#!/usr/bin/env node
// Local routing contract only. Never sends an alert or reports provider delivery.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { alertRoute, killSwitches, structuredEvent, createMetrics } =
  require('../cloud-server/operations-observability.js');

export const CONDITIONS = Object.freeze([
  'auth_failure_spike', 'api_error_spike', 'postgres_unavailable',
  'billing_reconciliation_exception', 'provider_failure', 'pool_exhausted',
  'queue_backlog', 'release_failure', 'backup_failure', 'direct_unavailable',
  'master_upload_failure', 'project_failure', 'index_publish_failure',
  'billing_webhook_failure', 'api_latency_spike', 'migration_failure',
  'temp_storage_pressure',
]);

export function assessObservability(env = process.env) {
  const routes = Object.fromEntries(CONDITIONS.map(condition => {
    const destination = alertRoute(condition, env);
    return [condition, destination.routable ? 'CONFIGURED_UNDELIVERED' : 'MISSING'];
  }));
  const switches = killSwitches(env);
  const metrics = createMetrics();
  metrics.increment('local_preflight');
  const event = structuredEvent('info', 'local_preflight', { token: 'discard', signal_count: CONDITIONS.length });
  if ('token' in event || metrics.snapshot()['local_preflight|{}'] !== 1) {
    throw new Error('Local observability sanitization/metrics contract failed.');
  }
  const missingRoutes = Object.entries(routes).filter(([, state]) => state === 'MISSING').map(([name]) => name);
  return { kind: 'V1_OBSERVABILITY_PREFLIGHT', result: missingRoutes.length ? 'BLOCKED_EXTERNAL' : 'LOCAL_ROUTE_CONFIGURED',
    routes, missingRoutes, killSwitches: switches, structuredEventSanitized: true,
    localMetricCounted: true, runtimeSignalsWired: ['auth_failure_spike', 'api_error_spike', 'postgres_unavailable',
      'billing_reconciliation_exception', 'provider_failure', 'pool_exhausted', 'queue_backlog',
      'direct_unavailable', 'master_upload_failure', 'project_failure', 'index_publish_failure',
      'billing_webhook_failure', 'api_latency_spike', 'migration_failure'],
    externalSignalsUnwired: ['release_failure', 'backup_failure', 'temp_storage_pressure'], alertDeliveryProven: false,
    backendRetentionProven: false, onCallProven: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = assessObservability();
    console.log(JSON.stringify(result, null, 2));
    if (result.missingRoutes.length) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ kind: 'V1_OBSERVABILITY_PREFLIGHT', result: 'FAIL',
      reason: error?.message || String(error) }));
    process.exitCode = 2;
  }
}
