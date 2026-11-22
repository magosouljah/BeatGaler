'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const test = require('node:test');
const { createUserStorageLifecycle, isDefinitiveMissingStorageError } = require('../user-storage-lifecycle');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

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

test('MASTER recovery verifies dialogs and disconnects with a fake Telegram client', async () => {
  process.env.BEATGALER_MASTER_SESSION = 'test-master-session';
  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'test-api-hash';
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'telegram') return { TelegramClient: FakeTelegramClient, Api: {} };
    if (request === 'telegram/sessions') return { StringSession: FakeStringSession };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../master-storage.js')];
    const storage = require('../master-storage.js');
    await assert.rejects(
      () => storage.findStorageChannelByAccountId({ async getDialogs() { return Array.from({ length: 1000 }, (_, id) => ({ entity: { id: id + 1, title: 'other' } })); } }, 'usr_recovery'),
      error => error?.code === 'STORAGE_RECONCILIATION_INCOMPLETE',
    );

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

    assert.equal(isDefinitiveMissingStorageError(new Error('CHANNEL_INVALID')), true);
    assert.equal(isDefinitiveMissingStorageError(new Error('CHANNEL_PRIVATE')), true);
    assert.equal(isDefinitiveMissingStorageError(new Error('ETIMEDOUT')), false);
    assert.equal(isDefinitiveMissingStorageError(new Error('ECONNRESET')), false);
  } finally {
    Module._load = originalLoad;
  }
});

test('login fails closed for an invalid vault binding without replacing it', async t => {
  const invalidChatId = 'invalid-vault-binding';
  const invalidUser = { id: 'usr_invalid_vault', username: 'invalid-vault', email: 'invalid-vault@example.test' };
  const write = fs.writeFileSync;
  let accountsFile;
  const seed = t.mock.method(fs, 'writeFileSync', (file, contents, ...options) => {
    const state = process.env.BEATGALER_STATE_DIR;
    if (state && file === path.join(state, 'accounts-data.json') &&
        path.basename(state).startsWith('beatgaler-composition-')) {
      const fixture = JSON.parse(contents);
      const fixtureUser = fixture.users.find(user => user.id === account.id);
      assert.ok(fixtureUser);
      fixture.users.push({ ...fixtureUser, ...invalidUser, storageChatId: invalidChatId });
      accountsFile = file;
      contents = JSON.stringify(fixture);
      seed.mock.restore(); // Subsequent application writes must be left intact.
    }
    return write(file, contents, ...options);
  });

  const storage = require('../master-storage');
  const verify = t.mock.method(storage, 'verifyPrivateUserStorageGroup', async () => { throw new Error('CHANNEL_INVALID'); });
  const create = t.mock.method(storage, 'createPrivateUserStorageGroup', async () => ({
    botApiChatId: '-1009876543210', title: 'Unexpected replacement',
  }));
  const cleanup = t.mock.method(storage, 'ensurePrivateUserStorageBotAbsent', async () => {});
  await withCloud(async (_app, send) => {
    assert.ok(accountsFile, 'the isolated composition must seed the invalid vault');
    const login = (email, beatgalerUserId) => send('POST', '/auth/login', {
      headers: { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' },
      body: { email, password: account.password, beatgalerUserId },
    });
    assert.equal((await login(account.email, account.beatgalerUserId)).status, 200);
    const rejected = await login(invalidUser.email, 'invalid-vault-installation');
    assert.equal(rejected.status, 503, rejected.data);
    assert.equal(rejected.headers['set-cookie'], undefined);
    const persisted = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    assert.equal(persisted.users.find(user => user.id === invalidUser.id).storageChatId, invalidChatId);
    assert.deepEqual([verify, create, cleanup].map(mock => mock.mock.callCount()), [0, 0, 0]);
  });
});

test('Storage assignment validates a stored vault locally and never replaces an invalid binding', async t => {
  const invalid = new Error('Invalid stored chat ID');
  const validateStoredChatId = t.mock.fn(value => {
    if (value !== '-100123') throw invalid;
    return Number(value);
  });
  const unexpected = t.mock.fn(() => { throw new Error('Unexpected storage operation'); });
  const lifecycle = createUserStorageLifecycle({
    validateStoredChatId,
    createPrivateUserStorageGroup: unexpected,
    verifyPrivateUserStorageGroup: unexpected,
    ensurePrivateUserStorageBotAbsent: unexpected,
    masterStorageReady: unexpected,
    managerBotUsername: 'FakeManagerBot',
    storageGroupLimit: 5,
    getProvisionedStorageCount: unexpected,
    saveAuthData: unexpected,
    clearStorageBindingsForUser: unexpected,
    rebindStorageBindingsForUser: unexpected,
    ensureEmptyIndexForStorage: unexpected,
  });
  const validUser = { id: 'usr_valid', storageChatId: '-100123' };
  const invalidUser = { id: 'usr_invalid', storageChatId: 'malformed' };

  assert.equal(await lifecycle.ensureAssigned(validUser), validUser);
  await assert.rejects(() => lifecycle.ensureAssigned(invalidUser), error => error === invalid);
  assert.deepEqual(validateStoredChatId.mock.calls.map(call => call.arguments), [['-100123'], ['malformed']]);
  assert.equal(invalidUser.storageChatId, 'malformed');
  assert.equal(unexpected.mock.callCount(), 0);
});
