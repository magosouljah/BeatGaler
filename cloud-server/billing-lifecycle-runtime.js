'use strict';

const crypto = require('crypto');
const { createBillingLifecycle, createBillingProviderActionWorker } = require('./billing-lifecycle');

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 25;

function createLifecycleWorker({ pool, adapter, inbox, pollMs = DEFAULT_POLL_MS, batchSize = DEFAULT_BATCH_SIZE,
  onError = () => {}, lifecycleFactory = createBillingLifecycle,
  actionWorkerFactory = createBillingProviderActionWorker } = {}) {
  if (!pool || !inbox || inbox.provider !== 'polar' || inbox.environment !== 'sandbox' ||
      adapter?.provider !== 'polar' || adapter?.environment !== 'sandbox' ||
      !Number.isInteger(pollMs) || pollMs < 100 || !Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('BILLING_LIFECYCLE_RUNTIME_CONFIG_INVALID');
  }
  const lifecycle = lifecycleFactory({ adapter });
  const actions = actionWorkerFactory({ pool, adapter });
  const workerId = `lifecycle_${crypto.randomUUID()}`;
  let running = false;
  let timer = null;
  let active = null;

  function report(area, code) {
    const safe = /^[A-Z0-9_:-]{1,128}$/.test(String(code || '')) ? code : 'BILLING_WORKER_FAILED';
    try { onError(area, safe); } catch (_) {}
  }

  async function pumpOnce() {
    let events = 0;
    let providerActions = 0;
    for (; events < batchSize && running; events += 1) {
      let result;
      try { result = await inbox.processNext({ workerId, handlers: lifecycle.handlers }); }
      catch (error) { report('inbox', error?.code || 'BILLING_LIFECYCLE_PROCESS_FAILED'); break; }
      if (!result) break;
    }
    for (; providerActions < batchSize && running; providerActions += 1) {
      let result;
      try { result = await actions.processNext({ workerId }); }
      catch (error) { report('action', error?.code || 'BILLING_ACTION_PROCESS_FAILED'); break; }
      if (!result) break;
    }
    return { events, providerActions };
  }

  function schedule() {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      active = pumpOnce()
        .catch(error => report('poll', error?.code || 'BILLING_LIFECYCLE_POLL_FAILED'))
        .finally(() => { active = null; schedule(); });
    }, pollMs);
    timer.unref?.();
  }

  function start() {
    if (running) return;
    running = true;
    schedule();
  }

  async function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (active) await active;
  }

  return Object.freeze({ lifecycle, actions, start, stop, pumpOnce,
    status: () => ({ running, active: Boolean(active) }),
  });
}

let worker = null;
let failureCode = 'BILLING_LIFECYCLE_NOT_INITIALIZED';

function configure(options) {
  worker = null;
  failureCode = 'BILLING_LIFECYCLE_UNAVAILABLE';
  try {
    worker = createLifecycleWorker(options);
    failureCode = null;
  } catch (_) {}
  return status();
}

function status() { return Object.freeze({ ready: Boolean(worker), running: Boolean(worker?.status().running), failureCode }); }
function start() { if (worker) worker.start(); return status(); }
async function stop() { if (worker) await worker.stop(); return status(); }

module.exports = { DEFAULT_POLL_MS, DEFAULT_BATCH_SIZE, createLifecycleWorker, configure, status, start, stop };
