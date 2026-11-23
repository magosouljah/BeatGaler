'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { attempts } = require('./helpers/catalog-net-guard.cjs');
require('./helpers/no-dotenv.cjs');

const directPath = require.resolve('../direct-transport-control');
const chatId = '-1001234567890';
const botId = '202';
const botToken = 'fake-assigned-bot-token';
const apiHash = 'fake-telegram-api-hash';
const permanentKey = Buffer.alloc(256, 0x9b);
const secretFields = {
  bot_token: botToken,
  telegram_api_hash: apiHash,
  permanent_auth_key: permanentKey.toString('base64'),
};
const pool = [
  { id: 'first', token: 'fake-other-bot-token' },
  { id: botId, label: 'Assigned', token: botToken, telegram_user_id: 2020, internal: secretFields },
];

function assertPublic(value) {
  // JSON completo, incluidos objetos y elementos de arrays.
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /"(?:bot_token|(?:telegram_)?api_hash|permanent_auth_key|perm_auth_key|auth_key|credential_envelope)"\s*:/i);
  for (const secret of [...pool.map(bot => bot.token), apiHash, permanentKey.toString('base64'), permanentKey.toString('hex')]) {
    assert.equal(json.includes(secret), false, 'El JSON público contiene una credencial ficticia.');
  }
}

function seed(dir) {
  const poolFile = path.join(dir, 'pool.json');
  const stateFile = path.join(dir, 'state.json');
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const setPool = (bots) => write(poolFile, { bots });
  const setState = (state) => write(stateFile, state);
  setPool(pool);
  setState({
    bots: { [botId]: { credential_version: 7, rotation_pending: true, quarantined: true } },
    leases: { current: { bot_id: botId, status: 'ACTIVE' }, cleaned: { bot_id: botId, status: 'CLEANED' } },
    operations: { current: { bot_id: botId } },
  });
  const mastersFile = path.join(dir, 'masters.json');
  write(mastersFile, [{ id: 'test-master', session: 'fake-master-session' }]);
  return {
    setPool, setState, poolFile, stateFile,
    env: {
      BEATGALER_DIRECT_TRANSPORT: 'off', TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: apiHash,
      TRANSPORT_BOTS_FILE: poolFile, TRANSPORT_POOL_STATE: stateFile, MASTERS_FILE: mastersFile,
      VAULT_REGISTRY_FILE: path.join(dir, 'vaults.json'), DIRECT_DIAGNOSTICS_DIR: path.join(dir, 'diag'),
    },
  };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-direct-characterization-'));
  const oldEnv = process.env;
  t.after(() => {
    process.env = oldEnv;
    delete require.cache[directPath];
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(attempts, []);
  });
  const files = seed(dir);
  process.env = { NODE_ENV: 'test', ...files.env };
  const calls = [];
  const replies = {
    getMe: { id: 2020, username: 'assigned_bot' },
    getChat: { id: Number(chatId) },
    getManagedBotToken: 'fake-managed-token',
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.telegram.org');
    const [, token, method] = target.pathname.split('/');
    assert.equal(options.method, 'POST');
    assert.ok(Object.hasOwn(replies, method), 'Método inesperado del Bot API');
    calls.push([method, token, JSON.parse(options.body)]);
    return { ok: true, json: async () => ({ ok: true, result: replies[method] }) };
  });
  return { ...files, transport: require(directPath), calls, replies };
}

test('catalogBotCredential elige el bot solicitado, conserva la versión y rechaza un ID desconocido', async (t) => {
  const f = fixture(t);
  const stateBefore = fs.readFileSync(f.stateFile, 'utf8');
  assert.deepEqual(await f.transport.catalogBotCredential(202), { token: botToken, telegramUserId: '2020', credentialVersion: 7 });
  assert.deepEqual(await f.transport.catalogBotCredential('first'), { token: pool[0].token, telegramUserId: null, credentialVersion: 1 });
  await assert.rejects(f.transport.catalogBotCredential('missing'), {
    message: 'Unknown transport bot missing.', code: 'BOT_UNKNOWN', transient: false,
  });
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), stateBefore);
});

