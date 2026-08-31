'use strict';

const { performance } = require('node:perf_hooks');

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function runCapacityHarness({ targetConcurrency, operations, workMs = 5, queueLimit = 1000 }) {
  targetConcurrency = positiveInt('targetConcurrency', targetConcurrency);
  operations = positiveInt('operations', operations);
  workMs = positiveInt('workMs', workMs);
  queueLimit = positiveInt('queueLimit', queueLimit);

  let active = 0;
  let maxActive = 0;
  let queued = 0;
  let maxQueued = 0;
  let rejected = 0;
  const queue = [];
  const latencies = [];
  const waits = [];
  const startedAt = performance.now();

  const execute = (enqueuedAt, resolve) => {
    const started = performance.now();
    waits.push(started - enqueuedAt);
    active += 1;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      active -= 1;
      latencies.push(performance.now() - enqueuedAt);
      resolve(true);
      const next = queue.shift();
      if (next) {
        queued -= 1;
        execute(next.enqueuedAt, next.resolve);
      }
    }, workMs);
  };

  const submit = () => new Promise(resolve => {
    const enqueuedAt = performance.now();
    if (active < targetConcurrency) return execute(enqueuedAt, resolve);
    if (queue.length >= queueLimit) {
      rejected += 1;
      return resolve(false);
    }
    queue.push({ enqueuedAt, resolve });
    queued += 1;
    maxQueued = Math.max(maxQueued, queued);
  });

  const outcomes = await Promise.all(Array.from({ length: operations }, submit));
  const durationMs = performance.now() - startedAt;
  const completed = outcomes.filter(Boolean).length;

  const recoveryStarted = performance.now();
  const recoveryOk = await submit();
  const recoveryMs = performance.now() - recoveryStarted;

  return {
    target_concurrency: targetConcurrency,
    operations_requested: operations,
    operations_completed: completed,
    errors: rejected,
    max_active: maxActive,
    max_queue_depth: maxQueued,
    queue_wait_ms: { p50: percentile(waits, 50), p95: percentile(waits, 95), max: Math.max(0, ...waits) },
    latency_ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99) },
    duration_ms: durationMs,
    ops_per_second: completed / (durationMs / 1000),
    recovery: { ok: recoveryOk, latency_ms: recoveryMs },
    note: 'Local synthetic harness only; no production/provider traffic and no F3/20.2 PASS claim.'
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Arguments must be --name value pairs');
    args[key.slice(2)] = value;
  }
  if (!args.target) throw new Error('--target is required; do not invent an expected peak');
  return {
    targetConcurrency: args.target,
    operations: args.operations || args.target,
    workMs: args['work-ms'] || 5,
    queueLimit: args['queue-limit'] || 1000,
  };
}

if (require.main === module) {
  runCapacityHarness(parseArgs(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { console.error(error.message); process.exitCode = 2; });
}

module.exports = { runCapacityHarness, parseArgs };
