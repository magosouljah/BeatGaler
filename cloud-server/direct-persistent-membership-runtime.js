'use strict';

const INSTALL_MARK = Symbol.for('beatgaler.direct.persistent-membership-activation');

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicPool(status) {
  return (Array.isArray(status?.bots) ? status.bots : [])
    .map(bot => ({ id: String(bot?.id || '').trim() }))
    .filter(bot => bot.id);
}

function leaseExpired(lease, heartbeatTimeoutMs) {
  const lastHeartbeat = Date.parse(String(lease?.last_heartbeat_at || lease?.started_at || ''));
  if (!Number.isFinite(lastHeartbeat)) return true;
  return Date.now() - lastHeartbeat >= Number(heartbeatTimeoutMs || 0);
}

function checkedLease({ directTransport, installationId, sessionId, generation }) {
  const status = directTransport.poolStatus();
  const pool = publicPool(status);
  const state = directTransport.__test.stateSnapshot(pool);
  const lease = state.leases?.[String(sessionId || '')] || null;
  if (!lease) return null;
  if (String(lease.installation_id || '') !== String(installationId || '')) return null;
  if (generation != null && Number(lease.generation) !== Number(generation)) return null;
  if (leaseExpired(lease, status?.heartbeat_timeout_ms || 5 * 60_000)) return null;
  return { status, pool, state, lease };
}

function assertAssignmentMatches(assignment, lease) {
  if (!assignment) {
    throw codedError(
      `Vault ${lease.chat_id} has no persistent Direct assignment.`,
      'TRANSPORT_ASSIGNMENT_MISSING',
    );
  }
  const assignedBotId = String(assignment.transportBotId || '').trim();
  if (!assignedBotId || assignedBotId !== String(lease.bot_id || '')) {
    throw codedError(
      `Direct lease bot ${lease.bot_id || '<none>'} does not match persistent assignment ${assignedBotId || '<none>'}.`,
      'TRANSPORT_ASSIGNMENT_MISMATCH',
    );
  }
  if (String(assignment.chatId || '') !== String(lease.chat_id || '')) {
    throw codedError(
      `Direct lease vault ${lease.chat_id || '<none>'} does not match persistent assignment ${assignment.chatId || '<none>'}.`,
      'TRANSPORT_ASSIGNMENT_MISMATCH',
    );
  }
  return assignedBotId;
}

function finalizeReadyLease({ directTransport, pool, lease }) {
  return directTransport.__test.mutateState(pool, state => {
    const current = state.leases?.[String(lease.session_id || '')] || null;
    if (!current) return null;
    if (
      String(current.installation_id || '') !== String(lease.installation_id || '') ||
      String(current.chat_id || '') !== String(lease.chat_id || '') ||
      String(current.bot_id || '') !== String(lease.bot_id || '') ||
      Number(current.generation) !== Number(lease.generation)
    ) return null;

    const wasActive = String(current.status || '') === 'ACTIVE';
    current.status = 'ACTIVE';
    current.last_heartbeat_at = new Date().toISOString();
    if (!wasActive && state.metrics?.[current.bot_id]) {
      const metric = state.metrics[current.bot_id];
      metric.sessions_today = Number(metric.sessions_today || 0) + 1;
      metric.total_sessions = Number(metric.total_sessions || 0) + 1;
      metric.last_used_at = new Date().toISOString();
    }
    return { ...current };
  });
}

function readyResult(finalized) {
  if (!finalized) throw new Error('Direct transport session disappeared before activation completed.');
  return { ok: true, activated: true, status: finalized.status || 'ACTIVE' };
}