test('catalogBotCredential comparte peticiones al gestor por versión y vuelve a pedir el token si cambia', async (t) => {
  const f = fixture(t);
  process.env.TEST_MANAGER_TOKEN = 'fake-manager-token';
  f.setPool([pool[0], { ...pool[1], token: undefined, managed: true, manager_token_env: 'TEST_MANAGER_TOKEN' }]);
  const read = () => f.transport.catalogBotCredential(botId);
  const expected = { token: 'fake-managed-token', telegramUserId: '2020', credentialVersion: 7 };
  assert.deepEqual(await Promise.all([read(), read()]), [expected, expected]);
  assert.deepEqual(await read(), expected);
  f.setState({ bots: { [botId]: { credential_version: 8 } } });
  f.replies.getManagedBotToken = 'fake-managed-token-v8';
  assert.deepEqual(await read(), { ...expected, token: 'fake-managed-token-v8', credentialVersion: 8 });
  assert.deepEqual(f.calls, Array.from({ length: 2 }, () => ['getManagedBotToken', 'botfake-manager-token', { user_id: 2020 }]));
});

test('catalogDirectSession conserva la sesión interna y un ID estable por bot y chat', async (t) => {
  const { transport } = fixture(t);
  const start = (overrides) => transport.catalogDirectSession({ botId: 202, chatId: Number(chatId), ...overrides });
  const session = await start();
  assert.deepEqual(session, {
    ok: true, mode: 'catalog-v1-direct', session_id: 'cdirect-' + crypto.createHash('sha256').update(botId + '|' + chatId).digest('hex').slice(0, 24),
    transport_id: botId, transport_user_id: '2020', transport_username: null, chat_id: chatId,
    bot_token: botToken, telegram_api_id: 12345, telegram_api_hash: apiHash, resolver_chat_id: null,
    generation: 1, credential_version: 7, heartbeat_interval_ms: 60000, heartbeat_timeout_ms: 300000,
    token_rotation_enabled: false, lease_state: 'ACTIVE',
  });
  assert.deepEqual(await start(), session);
  assert.notEqual((await start({ botId: 'first' })).session_id, session.session_id);
  assert.notEqual((await start({ chatId: '-1009' })).session_id, session.session_id);
  assert.equal((await start({ sessionId: 'supplied' })).session_id, 'supplied');
  await assert.rejects(start({ botId: 'missing' }), { code: 'BOT_UNKNOWN' });
  process.env.TELEGRAM_API_ID = 'invalid';
  await assert.rejects(start(), { message: 'TELEGRAM_API_ID must be a positive integer.' });
});

