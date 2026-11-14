'use strict';
// T16/T11 — Conexión del gateway real (enrutador por chat/bot, cliente perezoso, guardas de arranque). Sin red, sin credenciales reales:
// pool SQL falso + servidor MTProto FAKE detrás del adaptador real `createTelegramGateway`. Etiqueta FAKE: no es evidencia de proveedor (G2 NOT_PROVEN).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const rt = require('../../catalog-gateway-runtime.js');
const g = require('../../catalog/transport-gateway.js');
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
const send = (gw, chatId, operationId = 'op1') => gw.sendPart({ operationId, partKey: 'm0', randomId: g.newRandomId(), chatId, file: file(), mimeType: 'audio/mpeg', fileName: 'a.mp3' });

test('guardas de arranque: apagado por defecto; encendido exige plano PG; producción exige dictamen G2', () => {
  assert.equal(rt.gatewayFromEnv({ pool: {}, env: {} }), null);
  assert.equal(rt.gatewayFromEnv({ pool: {}, env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'false' } }), null);
  assert.throws(() => rt.gatewayFromEnv({ pool: null, env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'true' } }), /STOP-ENV/);
  assert.throws(() => rt.gatewayFromEnv({ pool: fakePool({}), env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'true', NODE_ENV: 'production' }, clientProvider: provider(createFakeTelegramServer()), sdk }), /STOP-GATE/);
  assert.throws(() => rt.assertGatewayAllowed({ BEATGALER_CATALOG_GATEWAY_ENABLED: 'true', BEATGALER_DEPLOYMENT_ENV: 'production' }), /STOP-GATE/);
  const ok = rt.gatewayFromEnv({ pool: fakePool({}), env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'true', NODE_ENV: 'production', BEATGALER_CATALOG_G2_APPROVED: 'true' }, clientProvider: provider(createFakeTelegramServer()), sdk });
  assert.ok(ok && ok.gateway);
  assert.equal(rt.gatewayFromEnv({ pool: fakePool({}), env: { BEATGALER_CATALOG_GATEWAY_ENABLED: 'true', NODE_ENV: 'development' }, clientProvider: provider(createFakeTelegramServer()), sdk }).gateway.sendPart.constructor.name, 'AsyncFunction');
});

test('cliente perezoso y enrutado por chat: cada biblioteca usa la sesión de SU bot; sin proveUniqueMatch; interfaz completa', async () => {
  const server = createFakeTelegramServer(); const prov = provider(server);
  const pool = fakePool({ '-1001': vault('Bot20'), '-1002': vault('Bot21') });
  const { gateway } = rt.createGatewayRuntime({ pool, clientProvider: prov, sdk });
  assert.deepEqual(prov.opened, [], 'ninguna sesión ni credencial se toca hasta la primera operación');
  for (const m of ['sendPart', 'verifyMessage', 'searchByRandomId', 'downloadPart', 'deleteMessage', 'probeAbsence']) assert.equal(typeof gateway[m], 'function', m);
  assert.equal(gateway.proveUniqueMatch, undefined, 'sin prueba de unicidad la reconciliación por búsqueda sigue en revisión manual (E5 opción A)');
  const r1 = await send(gateway, '-1001'); const r2 = await send(gateway, '-1002', 'op2'); const r3 = await send(gateway, '-1001', 'op3');
  assert.deepEqual([r1.senderId, r2.senderId, r3.senderId], ['20', '21', '20']);
  assert.deepEqual(prov.opened, ['Bot20', 'Bot21'], 'una sesión por bot, reutilizada');
  assert.deepEqual(server.messages().map((m) => m.sender), ['20', '21', '20']);
  const v = await gateway.verifyMessage({ chatId: '-1002', messageId: r2.messageId, senderId: 'Bot21' });
  assert.equal(v.size, 100);
  assert.equal(pool.calls.filter((c) => c === '-1001').length, 1, 'caché de chat→bot con TTL: una consulta SQL por chat');
});

