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

test('existing populated vault pays two MASTER pin reads for rejected empty-index preflight and recovery', async () => {
  // Pure in-memory transport and SQL doubles. Never contacts Telegram, PostgreSQL or a real Vault.
  const crypto = require('node:crypto');
  const existing = {
    schema: 'beatgaler.telegram.library', version: 2,
    beats: [{ id: 'kept-beat' }], trash: [], deleted: [],
  };
  const raw = Buffer.from(JSON.stringify(existing));
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const seenSql = [];
  let checkedOut = 0;
  let released = 0;
  let pinnedReads = 0;
  let published = 0;
  let deleted = 0;

  const query = async (sql) => {
    seenSql.push(sql);
    if (/^SELECT 1 FROM library_quota_state WHERE user_id/.test(sql)) return { rows: [{ present: 1 }] };
    if (/^SELECT id,telegram_chat_id,index_bootstrap_pending FROM vaults/.test(sql)) {
      return { rows: [{ id: 'existing-vault', telegram_chat_id: 'chat-existing', index_bootstrap_pending: false }] };
    }
    if (/^SELECT \* FROM library_quota_state WHERE user_id/.test(sql)) {
      return { rows: [{ index_message_id: 42, index_sha256: sha }] };
    }
    if (/^SELECT id FROM vaults WHERE user_id/.test(sql)) return { rows: [{ id: 'existing-vault' }] };
    if (/^SELECT index_message_id,index_sha256 FROM library_quota_state WHERE user_id/.test(sql)) {
      return { rows: [{ index_message_id: 42, index_sha256: sha }] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    throw new Error('Unexpected SQL in isolated test: ' + sql);
  };
  const pool = {
    query,
    async connect() {
      checkedOut += 1;
      return { query, release() { released += 1; } };
    },
  };
  const transport = {
    async getPinnedMessage() { throw new Error('Unexpected fallback pinned read'); },
    async readPinnedIndexBuffer(chatId) {
      assert.equal(chatId, 'chat-existing');
      pinnedReads += 1; // One call opens/closes one MASTER GramJS client in production.
      return { message_id: 42, caption: 'BEATGALER_LIBRARY_INDEX_V1', raw };
    },
    async publishIndexBuffer() { published += 1; throw new Error('Must not publish a replacement INDEX'); },
    async downloadMessageBuffer() { throw new Error('Must not download via fallback'); },
    async deleteMessages() { deleted += 1; throw new Error('Must not delete an INDEX'); },
  };
  const publication = createLibraryIndexPublication({ pool, transport });

  // This is the publish attempt from Web's ensureImportQuotaIndex().
  await assert.rejects(
    publication.publish({
      userId: 'existing-user', chatId: 'chat-existing',
      manifest: empty, expectedMessageId: 0,
    }),
    { code: 'LIBRARY_QUOTA_INDEX_CHANGED', message: 'Library INDEX changed.' },
  );
  assert.equal(pinnedReads, 1, 'rejected preflight still reads through MASTER');
  assert.equal(seenSql.filter(sql => sql === 'ROLLBACK').length, 1);

  // server-core.js /transport/index/publish runs this recovery in its generic catch.
  assert.deepEqual(
    await publication.recover({ userId: 'existing-user', chatId: 'chat-existing' }),
    { status: 'current' },
  );
  assert.equal(pinnedReads, 2, 'generic recovery opens MASTER again to read pinned INDEX');
  assert.equal(checkedOut, 2, 'each call obtains its own SQL transaction client');
  assert.equal(released, 2);
  assert.equal(seenSql.filter(sql => sql === 'BEGIN').length, 2);
  assert.equal(seenSql.filter(sql => sql === 'COMMIT').length, 1);
  assert.equal(seenSql.filter(sql => sql === 'ROLLBACK').length, 1);
  assert.equal(published, 0, 'no empty INDEX was published');
  assert.equal(deleted, 0, 'existing INDEX was not deleted');
  assert.deepEqual(JSON.parse(raw.toString('utf8')), existing, 'existing library remains unchanged');
});
