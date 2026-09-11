'use strict';

const ASSIGNMENT_LOCK_KEY = 'beatgaler:direct-vault-assignment:v1';
const MEMBERSHIP_STATES = Object.freeze(['pending', 'ready', 'repair']);

function requiredPool(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new Error('PostgreSQL pool with query() and connect() is required for persistent Direct vault assignment.');
  }
  return pool;
}

function normalizeVaultSelector(value) {
  const source = value && typeof value === 'object' ? value : { chatId: value };
  const vaultId = String(source.vaultId || source.id || '').trim();
  const chatId = String(source.chatId ?? source.storageChatId ?? source.telegramChatId ?? '').trim();
  if (!vaultId && !chatId) throw new Error('vaultId or chatId is required for persistent Direct vault assignment.');
  return Object.freeze({ vaultId: vaultId || null, chatId: chatId || null });
}

function normalizeTransportBot(value) {
  const id = String(value?.id || '').trim();
  if (!id) throw new Error('Transport bot id is required.');
  return Object.freeze({
    id,
    quarantined: Boolean(value?.quarantined),
    rotationPending: Boolean(value?.rotationPending ?? value?.rotation_pending),
  });
}

function assignmentFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    vaultId: String(row.id),
    userId: String(row.user_id),
    chatId: String(row.telegram_chat_id),
    transportBotId: row.transport_bot_id ? String(row.transport_bot_id) : null,
    membershipState: String(row.transport_membership_state || 'pending'),
    membershipUpdatedAt: row.transport_membership_updated_at || null,
  });
}

function vaultWhere(selector, startIndex = 1) {
  if (selector.vaultId) return { sql: `id=$${startIndex}`, params: [selector.vaultId] };
  return { sql: `telegram_chat_id=$${startIndex}`, params: [selector.chatId] };
}

function assignmentError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class DirectVaultAssignmentStore {
  constructor(pool) {
    this.pool = requiredPool(pool);
  }

  async getAssignment(vault) {
    const selector = normalizeVaultSelector(vault);
    const where = vaultWhere(selector);
    const result = await this.pool.query(
      `SELECT id,user_id,telegram_chat_id,transport_bot_id,transport_membership_state,transport_membership_updated_at
       FROM vaults WHERE ${where.sql}`,
      where.params,
    );
    return assignmentFromRow(result.rows[0]);
  }

  async syncTransportBots(bots) {
    const normalized = (bots || []).map(normalizeTransportBot);
    if (!normalized.length) throw assignmentError('Transport bot pool is empty.', 'TRANSPORT_ASSIGNMENT_NO_BOTS');
    const ids = normalized.map(bot => bot.id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ASSIGNMENT_LOCK_KEY]);
      await client.query(
        `UPDATE transport_bots
         SET quarantined=true,updated_at=now()
         WHERE NOT (id = ANY($1::text[]))`,
        [ids],
      );
      for (const bot of normalized) {
        await client.query(
          `INSERT INTO transport_bots(id,quarantined,rotation_pending,updated_at)
           VALUES($1,$2,$3,now())
           ON CONFLICT(id) DO UPDATE SET
             quarantined=EXCLUDED.quarantined,
             rotation_pending=EXCLUDED.rotation_pending,
             updated_at=now()`,
          [bot.id, bot.quarantined, bot.rotationPending],
        );
      }
      await client.query('COMMIT');
      return Object.freeze({ synced: normalized.length });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async assignIfMissing(vault) {
    const selector = normalizeVaultSelector(vault);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // This deliberately serializes all first-time assignments. They are rare,
      // and a global lock prevents two different vaults from observing the same
      // minimum count and both selecting the same bot concurrently.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ASSIGNMENT_LOCK_KEY]);
      const where = vaultWhere(selector);
      const currentResult = await client.query(
        `SELECT id,user_id,telegram_chat_id,transport_bot_id,transport_membership_state,transport_membership_updated_at
         FROM vaults WHERE ${where.sql} FOR UPDATE`,
        where.params,
      );
      const current = currentResult.rows[0];
      if (!current) throw assignmentError('Vault does not exist in PostgreSQL.', 'TRANSPORT_ASSIGNMENT_VAULT_NOT_FOUND');
      if (current.transport_bot_id) {
        await client.query('COMMIT');
        return assignmentFromRow(current);
      }

      const candidateResult = await client.query(
        `SELECT tb.id,COUNT(v.id)::bigint AS assignment_count
         FROM transport_bots tb
         LEFT JOIN vaults v ON v.transport_bot_id=tb.id
         WHERE tb.quarantined=false AND tb.rotation_pending=false
         GROUP BY tb.id
         ORDER BY COUNT(v.id) ASC,tb.id ASC
         LIMIT 1`,
      );
      const transportBotId = candidateResult.rows[0]?.id ? String(candidateResult.rows[0].id) : '';
      if (!transportBotId) {
        throw assignmentError('No assignable transport bot is available.', 'TRANSPORT_ASSIGNMENT_NO_BOTS');
      }

      const updateResult = await client.query(
        `UPDATE vaults
         SET transport_bot_id=$1,
             transport_membership_state='pending',
             transport_membership_updated_at=now(),
             updated_at=now()
         WHERE id=$2
         RETURNING id,user_id,telegram_chat_id,transport_bot_id,transport_membership_state,transport_membership_updated_at`,
        [transportBotId, current.id],
      );
      await client.query('COMMIT');
      return assignmentFromRow(updateResult.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async setMembershipState(vault, state, expectedTransportBotId = null) {
    const normalizedState = String(state || '').trim().toLowerCase();
    if (!MEMBERSHIP_STATES.includes(normalizedState)) {
      throw new Error(`Invalid transport membership state: ${state}`);
    }
    const selector = normalizeVaultSelector(vault);
    const where = vaultWhere(selector, 2);
    const params = [normalizedState, ...where.params];
    let botGuard = '';
    if (expectedTransportBotId != null) {
      params.push(String(expectedTransportBotId));
      botGuard = ` AND transport_bot_id=$${params.length}`;
    }
    const result = await this.pool.query(
      `UPDATE vaults
       SET transport_membership_state=$1,transport_membership_updated_at=now(),updated_at=now()
       WHERE ${where.sql}${botGuard} AND transport_bot_id IS NOT NULL
       RETURNING id,user_id,telegram_chat_id,transport_bot_id,transport_membership_state,transport_membership_updated_at`,
      params,
    );
    if (!result.rows[0]) {
      throw assignmentError('Persistent transport assignment is missing or changed.', 'TRANSPORT_ASSIGNMENT_MISMATCH');
    }
    return assignmentFromRow(result.rows[0]);
  }

  markMembershipReady(vault, expectedTransportBotId = null) {
    return this.setMembershipState(vault, 'ready', expectedTransportBotId);
  }

  markMembershipRepairNeeded(vault, expectedTransportBotId = null) {
    return this.setMembershipState(vault, 'repair', expectedTransportBotId);
  }
}

function createDirectVaultAssignmentStore(pool) {
  return new DirectVaultAssignmentStore(pool);
}

module.exports = {
  ASSIGNMENT_LOCK_KEY,
  MEMBERSHIP_STATES,
  normalizeVaultSelector,
  normalizeTransportBot,
  assignmentFromRow,
  DirectVaultAssignmentStore,
  createDirectVaultAssignmentStore,
};
