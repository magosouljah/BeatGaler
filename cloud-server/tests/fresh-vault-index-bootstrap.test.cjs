'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLibraryIndexPublication } = require('../library-index-publication');

function harness({ bootstrapPending, pointerExists = false }) {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (/SELECT 1 FROM library_quota_state WHERE user_id/.test(sql)) return { rows: [] };
    if (/SELECT id,telegram_chat_id,index_bootstrap_pending FROM vaults/.test(sql)) {
      return { rows: [{ id: 'vault-existing', telegram_chat_id: 'chat-existing', index_bootstrap_pending: bootstrapPending }] };
    }
    if (/SELECT \* FROM library_quota_state/.test(sql)) return { rows: [] };
    if (/SELECT 1 FROM vault_index_pointers/.test(sql)) return { rows: pointerExists ? [{ '?column?': 1 }] : [] };
    if (/^(BEGIN|ROLLBACK)$/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const pool = { query, async connect() { return { query, release() {} }; } };
  const transport = {
    getPinnedMessage: async () => null,
    publishIndexBuffer: async () => { throw new Error('INDEX must not be published'); },
    downloadMessageBuffer: async () => { throw new Error('INDEX must not be downloaded'); },
  };
  const publication = createLibraryIndexPublication({ pool, transport });
  return { publication, calls };
}

const empty = { schema: 'beatgaler.telegram.library', version: 2, beats: [], trash: [], deleted: [] };

test('an existing vault without a pointer cannot publish an empty initial INDEX', async () => {
  const { publication, calls } = harness({ bootstrapPending: false });
  await assert.rejects(publication.publish({ userId: 'user-existing', chatId: 'chat-existing', manifest: empty, expectedMessageId: 0 }),
    { code: 'LIBRARY_QUOTA_UNINITIALIZED' });
  assert.ok(calls.some(sql => /ROLLBACK/.test(sql)));
});

test('a pending bootstrap with an existing pointer still fails closed', async () => {
  const { publication, calls } = harness({ bootstrapPending: true, pointerExists: true });
  await assert.rejects(publication.publish({ userId: 'user-existing', chatId: 'chat-existing', manifest: empty, expectedMessageId: 0 }),
    { code: 'LIBRARY_QUOTA_INDEX_CHANGED' });
  assert.ok(calls.some(sql => /ROLLBACK/.test(sql)));
});

test('a marked fresh vault publishes and clears eligibility in the same transaction', async () => {
  const calls = [];
  let pinnedId = 0;
  let published = 0;
  let document = null;
  const query = async (sql) => {
    calls.push(sql);
    if (/SELECT id,telegram_chat_id,index_bootstrap_pending FROM vaults/.test(sql)) {
      return { rows: [{ id: 'vault-fresh', telegram_chat_id: 'chat-fresh', index_bootstrap_pending: true }] };
    }
    if (/SELECT 1 FROM library_quota_state|SELECT \* FROM library_quota_state|SELECT 1 FROM vault_index_pointers/.test(sql)) return { rows: [] };
    if (/SELECT beat_id,state FROM library_beats|SELECT beat_id,state,asset_message_ids,beat_sha256 FROM library_trash_purges/.test(sql)) return { rows: [] };
    if (/^(BEGIN|COMMIT)$/.test(sql)) return { rows: [] };
    if (/INSERT INTO library_quota_state|INSERT INTO vault_index_pointers|UPDATE vaults SET index_bootstrap_pending=false/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const pool = { query, async connect() { return { query, release() {} }; } };
  const transport = {
    async getPinnedMessage() { return pinnedId ? { message_id: pinnedId, caption: 'BEATGALER_LIBRARY_INDEX_V1' } : null; },
    async downloadMessageBuffer() { return document; },
    async publishIndexBuffer({ bytes }) { published += 1; document = Buffer.from(bytes); pinnedId = 4; return { messageId: 4 }; },
  };
  const service = createLibraryIndexPublication({ pool, transport });
  const result = await service.publish({ userId: 'user-fresh', chatId: 'chat-fresh', manifest: empty, expectedMessageId: 0 });
  assert.equal(result.messageId, 4);
  assert.equal(published, 1);
  const clear = calls.findIndex(sql => /UPDATE vaults SET index_bootstrap_pending=false/.test(sql));
  const commit = calls.findIndex(sql => /^COMMIT$/.test(sql));
  assert.ok(clear > 0 && commit > clear);
});
