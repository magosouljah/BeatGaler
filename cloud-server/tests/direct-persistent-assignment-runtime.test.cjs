'use strict';

const assert = require('node:assert/strict');
const runtime = require('../direct-persistent-assignment-runtime');

async function main() {
  const calls = { sync: [], assign: [], get: [], locks: [], ready: [], repair: [] };
  const assignments = new Map([
    ['vault-a', { chatId: 'vault-a', transportBotId: 'Bot02', membershipState: 'ready' }],
    ['vault-b', { chatId: 'vault-b', transportBotId: 'Bot01', membershipState: 'pending' }],
    ['vault-missing-bot', { chatId: 'vault-missing-bot', transportBotId: 'Bot99', membershipState: 'ready' }],
  ]);
  const store = {
    async syncTransportBots(bots) {
      calls.sync.push(bots);
      return { synced: bots.length };
    },
    async assignIfMissing({ chatId }) {
      calls.assign.push(chatId);
      return assignments.get(chatId) || null;
    },
    async getAssignment({ chatId }) {
      calls.get.push(chatId);
      return assignments.get(chatId) || null;
    },
    async withMembershipLock({ chatId }, callback) {
      calls.locks.push(chatId);
      return callback();
    },
    async markMembershipReady({ chatId }, expectedTransportBotId) {
      calls.ready.push([chatId, expectedTransportBotId]);
      const current = assignments.get(chatId);
      const updated = { ...current, membershipState: 'ready' };
      assignments.set(chatId, updated);
      return updated;
    },
    async markMembershipRepairNeeded({ chatId }, expectedTransportBotId) {
      calls.repair.push([chatId, expectedTransportBotId]);
      const current = assignments.get(chatId);
      const updated = { ...current, membershipState: 'repair' };
      assignments.set(chatId, updated);
      return updated;
    },
  };

  const pool = [
    { id: 'Bot01', token: 'secret-one' },
    { id: 'Bot02', token: 'secret-two' },
  ];
  const state = {
    bots: {
      Bot01: { quarantined: false, rotation_pending: false },
      Bot02: { quarantined: true, rotation_pending: true },
    },
  };

  runtime.configure({ store });

  const first = await runtime.resolveForVault({ pool, state, chatId: 'vault-a' });
  const second = await runtime.resolveForVault({ pool, state, chatId: 'vault-a' });
  assert.equal(first.assignment.transportBotId, 'Bot02');
  assert.equal(second.assignment.transportBotId, 'Bot02');
  assert.equal(first.bot.id, 'Bot02');
  assert.deepEqual(calls.assign, ['vault-a', 'vault-a']);

  // Syncing the production pool into PostgreSQL must expose only identity and
  // operational state; permanent bot tokens must never cross this boundary.
  assert.deepEqual(calls.sync[0], [
    { id: 'Bot01', quarantined: false, rotationPending: false },
    { id: 'Bot02', quarantined: true, rotationPending: true },
  ]);
  assert.equal(JSON.stringify(calls.sync[0]).includes('secret-one'), false);
  assert.equal(JSON.stringify(calls.sync[0]).includes('secret-two'), false);

  // An existing persistent assignment remains authoritative even if the bot is
  // currently quarantined. The adapter returns the same bot; session admission
  // decides whether it can run now, never by choosing a replacement here.
  assert.equal(first.bot.id, 'Bot02');

  await assert.rejects(
    () => runtime.resolveForVault({ pool, state, chatId: 'vault-missing-bot' }),
    error => error?.code === 'TRANSPORT_ASSIGNMENT_BOT_UNAVAILABLE',
  );

  assert.equal((await runtime.getAssignment('vault-b')).membershipState, 'pending');
  const locked = await runtime.withMembershipLock('vault-b', async () => 'locked-result');
  assert.equal(locked, 'locked-result');
  await runtime.markMembershipReady('vault-b', 'Bot01');
  assert.equal((await runtime.getAssignment('vault-b')).membershipState, 'ready');
  await runtime.markMembershipRepairNeeded('vault-b', 'Bot01');
  assert.equal((await runtime.getAssignment('vault-b')).membershipState, 'repair');
  assert.deepEqual(calls.locks, ['vault-b']);
  assert.deepEqual(calls.ready, [['vault-b', 'Bot01']]);
  assert.deepEqual(calls.repair, [['vault-b', 'Bot01']]);

  runtime._resetForTests();
  await assert.rejects(
    () => runtime.resolveForVault({ pool, state, chatId: 'vault-a' }),
    error => error?.code === 'TRANSPORT_ASSIGNMENT_POSTGRES_REQUIRED',
  );

  console.log('PASS Direct persistent assignment runtime adapter: same vault, membership state/lock operations, public pool sync, no secret persistence, no implicit reassignment');
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
