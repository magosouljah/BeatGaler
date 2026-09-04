'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

process.env.BEATGALER_MASTER_SESSION = 'test-master-session';
process.env.TELEGRAM_API_ID = '12345';
process.env.TELEGRAM_API_HASH = 'test-api-hash';

let dialogs = [];
let disconnectCount = 0;

class FakeTelegramClient {
  constructor() {}
  setLogLevel() {}
  async connect() {}
  async checkAuthorization() { return true; }
  async getDialogs() { return dialogs; }
  async disconnect() { disconnectCount += 1; }
}

class FakeStringSession {
  constructor(value) { this.value = value; }
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') return { TelegramClient: FakeTelegramClient, Api: {} };
  if (request === 'telegram/sessions') return { StringSession: FakeStringSession };
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    delete require.cache[require.resolve('../master-storage.js')];
    const storage = require('../master-storage.js');

    await assert.rejects(
      () => storage.verifyPrivateUserStorageGroup({ botApiChatId: '-100123' }),
      /private storage group could not be found by MASTER/i,
    );

    dialogs = [{ entity: { id: 123 } }];
    assert.equal(
      await storage.verifyPrivateUserStorageGroup({ botApiChatId: '-100123' }),
      true,
    );
    assert.equal(disconnectCount, 2, 'MASTER client must disconnect on both success and missing-vault paths');

    const coreSource = fs.readFileSync(path.join(__dirname, '..', 'server-core.js'), 'utf8');
    assert(coreSource.includes('verifyPrivateUserStorageGroup'));
    assert(coreSource.includes('await verifyPrivateUserStorageGroup({ botApiChatId: user.storageChatId })'));
    assert(coreSource.includes('vault no longer exists'));
    assert(coreSource.includes('return ensureUserStorage(user)'));

    console.log('PASS deleted vault is detected and wired to replacement provisioning');
  } finally {
    Module._load = originalLoad;
  }
})().catch(error => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
