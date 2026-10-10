'use strict';

const crypto = require('crypto');
const { createBillingReconciliationService, MAX_SWEEP_LIMIT } = require('./billing-reconciliation');
const { createBillingSafeLogger, safeErrorCode } = require('./billing-safe-log');

const DEFAULT_PENDING_MS = 60_000;
const DEFAULT_COMMERCIAL_MS = 15 * 60_000;

function createReconciliationRuntime({ pool, adapter, authority, pendingMs = DEFAULT_PENDING_MS,
  commercialMs = DEFAULT_COMMERCIAL_MS, pendingLimit = 50, commercialLimit = 100,
  logger = createBillingSafeLogger(), serviceFactory = createBillingReconciliationService } = {}) {
  if (authority !== 'postgres' || !pool || adapter?.provider !== 'polar' || adapter?.environment !== 'sandbox' ||
      ![pendingMs, commercialMs].every(ms => Number.isInteger(ms) && ms >= 100) ||
      ![pendingLimit, commercialLimit].every(limit => Number.isInteger(limit) && limit > 0 && limit <= MAX_SWEEP_LIMIT)) {
    throw Object.assign(new Error('Reconciliation runtime is unavailable.'), { code: 'BILLING_RECONCILIATION_CONFIG_INVALID' });
  }
  const service = serviceFactory({ pool, adapter, logger });
  let running = false;
  let timer = null;
  let active = null;
  let pendingCursor = null;
  let commercialCursor = null;
  let pendingDue = 0;
  let commercialDue = 0;

  async function sweep(kind) {
    const pending = kind === 'pending';
    try {
      const result = await service[pending ? 'runPendingSweep' : 'runCommercialSweep']({
        cursor: pending ? pendingCursor : commercialCursor,
        limit: pending ? pendingLimit : commercialLimit,
        sweepId: `web_${kind}_${crypto.randomUUID()}`,
        shouldContinue: () => running,
      });
      if (pending) pendingCursor = result.nextCursor;
      else commercialCursor = result.nextCursor;
    } catch (error) {
      logger.emit('reconciliation_failed', { provider: 'polar', environment: 'sandbox', mode: kind,
        reason: 'SWEEP_FAILED', errorCode: safeErrorCode(error) });
    }
  }

  async function tick() {
    if (running && Date.now() >= pendingDue) {
      await sweep('pending');
      pendingDue = Date.now() + pendingMs;
    }
    if (running && Date.now() >= commercialDue) {
      await sweep('commercial');
      commercialDue = Date.now() + commercialMs;
    }
  }

  function schedule() {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      active = tick().finally(() => { active = null; schedule(); });
      active.catch(() => {});
    }, Math.max(1, Math.min(pendingDue, commercialDue) - Date.now()));
    timer.unref?.();
  }

  function start() {
    if (running) return;
    running = true;
    pendingDue = Date.now() + pendingMs;
    commercialDue = Date.now() + commercialMs;
    schedule();
  }

  async function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (active) await active;
  }

  return Object.freeze({ start, stop,
    reconcileUser: options => service.reconcileUser(options),
    status: () => ({ running, active: Boolean(active), pendingCursor, commercialCursor }),
  });
}

let runtime = null;
let failureCode = 'BILLING_RECONCILIATION_NOT_INITIALIZED';
function configure(options) {
  if (runtime?.status().running) throw new Error('BILLING_RECONCILIATION_ALREADY_RUNNING');
  runtime = null;
  failureCode = 'BILLING_RECONCILIATION_UNAVAILABLE';
  try { runtime = createReconciliationRuntime(options); failureCode = null; } catch (_) {}
  return status();
}
function status() { return { ready: Boolean(runtime), running: Boolean(runtime?.status().running), failureCode }; }
function start() { runtime?.start(); return status(); }
async function stop() { if (runtime) await runtime.stop(); return status(); }
module.exports = { DEFAULT_PENDING_MS, DEFAULT_COMMERCIAL_MS, createReconciliationRuntime, configure, status, start, stop };
