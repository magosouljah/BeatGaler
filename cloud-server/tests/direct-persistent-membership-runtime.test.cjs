'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  installPersistentDirectMembershipActivation,
} = require('../direct-persistent-membership-runtime');

function isoNow() {
  return new Date().toISOString();
}

function oldIso() {
  return new Date(Date.now() - 60_000).toISOString();
}

function makeLease({ sessionId, installationId, chatId, botId = 'Bot02', generation = 1 }) {
  return {
    session_id: sessionId,
    bot_id: botId,
    installation_id: installationId,
    chat_id: chatId,
    generation,
    credential_version: 1,
    status: 'ASSIGNING',
    started_at: isoNow(),
    last_heartbeat_at: isoNow(),
  };
}

function readyAssignment(chatId, botId = 'Bot02') {
  return {
    chatId,
    transportBotId: botId,
    membershipState: 'ready',
    membershipUpdatedAt: oldIso(),
  };
}

function fakeEnvironment() {
  const state = {
    bots: {
      Bot01: { generation: 0, credential_version: 1, quarantined: false, rotation_pending: false },
      Bot02: { generation: 0, credential_version: 1, quarantined: false, rotation_pending: false },
    },
    leases: {},
    operations: {},
    metrics: {
      Bot01: { sessions_today: 0, total_sessions: 0, last_used_at: null },
      Bot02: { sessions_today: 0, total_sessions: 0, last_used_at: null },
    },
  };
  const assignments = new Map();
  const calls = { telegramProvision: [], locks: [], ready: [], repair: [] };
  const lockTails = new Map();

  const direct = {
    poolStatus() {
      return {
        configured: true,
        heartbeat_timeout_ms: 5 * 60_000,
        bots: [{ id: 'Bot01' }, { id: 'Bot02' }],
      };
    },
    __test: {
      stateSnapshot() {
        return state;
      },
      mutateState(_pool, mutator) {
        return mutator(state);
      },
    },
    async activateSession({ installationId, sessionId, generation }) {
      const lease = state.leases[String(sessionId)] || null;
      assert.ok(lease, 'fake provisioning requires the lease');
      assert.equal(lease.installation_id, String(installationId));
      assert.equal(Number(lease.generation), Number(generation));
      calls.telegramProvision.push(lease.chat_id);

      if (lease.chat_id === 'vault-flood' || lease.chat_id === 'vault-repair-flood') {
        const error = new Error('A wait of 30 seconds is required (caused by channels.InviteToChannel)');
        error.code = 'FLOOD_WAIT_30';
        throw error;
      }
      if (lease.chat_id === 'vault-repair-transient') {
        const error = new Error('socket reset during InviteToChannel');
        error.code = 'ECONNRESET';
        throw error;
      }
      if (lease.chat_id === 'vault-repair-missing') {
        throw new Error('MASTER cannot find private vault vault-repair-missing.');
      }
      if (lease.chat_id === 'vault-repair-concurrent') {
        await new Promise(resolve => setTimeout(resolve, 15));
      }

      lease.status = 'ACTIVE';
      lease.last_heartbeat_at = isoNow();
      return { ok: true, activated: true, status: 'ACTIVE' };
    },
  };

  const persistentAssignments = {
    async getAssignment(chatId) {
      const current = assignments.get(String(chatId));
      return current ? { ...current } : null;
    },
    async withMembershipLock(chatId, callback) {
      const key = String(chatId);
      calls.locks.push(key);
      const previous = lockTails.get(key) || Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      lockTails.set(key, previous.then(() => current));
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    },
    async markMembershipReady(chatId, expectedTransportBotId) {
      const key = String(chatId);
      const current = assignments.get(key);
      assert.ok(current, 'assignment must exist before ready');
      assert.equal(current.transportBotId, String(expectedTransportBotId));
      const updated = { ...current, membershipState: 'ready', membershipUpdatedAt: isoNow() };
      assignments.set(key, updated);
      calls.ready.push([key, String(expectedTransportBotId)]);
      return { ...updated };
    },
    async markMembershipRepairNeeded(chatId, expectedTransportBotId) {
      const key = String(chatId);
      const current = assignments.get(key);
      assert.ok(current, 'assignment must exist before repair');
      assert.equal(current.transportBotId, String(expectedTransportBotId));
      const updated = { ...current, membershipState: 'repair', membershipUpdatedAt: isoNow() };
      assignments.set(key, updated);
      calls.repair.push([key, String(expectedTransportBotId)]);
      return { ...updated };
    },
  };

  installPersistentDirectMembershipActivation({
    directTransport: direct,
    persistentAssignments,
  });

  return { direct, state, assignments, calls };
}

