'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Api } = require('telegram');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-message-download-'));
process.env.VAULT_REGISTRY_FILE = path.join(directory, 'registry.json');
process.env.MASTERS_FILE = path.join(directory, 'masters.json');
process.env.BEATGALER_MASTER_SESSION = 'fake-session';
process.env.TELEGRAM_API_ID = '12345';
process.env.TELEGRAM_API_HASH = 'fake-api-hash';

let messages;
let downloadResult;
let downloadCalls = 0;
class FakeTelegramClient {
  setLogLevel() {}
  async connect() {}
  async checkAuthorization() { return true; }
  async disconnect() {}
  async *iterDialogs() { yield { entity: { id: 123, className: 'Channel' } }; }
  async invoke(request) {
    assert.ok(request instanceof Api.channels.GetMessages);
    assert.equal(request.id.length, 1);
    assert.ok(request.id[0] instanceof Api.InputMessageID);
    assert.equal(request.id[0].id, 250);
    return { messages };
  }
  async getMessages() { throw new Error('getMessages hides MessageEmpty'); }
  async downloadMedia() { downloadCalls += 1; return downloadResult; }
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') return { TelegramClient: FakeTelegramClient, Api };
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, parent, isMain);
};
let direct;
try { direct = require('../direct-transport-control'); }
finally { Module._load = originalLoad; }

test('downloadMessageBuffer preserves missing, media, and download failure distinctions', async t => {
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  messages = [new Api.MessageEmpty({ id: 250 })];
  await assert.rejects(direct.downloadMessageBuffer('-100123', 250), error => {
    assert.equal(error.code, 'TELEGRAM_MESSAGE_MISSING');
    assert.equal(error.messageId, 250);
    assert.match(error.message, /250/);
    return true;
  });

  messages = [];
  await assert.rejects(direct.downloadMessageBuffer('-100123', 250), {
    code: 'TELEGRAM_MESSAGE_MISSING', messageId: 250,
  });

  messages = [{ id: 250 }];
  await assert.rejects(direct.downloadMessageBuffer('-100123', 250), error => {
    assert.equal(error.code, 'TELEGRAM_MESSAGE_NO_MEDIA');
    assert.equal(error.messageId, 250);
    assert.match(error.message, /250/);
    return true;
  });
  assert.equal(downloadCalls, 0);

  messages = [{ id: 250, media: { document: {} } }];
  downloadResult = undefined;
  await assert.rejects(direct.downloadMessageBuffer('-100123', 250), error => {
    assert.notEqual(error.code, 'TELEGRAM_MESSAGE_MISSING');
    assert.notEqual(error.code, 'TELEGRAM_MESSAGE_NO_MEDIA');
    assert.match(error.message, /returned no buffer/);
    return true;
  });

  downloadResult = Buffer.from('INDEX');
  assert.deepEqual(await direct.downloadMessageBuffer('-100123', 250), downloadResult);
  assert.equal(downloadCalls, 2);
});