function membershipUpdatedAtMs(assignment) {
  const parsed = Date.parse(String(assignment?.membershipUpdatedAt || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function installPersistentDirectMembershipActivation({ directTransport, persistentAssignments } = {}) {
  if (!directTransport || typeof directTransport.activateSession !== 'function') {
    throw new Error('Direct transport activateSession() is required.');
  }
  for (const method of ['getAssignment', 'withMembershipLock', 'markMembershipReady', 'markMembershipRepairNeeded']) {
    if (typeof persistentAssignments?.[method] !== 'function') {
      throw new Error(`Persistent Direct assignment runtime must implement ${method}().`);
    }
  }
  if (
    typeof directTransport?.__test?.stateSnapshot !== 'function' ||
    typeof directTransport?.__test?.mutateState !== 'function'
  ) {
    throw new Error('Direct transport activation adapter requires stateSnapshot() and mutateState().');
  }
  if (directTransport[INSTALL_MARK]?.wrappedActivateSession) return directTransport[INSTALL_MARK];

  const originalActivateSession = directTransport.activateSession.bind(directTransport);

  const provisionCurrentLease = async ({ args, checked, assignedBotId }) => {
    const result = await originalActivateSession(args);
    await persistentAssignments.markMembershipReady(checked.lease.chat_id, assignedBotId);
    return result;
  };

  const wrappedActivateSession = async (args = {}) => {
    const checked = checkedLease({ directTransport, ...args });
    if (!checked) throw new Error('Direct transport session is not active.');
    const chatId = String(checked.lease.chat_id);

    const initial = await persistentAssignments.getAssignment(chatId);
    const assignedBotId = assertAssignmentMatches(initial, checked.lease);

    // READY is the normal warm path. PostgreSQL membership is authoritative,
    // so activation becomes a local lease transition only: no MASTER lookup,
    // getEntity, InviteToChannel, EditAdmin or GetParticipant.
    if (String(initial.membershipState) === 'ready') {
      return readyResult(finalizeReadyLease({
        directTransport,
        pool: checked.pool,
        lease: checked.lease,
      }));
    }

    if (!['pending', 'repair'].includes(String(initial.membershipState))) {
      throw codedError(
        `Unsupported Direct membership state ${initial.membershipState}.`,
        'TRANSPORT_MEMBERSHIP_STATE_INVALID',
      );
    }

    // PENDING/REPAIR is exceptional provisioning. The session-level PostgreSQL
    // lock singleflights Telegram mutations across Cloud processes without any
    // SQL transaction remaining open while Telegram is contacted.
    return persistentAssignments.withMembershipLock(chatId, async () => {
      const reread = await persistentAssignments.getAssignment(chatId);
      assertAssignmentMatches(reread, checked.lease);

      if (String(reread.membershipState) === 'ready') {
        return readyResult(finalizeReadyLease({
          directTransport,
          pool: checked.pool,
          lease: checked.lease,
        }));
      }
      if (!['pending', 'repair'].includes(String(reread.membershipState))) {
        throw codedError(
          `Unsupported Direct membership state ${reread.membershipState}.`,
          'TRANSPORT_MEMBERSHIP_STATE_INVALID',
        );
      }

      // The existing activation implementation is intentionally retained as
      // the Telegram provisioning primitive for now. Under this per-vault lock
      // it operates on the lease's already-verified persistent bot. On any
      // Telegram/network/FLOOD_WAIT failure PostgreSQL stays pending/repair,
      // so a later retry uses the SAME transport bot and never auto-reassigns.
      return provisionCurrentLease({ args, checked, assignedBotId });
    });
  };

  const repairMembership = async (args = {}) => {
    const checked = checkedLease({ directTransport, ...args });
    if (!checked) throw new Error('Direct transport session is not active.');
    const chatId = String(checked.lease.chat_id);
    const requestStartedAt = Date.now();

    // Repair is explicit and serialized. READY never silently falls into this
    // path. The request timestamp lets a waiter detect that another concurrent
    // repair completed after this request began and coalesce instead of
    // immediately mutating READY back to REPAIR and provisioning twice.
    return persistentAssignments.withMembershipLock(chatId, async () => {
      const current = await persistentAssignments.getAssignment(chatId);
      const assignedBotId = assertAssignmentMatches(current, checked.lease);
      const membershipState = String(current.membershipState || '');

      if (membershipState === 'ready' && membershipUpdatedAtMs(current) >= requestStartedAt) {
        return readyResult(finalizeReadyLease({
          directTransport,
          pool: checked.pool,
          lease: checked.lease,
        }));
      }

      if (membershipState === 'pending') {
        throw codedError(
          'Initial Direct membership provisioning is pending; explicit repair applies only to previously-ready membership.',
          'TRANSPORT_MEMBERSHIP_REPAIR_NOT_READY',
        );
      }
      if (!['ready', 'repair'].includes(membershipState)) {
        throw codedError(
          `Unsupported Direct membership state ${current.membershipState}.`,
          'TRANSPORT_MEMBERSHIP_STATE_INVALID',
        );
      }

      if (membershipState === 'ready') {
        await persistentAssignments.markMembershipRepairNeeded(chatId, assignedBotId);
      }

      // Success is the only transition back to READY. FLOOD_WAIT, transient
      // Telegram/network errors and missing-vault errors escape once and leave
      // PostgreSQL in REPAIR. There is no internal retry loop or reassignment.
      return provisionCurrentLease({ args, checked, assignedBotId });
    });
  };

  directTransport.activateSession = wrappedActivateSession;
  directTransport.repairMembership = repairMembership;
  const installed = Object.freeze({ originalActivateSession, wrappedActivateSession, repairMembership });
  Object.defineProperty(directTransport, INSTALL_MARK, {
    configurable: true,
    enumerable: false,
    value: installed,
  });
  return installed;
}

module.exports = {
  installPersistentDirectMembershipActivation,
  checkedLease,
  assertAssignmentMatches,
  finalizeReadyLease,
  membershipUpdatedAtMs,
};
