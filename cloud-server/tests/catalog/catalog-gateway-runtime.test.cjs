'use strict';
// T16/T11 — Conexión del gateway real (enrutador por chat/bot, cliente perezoso, guardas de arranque). Sin red, sin credenciales reales:
// pool SQL falso + servidor MTProto FAKE detrás del adaptador real `createTelegramGateway`. Etiqueta FAKE: no es evidencia de proveedor (G2 NOT_PROVEN).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const rt = require('../../catalog-gateway-runtime.js');
const g = require('../../catalog/transport-gateway.js');
const telegramOp = require('../../operator/telegram-file-io.js');
const { createProjectAccessResolver } = require('../../catalog/direct.js');
const { createFakeTelegramServer } = require('../helpers/catalog-fake-mtproto.cjs');
const { Api } = require(path.join(__dirname, '..', '..', 'node_modules', 'telegram'));
const bigInt = require(path.join(__dirname, '..', '..', 'node_modules', 'big-integer'));
const sdk = { Api, bigInt };
const TOKEN = '123456789:AAFakeTokenFakeTokenFakeTokenFakeToken00';

function fakePool(map) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push(params[0]); const r = map[params[0]]; return { rows: r ? [r] : [] }; } };
}
const vault = (botId, extra = {}) => ({ bot_id: botId, quarantined: false, rotation_pending: false, ...extra });
function provider(server, { fail = null, numeric = null } = {}) {
  const opened = [];
  return {
    opened,
    async open(botId) {
      opened.push(botId);
      const f = fail && fail(botId); if (f) throw f;
      const selfId = numeric ? numeric(botId) : botId.replace(/\D/g, '');
      const client = server.session({ selfId }); client.disconnected = false; client.disconnect = async () => { client.disconnected = true; };
      return { client, telegramUserId: selfId };
    },
    async close() { this.closed = true; },
  };
}
const file = (n = 100) => ({ name: 'a.mp3', size: n, buffer: Buffer.alloc(n, 1) });
// El «navegador» (sesión propia del bot en el fake) es quien crea mensajes; el router del Cloud solo hace RPC de metadatos.
const seed = (server, selfId, chatId, operationId = 'op1') => telegramOp.createOperatorTelegram({ client: server.session({ selfId }), sdk, senderId: selfId, resolvePeer: async () => ({ peer: new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100?/, '')), accessHash: bigInt('7') }), channel: true }) }).sendPart({ operationId, partKey: 'm0', randomId: g.newRandomId(), chatId, file: file(), mimeType: 'audio/mpeg', fileName: 'a.mp3' });
// Efecto enrutado (revalida el bot en SQL en cada llamada): borrar un id inexistente no cambia nada en el fake.
const effect = (gw, chatId, messageId = 999_999) => gw.deleteMessage({ chatId, messageId });

test('guardas de arranque: apagado por defecto; encendido exige plano PG; producción exige dictamen G2', () => {
  assert.equal(rt.gatewayFromEnv({ pool: {}, env: {} }), null);
  assert.equal(rt.gatewayFromEnv({ pool: {}, env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'false' } }), null);
  assert.throws(() => rt.gatewayFromEnv({ pool: null, env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'true' } }), /STOP-ENV/);
  assert.throws(() => rt.gatewayFromEnv({ pool: fakePool({}), env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'true', NODE_ENV: 'production' }, clientProvider: provider(createFakeTelegramServer()), sdk }), /STOP-GATE/);
  assert.throws(() => rt.assertGatewayAllowed({ BEATGALER_CATALOG_GATEWAY_ENABLED: 'true', BEATGALER_DEPLOYMENT_ENV: 'production' }), /STOP-GATE/);
  const ok = rt.gatewayFromEnv({ pool: fakePool({}), env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'true', NODE_ENV: 'production', BEATGALER_CATALOG_G2_APPROVED: 'true' }, clientProvider: provider(createFakeTelegramServer()), sdk });
  assert.ok(ok && ok.gateway);
  assert.equal(rt.gatewayFromEnv({ pool: fakePool({}), env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'true', NODE_ENV: 'development' }, clientProvider: provider(createFakeTelegramServer()), sdk }).gateway.verifyMessage.constructor.name, 'AsyncFunction');
});

