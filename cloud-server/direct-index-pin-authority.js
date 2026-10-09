'use strict';

function createDirectIndexPinAuthority({ pool, transport }) {
  if (!pool?.connect || typeof transport?.restrictBotPinRights !== 'function') {
    throw new Error('PostgreSQL and MASTER bot-rights control are required.');
  }
  async function ensure({ chatId, botId, membershipState }) {
    if (String(membershipState) !== 'ready') return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(`SELECT transport_bot_id,index_pin_restricted_bot_id
          FROM vaults WHERE telegram_chat_id=$1 FOR UPDATE`, [String(chatId)])).rows[0];
      if (!row || String(row.transport_bot_id) !== String(botId)) {
        throw new Error('INDEX pin restriction does not match the assigned bot.');
      }
      if (String(row.index_pin_restricted_bot_id || '') !== String(botId)) {
        await transport.restrictBotPinRights(chatId, botId);
        await client.query(`UPDATE vaults SET index_pin_restricted_bot_id=$2,index_pin_restricted_at=now()
            WHERE telegram_chat_id=$1`, [String(chatId), String(botId)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({
    ensure,
    async ensureAll() {
      const rows = (await pool.query(`SELECT telegram_chat_id,transport_bot_id,transport_membership_state
        FROM vaults WHERE transport_bot_id IS NOT NULL AND transport_membership_state='ready'`)).rows;
      for (const row of rows) {
        await ensure({ chatId: row.telegram_chat_id, botId: row.transport_bot_id,
          membershipState: row.transport_membership_state });
      }
      return rows.length;
    },
  });
}

module.exports = { createDirectIndexPinAuthority };
