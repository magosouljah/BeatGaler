'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReconciliationRuntime, configure, status } = require('../billing-reconciliation-runtime');
const { createBillingSafeLogger } = require('../billing-safe-log');
const { main } = require('../scripts/billing-reconcile-user.cjs');

const adapter = { provider: 'polar', environment: 'sandbox' };
const options = { pool: {}, adapter, authority: 'postgres', pendingMs: 100, commercialMs: 100 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), 'runtime did not reach expected state');
}

test('reconciliation is unavailable without PostgreSQL authority, sandbox adapter or bounded schedules', async () => {
  for (const override of [{ authority: 'json' }, { pool: null }, { adapter: null },
    { adapter: { ...adapter, environment: 'production' } }, { pendingMs: 0 }, { commercialLimit: 501 }]) {
    assert.throws(() => createReconciliationRuntime({ ...options, ...override }), { code: 'BILLING_RECONCILIATION_CONFIG_INVALID' });
  }
  assert.equal(configure({}).ready, false);
  assert.equal(status().running, false);
  await assert.rejects(main(['--provider-id', 'arbitrary']), { code: 'BILLING_RECONCILIATION_INVALID' });
});

test('sweeps do not overlap; shutdown waits for active work and restart resumes cursors', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let inFlight = 0, maximum = 0;
  async function page(kind, input) {
    inFlight += 1; maximum = Math.max(maximum, inFlight);
    calls.push({ kind, cursor: input.cursor, limit: input.limit });
    if (calls.length === 1) await gate;
    assert.equal(input.shouldContinue(), calls.length > 1);
    inFlight -= 1;
    return { nextCursor: `${kind}_cursor` };
  }
  const runtime = createReconciliationRuntime({ ...options, pendingLimit: 2, commercialLimit: 3,
    serviceFactory: () => ({ runPendingSweep: input => page('pending', input), runCommercialSweep: input => page('commercial', input) }),
  });
  runtime.start();
  await until(() => calls.length === 1);
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await delay(150);
  assert.equal(stopped, false);
  assert.equal(calls.length, 1);
  release(); await stopping;
  assert.equal(runtime.status().active, false);
  runtime.start();
  try { await until(() => calls.length >= 3); } finally { await runtime.stop(); }
  assert.equal(maximum, 1);
  assert.equal(calls[1].cursor, 'pending_cursor');
  assert.equal(calls[1].limit, 2);
  assert.equal(calls[2].limit, 3);
  const count = calls.length;
  await delay(150);
  assert.equal(calls.length, count);
});

test('scheduler errors are sanitized and do not stop future sweeps', async () => {
  const emitted = [];
  let attempts = 0;
  const runtime = createReconciliationRuntime({ ...options,
    logger: createBillingSafeLogger({ sink: entry => emitted.push(entry) }),
    serviceFactory: () => ({
      async runPendingSweep() {
        attempts += 1;
        throw Object.assign(new Error('polar_oat_secret https://secret.invalid'), { code: 'token=secret' });
      },
      async runCommercialSweep() { return { nextCursor: null }; },
    }),
  });
  runtime.start();
  try { await until(() => attempts >= 2); } finally { await runtime.stop(); }
  assert.ok(emitted.length >= 2);
  assert.equal(emitted[0].errorCode, 'BILLING_RECONCILIATION_FAILED');
  assert.equal(JSON.stringify(emitted).includes('secret'), false);
});
