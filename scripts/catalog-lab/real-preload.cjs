'use strict';
// LAB REAL (prueba integrada G3): preload para `cloud-server/server.js` (--require). Cloud real + PostgreSQL EFÍMERO del LAB + gateway REAL de
// Telegram (adaptador transport-gateway + sesión MTProto del Bot20 de pruebas) y MASTER de pruebas (solo lectura de la línea base), SOLO sobre el chat del
// descriptor T11-SANDBOX vigente. Las credenciales se leen del disco local ignorado por Git y viven únicamente en memoria de este proceso.
// Se niega fuera de NODE_ENV=development + BEATGALER_DEPLOYMENT_ENV=test, de la base del LAB, con G2 aprobado o sin descriptor/aprobación válidos.
// Cada mensaje enviado se anota en state/ledger.jsonl; la limpieza (real-cleanup.cjs) solo borra mensajes del ledger/posteriores a la línea base.
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lab-env.cjs');
const R = path.join(L.ROOT, 'cloud-server') + '/';
const cfg = JSON.parse(fs.readFileSync(L.CFG_FILE, 'utf8'));
if (process.env.LAB_REAL !== '1') throw new Error('real-preload: LAB_REAL=1 requerido');
if (process.env.NODE_ENV !== 'development' || process.env.BEATGALER_DEPLOYMENT_ENV !== 'test') throw new Error('real-preload: entorno no permitido');
if (process.env.DATABASE_URL !== cfg.databaseUrl || !new RegExp(`@127\\.0\\.0\\.1:${cfg.db.port}/lab_br_`).test(process.env.DATABASE_URL || '')) throw new Error('real-preload: DATABASE_URL no es la base del LAB');
if (String(process.env.BEATGALER_CATALOG_G2_APPROVED || '').toLowerCase() === 'true') throw new Error('STOP-GATE: G2_APPROVED debe permanecer desactivado');

const { loadDescriptor } = require(path.join(L.ROOT, 'scripts', 'catalog-transport-sandbox.cjs'));
const d = loadDescriptor(process.env.LAB_REAL_DESCRIPTOR, { env: process.env, execute: true });
if (String(cfg.account.chatId) !== String(d.chats[0])) throw new Error('STOP-ISOLATION: el vault del LAB no apunta al chat del descriptor');

const readKv = (file) => { const out = {}; for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); } return out; };
const CLOUD = path.join(L.ROOT, 'cloud-server');
const tgEnv = readKv(path.join(CLOUD, '.env.telegram-test'));
const apiId = Number(tgEnv.TELEGRAM_API_ID); const apiHash = tgEnv.TELEGRAM_API_HASH;
if (!Number.isSafeInteger(apiId) || !apiHash) throw new Error('real-preload: credenciales API de prueba incompletas');
if (String(tgEnv.BEATGALER_TEST_MASTER_USERNAME || '').toLowerCase() !== d.master.username.toLowerCase()) throw new Error('STOP-ISOLATION: MASTER local distinto del descriptor');
const poolJson = JSON.parse(fs.readFileSync(path.join(CLOUD, 'transport-bots.local.json'), 'utf8'));
const botCfg = poolJson.bots.find((b) => b.id === d.bot.id);
if (poolJson.bots.length !== 1 || !botCfg || String(botCfg.telegram_user_id) !== String(d.bot.telegramUserId)) throw new Error('STOP-ISOLATION: el pool local no contiene exactamente el bot del descriptor');
const botToken = botCfg.token;
const masterSession = fs.readFileSync(path.join(CLOUD, 'master-session.txt'), 'utf8').trim();

const telegram = require(R + 'node_modules/telegram');
const { StringSession } = require(R + 'node_modules/telegram/sessions');
const bigInt = require(R + 'node_modules/big-integer');
const { Api, TelegramClient } = telegram;
const sdk = { Api, bigInt };
const gatewayRuntime = require(R + 'catalog-gateway-runtime');
const catalogPurge = require(R + 'catalog/purge');
const catalogDirect = require(R + 'catalog/direct');
const catalogOperations = require(R + 'catalog/operations');
const catalogQueries = require(R + 'catalog/queries');
const catalogCommands = require(R + 'catalog/commands');
const { createCatalogWorker } = require(R + 'catalog/worker');

const ledgerFile = path.join(L.STATE_DIR, 'ledger.jsonl');
const ledger = (rec) => { try { fs.appendFileSync(ledgerFile, JSON.stringify({ at: new Date().toISOString(), chatId: String(d.chats[0]), ...rec }) + '\n'); } catch (_) { /* el ledger nunca rompe el flujo */ } };

const provider = gatewayRuntime.createRealBotClientProvider({
  credentialFor: async (botId) => { if (botId !== d.bot.id) throw Object.assign(new Error('bot fuera del descriptor'), { code: 'BOT_UNKNOWN', transient: false }); return { token: botToken, telegramUserId: String(d.bot.telegramUserId), credentialVersion: 1 }; },
  apiCredentials: () => ({ apiId, apiHash }),
});
let runtime = null; let gateway = null;
const getGateway = (pool) => {
  if (gateway) return gateway;
  runtime = gatewayRuntime.createGatewayRuntime({ pool, clientProvider: provider, sdk, log: console });
  gateway = runtime.gateway; // E77: solo metadatos (verificar, reconciliar, purgar, MAIN); los envíos son del navegador y no pasan por aquí
  return gateway;
};

