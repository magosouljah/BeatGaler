'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  installPersistentDirectSessionStart,
} = require('../direct-persistent-session-runtime');

function fakeDirectTransport() {
  const state = {
    bots: {
      Bot01: { generation: 0, credential_version: 1, quarantined: false, rotation_pending: false },
      Bot02: { generation: 0, credential_version: 1, quarantined: false, rotation_pending: false },
    },
    leases: {},
    operations: {},
  };
  const calls = { legacyAllocator: 0, membershipCleanup: 0, start: 0 };

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
      mutateState(_pool, mutator) {
        return mutator(state);
      },
    },
    async startSession({ installationId, chatId }) {
      calls.start += 1;
      let lease = Object.values(state.leases).find(item =>
        item.installation_id === String(installationId) && item.status !== 'CLEANED'
      ) || null;
      if (lease && (lease.chat_id !== String(chatId) || lease.status === 'STOPPING')) {
        calls.membershipCleanup += 1;
        delete state.leases[lease.session_id];
        lease = null;
      }
      if (!lease) {
        // This models the legacy FIFO/load fallback. The wrapper must make this
        // branch unreachable by precreating the PostgreSQL-selected lease.
        calls.legacyAllocator += 1;
        const botId = 'Bot01';
        lease = {
          session_id: `legacy-${calls.legacyAllocator}`,
          bot_id: botId,
          installation_id: String(installationId),
          chat_id: String(chatId),
          generation: 1,
          credential_version: 1,
          status: 'ASSIGNING',
          started_at: new Date().toISOString(),
          last_heartbeat_at: new Date().toISOString(),
        };
        state.leases[lease.session_id] = lease;
      }
      return {
        ok: true,
        session_id: lease.session_id,
        transport_id: lease.bot_id,
        chat_id: lease.chat_id,
      };
    },
  };

  return { direct, state, calls };
}

async function main() {
  const { direct, state, calls } = fakeDirectTransport();
  const assignments = new Map([
    ['vault-a', 'Bot02'],
    ['vault-b', 'Bot01'],
  ]);
  const resolverCalls = [];
  const persistentAssignments = {
    async resolveForVault({ pool, state: publicState, chatId }) {
      resolverCalls.push({ pool, state: publicState, chatId });
      const botId = assignments.get(chatId);
      return {
        assignment: { chatId, transportBotId: botId, membershipState: 'ready' },
        bot: pool.find(bot => bot.id === botId),
      };
    },
  };

  installPersistentDirectSessionStart({ directTransport: direct, persistentAssignments });

  // Bot01 is first in the legacy pool, but PostgreSQL says Bot02. The session
  // must use Bot02 and the legacy allocator must never run.
  const first = await direct.startSession({ installationId: 'install-a', chatId: 'vault-a' });
  assert.equal(first.transport_id, 'Bot02');
  assert.equal(calls.legacyAllocator, 0);

  const repeated = await direct.startSession({ installationId: 'install-a', chatId: 'vault-a' });
  assert.equal(repeated.transport_id, 'Bot02');
  assert.equal(repeated.session_id, first.session_id);
  assert.equal(calls.legacyAllocator, 0);

  // Two installations for one vault may have independent leases, but both are
  // pinned to the same persistent bot.
  const secondDevice = await direct.startSession({ installationId: 'install-b', chatId: 'vault-a' });
  assert.equal(secondDevice.transport_id, 'Bot02');
  assert.notEqual(secondDevice.session_id, first.session_id);
  assert.equal(calls.legacyAllocator, 0);

  // A legacy mismatched lease is retired locally. No membership cleanup path is
  // allowed to run, and PostgreSQL ownership wins.
  state.leases.legacy_mismatch = {
    session_id: 'legacy_mismatch',
    bot_id: 'Bot01',
    installation_id: 'install-c',
    chat_id: 'vault-a',
    generation: 7,
    credential_version: 1,
    status: 'ACTIVE',
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  };
  state.operations.legacy_op = {
    operation_id: 'legacy_op',
    session_id: 'legacy_mismatch',
    bot_id: 'Bot01',
  };
  const migrated = await direct.startSession({ installationId: 'install-c', chatId: 'vault-a' });
  assert.equal(migrated.transport_id, 'Bot02');
  assert.equal(state.leases.legacy_mismatch, undefined);
  assert.equal(state.operations.legacy_op, undefined);
  assert.equal(calls.membershipCleanup, 0);
  assert.equal(calls.legacyAllocator, 0);

  // Quarantine never means Bot02 -> Bot01 fallback. The same assigned bot is
  // surfaced as unavailable and no lease is created for another bot.
  state.bots.Bot02.quarantined = true;
  await assert.rejects(
    () => direct.startSession({ installationId: 'install-d', chatId: 'vault-a' }),
    error => error?.code === 'TRANSPORT_ASSIGNMENT_BOT_QUARANTINED' && error?.transportBotId === 'Bot02',
  );
  assert.equal(
    Object.values(state.leases).some(lease => lease.installation_id === 'install-d'),
    false,
  );
  assert.equal(calls.legacyAllocator, 0);
  state.bots.Bot02.quarantined = false;

  // Rotation is also same-bot admission failure, never reassignment.
  state.bots.Bot02.rotation_pending = true;
  await assert.rejects(
    () => direct.startSession({ installationId: 'install-e', chatId: 'vault-a' }),
    error => error?.code === 'TRANSPORT_ASSIGNMENT_BOT_ROTATING' && error?.transportBotId === 'Bot02',
  );
  assert.equal(calls.legacyAllocator, 0);

  assert.ok(resolverCalls.length >= 6);
  assert.deepEqual(resolverCalls[0].pool, [{ id: 'Bot01' }, { id: 'Bot02' }]);
  assert.equal(JSON.stringify(resolverCalls[0]).includes('token'), false);

  // Source-level guard for the transitional wrapper architecture: normal
  // server startup must install the wrapper around the cached Direct module.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const serverSource = fs.readFileSync(path.join(repoRoot, 'cloud-server', 'server.js'), 'utf8');
  const wrapperSource = fs.readFileSync(path.join(repoRoot, 'cloud-server', 'direct-persistent-session-runtime.js'), 'utf8');
  assert.match(serverSource, /installPersistentDirectSessionStart/);
  assert.match(serverSource, /direct-persistent-session-runtime/);
  assert.doesNotMatch(wrapperSource, /leaseNextBot\s*\(/);
  assert.doesNotMatch(wrapperSource, /waitForAssignableTransport\s*\(/);

  console.log('PASS Direct persistent session start: exact assigned bot, same-bot multi-device leases, no FIFO ownership, no mismatch membership cleanup');
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
