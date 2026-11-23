'use strict';

const crypto = require('node:crypto');

// Share the existing pool, MASTER and token cache with the legacy transport.
function createCatalogTelegramTransport({
  loadPool,
  stateSnapshot,
  tokenForCredentialVersion,
  apiCredentials,
  heartbeatIntervalMs,
  heartbeatTimeoutMs,
  resolveBotIdentityViaHttp,
  masterForVault,
  Api,
  inviteAndPromote,
  managerBotApiCall,
  botMembershipError,
  wait,
}) {
  // Catálogo nativo (gateway de servidor, NATIVO r2.1 §8.6): credencial vigente de un bot del pool, solo lectura y bajo demanda. El token
  // nunca se registra ni se persiste; la versión de credencial acompaña para que una rotación invalide la sesión del gateway.
  async function catalogBotCredential(botId) {
    const pool = loadPool();
    const bot = pool.find(item => item.id === String(botId));
    if (!bot) throw Object.assign(new Error(`Unknown transport bot ${botId}.`), { code: 'BOT_UNKNOWN', transient: false });
    const botState = stateSnapshot(pool).bots[bot.id];
    const token = await tokenForCredentialVersion(bot, botState.credential_version);
    return { token, telegramUserId: bot.telegram_user_id || null, credentialVersion: botState.credential_version };
  }

  // Direct B (catálogo): forma interna de sesión que consume la frontera de autorización temporal (productive-temp-auth-boundary.js).
  // Las credenciales permanentes NUNCA salen del proceso: la frontera las elimina y entrega solo el bloque de vinculación.
  // Sin lease legacy, sin INDEX, sin MASTER: el bot es el asignado a la biblioteca (vaults.transport_bot_id), el mismo del gateway.
  async function catalogDirectSession({ botId, chatId, sessionId = null }) {
    const cred = await catalogBotCredential(botId);
    const { apiId, apiHash } = apiCredentials();
    return {
      ok: true,
      mode: 'catalog-v1-direct',
      // Estable por (bot, chat): el cliente exige que el bootstrap y la vinculación describan el mismo lease; no es un secreto ni un lease legacy.
      session_id: sessionId || `cdirect-${crypto.createHash('sha256').update(`${botId}|${chatId}`).digest('hex').slice(0, 24)}`,
      transport_id: String(botId),
      transport_user_id: cred.telegramUserId || null,
      transport_username: null,
      chat_id: String(chatId),
      bot_token: cred.token,
      telegram_api_id: apiId,
      telegram_api_hash: apiHash,
      resolver_chat_id: null,
      generation: 1,
      credential_version: cred.credentialVersion,
      heartbeat_interval_ms: heartbeatIntervalMs,
      heartbeat_timeout_ms: heartbeatTimeoutMs,
      token_rotation_enabled: false,
      lease_state: 'ACTIVE',
    };
  }

  // Native PostgreSQL: establish one assigned bot's membership in its exact
  // existing Telegram storage group. Does NOT rotate tokens, create/delete
  // messages, touch INDEX, or change bot assignments.
  async function ensureCatalogBotMembership({ chatId, botId }) {
    const chat = String(chatId || '').trim();
    const id = String(botId || '').trim();
    if (!/^-100[0-9]+$/.test(chat) || !id) throw new Error('CATALOG_TRANSPORT_TARGET_INVALID');
    const cred = await catalogBotCredential(id);
    const identity = await resolveBotIdentityViaHttp(cred.token);
    if (cred.telegramUserId && String(identity.telegram_user_id) !== String(cred.telegramUserId)) {
      const e = new Error('CATALOG_TRANSPORT_BOT_IDENTITY_MISMATCH'); e.code = 'BOT_IDENTITY_MISMATCH'; throw e;
    }
    if (!identity.telegram_username) throw new Error('CATALOG_TRANSPORT_BOT_USERNAME_MISSING');
    const master = await masterForVault(chat);
    try {
      const botEntity = await master.client.getEntity('@' + identity.telegram_username);
      await inviteAndPromote(master.client, master.vault, botEntity);
      const participant = await master.client.invoke(new Api.channels.GetParticipant({
        channel: master.vault, participant: botEntity,
      }));
      if (!participant?.participant) throw new Error('CATALOG_TRANSPORT_MASTER_MEMBERSHIP_UNVERIFIED');
    } finally {
      try { await master.client.disconnect(); } catch (_) {}
    }
    for (let n = 0; n < 8; n++) {
      try {
        const observed = await managerBotApiCall(cred.token, 'getChat', { chat_id: chat });
        if (String(observed?.id || '') === chat) return { ready: true, botId: id };
        throw new Error('CATALOG_TRANSPORT_BOT_CHAT_MISMATCH');
      } catch (error) {
        if (n === 7 || !botMembershipError(error).absent) throw error;
        await wait(Math.min(1500, 250 * (n + 1)));
      }
    }
    throw new Error('CATALOG_TRANSPORT_BOT_MEMBERSHIP_NOT_VISIBLE');
  }

  return { catalogBotCredential, catalogDirectSession, ensureCatalogBotMembership };
}

module.exports = { createCatalogTelegramTransport };
