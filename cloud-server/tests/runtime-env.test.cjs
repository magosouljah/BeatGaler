'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getRuntimeEnv, catalogWorkerEnv, criticalPathTraceFile } = require('../runtime-env');

test('runtime environment keeps the live object and parses the current values on each call', (t) => {
  const keys = [
    'BEATGALER_CATALOG_WORKER_ENABLED',
    'BEATGALER_CATALOG_WORKER_HEALTH_MS',
    'STAGE1_CRITICAL_PATH_CLOUD_TRACE_FILE',
  ];
  const original = keys.map(key => process.env[key]);
  t.after(() => {
    for (const [index, key] of keys.entries()) {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    }
  });
  for (const key of keys) delete process.env[key];

  const env = getRuntimeEnv();
  assert.equal(env, process.env);
  assert.equal(catalogWorkerEnv.enabled(), false);
  assert.equal(catalogWorkerEnv.healthIntervalMs(), 60_000);
  assert.equal(criticalPathTraceFile(), null);

  env.BEATGALER_CATALOG_WORKER_ENABLED = 'TrUe';
  env.BEATGALER_CATALOG_WORKER_HEALTH_MS = '2500';
  env.STAGE1_CRITICAL_PATH_CLOUD_TRACE_FILE = '  local-trace.jsonl  ';
  assert.equal(catalogWorkerEnv.enabled(), true);
  assert.equal(catalogWorkerEnv.healthIntervalMs(), 2500);
  assert.equal(criticalPathTraceFile(), 'local-trace.jsonl');

  env.BEATGALER_CATALOG_WORKER_ENABLED = ' true ';
  env.BEATGALER_CATALOG_WORKER_HEALTH_MS = 'invalid';
  env.STAGE1_CRITICAL_PATH_CLOUD_TRACE_FILE = '   ';
  assert.equal(catalogWorkerEnv.enabled(), false);
  assert.ok(Number.isNaN(catalogWorkerEnv.healthIntervalMs()));
  assert.equal(criticalPathTraceFile(), null);
});