test('owner-risk exception is explicit and never equals G2 approval', () => {
  const base = {
    NODE_ENV: 'production', BEATGALER_CATALOG_GATEWAY_ENABLED: 'true',
    BEATGALER_CATALOG_G2_APPROVED: 'false',
    BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED: 'true',
  };
  assert.throws(() => rt.assertGatewayAllowed(base), /STOP-GATE/);
  assert.equal(rt.assertGatewayAllowed({ ...base, BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }), true);
  assert.equal(rt.G2_FLAG, 'BEATGALER_CATALOG_G2_APPROVED');
  assert.equal(rt.OWNER_EXCEPTION_FLAG, 'BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED');
});

test('cliente perezoso y enrutado por chat: cada biblioteca usa la sesión de SU bot; sin proveUniqueMatch; interfaz SOLO de metadatos (E77)', async () => {
  const server = createFakeTelegramServer(); const prov = provider(server);
  const pool = fakePool({ '-1001': vault('Bot20'), '-1002': vault('Bot21') });
  const { gateway } = rt.createGatewayRuntime({ pool, clientProvider: prov, sdk });
  assert.deepEqual(prov.opened, [], 'ninguna sesión ni credencial se toca hasta la primera operación');
  assert.deepEqual(Object.keys(gateway).filter((k) => typeof gateway[k] === 'function').sort(), ['deleteMessage', 'probeAbsence', 'searchByRandomId', 'verifyMessage'], 'sin envío ni descarga de bytes');
  assert.equal(gateway.proveUniqueMatch, undefined, 'sin prueba de unicidad la reconciliación por búsqueda sigue en revisión manual (E5 opción A)');
  const m1 = await seed(server, '20', '-1001'); const m2 = await seed(server, '21', '-1002', 'op2');
  assert.equal((await gateway.verifyMessage({ chatId: '-1001', messageId: m1.messageId, senderId: 'Bot20' })).size, 100);
  assert.equal((await gateway.verifyMessage({ chatId: '-1002', messageId: m2.messageId, senderId: 'Bot21' })).size, 100);
  await gateway.verifyMessage({ chatId: '-1001', messageId: m1.messageId, senderId: 'Bot20' });
  assert.deepEqual(prov.opened, ['Bot20', 'Bot21'], 'una sesión por bot, reutilizada');
  assert.equal(pool.calls.filter((c) => c === '-1001').length, 1, 'las lecturas del mismo chat salen de la caché corta');
  await effect(gateway, '-1001'); await effect(gateway, '-1001');
  assert.equal(pool.calls.filter((c) => c === '-1001').length, 3, 'cada efecto (borrado) revalida en SQL');
});

test('fail-closed antes de abrir sesión: chat sin bot, bot en cuarentena, rotación pendiente y chat inválido', async () => {
  const server = createFakeTelegramServer(); const prov = provider(server);
  const pool = fakePool({ '-1001': vault('Bot20', { quarantined: true }), '-1002': vault('Bot21', { rotation_pending: true }), '-1003': { bot_id: null } });
  const { gateway } = rt.createGatewayRuntime({ pool, clientProvider: prov, sdk });
  await assert.rejects(effect(gateway, '-1999'), (e) => e.code === 'CHAT_BOT_UNRESOLVED' && e.transient === false);
  await assert.rejects(effect(gateway, '-1003'), (e) => e.code === 'CHAT_BOT_UNRESOLVED');
  await assert.rejects(effect(gateway, '-1001'), (e) => e.code === 'BOT_QUARANTINED' && e.transient === false);
  await assert.rejects(effect(gateway, '-1002'), (e) => e.code === 'BOT_ROTATION_PENDING' && e.transient === true);
  await assert.rejects(effect(gateway, 'abc; DROP'), (e) => e.code === 'CHAT_INVALID');
  await assert.rejects(gateway.verifyMessage({ chatId: '-1001', messageId: 5 }), (e) => e.code === 'BOT_QUARANTINED');
  assert.deepEqual(prov.opened, [], 'ningún rechazo abrió sesión ni leyó credenciales');
  assert.equal(server.messages().length, 0);
});