function addReadyLease({ state, assignments, chatId, sessionId, installationId, generation }) {
  assignments.set(chatId, readyAssignment(chatId));
  state.leases[sessionId] = makeLease({ sessionId, installationId, chatId, generation });
}

async function main() {
  const { direct, state, assignments, calls } = fakeEnvironment();

  // READY is the normal path: local lease -> ACTIVE with zero Telegram/MASTER
  // provisioning calls.
  assignments.set('vault-ready', readyAssignment('vault-ready'));
  state.leases.ready_session = makeLease({
    sessionId: 'ready_session',
    installationId: 'ready-install',
    chatId: 'vault-ready',
  });
  const ready = await direct.activateSession({
    installationId: 'ready-install',
    sessionId: 'ready_session',
    generation: 1,
  });
  assert.equal(ready.status, 'ACTIVE');
  assert.equal(state.leases.ready_session.status, 'ACTIVE');
  assert.deepEqual(calls.telegramProvision, []);

  // Two concurrent devices on the same PENDING vault serialize on one vault
  // lock. Exactly one reaches the Telegram provisioning primitive; the second
  // rereads READY and performs only its local lease transition.
  assignments.set('vault-pending', {
    chatId: 'vault-pending',
    transportBotId: 'Bot02',
    membershipState: 'pending',
    membershipUpdatedAt: oldIso(),
  });
  state.leases.pending_a = makeLease({
    sessionId: 'pending_a',
    installationId: 'pending-install-a',
    chatId: 'vault-pending',
    generation: 2,
  });
  state.leases.pending_b = makeLease({
    sessionId: 'pending_b',
    installationId: 'pending-install-b',
    chatId: 'vault-pending',
    generation: 3,
  });
  await Promise.all([
    direct.activateSession({ installationId: 'pending-install-a', sessionId: 'pending_a', generation: 2 }),
    direct.activateSession({ installationId: 'pending-install-b', sessionId: 'pending_b', generation: 3 }),
  ]);
  assert.equal(calls.telegramProvision.filter(chat => chat === 'vault-pending').length, 1);
  assert.equal(calls.ready.filter(([chat]) => chat === 'vault-pending').length, 1);
  assert.equal(assignments.get('vault-pending').membershipState, 'ready');
  assert.equal(state.leases.pending_a.status, 'ACTIVE');
  assert.equal(state.leases.pending_b.status, 'ACTIVE');

  // Persisted REPAIR uses the exact same persistent bot and returns to READY
  // after successful provisioning.
  assignments.set('vault-repair', {
    chatId: 'vault-repair',
    transportBotId: 'Bot02',
    membershipState: 'repair',
    membershipUpdatedAt: oldIso(),
  });
  state.leases.repair_session = makeLease({
    sessionId: 'repair_session',
    installationId: 'repair-install',
    chatId: 'vault-repair',
    generation: 4,
  });
  await direct.activateSession({
    installationId: 'repair-install',
    sessionId: 'repair_session',
    generation: 4,
  });
  assert.equal(assignments.get('vault-repair').transportBotId, 'Bot02');
  assert.equal(assignments.get('vault-repair').membershipState, 'ready');
  assert.equal(calls.telegramProvision.filter(chat => chat === 'vault-repair').length, 1);

  // Existing PENDING FLOOD_WAIT behavior remains fail-closed and same-bot.
  assignments.set('vault-flood', {
    chatId: 'vault-flood',
    transportBotId: 'Bot02',
    membershipState: 'pending',
    membershipUpdatedAt: oldIso(),
  });
  state.leases.flood_session = makeLease({
    sessionId: 'flood_session',
    installationId: 'flood-install',
    chatId: 'vault-flood',
    generation: 5,
  });
  await assert.rejects(
    () => direct.activateSession({ installationId: 'flood-install', sessionId: 'flood_session', generation: 5 }),
    error => error?.code === 'FLOOD_WAIT_30',
  );
  assert.equal(assignments.get('vault-flood').transportBotId, 'Bot02');
  assert.equal(assignments.get('vault-flood').membershipState, 'pending');

  // Task 6: a bot that was removed from the vault while PostgreSQL still says
  // READY is repaired explicitly. The transition is READY -> REPAIR -> READY,
  // and ownership remains Bot02 throughout.
  addReadyLease({
    state, assignments,
    chatId: 'vault-deleted-bot',
    sessionId: 'deleted_bot_session',
    installationId: 'deleted-bot-install',
    generation: 10,
  });
  const deletedBotRepair = await direct.repairMembership({
    installationId: 'deleted-bot-install',
    sessionId: 'deleted_bot_session',
    generation: 10,
  });
  assert.equal(deletedBotRepair.status, 'ACTIVE');
  assert.equal(assignments.get('vault-deleted-bot').transportBotId, 'Bot02');
  assert.equal(assignments.get('vault-deleted-bot').membershipState, 'ready');
  assert.equal(calls.repair.filter(([chat]) => chat === 'vault-deleted-bot').length, 1);
  assert.equal(calls.telegramProvision.filter(chat => chat === 'vault-deleted-bot').length, 1);

  // Concurrent explicit repairs coalesce across the same membership lock. The
  // second request began before the first completed, sees the fresh READY
  // timestamp, and must not run a second Invite/EditAdmin/GetParticipant cycle.
  addReadyLease({
    state, assignments,
    chatId: 'vault-repair-concurrent',
    sessionId: 'repair_concurrent_a',
    installationId: 'repair-concurrent-a',
    generation: 11,
  });
  state.leases.repair_concurrent_b = makeLease({
    sessionId: 'repair_concurrent_b',
    installationId: 'repair-concurrent-b',
    chatId: 'vault-repair-concurrent',
    generation: 12,
  });
  await Promise.all([
    direct.repairMembership({ installationId: 'repair-concurrent-a', sessionId: 'repair_concurrent_a', generation: 11 }),
    direct.repairMembership({ installationId: 'repair-concurrent-b', sessionId: 'repair_concurrent_b', generation: 12 }),
  ]);
  assert.equal(calls.telegramProvision.filter(chat => chat === 'vault-repair-concurrent').length, 1);
  assert.equal(calls.repair.filter(([chat]) => chat === 'vault-repair-concurrent').length, 1);
  assert.equal(calls.ready.filter(([chat]) => chat === 'vault-repair-concurrent').length, 1);
  assert.equal(assignments.get('vault-repair-concurrent').transportBotId, 'Bot02');
  assert.equal(assignments.get('vault-repair-concurrent').membershipState, 'ready');

  // FLOOD_WAIT on explicit repair escapes once, leaves REPAIR durable and
  // never changes Bot02 or falsely writes READY.
  addReadyLease({
    state, assignments,
    chatId: 'vault-repair-flood',
    sessionId: 'repair_flood_session',
    installationId: 'repair-flood-install',
    generation: 13,
  });
  await assert.rejects(
    () => direct.repairMembership({ installationId: 'repair-flood-install', sessionId: 'repair_flood_session', generation: 13 }),
    error => error?.code === 'FLOOD_WAIT_30',
  );
  assert.equal(assignments.get('vault-repair-flood').transportBotId, 'Bot02');
  assert.equal(assignments.get('vault-repair-flood').membershipState, 'repair');
  assert.equal(calls.telegramProvision.filter(chat => chat === 'vault-repair-flood').length, 1);
  assert.equal(calls.ready.some(([chat]) => chat === 'vault-repair-flood'), false);

  // Transient network errors behave identically: one attempt, durable REPAIR,
  // no reassignment and no internal retry loop.
  addReadyLease({
    state, assignments,
    chatId: 'vault-repair-transient',
    sessionId: 'repair_transient_session',
    installationId: 'repair-transient-install',
    generation: 14,
  });
  await assert.rejects(
    () => direct.repairMembership({ installationId: 'repair-transient-install', sessionId: 'repair_transient_session', generation: 14 }),
    error => error?.code === 'ECONNRESET',
  );
  assert.equal(assignments.get('vault-repair-transient').transportBotId, 'Bot02');
  assert.equal(assignments.get('vault-repair-transient').membershipState, 'repair');
  assert.equal(calls.telegramProvision.filter(chat => chat === 'vault-repair-transient').length, 1);

  // A missing/deleted vault is not recreated or reassigned by membership
  // repair. The explicit attempt fails once and remains REPAIR for operator /
  // vault-lifecycle handling.
  addReadyLease({
    state, assignments,
    chatId: 'vault-repair-missing',
    sessionId: 'repair_missing_session',
    installationId: 'repair-missing-install',
    generation: 15,
  });
  await assert.rejects(
    () => direct.repairMembership({ installationId: 'repair-missing-install', sessionId: 'repair_missing_session', generation: 15 }),
    /MASTER cannot find private vault/,
  );
  assert.equal(assignments.get('vault-repair-missing').transportBotId, 'Bot02');
  assert.equal(assignments.get('vault-repair-missing').membershipState, 'repair');
  assert.equal(calls.telegramProvision.filter(chat => chat === 'vault-repair-missing').length, 1);

  // Explicit repair is not a substitute for first-time provisioning.
  assignments.set('vault-explicit-pending', {
    chatId: 'vault-explicit-pending',
    transportBotId: 'Bot02',
    membershipState: 'pending',
    membershipUpdatedAt: oldIso(),
  });
  state.leases.explicit_pending_session = makeLease({
    sessionId: 'explicit_pending_session',
    installationId: 'explicit-pending-install',
    chatId: 'vault-explicit-pending',
    generation: 16,
  });
  await assert.rejects(
    () => direct.repairMembership({ installationId: 'explicit-pending-install', sessionId: 'explicit_pending_session', generation: 16 }),
    error => error?.code === 'TRANSPORT_MEMBERSHIP_REPAIR_NOT_READY',
  );
  assert.equal(calls.telegramProvision.some(chat => chat === 'vault-explicit-pending'), false);

  // A legacy/malformed lease can never make activation or repair mutate a
  // different bot than PostgreSQL owns.
  assignments.set('vault-mismatch', {
    chatId: 'vault-mismatch',
    transportBotId: 'Bot02',
    membershipState: 'ready',
    membershipUpdatedAt: oldIso(),
  });
  state.leases.mismatch_session = makeLease({
    sessionId: 'mismatch_session',
    installationId: 'mismatch-install',
    chatId: 'vault-mismatch',
    botId: 'Bot01',
    generation: 17,
  });
  const beforeMismatchProvisionCount = calls.telegramProvision.length;
  await assert.rejects(
    () => direct.repairMembership({ installationId: 'mismatch-install', sessionId: 'mismatch_session', generation: 17 }),
    error => error?.code === 'TRANSPORT_ASSIGNMENT_MISMATCH',
  );
  assert.equal(calls.telegramProvision.length, beforeMismatchProvisionCount);

  // USER_ALREADY_PARTICIPANT remains explicitly tolerated by the retained
  // Telegram provisioning primitive: InviteToChannel may report it, after
  // which EditAdmin + participant verification continue on the same bot.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const controlSource = fs.readFileSync(path.join(repoRoot, 'cloud-server', 'direct-transport-control.js'), 'utf8');
  const inviteStart = controlSource.indexOf('async function inviteAndPromote');
  const inviteEnd = controlSource.indexOf('async function cleanupLegacyVisibleHandshakes', inviteStart);
  const inviteSource = controlSource.slice(inviteStart, inviteEnd);
  assert.match(inviteSource, /USER_ALREADY_PARTICIPANT/);
  assert.match(inviteSource, /InviteToChannel/);
  assert.match(inviteSource, /EditAdmin/);

  // Source guard: the READY/repair decision layer itself has no Telegram/MASTER
  // mutation primitive. Those remain behind the exceptional original activate.
  const source = fs.readFileSync(path.join(repoRoot, 'cloud-server', 'direct-persistent-membership-runtime.js'), 'utf8');
  assert.doesNotMatch(source, /masterForVault\s*\(/);
  assert.doesNotMatch(source, /InviteToChannel\s*\(/);
  assert.doesNotMatch(source, /EditAdmin\s*\(/);
  assert.doesNotMatch(source, /GetParticipant\s*\(/);

  console.log('PASS Direct persistent membership: READY warm path, explicit same-bot repair, concurrent coalescing, FLOOD_WAIT/transient/missing-vault fail-closed');
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
