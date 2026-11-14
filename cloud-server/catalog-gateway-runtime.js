'use strict';
// T16/T11 — Conexión del gateway real de medios (NATIVO r2.1 §8.6) a server.js y al worker. Enrutador por chat sobre el adaptador
// `createTelegramGateway` (T11): el chat de cada biblioteca (vaults.telegram_chat_id) determina el bot de transporte asignado
// (vaults.transport_bot_id) y el envío/lectura/borrado se hace con la sesión MTProto de ESE bot. Ningún token sale del proceso.
//  - Apagado por defecto: sin BEATGALER_CATALOG_GATEWAY_ENABLED=true no se monta nada (fail-closed, 503 / jobs en reintento).
//  - En producción exige además BEATGALER_CATALOG_G2_APPROVED=true (dictamen G2): G2 sigue NOT_PROVEN, el cercado no se declara aquí.
//  - Clientes perezosos: no se abre ninguna sesión (ni se lee ningún token) hasta la primera operación real.
//  - Bots en cuarentena o con rotación pendiente se rechazan antes de cualquier efecto externo.
//  - Sin `proveUniqueMatch`: toda reconciliación por búsqueda sigue en revisión manual (Opción A, E5).
const { createTelegramGateway, GatewayError } = require('./catalog/transport-gateway');

const GATEWAY_FLAG = 'BEATGALER_CATALOG_GATEWAY_ENABLED';
const G2_FLAG = 'BEATGALER_CATALOG_G2_APPROVED';
const isTrue = (v) => String(v || '').trim().toLowerCase() === 'true';
const isProduction = (env) => ['production', 'prod'].includes(String(env.BEATGALER_DEPLOYMENT_ENV || env.NODE_ENV || '').trim().toLowerCase());

function gatewayEnabled(env = process.env) { return isTrue(env[GATEWAY_FLAG]); }

// Guarda de arranque: devuelve null si el gateway está apagado; lanza STOP-* si está encendido sin condiciones.
function assertGatewayAllowed(env = process.env) {
  if (!gatewayEnabled(env)) return false;
  if (isProduction(env) && !isTrue(env[G2_FLAG])) throw new Error(`STOP-GATE: ${GATEWAY_FLAG}=true in production requires ${G2_FLAG}=true (independent G2 verdict); refusing to start.`);
  return true;
}

function createGatewayRuntime({ pool, clientProvider, sdk, log = null, chatTtlMs = 30_000, now = () => Date.now() } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('gateway runtime requires a PostgreSQL pool');
  if (!clientProvider || typeof clientProvider.open !== 'function') throw new Error('gateway runtime requires clientProvider.open(botId)');
  if (!sdk || !sdk.Api || typeof sdk.bigInt !== 'function') throw new Error('gateway runtime requires sdk { Api, bigInt }');
  const chatCache = new Map(); // chatId -> { botId, until }
  const bots = new Map(); // botId -> Promise<{ gateway, client }>
  const metrics = { routed: 0, botsOpened: 0, botOpenFailures: 0, botsDropped: 0, rejectedBot: 0, unresolvedChat: 0 };
  const warn = (event, fields) => { if (log && typeof log.warn === 'function') log.warn('catalog-gateway-runtime', { event, ...fields }); };

  // chat → bot de transporte asignado (SQL es la única autoridad). Nunca se elige un bot "por intuición" si la fila falta.
  async function botForChat(chatId) {
    const key = String(chatId == null ? '' : chatId);
    if (!/^-?[0-9]{1,20}$/.test(key)) throw new GatewayError('CHAT_INVALID', 'chatId must be a numeric Telegram chat id', { transient: false });
    const hit = chatCache.get(key);
    if (hit && hit.until > now()) return hit.botId;
    const r = (await pool.query('SELECT v.transport_bot_id AS bot_id, b.quarantined, b.rotation_pending FROM vaults v LEFT JOIN transport_bots b ON b.id = v.transport_bot_id WHERE v.telegram_chat_id = $1', [key])).rows[0];
    if (!r || !r.bot_id) { metrics.unresolvedChat++; throw new GatewayError('CHAT_BOT_UNRESOLVED', 'no transport bot is assigned to this chat', { transient: false, status: 404 }); }
    if (r.quarantined) { metrics.rejectedBot++; throw new GatewayError('BOT_QUARANTINED', 'the assigned transport bot is quarantined', { transient: false, status: 403 }); }
    if (r.rotation_pending) { metrics.rejectedBot++; throw new GatewayError('BOT_ROTATION_PENDING', 'the assigned transport bot is being rotated', { transient: true, retryAfterMs: 60_000, status: 503 }); }
    chatCache.set(key, { botId: String(r.bot_id), until: now() + chatTtlMs });
    return String(r.bot_id);
  }

  async function openBot(botId) {
    let opened;
    try { opened = await clientProvider.open(botId); } catch (error) {
      metrics.botOpenFailures++; warn('BOT_OPEN_FAILED', { botId, code: error && error.code ? String(error.code).slice(0, 40) : 'ERROR' });
      throw new GatewayError('GATEWAY_BOT_UNAVAILABLE', 'the transport bot session could not be opened', { transient: error && error.transient === false ? false : true, retryAfterMs: 30_000, status: 503 });
    }
    const senderId = String(opened.telegramUserId || '');
    if (!/^[0-9]{1,20}$/.test(senderId)) throw new GatewayError('BOT_IDENTITY_INVALID', 'the bot session did not report a numeric identity', { transient: false });
    const client = opened.client;
    const resolvePeer = async (chatId) => {
      let peer = null;
      if (typeof client.getInputEntity === 'function') { try { peer = await client.getInputEntity(chatId); } catch (_) { peer = null; } }
      if (!peer) peer = new sdk.Api.InputPeerChannel({ channelId: sdk.bigInt(String(chatId).replace(/^-100/, '')), accessHash: sdk.bigInt(0) });
      return { peer, channel: true };
    };
    metrics.botsOpened++;
    return { gateway: createTelegramGateway({ client, sdk, senderId, botId, resolvePeer, log }), client };
  }

  function dropBot(botId, why) {
    const p = bots.get(botId); if (!p) return;
    bots.delete(botId); metrics.botsDropped++; warn('BOT_DROPPED', { botId, why });
    p.then(({ client }) => { if (client && typeof client.disconnect === 'function') return client.disconnect(); return null; }).catch(() => {});
  }

  async function routeFor(chatId) {
    const botId = await botForChat(chatId);
    let p = bots.get(botId);
    if (!p) { p = openBot(botId); bots.set(botId, p); p.catch(() => { if (bots.get(botId) === p) bots.delete(botId); }); }
    metrics.routed++;
    return { botId, ...(await p) };
  }

  const call = (method) => async (args = {}) => {
    const { botId, gateway } = await routeFor(args.chatId);
    try { return await gateway[method](args); } catch (error) {
      if (error && error.code === 'CREDENTIAL_REVOKED') { chatCache.clear(); dropBot(botId, 'CREDENTIAL_REVOKED'); }
      throw error;
    }
  };

  const gateway = Object.freeze({
    sendPart: call('sendPart'), verifyMessage: call('verifyMessage'), searchByRandomId: call('searchByRandomId'),
    downloadPart: call('downloadPart'), deleteMessage: call('deleteMessage'), probeAbsence: call('probeAbsence'),
    metrics, runtime: Object.freeze({ botsOpen: () => bots.size }),
  });
  async function close() {
    const all = [...bots.keys()]; for (const id of all) dropBot(id, 'CLOSE');
    if (typeof clientProvider.close === 'function') await clientProvider.close().catch(() => {});
  }
  return Object.freeze({ gateway, close, botForChat, metrics });
}

