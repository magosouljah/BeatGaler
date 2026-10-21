'use strict';

function retryDelay(attempt) {
  const power = Math.max(0, Math.min(6, Number(attempt || 1) - 1));
  return Math.min(60 * 60 * 1000, 60_000 * (2 ** power));
}

function createAuthDeliveryWorker({
  service,
  emailNotifier,
  intervalMs = 2_000,
  staleMs = 5 * 60_000,
  logger = console,
} = {}) {
  if (!service || typeof service.claimDelivery !== 'function') throw new Error('Auth delivery worker requires pending signup service.');
  if (typeof emailNotifier !== 'function') return { start() {}, stop() {}, runOnce: async () => false, enabled: false };

  let timer = null;
  let running = false;
  let stopped = true;
  let sweeps = 0;

  async function runOnce() {
    if (running) return false;
    running = true;
    try {
      sweeps += 1;
      if (sweeps === 1 || sweeps % 150 === 0) {
        await service.requeueStaleDeliveries({ staleMs });
      }
      const claimed = await service.claimDelivery();
      if (!claimed) return false;
      const { row, secret } = claimed;
      try {
        if (String(row?.kind) !== 'signup_verification') {
          await service.completeDelivery(row.id, { ok: false, errorCode: 'DELIVERY_KIND_UNSUPPORTED', retryDelayMs: 60 * 60 * 1000 });
          return true;
        }
        await emailNotifier({
          kind: 'email_verification',
          to: secret?.email,
          token: secret?.manual_code,
          expires_at: secret?.expires_at,
        });
        await service.completeDelivery(row.id, { ok: true });
      } catch (error) {
        const code = String(error?.code || 'EMAIL_DELIVERY_FAILED').slice(0, 120);
        await service.completeDelivery(row.id, {
          ok: false,
          errorCode: code,
          retryDelayMs: retryDelay(row?.attempt_count),
        });
        logger.warn?.('[auth-delivery] signup verification delivery failed', { code });
      }
      return true;
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      try { await runOnce(); }
      catch (error) { logger.error?.('[auth-delivery] worker iteration failed', error?.message || String(error)); }
      schedule();
    }, Math.max(250, Number(intervalMs || 2_000)));
    timer.unref?.();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { start, stop, runOnce, enabled: true };
}

module.exports = { retryDelay, createAuthDeliveryWorker };