test('fallo al abrir sesión: transitorio, sin filtrar el secreto, no se cachea y el siguiente intento reabre', async () => {
  const server = createFakeTelegramServer(); let n = 0;
  const prov = provider(server, { fail: () => (++n === 1 ? Object.assign(new Error(`AUTH ${TOKEN}`), { code: 'ECONNRESET' }) : null) });
  const { gateway } = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: prov, sdk });
  await assert.rejects(effect(gateway, '-1001'), (e) => { assert.equal(e.code, 'GATEWAY_BOT_UNAVAILABLE'); assert.equal(e.transient, true); assert.ok(!JSON.stringify([e.message, e.detail, e.stack]).includes(TOKEN), 'el token no aparece en el error'); return true; });
  assert.equal((await effect(gateway, '-1001')).requested, true);
  assert.deepEqual(prov.opened, ['Bot20', 'Bot20']);
  // fallo permanente declarado por el proveedor (identidad distinta) → no transitorio
  const bad = provider(server, { fail: () => Object.assign(new Error('x'), { code: 'BOT_IDENTITY_MISMATCH', transient: false }) });
  const r2 = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: bad, sdk });
  await assert.rejects(effect(r2.gateway, '-1001'), (e) => e.code === 'GATEWAY_BOT_UNAVAILABLE' && e.transient === false);
  // identidad no numérica → cerrado
  const odd = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: { async open() { return { client: server.session({ selfId: '20' }), telegramUserId: 'abc' }; } }, sdk });
  await assert.rejects(effect(odd.gateway, '-1001'), (e) => e.code === 'BOT_IDENTITY_INVALID');
});

test('credencial revocada: la sesión se descarta y desconecta; la siguiente operación reabre (token nuevo del pool)', async () => {
  const server = createFakeTelegramServer(); const prov = provider(server); const clients = [];
  const origOpen = prov.open.bind(prov); prov.open = async (b) => { const o = await origOpen(b); clients.push(o.client); return o; };
  const { gateway, close } = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: prov, sdk });
  assert.equal((await effect(gateway, '-1001')).requested, true);
  server.revokeBot('20');
  await assert.rejects(effect(gateway, '-1001'), (e) => e.code === 'CREDENTIAL_REVOKED');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(clients[0].disconnected, true, 'sesión revocada desconectada');
  assert.equal(gateway.runtime.botsOpen(), 0);
  await close();
  assert.equal(prov.closed, true);
});

test('proveedor real: token solo hacia start(); identidad distinta o fallo → se desconecta y no se filtra', async () => {
  const log = []; let me = '20'; let failStart = false;
  class FakeClient { constructor() { this.session = {}; } setLogLevel() {} async connect() { log.push('connect'); } async start(o) { log.push(`start:${o.botAuthToken === TOKEN}`); if (failStart) throw new Error(`bad ${o.botAuthToken}`); } async getMe() { return { id: me }; } async disconnect() { log.push('disconnect'); } }
  const telegram = { TelegramClient: FakeClient, StringSession: class {} };
  const p = rt.createRealBotClientProvider({ credentialFor: async () => ({ token: TOKEN, telegramUserId: '20' }), apiCredentials: () => ({ apiId: 1, apiHash: 'h' }), telegram });
  const o = await p.open('Bot20'); assert.equal(o.telegramUserId, '20'); assert.deepEqual(log, ['connect', 'start:true']);
  me = '99'; log.length = 0;
  await assert.rejects(p.open('Bot20'), (e) => e.code === 'BOT_IDENTITY_MISMATCH' && e.transient === false); assert.ok(log.includes('disconnect'));
  me = '20'; failStart = true; log.length = 0;
  await assert.rejects(p.open('Bot20')); assert.ok(log.includes('disconnect'));
  await p.close();
  const noCreds = rt.createRealBotClientProvider({ credentialFor: async () => ({ token: TOKEN }), apiCredentials: () => { throw Object.assign(new Error('missing'), { code: 'API_CREDENTIALS_MISSING' }); }, telegram });
  await assert.rejects(noCreds.open('Bot20'), (e) => e.code === 'API_CREDENTIALS_MISSING');
});

test('Access de PROJECT: plan con upload_project y tope de bytes; si no, 403 PROJECT_UPLOAD_DENIED', async () => {
  const ok = createProjectAccessResolver({ resolveUserAccess: async () => ({ capabilities: { upload_project: true }, quotas: { max_project_zip_bytes: 1000 } }) });
  assert.deepEqual(await ok('u'), { maxBytes: 1000 });
  for (const access of [null, { capabilities: {}, quotas: { max_project_zip_bytes: 1000 } }, { capabilities: { upload_project: true }, quotas: { max_project_zip_bytes: 0 } }, { capabilities: { upload_project: true }, quotas: {} }]) {
    await assert.rejects(createProjectAccessResolver({ resolveUserAccess: async () => access })('u'), (e) => e.code === 'PROJECT_UPLOAD_DENIED' && e.status === 403);
  }
});

