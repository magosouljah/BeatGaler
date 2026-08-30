'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runCapacityHarness, parseArgs } = require('./capacity-load-harness.cjs');

test('requires an explicit target instead of inventing expected peak', () => {
  assert.throws(() => parseArgs(['--operations', '8']), /--target is required/);
});

test('measures bounded concurrency, queueing, latency, errors and recovery locally', async () => {
  const result = await runCapacityHarness({ targetConcurrency: 2, operations: 8, workMs: 2, queueLimit: 16 });
  assert.equal(result.target_concurrency, 2);
  assert.equal(result.operations_requested, 8);
  assert.equal(result.operations_completed, 8);
  assert.equal(result.errors, 0);
  assert.equal(result.max_active, 2);
  assert.ok(result.max_queue_depth >= 1);
  assert.ok(result.queue_wait_ms.max >= 0);
  assert.ok(result.latency_ms.p95 >= 0);
  assert.ok(result.ops_per_second > 0);
  assert.equal(result.recovery.ok, true);
});

test('reports admission errors when the synthetic wait queue is exhausted', async () => {
  const result = await runCapacityHarness({ targetConcurrency: 1, operations: 6, workMs: 3, queueLimit: 1 });
  assert.equal(result.max_active, 1);
  assert.ok(result.errors > 0);
  assert.equal(result.recovery.ok, true);
});