test('ensureCatalogBotMembership verifica al bot asignado y acepta una invitación ya aplicada', async (t) => {
  const telegram = require(createRequire(directPath).resolve('telegram'));
  const calls = [];
  const vault = { id: 1234567890, className: 'Channel' };
  const entity = { id: 2020 };
  let invited = false;
  let participant = { participant: {} };
  t.mock.getter(telegram, 'TelegramClient', () => class FakeMaster {
    constructor(session) { assert.equal(session.value, 'fake-master-session'); }
    async connect() { calls.push('connect'); }
    async checkAuthorization() { return true; }
    async *iterDialogs() { yield { entity: { id: 9, className: 'Channel' } }; yield { entity: vault }; }
    async getEntity(name) { assert.equal(name, '@assigned_bot'); return entity; }
    async invoke(request) {
      assert.equal(request.channel, vault);
      calls.push(request.className);
      if (request.className === 'channels.InviteToChannel') {
        assert.deepEqual(request.users, [entity]);
        if (invited) throw new Error('USER_ALREADY_PARTICIPANT');
        invited = true;
      } else if (request.className === 'channels.EditAdmin') {
        assert.equal(request.userId, entity);
        assert.deepEqual([request.adminRights.other, request.adminRights.deleteMessages, request.adminRights.pinMessages], [true, false, false]);
      } else {
        assert.equal(request.className, 'channels.GetParticipant');
        assert.equal(request.participant, entity);
        return participant;
      }
    }
    async disconnect() { calls.push('disconnect'); }
  });
  const sessions = createRequire(directPath)('telegram/sessions');
  t.mock.getter(sessions, 'StringSession', () => class FakeSession {
    constructor(value) { this.value = value; }
  });
  const f = fixture(t);
  const ensure = (overrides) => f.transport.ensureCatalogBotMembership({ chatId: ' ' + chatId, botId: botId + ' ', ...overrides });
  const masterCalls = ['connect', 'channels.InviteToChannel', 'channels.EditAdmin', 'channels.GetParticipant', 'disconnect'];
  for (let i = 0; i < 2; i++) assert.deepEqual(await ensure(), { ready: true, botId });
  assert.deepEqual(calls, [...masterCalls, ...masterCalls]);
  const botCalls = [['getMe', 'bot' + botToken, {}], ['getChat', 'bot' + botToken, { chat_id: chatId }]];
  assert.deepEqual(f.calls, [...botCalls, ...botCalls]);
  await assert.rejects(ensure({ chatId: '-42' }), { message: 'CATALOG_TRANSPORT_TARGET_INVALID' });
  await assert.rejects(ensure({ botId: ' ' }), { message: 'CATALOG_TRANSPORT_TARGET_INVALID' });
  await assert.rejects(ensure({ botId: 'missing' }), { code: 'BOT_UNKNOWN' });
  assert.deepEqual(f.calls, [...botCalls, ...botCalls]);
  f.replies.getMe = { id: 9, username: 'wrong_bot' };
  await assert.rejects(ensure(), { code: 'BOT_IDENTITY_MISMATCH' });
  f.replies.getMe = { id: 2020 };
  await assert.rejects(ensure(), { message: 'CATALOG_TRANSPORT_BOT_USERNAME_MISSING' });
  assert.deepEqual(calls, [...masterCalls, ...masterCalls]);
  f.replies.getMe = { id: 2020, username: 'assigned_bot' };
  participant = {};
  await assert.rejects(ensure(), { message: 'CATALOG_TRANSPORT_MASTER_MEMBERSHIP_UNVERIFIED' });
  assert.deepEqual(calls.slice(-5), masterCalls);
  assert.deepEqual(f.calls.at(-1), botCalls[0]);
  participant = { participant: {} };
  f.replies.getChat = { id: -1009 };
  await assert.rejects(ensure(), { message: 'CATALOG_TRANSPORT_BOT_CHAT_MISMATCH' });
});

test('enabled y poolStatus distinguen flag, credenciales, pool ausente y contadores efímeros', (t) => {
  const f = fixture(t);
  assert.equal(f.transport.enabled(), false);
  assert.equal(f.transport.poolStatus().configured, false);
  process.env.BEATGALER_DIRECT_TRANSPORT = 'true';
  assert.equal(f.transport.enabled(), true);
  const status = f.transport.poolStatus();
  assertPublic(status);
  assert.deepEqual(status, {
    configured: true, heartbeat_interval_ms: 60000, heartbeat_timeout_ms: 300000,
    sessions: 2, operations: 1, queue: [],
    bots: [
      { id: 'first', label: 'first', managed: false, active_vaults: 0, active_operations: 0, credential_version: 1, rotation_pending: false, quarantined: false },
      { id: botId, label: 'Assigned', managed: false, active_vaults: 1, active_operations: 1, credential_version: 7, rotation_pending: true, quarantined: true },
    ],
  });
  delete process.env.TELEGRAM_API_HASH;
  assert.equal(f.transport.enabled(), false);
  fs.unlinkSync(f.poolFile);
  process.env.TELEGRAM_API_HASH = apiHash;
  assert.equal(f.transport.enabled(), false);
  assert.deepEqual(f.transport.poolStatus(), { configured: false, bots: [], sessions: 0, operations: 0 });
});

