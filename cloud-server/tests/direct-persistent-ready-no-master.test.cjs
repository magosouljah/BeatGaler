'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-direct-ready-no-master-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
const registryFile = path.join(tmp, 'vault-registry.json');
const mastersFile = path.join(tmp, 'masters-does-not-exist.json');

fs.writeFileSync(poolFile, JSON.stringify({
  bots: [{
    id: 'Bot01',
    token: 'fake-direct-token',
    telegram_user_id: '123456789',
    telegram_username: 'BeatGalerTransport01Bot',
  }],
}));
fs.writeFileSync(registryFile, JSON.stringify({
  version: 1,
  vaults: {},
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
process.env.TELEGRAM_API_ID = '12345';
process.env.TELEGRAM_API_HASH = 'fake-api-hash';
delete process.env.BEATGALER_MASTER_SESSION;
delete process.env.MASTER_SESSION;
delete process.env.MASTER_SESSION_FILE;
delete process.env.DIRECT_BOTAPI_RESOLVER_CHAT_ID;

let telegramClientConstructions = 0;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') {
    return {
      TelegramClient: class {
        constructor() {
          telegramClientConstructions += 1;
          throw new Error('MASTER MUST NOT OPEN ON READY STARTUP');
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
  const { installPersistentDirectSessionStart } = require('../direct-persistent-session-runtime');
  const { installPersistentDirectMembershipActivation } = require('../direct-persistent-membership-runtime');

  const assignment = {
    chatId: '-1007000000001',
    transportBotId: 'Bot01',
    membershipState: 'ready',
  };
  const persistentAssignments = {
    async resolveForVault({ pool, chatId }) {
      assert.equal(String(chatId), assignment.chatId);
      return { assignment: { ...assignment }, bot: pool.find(bot => bot.id === 'Bot01') };
    },
    async getAssignment(chatId) {
      assert.equal(String(chatId), assignment.chatId);
      return { ...assignment };
    },
    async withMembershipLock() {
      throw new Error('READY startup must not enter membership provisioning lock');
    },
    async markMembershipReady() {
      throw new Error('READY startup must not rewrite membership state');
    },
  };

  installPersistentDirectSessionStart({
    directTransport: direct,
    persistentAssignments,
  });
  installPersistentDirectMembershipActivation({
    directTransport: direct,
    persistentAssignments,
  });

  const session = await direct.startSession({
    installationId: 'ready-installation',
    chatId: assignment.chatId,
  });
  assert.equal(session.transport_id, 'Bot01');
  assert.equal(session.chat_id, assignment.chatId);
  assert.equal(session.resolver_chat_id, '-1009000000001');
  assert.equal(session.bot_token, 'fake-direct-token');
  assert.equal(telegramClientConstructions, 0, 'persisted resolver fast path must not construct MASTER TelegramClient');

  const activated = await direct.activateSession({
    installationId: 'ready-installation',
    sessionId: session.session_id,
    generation: session.generation,
  });
  assert.equal(activated.ok, true);
  assert.equal(activated.status, 'ACTIVE');
  assert.equal(telegramClientConstructions, 0, 'READY activation must stay MASTER-free');

  const state = direct.__test.stateSnapshot([{ id: 'Bot01' }]);
  assert.equal(state.leases[session.session_id].bot_id, 'Bot01');
  assert.equal(state.leases[session.session_id].status, 'ACTIVE');

  console.log('PASS Direct READY startup: persisted resolver + persistent assignment + activation succeed with MASTER unavailable');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});
