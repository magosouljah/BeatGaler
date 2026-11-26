'use strict';
// Existing-pool Telegram transport for native PostgreSQL libraries.
// Assignment is durable; Telegram invitation happens OUTSIDE SQL transactions,
// serialized by a per-vault advisory lock. A failed invitation leaves PENDING,
// never promotes a vault to READY without proof, and never rotates bot tokens.
const { requireUserId } = require('./contract');
const { CatalogQueryError } = require('./cursor');

const fail = (reason, status = 503) => new CatalogQueryError('CATALOG_UNAVAILABLE',
  status, 'library storage transport is not ready', { reason });

function createNativeTransportProvisioner({ pool, assignmentStore = null, transport = null, log = () => {} } = {}) {
  if (!pool || typeof pool.query !== 'function') throw Error('PostgreSQL pool is required');
  // Transporte y almacén de asignaciones se INYECTAN (server.js): catalog/ no importa transporte ni red (contrato T03).
  if (!assignmentStore || typeof assignmentStore.withMembershipLock !== 'function') throw Error('assignment store required');
  const store = assignmentStore;
  const gateway = transport;
  if (!gateway) throw Error('Telegram membership provider required');
  if (typeof gateway.ensureCatalogBotMembership !== 'function') throw Error('Telegram membership provider required');

  async function ensureForUser({ userId } = {}) {
    const uid = requireUserId(userId);
    const r = await pool.query(`SELECT c.chat_id, v.telegram_chat_id
       FROM catalog_libraries l
       JOIN vaults v ON v.user_id=l.user_id
       JOIN catalog_library_chats c ON c.user_id=l.user_id AND c.state='CURRENT'
       WHERE l.user_id=$1 AND l.authority='POSTGRES'`, [uid]);
    const row = r.rows[0];
    if (!row) throw fail('LIBRARY_NOT_PROVISIONED', 409);
    const chat = String(row.chat_id || '');
    if (!/^-100[0-9]+$/.test(chat) || chat !== String(row.telegram_chat_id || '')) {
      throw fail('VAULT_CHAT_MISMATCH', 409);
    }
    return store.withMembershipLock({ chatId: chat }, async () => {
      const a = (await pool.query('SELECT transport_bot_ids FROM catalog_native_activation')).rows;
      if (a.length !== 1) throw fail('CATALOG_NOT_ACTIVATED');
      let allowed;
      try { allowed = JSON.parse(a[0].transport_bot_ids); } catch { throw fail('BOT_ACTIVATION_INVALID'); }
      if (!Array.isArray(allowed) || !allowed.length) throw fail('BOT_ACTIVATION_INVALID');
      const current = await store.getAssignment({ chatId: chat });
      const assignment = current?.transportBotId ? current : await store.assignIfMissing({ chatId: chat });
      const bot = String(assignment?.transportBotId || '');
      if (!bot || !allowed.includes(bot)) throw fail('BOT_NOT_IN_NATIVE_ACTIVATION');
      const states = (await pool.query('SELECT quarantined, rotation_pending FROM transport_bots WHERE id=$1', [bot])).rows;
      if (states.length !== 1 || states[0].quarantined || states[0].rotation_pending) {
        throw fail('BOT_NOT_READY');
      }
      if (assignment.membershipState === 'ready') return { botId: bot, ready: true };
      try {
        const proof = await gateway.ensureCatalogBotMembership({ chatId: chat, botId: bot });
        if (proof?.ready !== true || String(proof.botId) !== bot) throw Error('PROOF_INVALID');
        await store.markMembershipReady({ chatId: chat }, bot);
        log('[catalog-transport] native bot membership ready');
        return { botId: bot, ready: true };
      } catch (error) {
        log('[catalog-transport] native bot membership pending', String(error?.code || error?.name || 'ERROR').slice(0, 48));
        throw fail('BOT_MEMBERSHIP_PENDING');
      }
    });
  }
  return Object.freeze({ ensureForUser });
}
function buildNativeTransportProvisioner(options = null) {
  return options ? createNativeTransportProvisioner(options) : null;
}
module.exports = { createNativeTransportProvisioner, buildNativeTransportProvisioner };
