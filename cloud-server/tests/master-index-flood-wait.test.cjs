'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Api } = require('telegram');
const { FloodWaitError } = require('telegram/errors');
const { telegramRetryAfterSeconds, withTelegramFloodWait } = require('../telegram-retry');
const { __test } = require('../direct-transport-control');

const floodMessage = 'A wait of 580 seconds is required (caused by messages.UpdatePinnedMessage)';

test('Telegram retry duration accepts Bot API, structured GramJS and observed GramJS text', () => {
  assert.equal(telegramRetryAfterSeconds({ retry_after: 5 }), 5);
  assert.equal(telegramRetryAfterSeconds({ seconds: 580 }), 580);
  assert.equal(telegramRetryAfterSeconds(new Error(floodMessage)), 580);
  const gramjs = new FloodWaitError({ capture: '580', request: { className: 'messages.UpdatePinnedMessage' } });
  assert.equal(gramjs.code, 420);
  assert.equal(gramjs.seconds, 580);
  assert.equal(telegramRetryAfterSeconds(gramjs), 580);
  assert.equal(telegramRetryAfterSeconds({ code: 420, message: 'Unknown flood error' }), null);
});

test('FloodWait retries after the reported delay without sleeping in the test', async () => {
  const waits = [];
  let attempts = 0;
  const result = await withTelegramFloodWait('pin', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error(floodMessage);
    return 'success';
  }, { sleepFn: async ms => waits.push(ms) });
  assert.equal(result, 'success');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [580_350]);
});

test('MASTER INDEX retries the same pin only and deletes the old copy after success', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-pin-test-'));
  const filePath = path.join(directory, 'library.json');
  fs.writeFileSync(filePath, '{}');
  const events = [];
  const pinIds = [];
  let sends = 0;
  const masterInfo = {
    vault: { id: 42 },
    client: {
      async sendFile() { sends += 1; events.push('send'); return { id: 123 }; },
      async invoke(request) {
        if (request instanceof Api.messages.UpdatePinnedMessage) {
          pinIds.push(request.id);
          events.push('pin');
          if (pinIds.length === 1) throw new Error(floodMessage);
          return true;
        }
        if (request instanceof Api.channels.DeleteMessages) {
          events.push('delete');
          assert.deepEqual(request.id, [122]);
          return true;
        }
        throw new Error('unexpected RPC');
      },
    },
  };
  try {
    const waits = [];
    const result = await __test.commitIndexCopyOnWriteWithMaster(
      masterInfo, { filePath, caption: 'BEATGALER_LIBRARY_INDEX_V1', previousMessageId: 122 },
      { sleepFn: async ms => waits.push(ms), onWait: () => {} },
    );
    assert.equal(sends, 1);
    assert.deepEqual(pinIds, [123, 123]);
    assert.deepEqual(waits, [580_350]);
    assert.deepEqual(events, ['send', 'pin', 'pin', 'delete']);
    assert.equal(result.messageId, 123);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MASTER recovery pin uses the same retry and does not send a new document', async () => {
  const ids = [];
  const waits = [];
  const masterInfo = { vault: {}, client: {
    async invoke(request) {
      assert.ok(request instanceof Api.messages.UpdatePinnedMessage);
      ids.push(request.id);
      if (ids.length === 1) throw new Error(floodMessage);
      return true;
    },
  } };
  await __test.pinMasterIndexMessage(masterInfo, 123, {
    sleepFn: async ms => waits.push(ms), onWait: () => {},
  });
  assert.deepEqual(ids, [123, 123]);
  assert.deepEqual(waits, [580_350]);
});

test('unclassified 420 fails immediately and leaves the old INDEX in place', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-pin-test-'));
  const filePath = path.join(directory, 'library.json');
  fs.writeFileSync(filePath, '{}');
  const events = [];
  const error = Object.assign(new Error('Unknown flood error'), { code: 420 });
  const masterInfo = { vault: {}, client: {
    async sendFile() { events.push('send'); return { id: 123 }; },
    async invoke(request) {
      events.push(request instanceof Api.messages.UpdatePinnedMessage ? 'pin' : 'delete');
      throw error;
    },
  } };
  try {
    await assert.rejects(__test.commitIndexCopyOnWriteWithMaster(
      masterInfo, { filePath, caption: 'BEATGALER_LIBRARY_INDEX_V1', previousMessageId: 122 },
      { sleepFn: async () => assert.fail('unexpected sleep'), onWait: () => {} },
    ), err => err === error);
    assert.deepEqual(events, ['send', 'pin']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