// MASTER de pruebas: solo LECTURA para la línea base del chat (E77: PROJECT ya no se publica por MASTER; va por Direct B con el bot).
let masterP = null;
const openMaster = () => masterP || (masterP = (async () => { const c = new TelegramClient(new StringSession(masterSession), apiId, apiHash, { connectionRetries: 3, autoReconnect: true }); c.setLogLevel?.('none'); await c.connect(); const me = await c.getMe(); if (String(me.id) !== String(d.master.telegramUserId)) { await c.disconnect(); throw Object.assign(new Error('MASTER distinto del descriptor'), { code: 'MASTER_MISMATCH', effectPossible: false }); } return { client: c, id: String(me.id) }; })().catch((e) => { masterP = null; throw e; }));
const chatGuard = (chatId) => { if (String(chatId) !== String(d.chats[0])) throw Object.assign(new Error('STOP-ISOLATION: chat fuera del descriptor'), { effectPossible: false }); };
// Línea base: último mensaje del chat antes de operar (la limpieza nunca toca ids ≤ base).
(async () => { try { const m = await openMaster(); const h = await m.client.getMessages(await m.client.getInputEntity(d.chats[0]), { limit: 1 }); fs.writeFileSync(path.join(L.STATE_DIR, 'baseline.json'), JSON.stringify({ chatId: String(d.chats[0]), lastMessageId: h && h[0] ? Number(h[0].id) : 0, at: new Date().toISOString() })); console.log('[real] línea base registrada'); } catch (e) { console.error('[real] sin línea base:', e.code || e.message); } })();

const wrap = (mod, name, patch) => { const orig = mod[name]; mod[name] = (options) => orig(options && patch(options)); };
wrap(catalogOperations, 'configureCatalogOperations', (o) => ({ ...o, resolveAccess: async () => ({ maxBeats: null }) }));
// E75: el MAIN de prefijos lo sube el navegador; el Cloud solo usa el gateway para COMPROBAR el mensaje publicado (metadatos, sin bytes).
wrap(require(R + 'catalog/prefix-packs'), 'configurePrefixPacks', (o) => ({ ...o, gateway: getGateway(o.pool) }));
wrap(catalogPurge, 'configureCatalogPurge', (o) => ({ ...o, gateway: getGateway(o.pool) }));
// E77: único transporte de archivos = Direct B. El worker en proceso arranca al configurarse el plano directo; tope de PROJECT holgado en el LAB.
const origDirect = catalogDirect.configureCatalogDirect;
catalogDirect.configureCatalogDirect = (options) => {
  const transport = origDirect(options && { ...options, resolveProjectAccess: async () => ({ maxBytes: 200 * 1024 * 1024 }) });
  if (options && options.pool) getGateway(options.pool);
  if (transport) setTimeout(() => {
    const worker = createCatalogWorker({ pool: options.pool, operations: catalogOperations.currentCatalogOperations(), queries: catalogQueries.currentCatalogQueries(), commands: catalogCommands.currentCatalogCommands(), transport: gateway, purge: catalogPurge.currentCatalogPurge(), owner: 'lab-real-inproc', log: (...a) => console.warn('[real-worker]', ...a), options: { pollMs: 500, globalConcurrency: 2 } });
    worker.start?.(); global.__labReal = { worker, runtime };
    console.log('[real] worker en proceso activo; gateway REAL de solo metadatos (Bot20) sobre el chat del descriptor');
  }, 0);
  return transport;
};
// E72 Direct B real (solo LAB): la sesión directa del catálogo usa el token del Bot20 del descriptor (mismo origen que el gateway); sin pool legacy ni INDEX.
// La frontera temporal (productive-temp-auth-boundary) quita token/hash antes de responder al navegador: éste solo recibe el bloque de vinculación.
if (String(process.env.BEATGALER_CATALOG_DIRECT_ENABLED || '').toLowerCase() === 'true') {
  const catalogTransport = require(R + 'catalog-telegram-transport').getCatalogTelegramTransport();
  const crypto = require('node:crypto');
  catalogTransport.catalogDirectSession = async ({ botId, chatId, sessionId = null }) => {
    if (botId !== d.bot.id) throw Object.assign(new Error('bot fuera del descriptor'), { code: 'BOT_UNKNOWN', transient: false });
    chatGuard(chatId);
    return { ok: true, mode: 'catalog-v1-direct', session_id: sessionId || `cdirect-${crypto.createHash('sha256').update(`${botId}|${chatId}`).digest('hex').slice(0, 24)}`,
      transport_id: String(botId), transport_user_id: String(d.bot.telegramUserId), transport_username: null, chat_id: String(chatId),
      bot_token: botToken, telegram_api_id: apiId, telegram_api_hash: apiHash, resolver_chat_id: null, generation: 1, credential_version: 1,
      heartbeat_interval_ms: 30000, heartbeat_timeout_ms: 90000, token_rotation_enabled: false, lease_state: 'ACTIVE' };
  };
  console.log('[real] Direct B real: sesión del catálogo servida con el Bot20 del descriptor (G2 NO aprobado)');
}
process.on('exit', () => { try { runtime && runtime.close(); } catch (_) { /* cierre best-effort */ } });
console.log('[real] preload activo: gateway Telegram REAL de pruebas (descriptor ' + d.approvalId + '), G2 NO aprobado');