test('transiciones tras calentar la caché: cuarentena, rotación y reasignación bloquean el borrado de inmediato; lecturas caducan por TTL', async () => {
  const server = createFakeTelegramServer(); const prov = provider(server); let t = 1000;
  const map = { '-1001': vault('Bot20') };
  const { gateway } = rt.createGatewayRuntime({ pool: fakePool(map), clientProvider: prov, sdk, chatTtlMs: 5000, now: () => t });
  const r = await seed(server, '20', '-1001');
  await gateway.verifyMessage({ chatId: '-1001', messageId: r.messageId, senderId: 'Bot20' }); // caché caliente
  // cuarentena
  map['-1001'] = vault('Bot20', { quarantined: true });
  await assert.rejects(gateway.deleteMessage({ chatId: '-1001', messageId: r.messageId }), (e) => e.code === 'BOT_QUARANTINED');
  await assert.rejects(gateway.verifyMessage({ chatId: '-1001', messageId: r.messageId, senderId: 'Bot20' }), (e) => e.code === 'BOT_QUARANTINED', 'un rechazo de efecto vacía la caché: la lectura siguiente revalida y también se rechaza');
  // lecturas: dentro del TTL toleran la caché (límite documentado); pasado el TTL revalidan
  map['-1001'] = vault('Bot20'); await gateway.verifyMessage({ chatId: '-1001', messageId: r.messageId, senderId: 'Bot20' });
  map['-1001'] = vault('Bot20', { quarantined: true });
  await gateway.verifyMessage({ chatId: '-1001', messageId: r.messageId, senderId: 'Bot20' });
  t += 5001;
  await assert.rejects(gateway.verifyMessage({ chatId: '-1001', messageId: r.messageId, senderId: 'Bot20' }), (e) => e.code === 'BOT_QUARANTINED', 'pasado el TTL la lectura también se rechaza');
  assert.equal(server.messages().length, 1, 'ningún efecto tras la cuarentena');
  // rotación pendiente
  map['-1001'] = vault('Bot20'); assert.equal((await effect(gateway, '-1001')).requested, true);
  map['-1001'] = vault('Bot20', { rotation_pending: true });
  await assert.rejects(gateway.deleteMessage({ chatId: '-1001', messageId: r.messageId }), (e) => e.code === 'BOT_ROTATION_PENDING');
  // reasignación a otro bot: el siguiente efecto sale por el NUEVO bot, nunca por la sesión cacheada del anterior
  map['-1001'] = vault('Bot21');
  assert.equal((await effect(gateway, '-1001')).requested, true);
  assert.deepEqual(prov.opened, ['Bot20', 'Bot21']);
  assert.equal(server.messages().length, 1, 'el mensaje sembrado sigue intacto');
});

test('FLOOD_WAIT al abrir la sesión del bot (hallazgo G3 real): sin efecto externo (effectPossible=false), cooldown sin volver a llamar a Telegram y reapertura al vencer; no es UNCERTAIN', async () => {
  const server = createFakeTelegramServer(); let t = 1_000_000; let opens = 0;
  const flood = () => Object.assign(new Error('FLOOD_WAIT_40'), { code: 420, seconds: 40 });
  const prov = provider(server, { fail: () => { opens++; return opens === 1 ? flood() : null; } });
  const { gateway } = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: prov, sdk, now: () => t });
  const err1 = await effect(gateway, '-1001').then(() => null, (e) => e);
  assert.equal(err1.code, 'GATEWAY_BOT_UNAVAILABLE'); assert.equal(err1.effectPossible, false); assert.equal(err1.retryAfterMs, 40_000); assert.equal(err1.reason, 'FLOOD_WAIT');
  const callsAfterFlood = opens;
  t += 10_000; // dentro del cooldown: no se llama a Telegram
  const err2 = await effect(gateway, '-1001').then(() => null, (e) => e);
  assert.equal(err2.reason, 'FLOOD_COOLDOWN'); assert.equal(err2.effectPossible, false); assert.equal(err2.retryAfterMs, 30_000); assert.equal(opens, callsAfterFlood, 'el cooldown no abre sesión');
  t += 31_000; // vencido: reabre
  assert.equal((await effect(gateway, '-1001')).requested, true);
  // errores de ruteo (cuarentena, chat sin bot) tampoco tienen efecto posible
  await assert.rejects(effect(gateway, '-1999'), (e) => e.code === 'CHAT_BOT_UNRESOLVED' && e.effectPossible === false);
});

