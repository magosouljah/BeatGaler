'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assignmentsRuntime = require('../direct-persistent-assignment-runtime');
const { installPersistentDirectSessionStart } = require('../direct-persistent-session-runtime');
const { installPersistentDirectMembershipActivation } = require('../direct-persistent-membership-runtime');

function nowIso() { return new Date().toISOString(); }

function fakeDirectTransport() {
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
  const calls = { legacyAllocator: 0, membershipCleanup: 0, provisioning: [] };

  const direct = {
    poolStatus() {
      return {
        configured: true,
        heartbeat_timeout_ms: 5 * 60_000,
        bots: Object.entries(state.bots).map(([id, bot]) => ({
          id,
          quarantined: bot.quarantined,
          rotation_pending: bot.rotation_pending,
        })),
      };
    },
    __test: {
      mutateState(_pool, mutator) { return mutator(state); },
      stateSnapshot() { return state; },
    },
    async startSession({ installationId, chatId }) {
      let lease = Object.values(state.leases).find(item =>
        item.installation_id === String(installationId) && item.status !== 'CLEANED'
      ) || null;
      if (lease && (lease.chat_id !== String(chatId) || lease.status === 'STOPPING')) {
        calls.membershipCleanup += 1;
        delete state.leases[lease.session_id];
        lease = null;
      }
      if (!lease) {
        calls.legacyAllocator += 1;
        throw new Error('legacy FIFO allocator must be unreachable after persistent assignment wrapper');
      }
      return {
        ok: true,
        session_id: lease.session_id,
        transport_id: lease.bot_id,
        chat_id: lease.chat_id,
        generation: lease.generation,
      };
    },
    async activateSession({ installationId, sessionId, generation }) {
      const lease = state.leases[String(sessionId)] || null;
      assert.ok(lease, 'provisioning requires a prepared lease');
      assert.equal(lease.installation_id, String(installationId));
      assert.equal(Number(lease.generation), Number(generation));
      calls.provisioning.push({ chatId: lease.chat_id, botId: lease.bot_id });
      lease.status = 'ACTIVE';
      lease.last_heartbeat_at = nowIso();
      return { ok: true, activated: true, status: 'ACTIVE' };
    },
  };
  return { direct, state, calls };
}

