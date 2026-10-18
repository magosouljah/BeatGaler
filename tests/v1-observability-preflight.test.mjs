import test from 'node:test';
import assert from 'node:assert/strict';
import { assessObservability, CONDITIONS } from '../scripts/v1-observability-preflight.mjs';

test('observability preflight identifies every missing route without sending anything', () => {
  const result = assessObservability({});
  assert.deepEqual(result.missingRoutes, CONDITIONS);
  assert.equal(result.structuredEventSanitized, true);
  assert.equal(result.localMetricCounted, true);
  assert.deepEqual(result.runtimeSignalsWired, ['auth_failure_spike', 'api_error_spike', 'postgres_unavailable',
    'billing_reconciliation_exception', 'provider_failure', 'pool_exhausted', 'queue_backlog',
    'direct_unavailable', 'master_upload_failure', 'project_failure', 'index_publish_failure',
    'billing_webhook_failure', 'api_latency_spike', 'migration_failure']);
  assert.deepEqual(result.externalSignalsUnwired, ['release_failure', 'backup_failure', 'temp_storage_pressure']);
  assert.equal(result.alertDeliveryProven, false);
});

test('configured route remains explicitly undelivered', () => {
  const result = assessObservability({ BEATGALER_ALERT_DB_ROUTE: 'ops-db' });
  assert.equal(result.routes.postgres_unavailable, 'CONFIGURED_UNDELIVERED');
  assert.equal(result.alertDeliveryProven, false);
  assert.equal(result.missingRoutes.length, CONDITIONS.length - 1);
});
