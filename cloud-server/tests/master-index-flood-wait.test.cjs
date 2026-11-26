'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FloodWaitError } = require('telegram/errors');
const { telegramRetryAfterSeconds, withTelegramFloodWait } = require('../telegram-retry');

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