test('stripDirectCredentials elimina las credenciales planas de su entrada vigente', () => {
  const { stripDirectCredentials } = require('../catalog/authority');
  const session = { bot_token: botToken, api_hash: apiHash, telegram_api_hash: apiHash, api_id: 42, telegram_api_id: 12345, nested: [{ transport_id: botId }] };
  const stripped = stripDirectCredentials(session);
  assertPublic(stripped);
  assert.deepEqual(stripped, { nested: [{ transport_id: botId }] });
  assert.equal(session.bot_token, botToken);
});

function fakePermanentAuthorization(t) {
  const boundaryRequire = createRequire(require.resolve('../productive-temp-auth-boundary'));
  const webRequire = createRequire(boundaryRequire.resolve('@mtcute/web'));
  const coreDir = path.dirname(webRequire.resolve('@mtcute/core'));
  const imports = [];
  class FakeConnection {
    _session = { _authKey: { setup: (key) => assert.equal(key, permanentKey) }, updateTimeOffset() {} };
    onUsable = { add: (callback) => { this.notifyUsable = callback; } };
    constructor({ salts }) { this._salts = salts; }
    connect() { this.notifyUsable(); }
    onConnectionUsable() {}
    async sendRpc(request) {
      imports.push(request);
      return { _: 'auth.authorization', user: { id: 2020, bot: true } };
    }
  }
  const load = Module.prototype.require;
  t.mock.method(Module.prototype, 'require', function (request) {
    if (request === path.join(coreDir, 'network/session-connection.cjs')) return { SessionConnection: FakeConnection };
    if (request === path.join(coreDir, 'network/authorization.cjs')) return { doAuthorization: async () => [permanentKey, null, 0] };
    return load.call(this, request);
  });
  return imports;
}

function fakeCatalogPool() {
  const library = {
    user_id: 'catalog-user', vault_id: 'vault', authority: 'POSTGRES', migration_state: 'IDLE',
    authority_era: 'era', authority_epoch: '2', current_chat_id: chatId,
  };
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM catalog_native_activation')) return { rows: [{ transport_bot_ids: JSON.stringify(pool.map(bot => bot.id)) }] };
      if (sql === 'BEGIN READ ONLY' || sql === 'COMMIT') return { rows: [] };
      assert.deepEqual(params, [library.user_id]);
      if (sql.includes('FROM control_plane_flush_quarantine')) return { rows: [] };
      if (sql.includes('FROM catalog_libraries l')) return { rows: [library] };
      if (sql.includes('SELECT v.transport_bot_id AS bot_id')) return { rows: [{ bot_id: botId }] };
      assert.fail('Consulta inesperada del catálogo: ' + sql);
    },
    release() {},
  };
  return { query: client.query, async connect() { return client; } };
}

async function observeRoute(router, method, url, request = {}) {
  const stack = Array.isArray(router.stack) ? router.stack : (router._router || router.router).stack;
  const route = stack.find(layer => layer.route?.path === url && layer.route.methods[method])?.route;
  assert.ok(route, method + ' ' + url + ' debe estar registrada');
  const req = { method: method.toUpperCase(), url, headers: {}, ...request };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(body)) }); },
    };
    route.dispatch(req, res, error => reject(error || new Error('La ruta no respondió')));
  });
}