async function main() {
  const rows = new Map([
    ['legacy-a', { chatId: 'legacy-a', transportBotId: null, membershipState: 'pending', membershipUpdatedAt: null }],
    ['legacy-b', { chatId: 'legacy-b', transportBotId: null, membershipState: 'pending', membershipUpdatedAt: null }],
    ['legacy-live-lease', { chatId: 'legacy-live-lease', transportBotId: null, membershipState: 'pending', membershipUpdatedAt: null }],
  ]);
  const calls = { assign: [], ready: [], repair: [], locks: [] };
  const store = {
    async syncTransportBots() { return { synced: 2 }; },
    async assignIfMissing({ chatId }) {
      const key = String(chatId);
      calls.assign.push(key);
      const row = rows.get(key);
      if (!row) return null;
      if (!row.transportBotId) {
        row.transportBotId = 'Bot02';
        row.membershipState = 'pending';
        row.membershipUpdatedAt = nowIso();
      }
      return { ...row };
    },
    async getAssignment({ chatId }) {
      const row = rows.get(String(chatId));
      return row ? { ...row } : null;
    },
    async withMembershipLock({ chatId }, callback) {
      calls.locks.push(String(chatId));
      return callback();
    },
    async markMembershipReady({ chatId }, expectedTransportBotId) {
      const row = rows.get(String(chatId));
      assert.equal(row.transportBotId, String(expectedTransportBotId));
      row.membershipState = 'ready';
      row.membershipUpdatedAt = nowIso();
      calls.ready.push(String(chatId));
      return { ...row };
    },
    async markMembershipRepairNeeded({ chatId }, expectedTransportBotId) {
      const row = rows.get(String(chatId));
      assert.equal(row.transportBotId, String(expectedTransportBotId));
      row.membershipState = 'repair';
      row.membershipUpdatedAt = nowIso();
      calls.repair.push(String(chatId));
      return { ...row };
    },
  };

  assignmentsRuntime.configure({ store });
  const { direct, state, calls: directCalls } = fakeDirectTransport();
  installPersistentDirectSessionStart({ directTransport: direct, persistentAssignments: assignmentsRuntime });
  installPersistentDirectMembershipActivation({ directTransport: direct, persistentAssignments: assignmentsRuntime });

  assert.equal(rows.get('legacy-a').transportBotId, null);
  assert.equal(rows.get('legacy-b').transportBotId, null);
  const first = await direct.startSession({ installationId: 'legacy-install-a', chatId: 'legacy-a' });
  assert.equal(first.transport_id, 'Bot02');
  assert.equal(rows.get('legacy-a').transportBotId, 'Bot02');
  assert.equal(rows.get('legacy-a').membershipState, 'pending');
  assert.equal(rows.get('legacy-b').transportBotId, null, 'unaccessed legacy vault must remain unassigned');
  assert.deepEqual(calls.assign, ['legacy-a']);
  assert.equal(directCalls.legacyAllocator, 0);

  await direct.activateSession({
    installationId: 'legacy-install-a',
    sessionId: first.session_id,
    generation: first.generation,
  });
  assert.equal(rows.get('legacy-a').membershipState, 'ready');
  assert.deepEqual(directCalls.provisioning, [{ chatId: 'legacy-a', botId: 'Bot02' }]);
  assert.deepEqual(calls.ready, ['legacy-a']);

  const repeated = await direct.startSession({ installationId: 'legacy-install-a', chatId: 'legacy-a' });
  assert.equal(repeated.transport_id, 'Bot02');
  await direct.activateSession({
    installationId: 'legacy-install-a',
    sessionId: repeated.session_id,
    generation: repeated.generation,
  });
  assert.equal(directCalls.provisioning.length, 1);
  assert.equal(rows.get('legacy-b').transportBotId, null);

  state.leases.old_live = {
    session_id: 'old_live',
    bot_id: 'Bot01',
    installation_id: 'legacy-live-install',
    chat_id: 'legacy-live-lease',
    generation: 9,
    credential_version: 1,
    status: 'ACTIVE',
    started_at: nowIso(),
    last_heartbeat_at: nowIso(),
  };
  state.operations.old_live_op = {
    operation_id: 'old_live_op',
    session_id: 'old_live',
    bot_id: 'Bot01',
  };
  const migrated = await direct.startSession({
    installationId: 'legacy-live-install',
    chatId: 'legacy-live-lease',
  });
  assert.equal(migrated.transport_id, 'Bot02');
  assert.equal(rows.get('legacy-live-lease').transportBotId, 'Bot02');
  assert.equal(rows.get('legacy-live-lease').membershipState, 'pending');
  assert.equal(state.leases.old_live, undefined);
  assert.equal(state.operations.old_live_op, undefined);
  assert.equal(directCalls.membershipCleanup, 0);
  assert.equal(directCalls.legacyAllocator, 0);
  await direct.activateSession({
    installationId: 'legacy-live-install',
    sessionId: migrated.session_id,
    generation: migrated.generation,
  });
  assert.equal(rows.get('legacy-live-lease').membershipState, 'ready');
  assert.equal(directCalls.provisioning.filter(call => call.chatId === 'legacy-live-lease').length, 1);

  const repoRoot = path.resolve(__dirname, '..', '..');
  const migration = fs.readFileSync(path.join(repoRoot, 'cloud-server', 'migrations', '0010_persistent_transport_assignment.sql'), 'utf8');
  const transportBotColumnLine = migration.split(/\r?\n/).find(line => line.includes('ADD COLUMN transport_bot_id')) || '';
  assert.match(transportBotColumnLine, /ADD COLUMN transport_bot_id text REFERENCES transport_bots\(id\)/);
  assert.doesNotMatch(transportBotColumnLine, /DEFAULT/i, 'transport_bot_id must stay nullable for lazy legacy rollout');
  assert.doesNotMatch(migration, /UPDATE\s+vaults\s+SET\s+transport_bot_id/i);

  assignmentsRuntime._resetForTests();
  console.log('PASS Direct legacy lazy rollout: NULL assigns on first access only, provisions once, PG wins over live legacy lease, no mass migration');
}

main().catch(error => {
  assignmentsRuntime._resetForTests();
  console.error(error?.stack || error);
  process.exitCode = 1;
});
