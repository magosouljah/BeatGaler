'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDirectIndexPinAuthority } = require('../direct-index-pin-authority');
const { createLibraryIndexPublication } = require('../library-index-publication');

function missingVault() {
  const error = new Error('MASTER cannot find private vault broken.');
  error.code = 'MASTER_VAULT_NOT_FOUND';
  return error;
}

test('startup pin restrictions degrade one absent vault and continue with the next', async () => {
  const restricted = [];
  const repaired = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes('SELECT telegram_chat_id,transport_bot_id')) return { rows: [
        { telegram_chat_id: 'broken', transport_bot_id: 'Bot01', transport_membership_state: 'ready' },
        { telegram_chat_id: 'healthy', transport_bot_id: 'Bot02', transport_membership_state: 'ready' },
      ] };
      if (sql.includes("UPDATE vaults SET transport_membership_state='repair'")) { repaired.push(params[0]); return { rowCount: 1, rows: [] }; }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql, params) {
          if (sql.includes('SELECT transport_bot_id')) return { rows: [{
            transport_bot_id: params[0] === 'broken' ? 'Bot01' : 'Bot02',
            index_pin_restricted_bot_id: null, project_media_restricted_bot_id: null,
          }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const authority = createDirectIndexPinAuthority({ pool, transport: {
    async restrictBotPinRights(chatId) {
      if (chatId === 'broken') throw missingVault();
      restricted.push(chatId);
    },
  } });
  assert.equal(await authority.ensureAll(), 1);
  assert.deepEqual(restricted, ['healthy']);
  assert.deepEqual(repaired, ['broken']);
});

test('library recovery skips an absent vault, recovers the rest, and keeps DB failure fatal', async () => {
  const manifest = { schema: 'beatgaler.telegram.library', version: 2, beats: [], trash: [] };
  const raw = Buffer.from(JSON.stringify(manifest));
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const recovered = [];
  const repaired = [];
  let globalFailure = false;
  const pool = {
    async query(sql, params) {
      if (globalFailure) throw new Error('database unavailable');
      if (sql.includes('FROM library_quota_state s JOIN vaults')) return { rows: [
        { user_id: 'user-broken', telegram_chat_id: 'broken', index_message_id: 1, predecessor_message_id: 0 },
        { user_id: 'user-healthy', telegram_chat_id: 'healthy', index_message_id: 1, predecessor_message_id: 0 },
      ] };
      if (sql.includes("UPDATE vaults SET transport_membership_state='repair'")) { repaired.push(params[0]); return { rowCount: 1, rows: [] }; }
      if (sql.includes('FROM library_trash_purges')) return { rows: [] };
      if (sql.includes('FROM vaults v') && sql.includes('s.user_id IS NULL')) return { rows: [] };
      if (sql.includes('SELECT index_message_id,index_sha256')) return { rows: [{ index_message_id: 1, index_sha256: sha }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql, params) {
          if (sql.includes('SELECT id FROM vaults')) return { rows: [{ id: params[0] }] };
          if (sql.includes('SELECT index_message_id,index_sha256')) return { rows: [{ index_message_id: 1, index_sha256: sha }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const transport = {
    async getPinnedMessage() { throw new Error('unused'); },
    async readPinnedIndexBuffer(chatId) {
      if (chatId === 'broken') throw missingVault();
      recovered.push(chatId);
      return { message_id: 1, caption: 'BEATGALER_LIBRARY_INDEX_V1', raw };
    },
    async publishIndexBuffer() {},
    async downloadMessageBuffer() {},
  };
  const publication = createLibraryIndexPublication({ pool, transport });
  assert.equal(await publication.recoverAll(), 1);
  assert.ok(recovered.length >= 1);
  assert.deepEqual(repaired, ['broken']);
  globalFailure = true;
  await assert.rejects(publication.recoverAll(), /database unavailable/);
});

test('a MASTER configuration error is not classified as a missing vault', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('SELECT telegram_chat_id,transport_bot_id')) return { rows: [
        { telegram_chat_id: 'broken', transport_bot_id: 'Bot01', transport_membership_state: 'ready' },
      ] };
      throw new Error('Unexpected repair query');
    },
    async connect() {
      return { async query(sql) {
        if (sql.includes('SELECT transport_bot_id')) return { rows: [{ transport_bot_id: 'Bot01' }] };
        return { rows: [] };
      }, release() {} };
    },
  };
  const authority = createDirectIndexPinAuthority({ pool, transport: {
    async restrictBotPinRights() { throw new Error('MASTER Telegram session is not configured.'); },
  } });
  await assert.rejects(authority.ensureAll(), /MASTER Telegram session is not configured/);
});
