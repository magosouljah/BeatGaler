'use strict';
// LAB REAL (prueba integrada G3): preload para `cloud-server/server.js` (--require). Cloud real + PostgreSQL EFÍMERO del LAB + gateway REAL de
// Telegram (adaptador transport-gateway + sesión MTProto del Bot20 de pruebas) y MASTER de pruebas para PROJECT, SOLO sobre el chat del
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
const { CustomFile } = require(R + 'node_modules/telegram/client/uploads');
const bigInt = require(R + 'node_modules/big-integer');
const { Api, TelegramClient } = telegram;
const sdk = { Api, bigInt, CustomFile };
const gatewayRuntime = require(R + 'catalog-gateway-runtime');
const catalogMedia = require(R + 'catalog/media');
const catalogPurge = require(R + 'catalog/purge');
const catalogTransport = require(R + 'catalog/transport');
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
  const g = runtime.gateway;
  gateway = Object.freeze({ ...g, async sendPart(args) { try { const r = await g.sendPart(args); ledger({ via: 'bot', op: args.operationId, partKey: args.partKey, messageId: r && r.messageId }); return r; } catch (e) { ledger({ via: 'bot', op: args.operationId, partKey: args.partKey, error: e && e.code }); throw e; } } });
  return gateway;
};

// MASTER de pruebas (PROJECT): sesión perezosa, mismo chat del descriptor.
let masterP = null;
const openMaster = () => masterP || (masterP = (async () => { const c = new TelegramClient(new StringSession(masterSession), apiId, apiHash, { connectionRetries: 3, autoReconnect: true }); c.setLogLevel?.('none'); await c.connect(); const me = await c.getMe(); if (String(me.id) !== String(d.master.telegramUserId)) { await c.disconnect(); throw Object.assign(new Error('MASTER distinto del descriptor'), { code: 'MASTER_MISMATCH', effectPossible: false }); } return { client: c, id: String(me.id) }; })().catch((e) => { masterP = null; throw e; }));
const chatGuard = (chatId) => { if (String(chatId) !== String(d.chats[0])) throw Object.assign(new Error('STOP-ISOLATION: chat fuera del descriptor'), { effectPossible: false }); };
const master = {
  async resolveSenderId({ chatId }) { chatGuard(chatId); return (await openMaster()).id; },
  async publishProjectFile({ chatId, filePath, filename, sizeBytes, sha256, caption }) {
    chatGuard(chatId); const m = await openMaster();
    let entity; try { entity = await m.client.getInputEntity(chatId); } catch (_) { entity = new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt(0) }); }
    const sent = await m.client.sendFile(entity, { file: new CustomFile(path.basename(String(filename || 'project.zip')), sizeBytes, filePath), forceDocument: true, caption, workers: 1 });
    const id = Number(sent && sent.id); const documentId = String(sent && sent.media && sent.media.document && sent.media.document.id || '');
    ledger({ via: 'master', messageId: id, caption: String(caption || '').slice(0, 120) });
    if (!Number.isSafeInteger(id) || id <= 0 || !documentId) throw new Error('MASTER no devolvió documento PROJECT');
    const sz = Number(sent.media.document.size);
    return { messageId: id, documentId, senderId: sent.fromId && sent.fromId.userId != null ? String(sent.fromId.userId) : m.id, sizeBytes: Number.isSafeInteger(sz) && sz > 0 ? sz : sizeBytes };
  },
};

// Línea base: último mensaje del chat antes de operar (la limpieza nunca toca ids ≤ base).
(async () => { try { const m = await openMaster(); const h = await m.client.getMessages(await m.client.getInputEntity(d.chats[0]), { limit: 1 }); fs.writeFileSync(path.join(L.STATE_DIR, 'baseline.json'), JSON.stringify({ chatId: String(d.chats[0]), lastMessageId: h && h[0] ? Number(h[0].id) : 0, at: new Date().toISOString() })); console.log('[real] línea base registrada'); } catch (e) { console.error('[real] sin línea base:', e.code || e.message); } })();

const wrap = (mod, name, patch) => { const orig = mod[name]; mod[name] = (options) => orig(options && patch(options)); };
wrap(catalogMedia, 'configureCatalogMedia', (o) => ({ ...o, gateway: getGateway(o.pool) }));
wrap(catalogOperations, 'configureCatalogOperations', (o) => ({ ...o, resolveAccess: async () => ({ maxBeats: null }) }));
wrap(catalogPurge, 'configureCatalogPurge', (o) => ({ ...o, gateway: getGateway(o.pool) }));
const origTransport = catalogTransport.configureCatalogTransport;
catalogTransport.configureCatalogTransport = (options) => {
  const transport = origTransport(options && { ...options, gateway: getGateway(options.pool), master, resolveProjectAccess: async () => ({ maxBytes: 200 * 1024 * 1024 }) });
  if (transport) setTimeout(() => {
    const worker = createCatalogWorker({ pool: options.pool, operations: catalogOperations.currentCatalogOperations(), queries: catalogQueries.currentCatalogQueries(), commands: catalogCommands.currentCatalogCommands(), transport: gateway, purge: catalogPurge.currentCatalogPurge(), owner: 'lab-real-inproc', log: (...a) => console.warn('[real-worker]', ...a), options: { pollMs: 500, globalConcurrency: 2 } });
    worker.start?.(); global.__labReal = { worker, runtime };
    console.log('[real] worker en proceso activo; gateway REAL (Bot20) sobre el chat del descriptor');
  }, 0);
  return transport;
};
process.on('exit', () => { try { runtime && runtime.close(); } catch (_) { /* cierre best-effort */ } });
console.log('[real] preload activo: gateway Telegram REAL de pruebas (descriptor ' + d.approvalId + '), G2 NO aprobado');
