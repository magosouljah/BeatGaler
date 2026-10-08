'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVaultIndexPointerStore } = require('../vault-index-pointer-store');

function memoryPool() {
  const vaults = new Map([['chat-a', 'vault-a'], ['chat-b', 'vault-b'], ['chat-empty', 'vault-empty']]);
  const pointers = new Map();
  const query = async (sql, values = []) => {
    if (/FROM vaults v\s+LEFT JOIN vault_index_pointers/i.test(sql)) {
      const vaultId = vaults.get(values[0]);
      const row = vaultId ? { vault_id: vaultId, ...(pointers.get(vaultId) || {}) } : null;
      return { rows: row ? [row] : [] };
    }
    if (/SELECT id FROM vaults WHERE telegram_chat_id/i.test(sql)) {
      const id = vaults.get(values[0]);
      return { rows: id ? [{ id }] : [] };
    }
    if (/SELECT index_message_id, revision FROM vault_index_pointers/i.test(sql)) {
      const row = pointers.get(values[0]);
      return { rows: row ? [row] : [] };
    }
    if (/INSERT INTO vault_index_pointers/i.test(sql)) {
      const [vaultId, messageId, predecessor, source] = values;
      const before = pointers.get(vaultId);
      const row = {
        index_message_id: messageId,
        predecessor_message_id: before?.index_message_id || predecessor || null,
        revision: (before?.revision || 0) + 1,
        source,
        verified_at: 'now', updated_at: 'now',
      };
      pointers.set(vaultId, row);
      return { rows: [row] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return {
    query,
    async connect() { return { query, release() {} }; },
    pointers,
  };
}

test('fast path reads a valid vault pointer without touching another vault', async () => {
  const pool = memoryPool();
  const store = createVaultIndexPointerStore(pool);
  await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 101, expectedMessageId: null, source: 'publish' });
  const pointer = await store.getForChat('chat-a');
  assert.equal(pointer.message_id, 101);
  assert.equal(pointer.vault_id, 'vault-a');
});

test('missing pointer repairs from the pin and records its recovery source', async () => {
  const store = createVaultIndexPointerStore(memoryPool());
  const committed = await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 102, expectedMessageId: null, source: 'pin_recovery' });
  assert.equal(committed.status, 'updated');
  assert.equal((await store.getForChat('chat-a')).source, 'pin_recovery');
});

test('a crash after Telegram publication leaves the old pointer recoverable without creating an empty library', async () => {
  const store = createVaultIndexPointerStore(memoryPool());
  await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 103, expectedMessageId: null, source: 'publish' });
  const repaired = await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 104, expectedMessageId: 103, source: 'history_recovery' });
  assert.equal(repaired.status, 'updated');
  assert.equal((await store.getForChat('chat-a')).message_id, 104);
});

test('a published replacement advances the pointer and the next reload observes it', async () => {
  const store = createVaultIndexPointerStore(memoryPool());
  await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 105, expectedMessageId: null, source: 'publish' });
  await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 106, expectedMessageId: 105, source: 'publish' });
  const reload = await store.getForChat('chat-a');
  assert.equal(reload.message_id, 106);
  assert.equal(reload.predecessor_message_id, 105);
  assert.equal(reload.revision, 2);
});

test('a truly empty vault has no pointer until the guarded initial publication succeeds', async () => {
  const store = createVaultIndexPointerStore(memoryPool());
  assert.equal((await store.getForChat('chat-empty')).message_id, null);
  await store.compareAndSetForChat({ telegramChatId: 'chat-empty', messageId: 107, expectedMessageId: null, source: 'publish' });
  assert.equal((await store.getForChat('chat-empty')).message_id, 107);
});

test('vault pointers are isolated and a stale writer cannot roll one back after a crash/race', async () => {
  const store = createVaultIndexPointerStore(memoryPool());
  await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 108, expectedMessageId: null, source: 'publish' });
  await store.compareAndSetForChat({ telegramChatId: 'chat-b', messageId: 208, expectedMessageId: null, source: 'publish' });
  await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 109, expectedMessageId: 108, source: 'publish' });
  const stale = await store.compareAndSetForChat({ telegramChatId: 'chat-a', messageId: 110, expectedMessageId: 108, source: 'publish' });
  assert.equal(stale.status, 'conflict');
  assert.equal((await store.getForChat('chat-a')).message_id, 109);
  assert.equal((await store.getForChat('chat-b')).message_id, 208);
});
