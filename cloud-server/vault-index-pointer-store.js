'use strict';

function positiveMessageId(value) {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function nullableMessageId(value) {
  if (value === null || value === undefined || value === '' || Number(value) === 0) return null;
  return positiveMessageId(value);
}

function normalizeSource(value) {
  return ['publish', 'pin_recovery', 'history_recovery', 'migration'].includes(value)
    ? value
    : 'publish';
}

/**
 * PostgreSQL storage for the non-authoritative INDEX shortcut. Every method
 * addresses a Telegram chat through its owning vault row, so callers cannot
 * select another vault by presenting an arbitrary vault id.
 */
function createVaultIndexPointerStore(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is required for vault INDEX pointers.');

  async function getForChat(telegramChatId) {
    const result = await pool.query(`
      SELECT v.id AS vault_id, p.index_message_id, p.predecessor_message_id,
             p.revision, p.source, p.verified_at, p.updated_at
        FROM vaults v
        LEFT JOIN vault_index_pointers p ON p.vault_id = v.id
       WHERE v.telegram_chat_id = $1
    `, [String(telegramChatId || '').trim()]);
    const row = result.rows[0] || null;
    if (!row) return null;
    return {
      vault_id: String(row.vault_id),
      message_id: positiveMessageId(row.index_message_id),
      predecessor_message_id: nullableMessageId(row.predecessor_message_id),
      revision: Number(row.revision || 0) || null,
      source: row.source || null,
      verified_at: row.verified_at || null,
      updated_at: row.updated_at || null,
    };
  }

  async function compareAndSetForChat({ telegramChatId, messageId, expectedMessageId = null, source = 'publish' }) {
    const next = positiveMessageId(messageId);
    if (!next) throw new Error('A positive INDEX message id is required.');
    const expected = nullableMessageId(expectedMessageId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The vault row lock serializes pointer repair and publication even when
      // different browser installations arrive through different Cloud nodes.
      const vault = await client.query(
        'SELECT id FROM vaults WHERE telegram_chat_id = $1 FOR UPDATE',
        [String(telegramChatId || '').trim()],
      );
      if (!vault.rows[0]) throw new Error('No vault owns this Telegram chat.');
      const vaultId = String(vault.rows[0].id);
      const current = await client.query(
        'SELECT index_message_id, revision FROM vault_index_pointers WHERE vault_id = $1 FOR UPDATE',
        [vaultId],
      );
      const currentId = positiveMessageId(current.rows[0]?.index_message_id);
      if (currentId === next) {
        await client.query('COMMIT');
        return { status: 'same', vault_id: vaultId, message_id: next, revision: Number(current.rows[0]?.revision || 1) };
      }
      if (currentId !== expected) {
        await client.query('COMMIT');
        return { status: 'conflict', vault_id: vaultId, message_id: currentId, revision: Number(current.rows[0]?.revision || 0) || null };
      }
      const result = await client.query(`
        INSERT INTO vault_index_pointers(
          vault_id, index_message_id, predecessor_message_id, revision, source, verified_at, updated_at
        ) VALUES($1, $2, $3, 1, $4, now(), now())
        ON CONFLICT(vault_id) DO UPDATE SET
          index_message_id = EXCLUDED.index_message_id,
          predecessor_message_id = vault_index_pointers.index_message_id,
          revision = vault_index_pointers.revision + 1,
          source = EXCLUDED.source,
          verified_at = now(),
          updated_at = now()
        RETURNING index_message_id, revision
      `, [vaultId, next, expected, normalizeSource(source)]);
      await client.query('COMMIT');
      return { status: 'updated', vault_id: vaultId, message_id: next, revision: Number(result.rows[0]?.revision || 1) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ getForChat, compareAndSetForChat });
}

let configuredStore = null;
function configure({ pool = null, store = null } = {}) {
  configuredStore = store || (pool ? createVaultIndexPointerStore(pool) : null);
  return configuredStore;
}
function requiredStore() {
  if (!configuredStore) throw new Error('PostgreSQL vault INDEX pointer store is unavailable.');
  return configuredStore;
}

module.exports = {
  positiveMessageId,
  nullableMessageId,
  createVaultIndexPointerStore,
  configure,
  getForChat(chatId) { return requiredStore().getForChat(chatId); },
  compareAndSetForChat(input) { return requiredStore().compareAndSetForChat(input); },
  _resetForTests() { configuredStore = null; },
};
