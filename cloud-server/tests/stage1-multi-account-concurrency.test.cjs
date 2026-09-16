'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-stage1-multi-account-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
const registryFile = path.join(tmp, 'vault-registry.json');
const mastersFile = path.join(tmp, 'masters-does-not-exist.json');

const bots = Array.from({ length: 3 }, (_, index) => ({
  id: `Bot0${index + 1}`,
  label: `Transport 0${index + 1}`,
  token: `fake-direct-token-${index + 1}`,
  telegram_user_id: String(100000000 + index),
  telegram_username: `BeatGalerTransport0${index + 1}Bot`,
}));

fs.writeFileSync(poolFile, JSON.stringify({ bots }, null, 2));
fs.writeFileSync(registryFile, JSON.stringify({ version: 1, vaults: {} }, null, 2));

process.env.TRANSPORT_BOTS_FILE = poolFile;
process.env.TRANSPORT_POOL_STATE = stateFile;
process.env.VAULT_REGISTRY_FILE = registryFile;
process.env.MASTERS_FILE = mastersFile;
process.env.DIRECT_DIAGNOSTICS_DIR = path.join(tmp, 'diag');
process.env.BEATGALER_DIRECT_TRANSPORT = 'true';
process.env.DIRECT_TOKEN_ROTATION_ENABLED = 'false';
process.env.DIRECT_HEARTBEAT_INTERVAL_MS = '600000';
process.env.DIRECT_HEARTBEAT_TIMEOUT_MS = '60000';
process.env.TELEGRAM_API_ID = '12345';
process.env.TELEGRAM_API_HASH = 'fake-api-hash';
delete process.env.BEATGALER_MASTER_SESSION;
delete process.env.MASTER_SESSION;
delete process.env.MASTER_SESSION_FILE;

let telegramClientConstructions = 0;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') {
    return {
      TelegramClient: class {
        constructor() {
          telegramClientConstructions += 1;
          throw new Error('MASTER MUST NOT OPEN DURING STAGE1 CONCURRENCY TEST');
        }
      },
      Api: {},
    };
  }
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, parent, isMain);
};

function botForAccount(index) {
  return bots[index % bots.length].id;
}

function prepareAccount(direct, prepareAssignedLease, index, installationSuffix = '') {
  const botId = botForAccount(index);
  return prepareAssignedLease({
    directTransport: direct,
    status: direct.poolStatus(),
    transportBotId: botId,
    installationId: `stage1-install-${index}${installationSuffix}`,
    chatId: `stage1-vault-${index}`,
  }).lease;
}

function opArgs(lease, kind) {
  return {
    installationId: lease.installation_id,
    sessionId: lease.session_id,
    generation: lease.generation,
    credentialVersion: lease.credential_version,
    kind,
  };
}

