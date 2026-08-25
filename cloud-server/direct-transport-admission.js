'use strict';

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function installDirectTransportAdmission(directTransport, options = {}) {
  if (!directTransport || typeof directTransport.startSession !== 'function' || typeof directTransport.poolStatus !== 'function') {
    throw new Error('Direct transport admission requires startSession() and poolStatus().');
  }
  if (directTransport.__admissionInstalled) return directTransport;

  const maxVaultsPerBot = positiveInt(
    options.maxVaultsPerBot ?? process.env.DIRECT_MAX_VAULTS_PER_BOT,
    4,
    1,
    64,
  );
  const waitlistMax = positiveInt(
    options.waitlistMax ?? process.env.DIRECT_ADMISSION_WAITLIST_MAX,
    320,
    1,
    100000,
  );
  const waitTimeoutMs = positiveInt(
    options.waitTimeoutMs ?? process.env.DIRECT_ADMISSION_WAIT_TIMEOUT_MS,
    30000,
    100,
    10 * 60 * 1000,
  );
  const pumpIntervalMs = positiveInt(options.pumpIntervalMs, 250, 10, 5000);

  const originalStartSession = directTransport.startSession.bind(directTransport);
  const originalStopSession = typeof directTransport.stopSession === 'function'
    ? directTransport.stopSession.bind(directTransport)
    : null;
  const originalCleanupExpiredSessions = typeof directTransport.cleanupExpiredSessions === 'function'
    ? directTransport.cleanupExpiredSessions.bind(directTransport)
    : null;
  const originalPoolStatus = directTransport.poolStatus.bind(directTransport);

  const waitlist = [];
  let pendingStarts = 0;
  const metrics = {
    exclusive_assignments_total: 0,
    shared_fallback_assignments_total: 0,
    waitlist_enqueued_total: 0,
    waitlist_admitted_total: 0,
    waitlist_rejected_total: 0,
    waitlist_timeout_total: 0,
  };

  function capacitySnapshot() {
    const status = originalPoolStatus();
    const bots = Array.isArray(status?.bots) ? status.bots : [];
    const eligible = bots.filter(bot => !bot.quarantined && !bot.rotation_pending);
    const loads = eligible.map(bot => Math.max(0, Number(bot.active_vaults || 0)));
    const freeBots = loads.filter(load => load === 0).length;
    const sharedBots = loads.filter(load => load > 1).length;
    const sharedLeases = loads.reduce((sum, load) => sum + Math.max(0, load - 1), 0);
    const activeLeases = loads.reduce((sum, load) => sum + load, 0);
    const totalCapacity = eligible.length * maxVaultsPerBot;
    const availableSlots = loads.reduce((sum, load) => sum + Math.max(0, maxVaultsPerBot - load), 0);
    return {
      eligible_bots: eligible.length,
      free_bots: freeBots,
      active_leases: activeLeases,
      shared_bots: sharedBots,
      shared_leases: sharedLeases,
      total_capacity: totalCapacity,
      available_slots: availableSlots,
      min_load: loads.length ? Math.min(...loads) : 0,
      max_load: loads.length ? Math.max(...loads) : 0,
    };
  }

  function makeAdmissionError(code, message, retryAfterSeconds = 5) {
    const error = new Error(message);
    error.code = code;
    error.retry_after_seconds = retryAfterSeconds;
    return error;
  }

  function reserveIfPossible() {
    const capacity = capacitySnapshot();
    if (capacity.eligible_bots === 0) return null;
    if (capacity.available_slots - pendingStarts <= 0) return null;
    pendingStarts += 1;
    return {
      mode: capacity.free_bots > 0 ? 'exclusive' : 'shared_fallback',
      freeBotsBefore: capacity.free_bots,
      capacity,
    };
  }

  function releaseReservation() {
    pendingStarts = Math.max(0, pendingStarts - 1);
  }

  function runReservedStart(args, reservation, fromWaitlist = false) {
    if (fromWaitlist) metrics.waitlist_admitted_total += 1;
    if (reservation.mode === 'exclusive') metrics.exclusive_assignments_total += 1;
    else metrics.shared_fallback_assignments_total += 1;

    console.log(
      `[direct-admission] assignment_mode=${reservation.mode} ` +
      `free_bots_before=${reservation.freeBotsBefore} ` +
      `active=${reservation.capacity.active_leases} ` +
      `capacity=${reservation.capacity.total_capacity}`
    );

    return Promise.resolve()
      .then(() => originalStartSession(args))
      .finally(() => {
        releaseReservation();
        queueMicrotask(pumpWaitlist);
      });
  }

  function removeQueued(entry) {
    const index = waitlist.indexOf(entry);
    if (index >= 0) waitlist.splice(index, 1);
  }

  function pumpWaitlist() {
    while (waitlist.length) {
      const reservation = reserveIfPossible();
      if (!reservation) return;
      const entry = waitlist.shift();
      clearTimeout(entry.timer);
      runReservedStart(entry.args, reservation, true).then(entry.resolve, entry.reject);
    }
  }

  directTransport.startSession = function startSessionWithAdmission(args) {
    const reservation = reserveIfPossible();
    if (reservation) return runReservedStart(args, reservation, false);

    if (waitlist.length >= waitlistMax) {
      metrics.waitlist_rejected_total += 1;
      return Promise.reject(makeAdmissionError(
        'POOL_WAITLIST_FULL',
        'Transport capacity is full and the admission waitlist is full.',
      ));
    }

    metrics.waitlist_enqueued_total += 1;
    return new Promise((resolve, reject) => {
      const entry = { args, resolve, reject, enqueuedAt: Date.now(), timer: null };
      entry.timer = setTimeout(() => {
        removeQueued(entry);
        metrics.waitlist_timeout_total += 1;
        reject(makeAdmissionError(
          'POOL_WAIT_TIMEOUT',
          'Transport capacity remained full while waiting for a slot.',
        ));
      }, waitTimeoutMs);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      waitlist.push(entry);
    });
  };

  if (originalStopSession) {
    directTransport.stopSession = async function stopSessionWithAdmission(args) {
      try { return await originalStopSession(args); }
      finally { queueMicrotask(pumpWaitlist); }
    };
  }

  if (originalCleanupExpiredSessions) {
    directTransport.cleanupExpiredSessions = async function cleanupWithAdmission(...args) {
      try { return await originalCleanupExpiredSessions(...args); }
      finally { queueMicrotask(pumpWaitlist); }
    };
  }

  directTransport.poolStatus = function poolStatusWithAdmission() {
    const status = originalPoolStatus();
    const capacity = capacitySnapshot();
    return {
      ...status,
      admission: {
        max_vaults_per_bot: maxVaultsPerBot,
        waitlist_max: waitlistMax,
        wait_timeout_ms: waitTimeoutMs,
        waitlist_depth: waitlist.length,
        pending_starts: pendingStarts,
        ...capacity,
        ...metrics,
      },
    };
  };

  const timer = setInterval(pumpWaitlist, pumpIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  Object.defineProperty(directTransport, '__admissionInstalled', { value: true, enumerable: false });
  Object.defineProperty(directTransport, '__admissionTest', {
    value: { capacitySnapshot, pumpWaitlist, waitlist, metrics, maxVaultsPerBot, waitlistMax, waitTimeoutMs },
    enumerable: false,
  });

  return directTransport;
}

module.exports = { installDirectTransportAdmission };