test('fail-closed antes de abrir sesión: chat sin bot, bot en cuarentena, rotación pendiente y chat inválido', async () => {
  const server = createFakeTelegramServer(); const prov = provider(server);
  const pool = fakePool({ '-1001': vault('Bot20', { quarantined: true }), '-1002': vault('Bot21', { rotation_pending: true }), '-1003': { bot_id: null } });
  const { gateway } = rt.createGatewayRuntime({ pool, clientProvider: prov, sdk });
  await assert.rejects(send(gateway, '-1999'), (e) => e.code === 'CHAT_BOT_UNRESOLVED' && e.transient === false);
  await assert.rejects(send(gateway, '-1003'), (e) => e.code === 'CHAT_BOT_UNRESOLVED');
  await assert.rejects(send(gateway, '-1001'), (e) => e.code === 'BOT_QUARANTINED' && e.transient === false);
  await assert.rejects(send(gateway, '-1002'), (e) => e.code === 'BOT_ROTATION_PENDING' && e.transient === true);
  await assert.rejects(send(gateway, 'abc; DROP'), (e) => e.code === 'CHAT_INVALID');
  await assert.rejects(gateway.deleteMessage({ chatId: '-1001', messageId: 5 }), (e) => e.code === 'BOT_QUARANTINED');
  assert.deepEqual(prov.opened, [], 'ningún rechazo abrió sesión ni leyó credenciales');
  assert.equal(server.messages().length, 0);
});

test('fallo al abrir sesión: transitorio, sin filtrar el secreto, no se cachea y el siguiente intento reabre', async () => {
  const server = createFakeTelegramServer(); let n = 0;
  const prov = provider(server, { fail: () => (++n === 1 ? Object.assign(new Error(`AUTH ${TOKEN}`), { code: 'ECONNRESET' }) : null) });
  const { gateway } = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: prov, sdk });
  await assert.rejects(send(gateway, '-1001'), (e) => { assert.equal(e.code, 'GATEWAY_BOT_UNAVAILABLE'); assert.equal(e.transient, true); assert.ok(!JSON.stringify([e.message, e.detail, e.stack]).includes(TOKEN), 'el token no aparece en el error'); return true; });
  assert.equal((await send(gateway, '-1001')).senderId, '20');
  assert.deepEqual(prov.opened, ['Bot20', 'Bot20']);
  // fallo permanente declarado por el proveedor (identidad distinta) → no transitorio
  const bad = provider(server, { fail: () => Object.assign(new Error('x'), { code: 'BOT_IDENTITY_MISMATCH', transient: false }) });
  const r2 = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: bad, sdk });
  await assert.rejects(send(r2.gateway, '-1001'), (e) => e.code === 'GATEWAY_BOT_UNAVAILABLE' && e.transient === false);
  // identidad no numérica → cerrado
  const odd = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: { async open() { return { client: server.session({ selfId: '20' }), telegramUserId: 'abc' }; } }, sdk });
  await assert.rejects(send(odd.gateway, '-1001'), (e) => e.code === 'BOT_IDENTITY_INVALID');
});

test('credencial revocada: la sesión se descarta y desconecta; la siguiente operación reabre (token nuevo del pool)', async () => {
  const server = createFakeTelegramServer(); const prov = provider(server); const clients = [];
  const origOpen = prov.open.bind(prov); prov.open = async (b) => { const o = await origOpen(b); clients.push(o.client); return o; };
  const { gateway, close } = rt.createGatewayRuntime({ pool: fakePool({ '-1001': vault('Bot20') }), clientProvider: prov, sdk });
  assert.equal((await send(gateway, '-1001')).senderId, '20');
  server.revokeBot('20');
  await assert.rejects(send(gateway, '-1001', 'opR'), (e) => e.code === 'CREDENTIAL_REVOKED');
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
  const ok = rt.createProjectAccessResolver({ resolveUserAccess: async () => ({ capabilities: { upload_project: true }, quotas: { max_project_zip_bytes: 1000 } }) });
  assert.deepEqual(await ok('u'), { maxBytes: 1000 });
  for (const access of [null, { capabilities: {}, quotas: { max_project_zip_bytes: 1000 } }, { capabilities: { upload_project: true }, quotas: { max_project_zip_bytes: 0 } }, { capabilities: { upload_project: true }, quotas: {} }]) {
    await assert.rejects(rt.createProjectAccessResolver({ resolveUserAccess: async () => access })('u'), (e) => e.code === 'PROJECT_UPLOAD_DENIED' && e.status === 403);
  }
});
