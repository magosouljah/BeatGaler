'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { indexRows, readTelegramLibraryIndex } = require('../library-beat-quota');

const observation = manifest => ({ messageId: 42, manifest, serverVerified: true });
const manifest = (beats = [], trash = []) => ({ schema: 'beatgaler.telegram.library', version: 2, beats, trash });

test('INDEX bootstrap refuses unverified or ambiguous identities', () => {
  assert.throws(() => indexRows({ messageId: 42, manifest: manifest(), serverVerified: false }), { code: 'LIBRARY_QUOTA_INDEX_UNVERIFIED' });
  assert.throws(() => indexRows(observation(manifest([{ id: 'same' }], [{ beat: { id: 'same' } }]))), { code: 'LIBRARY_QUOTA_INDEX_INVALID' });
  assert.throws(() => indexRows(observation(manifest([{ name: 'missing-id' }]))), { code: 'LIBRARY_QUOTA_INVALID_INPUT' });
  assert.equal(indexRows(observation(manifest([{ id: 'one' }, { id: 'one' }]))).rows.size, 1);
});

test('server INDEX reader downloads the pinned Telegram document and checks the pin again', async () => {
  const raw = Buffer.from(JSON.stringify(manifest([{ id: 'one' }], [{ beat: { id: 'two' } }])));
  const client = { async query(sql, values) {
    assert.match(sql, /FROM vaults WHERE user_id/);
    assert.deepEqual(values, ['u1']);
    return { rows: [{ telegram_chat_id: '-100123' }] };
  } };
  let pins = 0;
  const transport = {
    async getPinnedMessage(chatId) {
      assert.equal(chatId, '-100123');
      pins += 1;
      return { message_id: 42, caption: 'BEATGALER_LIBRARY_INDEX_V1' };
    },
    async downloadMessageBuffer(chatId, messageId) {
      assert.equal(chatId, '-100123');
      assert.equal(messageId, 42);
      return raw;
    },
  };
  const result = await readTelegramLibraryIndex('u1', { client, transport });
  assert.equal(result.serverVerified, true);
  assert.equal(result.messageId, 42);
  assert.equal(pins, 2);
  assert.equal(indexRows(result).rows.size, 2);
  const changed = { ...transport, async getPinnedMessage() { pins += 1; return { message_id: pins === 3 ? 42 : 43, caption: 'BEATGALER_LIBRARY_INDEX_V1' }; } };
  await assert.rejects(readTelegramLibraryIndex('u1', { client, transport: changed }), { code: 'LIBRARY_QUOTA_INDEX_CHANGED' });
});
