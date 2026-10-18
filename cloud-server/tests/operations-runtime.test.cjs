'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationsRuntime } = require('../operations-runtime');

test('request failures emit bounded auth/API spike conditions without route secrets', () => {
  const lines = [];
  let timestamp = 100_000;
  const runtime = createOperationsRuntime({
    env: { BEATGALER_ALERT_AUTH_ROUTE: 'https://example.invalid/private-token' },
    logger: { log: line => lines.push(JSON.parse(line)) }, now: () => timestamp,
  });
  for (let index = 0; index < 10; index += 1) {
    runtime.recordHttp({ statusCode: 401, authRoute: true, durationMs: 5 });
  }
  for (let index = 0; index < 5; index += 1) runtime.recordHttp({ statusCode: 503, durationMs: 8 });
  assert.equal(lines.filter(line => line.condition === 'auth_failure_spike').length, 1);
  assert.equal(lines.filter(line => line.condition === 'api_error_spike').length, 1);
  assert.equal(lines.find(line => line.condition === 'auth_failure_spike').routeConfigured, true);
  assert.equal(lines.filter(line => line.event === 'http.error').length, 5);
  assert(!JSON.stringify(lines).includes('private-token'));
  assert.equal(runtime.snapshot()['http.response|{"statusClass":"5xx"}'], 5);
  timestamp += 61_000;
  runtime.recordHttp({ statusCode: 401, authRoute: true });
  assert.equal(lines.filter(line => line.condition === 'auth_failure_spike').length, 1);
});

test('PostgreSQL readiness transition emits once until recovery', () => {
  const lines = [];
  const runtime = createOperationsRuntime({ logger: { log: line => lines.push(JSON.parse(line)) } });
  runtime.recordReadiness({ dependencies: { postgres: 'missing' } });
  runtime.recordReadiness({ dependencies: { postgres: 'unavailable' } });
  assert.equal(lines.filter(line => line.condition === 'postgres_unavailable').length, 1);
  runtime.recordReadiness({ dependencies: { postgres: 'ready' } });
  runtime.recordReadiness({ dependencies: { postgres: 'unavailable' } });
  assert.equal(lines.filter(line => line.condition === 'postgres_unavailable').length, 2);
});

test('PostgreSQL pool saturation emits once until capacity recovers', () => {
  const lines = [];
  const runtime = createOperationsRuntime({ logger: { log: line => lines.push(JSON.parse(line)) } });
  const pool = { options: { max: 4 }, totalCount: 4, idleCount: 0, waitingCount: 2 };
  runtime.recordPool(pool);
  runtime.recordPool(pool);
  assert.equal(lines.filter(line => line.condition === 'pool_exhausted').length, 1);
  runtime.recordPool({ ...pool, waitingCount: 0 });
  runtime.recordPool(pool);
  assert.equal(lines.filter(line => line.condition === 'pool_exhausted').length, 2);
});

test('request route failures and latency emit specific sanitized conditions', () => {
  const lines = [];
  const runtime = createOperationsRuntime({ logger: { log: line => lines.push(JSON.parse(line)) } });
  for (const [path, condition] of [
    ['/transport/project/upload', 'project_failure'], ['/beats/upload', 'master_upload_failure'],
    ['/transport/index/publish', 'index_publish_failure'], ['/webhooks/polar', 'billing_webhook_failure'],
    ['/transport/session/start', 'direct_unavailable'],
  ]) {
    runtime.recordHttp({ path, statusCode: 503, durationMs: 20 });
    assert.equal(lines.filter(line => line.condition === condition).length, 1, condition);
  }
  for (let index = 0; index < 3; index += 1) {
    runtime.recordHttp({ path: '/billing/portal/availability', statusCode: 200, durationMs: 5001 });
  }
  assert.equal(lines.filter(line => line.condition === 'api_latency_spike').length, 1);
  assert(!JSON.stringify(lines).includes('private-token'));
});

test('failed log sink cannot interrupt request completion accounting', () => {
  const runtime = createOperationsRuntime({ logger: { log() { throw new Error('sink unavailable'); } } });
  assert.doesNotThrow(() => runtime.recordHttp({ statusCode: 503, path: '/transport/project/upload' }));
  assert.equal(runtime.snapshot()['condition.project_failure|{}'], 1);
});