test('transformSession y POST /catalog/v1/direct/session emiten bootstrap y vínculo sin secretos', async (t) => {
  const { transport } = fixture(t);
  const imports = fakePermanentAuthorization(t);
  const { transformSession } = require('../productive-temp-auth-boundary');
  const internal = await transport.catalogDirectSession({ botId, chatId });
  const rejected = await transformSession({ ...internal, ok: false, credential_envelope: secretFields }, null);
  assertPublic(rejected);
  assert.equal(rejected.ok, false);

  const { assembleServerCatalog } = require('../catalog-assembly');
  const { currentCatalogAuthority } = require('../catalog/authority');
  const { currentCatalogQueries } = require('../catalog/queries');
  const { currentCatalogDirect } = require('../catalog/direct');
  const { createCatalogRouter } = require('../catalog/routes');
  await assembleServerCatalog({
    pool: fakeCatalogPool(), cutover: { authority: 'postgres' }, onGatewayConfigured() {},
    env: {
      NODE_ENV: 'test', BEATGALER_CATALOG_NATIVE_ENABLED: 'true',
      BEATGALER_CATALOG_DIRECT_ENABLED: 'true', BEATGALER_CATALOG_DIRECT_PREWARM_BOTS: '0',
    },
  });
  const router = createCatalogRouter({
    authority: currentCatalogAuthority(), queries: currentCatalogQueries(),
    direct: currentCatalogDirect(), authenticate: () => ({ id: 'catalog-user' }),
  });
  const start = (body) => observeRoute(router, 'post', '/catalog/v1/direct/session', { body });
  const bootstrap = await start({});
  assert.equal(bootstrap.status, 200);
  assertPublic(bootstrap.body);
  assert.deepEqual(bootstrap.body.temp_auth, { version: 1, api_id: 12345, dc_id: 2, expected_bot_id: '2020', expires_at: null, binding: null });
  assert.equal(bootstrap.body.temp_auth_required, true);
  assert.equal(bootstrap.body.protocol, 'catalog-v1-direct');
  assert.equal(bootstrap.body.mode, 'galer-direct-temp-mtproto');
  assert.equal(bootstrap.body.session_id, internal.session_id);
  assert.equal(bootstrap.body.transport_id, botId);
  assert.deepEqual(bootstrap.body.catalog, { authority_era: 'era', authority_epoch: '2', chat_id: chatId });

  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const long = (low) => ({ low, high: 0, unsigned: false });
  const binding = await start({ tempAuthMetadata: { expiresAt, msgId: long(4), nonce: long(1), tempAuthKeyId: long(2), tempSessionId: long(3) } });
  assert.equal(binding.status, 200);
  assertPublic(binding.body);
  assert.equal(binding.body.session_id, bootstrap.body.session_id);
  assert.equal(binding.body.temp_auth_required, false);
  assert.equal(binding.body.temp_auth.expires_at, expiresAt);
  assert.ok(Buffer.from(binding.body.temp_auth.binding.encrypted_message, 'base64').length > 24);
  const keyId = crypto.createHash('sha1').update(permanentKey).digest().subarray(-8);
  assert.deepEqual(binding.body.temp_auth.binding.perm_auth_key_id, { low: keyId.readInt32LE(), high: keyId.readInt32LE(4), unsigned: false });
  assert.deepEqual(imports, [{ _: 'auth.importBotAuthorization', flags: 0, apiId: 12345, apiHash, botAuthToken: botToken }]);

  const invalid = await start({ tempAuthMetadata: { expiresAt: 1 } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.detail.reason, 'TEMP_AUTH_EXPIRY');
  assertPublic(invalid.body);
});

test('GET /transport/status publica contadores del pool y omite incluso las credenciales anidadas de su fixture', async () => {
  const { withCloud } = require('./helpers/composition-cloud.cjs');
  let files;
  await withCloud(async (app) => {
    process.env.BEATGALER_DIRECT_TRANSPORT = 'true';
    const status = (remoteAddress) => observeRoute(app, 'get', '/transport/status', { socket: { remoteAddress } });
    assert.deepEqual(await status('192.0.2.1'), { status: 404, body: { error: 'Not available.' } });
    const response = await status('127.0.0.1');
    assert.equal(response.status, 200);
    assertPublic(response.body);
    assert.deepEqual([response.body.ok, response.body.direct, response.body.sessions, response.body.operations], [true, true, 2, 1]);
    assert.deepEqual(response.body.bots.map(bot => [bot.id, bot.credential_version]), [['first', 1], [botId, 7]]);
    files.setPool([]);
    const invalid = await status('127.0.0.1');
    assert.deepEqual(invalid, { status: 503, body: { ok: false, direct: false, error: 'Cloud transport status is unavailable.' } });
    assertPublic(invalid.body);
  }, {
    inMemory: true,
    prepare(dir) {
      files = seed(dir);
      Object.assign(process.env, files.env);
    },
  });
});
