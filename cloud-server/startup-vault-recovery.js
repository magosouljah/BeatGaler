'use strict';

async function skipMissingVault({ pool, chatId, phase, error }) {
  if (error?.code !== 'MASTER_VAULT_NOT_FOUND') return false;
  const result = await pool.query(`UPDATE vaults SET transport_membership_state='repair',
    transport_membership_updated_at=now(),updated_at=now()
    WHERE telegram_chat_id=$1 AND transport_bot_id IS NOT NULL`, [String(chatId)]);
  console.warn('[vault-recovery] inaccessible vault skipped', {
    phase,
    chat_id: String(chatId),
    code: 'MASTER_VAULT_NOT_FOUND',
    membership_repair: Number(result.rowCount || 0) > 0,
  });
  return true;
}

module.exports = { skipMissingVault };
