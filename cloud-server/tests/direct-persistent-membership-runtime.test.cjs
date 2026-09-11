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
  const calls = { telegramProvision: [], locks: [], ready: [] };
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

      if (lease.chat_id === 'vault-flood') {
        const error = new Error('A wait of 30 seconds is required (caused by channels.InviteToChannel)');
        error.code = 'FLOOD_WAIT_30';
        throw error;
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
      const updated = { ...current, membershipState: 'ready' };
      assignments.set(key, updated);
      calls.ready.push([key, String(expectedTransportBotId)]);
      return { ...updated };
    },
  };

  installPersistentDirectMembershipActivation({
    directTransport: direct,
    persistentAssignments,
  });

  return { direct, state, assignments, calls };
}

async function main() {
  const { direct, state, assignments, calls } = fakeEnvironment();

  // READY is the normal path: local lease -> ACTIVE with zero Telegram/MASTER
  // provisioning calls.
  assignments.set('vault-ready', {
    chatId: 'vault-ready',
    transportBotId: 'Bot02',
    membershipState: 'ready',
  });
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
  // lock. Exactly one reaches the legacy Telegram provisioning primitive; the
  // second rereads READY and performs only its local lease transition.
  assignments.set('vault-pending', {
    chatId: 'vault-pending',
    transportBotId: 'Bot02',
    membershipState: 'pending',
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

  // REPAIR uses the exact same persistent bot and, after successful explicit
  // provisioning, returns to READY.
  assignments.set('vault-repair', {
    chatId: 'vault-repair',
    transportBotId: 'Bot02',
    membershipState: 'repair',
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

  // FLOOD_WAIT/network-style provisioning failure never rewrites ownership and
  // does not falsely mark membership ready. A later retry remains same-bot.
  assignments.set('vault-flood', {
    chatId: 'vault-flood',
    transportBotId: 'Bot02',
    membershipState: 'pending',
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
  assert.equal(calls.ready.some(([chat]) => chat === 'vault-flood'), false);

  // A legacy/malformed lease can never make activation mutate a different bot
  // than PostgreSQL owns.
  assignments.set('vault-mismatch', {
    chatId: 'vault-mismatch',
    transportBotId: 'Bot02',
    membershipState: 'pending',
  });
  state.leases.mismatch_session = makeLease({
    sessionId: 'mismatch_session',
    installationId: 'mismatch-install',
    chatId: 'vault-mismatch',
    botId: 'Bot01',
    generation: 6,
  });
  const beforeMismatchProvisionCount = calls.telegramProvision.length;
  await assert.rejects(
    () => direct.activateSession({ installationId: 'mismatch-install', sessionId: 'mismatch_session', generation: 6 }),
    error => error?.code === 'TRANSPORT_ASSIGNMENT_MISMATCH',
  );
  assert.equal(calls.telegramProvision.length, beforeMismatchProvisionCount);

  // Source guard: the new READY decision layer itself has no Telegram/MASTER
  // mutation primitive. Those remain behind the exceptional original activate.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const source = fs.readFileSync(path.join(repoRoot, 'cloud-server', 'direct-persistent-membership-runtime.js'), 'utf8');
  assert.doesNotMatch(source, /masterForVault\s*\(/);
  assert.doesNotMatch(source, /InviteToChannel\s*\(/);
  assert.doesNotMatch(source, /EditAdmin\s*\(/);
  assert.doesNotMatch(source, /GetParticipant\s*\(/);

  console.log('PASS Direct persistent membership activation: READY no provisioning, PENDING/REPAIR singleflight, same-bot FLOOD_WAIT, mismatch rejected');
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
