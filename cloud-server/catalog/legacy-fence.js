'use strict';
// T05-N — Capa 1 del cerco (NATIVO r2.1 §5.1): si el dueño tiene fila en catalog_libraries (cualquier autoridad) o el
// chat está registrado en catalog_library_chats, toda entrada C10 legacy se rechaza ANTES del primer efecto externo
// (Telegram, MASTER, temporales o SQL legacy). Siempre activa, también con el flag nativo apagado.
// HTTP responde 410 LEGACY_CLIENT_UNSUPPORTED; los helpers lanzan CatalogLegacyFenceError (status 410).
// La capa 0 (triggers 0027) es solo defensa en profundidad del ledger: no sustituye a esta capa.

const FENCE_CODE = 'LEGACY_CLIENT_UNSUPPORTED';
const FENCE_STATUS = 410;

class CatalogLegacyFenceError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CatalogLegacyFenceError';
    this.code = FENCE_CODE;
    this.status = FENCE_STATUS;
    this.detail = detail;
  }
}

const USER_SQL = 'SELECT 1 FROM catalog_libraries WHERE user_id=$1 /* catalog-legacy-fence */';
const CHAT_SQL = `SELECT 1 FROM catalog_libraries l JOIN vaults v ON v.user_id=l.user_id WHERE v.telegram_chat_id=$1
  UNION ALL SELECT 1 FROM catalog_library_chats c WHERE c.chat_id=$1 /* catalog-legacy-fence */`;

function normalize(value) {
  return String(value ?? '').trim();
}

// `pool` puede ser un pool o un cliente ya dentro de una transacción (para la comprobación bajo el lock del vault).
function createLegacyFence({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool or client is required for the catalog legacy fence.');

  async function isCatalogUser(userId, client = pool) {
    const uid = normalize(userId);
    if (!uid) return false;
    const r = await client.query(USER_SQL, [uid]);
    return Boolean(r?.rows?.length);
  }

  async function isCatalogChat(chatId, client = pool) {
    const chat = normalize(chatId);
    if (!chat) return false;
    const r = await client.query(CHAT_SQL, [chat]);
    return Boolean(r?.rows?.length);
  }

  async function assertUserNotCatalog(userId, { client = pool, entry = 'legacy' } = {}) {
    if (await isCatalogUser(userId, client)) {
      throw new CatalogLegacyFenceError(`Legacy INDEX entry ${entry} is not available for a PostgreSQL catalog library.`, { entry, by: 'user' });
    }
  }

  async function assertChatNotCatalog(chatId, { client = pool, entry = 'legacy' } = {}) {
    if (await isCatalogChat(chatId, client)) {
      throw new CatalogLegacyFenceError(`Legacy INDEX entry ${entry} is not available for a PostgreSQL catalog chat.`, { entry, by: 'chat' });
    }
  }

  // Comprueba usuario y chat (el que esté presente). Un solo punto para las entradas C10.
  async function assertLegacyEntryAllowed({ userId, chatId, client = pool, entry = 'legacy' } = {}) {
    if (normalize(userId)) await assertUserNotCatalog(userId, { client, entry });
    if (normalize(chatId)) await assertChatNotCatalog(chatId, { client, entry });
  }

  return Object.freeze({ isCatalogUser, isCatalogChat, assertUserNotCatalog, assertChatNotCatalog, assertLegacyEntryAllowed });
}

function isLegacyFenceError(error) {
  return Boolean(error) && error.code === FENCE_CODE && Number(error.status) === FENCE_STATUS;
}

// Respuesta HTTP uniforme para las rutas cuyo catch no propaga `status` (commit, bootstrap-state, topic, session/start).
function respondLegacyFence(res, error) {
  if (!isLegacyFenceError(error)) return false;
  res.status(FENCE_STATUS).json({ ok: false, code: FENCE_CODE, error: error.message });
  return true;
}

module.exports = {
  FENCE_CODE, FENCE_STATUS, CatalogLegacyFenceError, createLegacyFence, isLegacyFenceError, respondLegacyFence,
  __sql: Object.freeze({ USER_SQL, CHAT_SQL }),
};