(async () => {
  const direct = require('../direct-transport-control.js');
  const { prepareAssignedLease } = require('../direct-persistent-session-runtime');

  assert.equal(direct.enabled(), true);
  assert.deepEqual(direct.poolStatus().bots.map(bot => bot.id), ['Bot01', 'Bot02', 'Bot03']);

  const leases = [];

  // Three real-account equivalents: one active vault per configured bot.
  for (let index = 0; index < 3; index += 1) {
    leases.push(prepareAccount(direct, prepareAssignedLease, index));
  }
  let status = direct.poolStatus();
  assert.equal(status.sessions, 3, 'three accounts must coexist');
  assert.deepEqual(status.bots.map(bot => bot.active_vaults), [1, 1, 1]);
  assert.equal(status.operations, 0);
  assert.deepEqual(status.queue, []);

  // Grow to ten accounts. Persistent ownership permits bot sharing; there is
  // no retired one-vault-per-bot cap and no FIFO queue.
  for (let index = 3; index < 10; index += 1) {
    leases.push(prepareAccount(direct, prepareAssignedLease, index));
  }
  status = direct.poolStatus();
  assert.equal(status.sessions, 10, 'ten accounts must coexist on three transport bots');
  assert.deepEqual(status.bots.map(bot => bot.active_vaults), [4, 3, 3]);
  assert.deepEqual(status.queue, []);

  // Two INDEX operations on different vaults must run concurrently even when
  // both vaults share Bot01. Serialization is by chat_id, not by transport bot.
  const vaultA = leases[0];
  const vaultB = leases[3];
  assert.equal(vaultA.bot_id, 'Bot01');
  assert.equal(vaultB.bot_id, 'Bot01');
  const opA = await direct.beginOperation(opArgs(vaultA, 'replace_index'));
  const opB = await direct.beginOperation(opArgs(vaultB, 'get_index'));
  assert.equal(opA.ok, true, 'vault A operation should start');
  assert.equal(opB.ok, true, 'vault B must not be blocked by vault A on the same bot');
  status = direct.poolStatus();
  assert.equal(status.operations, 2);
  assert.equal(status.bots.find(bot => bot.id === 'Bot01').active_operations, 2);

  // A second device on the SAME vault must be serialized against the active
  // INDEX operation, proving the lock boundary is vault-scoped rather than global.
  const secondDevice = prepareAssignedLease({
    directTransport: direct,
    status: direct.poolStatus(),
    transportBotId: vaultA.bot_id,
    installationId: 'stage1-install-0-device-2',
    chatId: vaultA.chat_id,
  }).lease;
  const blockedSameVault = await direct.beginOperation(opArgs(secondDevice, 'get_index'));
  assert.equal(blockedSameVault.ok, false);
  assert.equal(blockedSameVault.wait, true);
  assert.equal(blockedSameVault.reason, 'index_busy');

  await direct.endOperation({
    installationId: vaultA.installation_id,
    sessionId: vaultA.session_id,
    generation: vaultA.generation,
    operationId: opA.operation_id,
  });
  const admittedSameVault = await direct.beginOperation(opArgs(secondDevice, 'get_index'));
  assert.equal(admittedSameVault.ok, true, 'same vault must proceed once its previous INDEX operation ends');

  await direct.endOperation({
    installationId: vaultB.installation_id,
    sessionId: vaultB.session_id,
    generation: vaultB.generation,
    operationId: opB.operation_id,
  });
  await direct.endOperation({
    installationId: secondDevice.installation_id,
    sessionId: secondDevice.session_id,
    generation: secondDevice.generation,
    operationId: admittedSameVault.operation_id,
  });
  await direct.stopSession({
    installationId: secondDevice.installation_id,
    sessionId: secondDevice.session_id,
    generation: secondDevice.generation,
  });

  status = direct.poolStatus();
  assert.equal(status.sessions, 10);
  assert.equal(status.operations, 0);

  // Pressure test: 80 simultaneous account sessions over only three bots. This
  // deliberately exceeds bot count and verifies deterministic sharing without
  // a queue or hard active-vault cap.
  for (let index = 10; index < 80; index += 1) {
    leases.push(prepareAccount(direct, prepareAssignedLease, index));
  }
  status = direct.poolStatus();
  assert.equal(status.sessions, 80, 'eighty accounts must coexist in local session state');
  assert.deepEqual(status.bots.map(bot => bot.active_vaults), [27, 27, 26]);
  assert.equal(status.operations, 0);
  assert.deepEqual(status.queue, []);

  // Simulate one browser disappearing. Only that expired session is reaped;
  // the other 79 accounts stay active and persistent membership is untouched.
  const expired = leases[1];
  direct.__test.mutateState(bots.map(bot => ({ id: bot.id })), state => {
    state.leases[expired.session_id].last_heartbeat_at = new Date(Date.now() - 120000).toISOString();
  });
  await direct.cleanupExpiredSessions();

  status = direct.poolStatus();
  assert.equal(status.sessions, 79, 'heartbeat cleanup must remove exactly the expired account');
  assert.deepEqual(status.bots.map(bot => bot.active_vaults), [27, 26, 26]);
  assert.equal(status.operations, 0);
  assert.equal(telegramClientConstructions, 0, 'session concurrency/cleanup must not open MASTER');

  console.log('PASS Stage 1 multi-account concurrency: 3/10/80 sessions, bot sharing, vault-scoped operations, cleanup isolation');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});