// Proveedor real: sesión MTProto de bot con el token del pool existente (resuelto bajo demanda por `credentialFor`). El token solo vive
// en memoria del cliente; nunca se registra ni se devuelve. La identidad real (getMe) debe coincidir con la declarada en el pool.
function createRealBotClientProvider({ credentialFor, apiCredentials, telegram = null } = {}) {
  if (typeof credentialFor !== 'function') throw new Error('credentialFor(botId) is required');
  const clients = new Set();
  return {
    async open(botId) {
      const tg = telegram || { ...require('telegram'), StringSession: require('telegram/sessions').StringSession };
      const { apiId, apiHash } = apiCredentials();
      const cred = await credentialFor(botId);
      const client = new tg.TelegramClient(new tg.StringSession(''), apiId, apiHash, { connectionRetries: 5, autoReconnect: true });
      if (typeof client.setLogLevel === 'function') client.setLogLevel('none');
      clients.add(client);
      try {
        await client.connect();
        await client.start({ botAuthToken: cred.token });
        const me = await client.getMe();
        if (cred.telegramUserId && String(me.id) !== String(cred.telegramUserId)) throw Object.assign(new Error('bot session identity differs from the pool'), { code: 'BOT_IDENTITY_MISMATCH', transient: false });
        return { client, telegramUserId: String(me.id) };
      } catch (error) { clients.delete(client); try { await client.disconnect(); } catch (_) {} throw error; }
    },
    async close() { for (const c of clients) { try { await c.disconnect(); } catch (_) {} } clients.clear(); },
  };
}

// Montaje desde entorno. Devuelve null si está apagado. `credentialFor` por defecto = pool de transporte vigente (direct-transport-control).
function gatewayFromEnv({ pool, env = process.env, log = null, credentialFor = null, clientProvider = null, sdk = null } = {}) {
  if (!assertGatewayAllowed(env)) return null;
  if (!pool) throw new Error('STOP-ENV: the catalog gateway requires the PostgreSQL control plane');
  const sdkReal = sdk || (() => { const { Api } = require('telegram'); const { CustomFile } = require('telegram/client/uploads'); return { Api, bigInt: require('big-integer'), CustomFile }; })();
  const provider = clientProvider || createRealBotClientProvider({
    credentialFor: credentialFor || ((botId) => require('./direct-transport-control').catalogBotCredential(botId)),
    apiCredentials: () => { const apiId = Number(env.TELEGRAM_API_ID); const apiHash = String(env.TELEGRAM_API_HASH || ''); if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) throw Object.assign(new Error('Telegram API credentials are missing'), { code: 'API_CREDENTIALS_MISSING', transient: false }); return { apiId, apiHash }; },
  });
  return createGatewayRuntime({ pool, clientProvider: provider, sdk: sdkReal, log });
}

// Access para PROJECT (mismo criterio que project-access.js): plan con upload_project y tope de bytes vigente.
function createProjectAccessResolver({ resolveUserAccess } = {}) {
  if (typeof resolveUserAccess !== 'function') throw new Error('resolveUserAccess is required');
  return async (userId) => {
    const access = await resolveUserAccess({ id: userId });
    const maxBytes = access && access.quotas ? access.quotas.max_project_zip_bytes : null;
    if (!access || !access.capabilities || !access.capabilities.upload_project || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw Object.assign(new Error('PROJECT upload is not available on this plan.'), { code: 'PROJECT_UPLOAD_DENIED', status: 403 });
    }
    return { maxBytes };
  };
}

module.exports = Object.freeze({ GATEWAY_FLAG, G2_FLAG, gatewayEnabled, assertGatewayAllowed, createGatewayRuntime, createRealBotClientProvider, gatewayFromEnv, createProjectAccessResolver });
