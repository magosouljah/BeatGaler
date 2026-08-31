'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { structuredEvent, createMetrics, alertRoute, killSwitches, assertOperationEnabled } = require('../operations-observability');

test('structured logs redact secret-shaped fields', () => {
  const event = structuredEvent('error', 'api.failed', { requestId: 'r1', authorization: 'Bearer nope', password: 'nope', status: 500 }, () => new Date('2026-08-30T00:00:00Z'));
  assert.equal(event.requestId, 'r1');
  assert.equal(event.status, 500);
  assert.equal(event.authorization, undefined);
  assert.equal(event.password, undefined);
});

test('metrics count named internal events', () => {
  const metrics = createMetrics();
  metrics.increment('api.errors', { class: '5xx' });
  metrics.increment('api.errors', { class: '5xx' });
  assert.deepEqual(metrics.snapshot(), { 'api.errors|{"class":"5xx"}': 2 });
});

test('alert routing is explicit and reports missing external route without inventing delivery', () => {
  assert.deepEqual(alertRoute('postgres_unavailable', {}), { condition: 'postgres_unavailable', route: null, routable: false });
  assert.deepEqual(alertRoute('backup_failure', { BACKUP_FAILURE_ALERT_ROUTE: 'ops-critical' }), { condition: 'backup_failure', route: 'ops-critical', routable: true });
});

test('kill switches fail closed on invalid config and block enabled switch', () => {
  assert.throws(() => killSwitches({ BEATGALER_KILL_BILLING_WRITES: 'maybe' }), /must be on or off/);
  const switches = killSwitches({ BEATGALER_KILL_BILLING_WRITES: 'on' });
  assert.throws(() => assertOperationEnabled('billingWrites', switches), error => error.code === 'OPERATION_KILLED');
  assert.doesNotThrow(() => assertOperationEnabled('directOperations', switches));
});
