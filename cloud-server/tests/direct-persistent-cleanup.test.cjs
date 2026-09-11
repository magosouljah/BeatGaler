'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-direct-persistent-cleanup-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
const registryFile = path.join(tmp, 'vault-registry.json');
const mastersFile = path.join(tmp, 'masters-does-not-exist.json');
const bot = {
  id: 'Bot01',
  token: 'fake-direct-token',
  telegram_user_id: '123456789',
  telegram_username: 'BeatGalerTransport01Bot',
};

fs.writeFileSync(poolFile, JSON.stringify({ bots: [bot] }));
fs.writeFileSync(registryFile, JSON.stringify({
  version: 1,
  vaults: {
    '-1007000000001': { persistent_marker: 'must-survive-cleanup' },
    '-1007000000002': { persistent_marker: 'must-survive-expiry' },
  },
  resolver: {
    chat_id: '-1009000000001',
    created_at: new Date().toISOString(),
    master_id: 'Master01',
  },
}));

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
          throw new Error('MASTER MUST NOT OPEN DURING NORMAL CLEANUP');
        }
      },
      Api: {},
    };
  }
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const direct = require('../direct-transport-control.js');
  const { prepareAssignedLease } = require('../direct-persistent-session-runtime');
  const runtimePool = [{ id: 'Bot01' }];

  const first = prepareAssignedLease({
    directTransport: direct,
    status: direct.poolStatus(),
    transportBotId: bot.id,
    installationId: 'normal-close-installation',
    chatId: '-1007000000001',
  });
  const firstOp = await direct.beginOperation({
    installationId: first.lease.installation_id,
    sessionId: first.lease.session_id,
    generation: first.lease.generation,
    credentialVersion: first.lease.credential_version,
    kind: 'data',
  });
  assert.equal(firstOp.ok, true);

  const stopped = await direct.stopSession({
    installationId: first.lease.installation_id,
    sessionId: first.lease.session_id,
    generation: first.lease.generation,
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.released, true);
  assert.equal(stopped.membership_preserved, true);
  let state = direct.__test.stateSnapshot(runtimePool);
  assert.equal(state.leases[first.lease.session_id], undefined, 'normal close must delete the local lease');
  assert.equal(state.operations[firstOp.operation_id], undefined, 'normal close must delete lease-owned operations');
  assert.equal(telegramClientConstructions, 0, 'normal close must not construct MASTER TelegramClient');

  const second = prepareAssignedLease({
    directTransport: direct,
    status: direct.poolStatus(),
    transportBotId: bot.id,
    installationId: 'heartbeat-expired-installation',
    chatId: '-1007000000002',
  });
  const secondOp = await direct.beginOperation({
    installationId: second.lease.installation_id,
    sessionId: second.lease.session_id,
    generation: second.lease.generation,
    credentialVersion: second.lease.credential_version,
    kind: 'data',
  });
  assert.equal(secondOp.ok, true);
  direct.__test.mutateState(runtimePool, current => {
    current.leases[second.lease.session_id].last_heartbeat_at = new Date(Date.now() - 120000).toISOString();
  });

  await direct.cleanupExpiredSessions();
  state = direct.__test.stateSnapshot(runtimePool);
  assert.equal(state.leases[second.lease.session_id], undefined, 'heartbeat cleanup must delete the expired local lease');
  assert.equal(state.operations[secondOp.operation_id], undefined, 'heartbeat cleanup must delete expired lease operations');
  assert.equal(telegramClientConstructions, 0, 'heartbeat cleanup must not construct MASTER TelegramClient');

  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  assert.equal(registry.vaults['-1007000000001'].persistent_marker, 'must-survive-cleanup');
  assert.equal(registry.vaults['-1007000000002'].persistent_marker, 'must-survive-expiry');
  assert.equal(typeof direct.decommissionVaultMembership, 'function', 'membership removal must exist only as an explicit decommission operation');

  console.log('PASS Direct persistent cleanup: normal close and heartbeat expiry remove local session state without MASTER or membership removal');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});
