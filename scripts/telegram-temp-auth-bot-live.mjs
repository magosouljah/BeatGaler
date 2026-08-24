import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Task 5.1 M0-B2 live proof only.
//
// Security boundary:
// - The parent process is the binder/control side and is the ONLY process that
//   receives the dedicated API id, API hash and bot token.
// - The child process is the simulated device. It is forked with those secrets
//   explicitly removed from its environment.
// - The parent creates and bot-authorizes the permanent MTProto auth key.
// - The child creates and retains the temporary MTProto auth key.
// - The child sends only binding metadata to the parent; never temp-key bytes.
// - The parent returns only the permanent key id + encrypted binding envelope.
// - The child binds directly with Telegram, then calls users.getUsers(inputUserSelf)
//   directly using the temporary key.
// - No BeatGaler user, vault, message mutation, file transfer, token rotation or
//   revocation is involved.
//
// This is probe code, not production runtime.

const SECRET_NAMES = [
  'BEATGALER_M0_B2_API_ID',
  'BEATGALER_M0_B2_API_HASH',
  'BEATGALER_M0_B2_BOT_TOKEN',
  // Also strip the product names defensively if a runner happens to define them.
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
];
const TEMP_EXPIRY_SECONDS = 10 * 60;
const TIMEOUT_MS = 60_000;
const PROD_DC = {
  id: 2,
  ipAddress: 'venus.web.telegram.org',
  port: 443,
  testMode: false,
  mediaOnly: false,
  ipv6: false,
};

function requiredSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required M0-B2 secret: ${name}`);
  return value;
}

function sanitizedClientEnv() {
  const env = { ...process.env, BEATGALER_M0_B2_CLIENT: '1' };
  for (const name of SECRET_NAMES) delete env[name];
  return env;
}

function assertClientHasNoSecrets() {
  for (const name of SECRET_NAMES) {
    assert.equal(process.env[name], undefined, `${name} must not reach the client process.`);
  }
}

function silentLogger(prefix = '') {
  return {
    prefix,
    mgr: { level: 0 },
    create(child) { return silentLogger(prefix ? `${prefix}:${child}` : child); },
    verbose() {},
    debug() {},
    info() {},
    warn() {},
    error(...args) { console.error('[mtcute-b2-probe]', ...args); },
  };
}

function timeout(promise, label, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function findPackageRoot(entryUrl, expectedName) {
  let current = path.dirname(fileURLToPath(entryUrl));
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'));
      if (manifest.name === expectedName) return { root: current, manifest };
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate ${expectedName} package root.`);
}

async function findFirstWasm(root) {
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name.endsWith('.wasm')) return full;
    }
  }
  throw new Error('Could not locate @mtcute/wasm binary.');
}

async function loadMtcuteInternals() {
  const web = await import('@mtcute/web');
  const webEntry = import.meta.resolve('@mtcute/web');
  const webPkg = await findPackageRoot(webEntry, '@mtcute/web');
  const requireFromWeb = createRequire(pathToFileURL(path.join(webPkg.root, 'package.json')));
  const coreEntry = requireFromWeb.resolve('@mtcute/core');
  const corePkg = await findPackageRoot(pathToFileURL(coreEntry), '@mtcute/core');
  const requireFromCore = createRequire(pathToFileURL(path.join(corePkg.root, 'package.json')));

  assert.equal(webPkg.manifest.version, '0.31.0');
  assert.equal(corePkg.manifest.version, '0.31.0');

  const { SessionConnection } = requireFromCore(path.join(corePkg.root, 'network/session-connection.cjs'));
  const { doAuthorization } = requireFromCore(path.join(corePkg.root, 'network/authorization.cjs'));
  const { ServerSaltManager } = requireFromCore(path.join(corePkg.root, 'network/server-salt.cjs'));
  const { __tlReaderMap } = requireFromCore(path.join(corePkg.root, 'tl/binary/reader.cjs'));
  const { __tlWriterMap } = requireFromCore(path.join(corePkg.root, 'tl/binary/writer.cjs'));
  const { createAesIgeForMessageOld } = requireFromCore(path.join(corePkg.root, 'utils/crypto/mtproto.cjs'));
  const { longFromBuffer, randomLong } = requireFromCore(path.join(corePkg.root, 'utils/long-utils.cjs'));
  const { defaultReconnectionStrategy } = requireFromCore('@fuman/net');
  const { TlBinaryWriter, TlSerializationCounter } = requireFromCore('@mtcute/tl-runtime');

  const wasmEntry = requireFromWeb.resolve('@mtcute/wasm');
  const wasmPkg = await findPackageRoot(pathToFileURL(wasmEntry), '@mtcute/wasm');
  const wasmBytes = await readFile(await findFirstWasm(wasmPkg.root));

  return {
    ...web,
    SessionConnection,
    doAuthorization,
    ServerSaltManager,
    __tlReaderMap,
    __tlWriterMap,
    createAesIgeForMessageOld,
    longFromBuffer,
    randomLong,
    defaultReconnectionStrategy,
    TlBinaryWriter,
    TlSerializationCounter,
    wasmBytes,
  };
}

async function makeCrypto(m) {
  const response = new Response(m.wasmBytes, {
    headers: { 'Content-Type': 'application/wasm' },
  });
  const crypto = new m.WebCryptoProvider({ wasmInput: response });
  await crypto.initialize();
  return crypto;
}

async function makeManualConnection(m, crypto, label, apiId = 0) {
  class ManualSessionConnection extends m.SessionConnection {
    onConnected() {
      // The probe explicitly drives permanent or temporary key generation.
    }
  }

  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => `BeatGaler M0-B2 ${label}`,
    getDefaultLogLevel: () => null,
  };
  const transport = new m.WebSocketTransport({ ws: globalThis.WebSocket });
  const connection = new ManualSessionConnection({
    crypto,
    initConnection: {
      _: 'initConnection',
      apiId,
      deviceModel: `BeatGaler M0-B2 ${label}`,
      systemVersion: process.version,
      appVersion: '0.8.0-alpha.1-probe',
      systemLangCode: 'en',
      langPack: '',
      langCode: 'en',
      query: { _: 'help.getNearestDc' },
    },
    transport,
    dc: PROD_DC,
    testMode: false,
    reconnectionStrategy: m.defaultReconnectionStrategy,
    layer: m.tl.LAYER,
    disableUpdates: true,
    readerMap: m.__tlReaderMap,
    writerMap: m.__tlWriterMap,
    usePfs: false,
    isMainConnection: true,
    isMainDcConnection: true,
    inactivityTimeout: 120_000,
    salts: new m.ServerSaltManager(),
    platform,
    pingInterval: 60_000,
  }, silentLogger(label));

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} socket open timeout`)), TIMEOUT_MS);
    connection.onUsable.add(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  connection.connect();
  await opened;
  return connection;
}

function longJson(value) {
  return { low: value.low, high: value.high, unsigned: Boolean(value.unsigned) };
}

function longFromJson(Long, value) {
  return new Long(value.low, value.high, Boolean(value.unsigned));
}

async function buildBindingEnvelope(m, crypto, permanentKeyBytes, metadata) {
  const permAuthKeyIdBytes = crypto.sha1(permanentKeyBytes).subarray(-8);
  const permAuthKeyId = m.longFromBuffer(permAuthKeyIdBytes);
  const msgId = longFromJson(m.Long, metadata.msgId);
  const nonce = longFromJson(m.Long, metadata.nonce);
  const tempAuthKeyId = longFromJson(m.Long, metadata.tempAuthKeyId);
  const tempSessionId = longFromJson(m.Long, metadata.tempSessionId);

  const inner = {
    _: 'mt_bind_auth_key_inner',
    nonce,
    tempAuthKeyId,
    permAuthKeyId,
    tempSessionId,
    expiresAt: metadata.expiresAt,
  };

  const writer = m.TlBinaryWriter.alloc(m.__tlWriterMap, 80);
  writer.raw(crypto.randomBytes(16));
  writer.long(msgId);
  writer.int(0);
  writer.int(40);
  writer.object(inner);
  const msgWithoutPadding = writer.result();
  writer.raw(crypto.randomBytes(8));
  const msgWithPadding = writer.result();

  const msgKey = crypto.sha1(msgWithoutPadding).subarray(4, 20);
  const ige = m.createAesIgeForMessageOld(crypto, permanentKeyBytes, msgKey, true);
  const encryptedData = ige.encrypt(msgWithPadding);
  const encryptedMessage = new Uint8Array(8 + 16 + encryptedData.length);
  encryptedMessage.set(permAuthKeyIdBytes, 0);
  encryptedMessage.set(msgKey, 8);
  encryptedMessage.set(encryptedData, 24);

  return {
    permAuthKeyId: longJson(permAuthKeyId),
    encryptedMessage: Buffer.from(encryptedMessage).toString('base64'),
  };
}

class DeferredLike {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

async function waitForProcessMessage(proc, acceptedTypes, label) {
  const types = new Set(Array.isArray(acceptedTypes) ? acceptedTypes : [acceptedTypes]);
  return timeout(new Promise((resolve, reject) => {
    const onMessage = message => {
      if (!types.has(message?.type)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`${label} exited before ${[...types].join('/')} (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      proc.off('message', onMessage);
      proc.off('exit', onExit);
    };
    proc.on('message', onMessage);
    proc.on('exit', onExit);
  }), `${label} message`);
}

async function clientMain() {
  assertClientHasNoSecrets();
  assert.ok(globalThis.WebSocket, 'Node runtime must provide WebSocket.');

  const m = await loadMtcuteInternals();
  const crypto = await makeCrypto(m);
  const connection = await makeManualConnection(m, crypto, 'client', 0);
  let tempAuthKeyBytes;

  try {
    const [generatedTempKey, tempServerSalt] = await timeout(
      m.doAuthorization(connection, crypto, TEMP_EXPIRY_SECONDS),
      'temporary auth generation',
    );
    tempAuthKeyBytes = generatedTempKey;

    // Harness-only mtcute 0.31.0 decrypt guard workaround. This random key is
    // not authorized and is never the binder's permanent key.
    connection._session._authKey.setup(crypto.randomBytes(256));
    const tempKey = connection._session._authKeyTempSecondary;
    tempKey.setup(tempAuthKeyBytes);

    const msgId = connection._session.getMessageId();
    const nonce = m.randomLong();
    const expiresAt = Math.floor(Date.now() / 1000) + TEMP_EXPIRY_SECONDS;
    const metadata = {
      msgId: longJson(msgId),
      nonce: longJson(nonce),
      tempAuthKeyId: longJson(m.longFromBuffer(tempKey.id)),
      tempSessionId: longJson(connection._session._sessionId),
      expiresAt,
    };

    process.send?.({ type: 'build-binding', metadata });
    const envelopeMessage = await waitForProcessMessage(process, 'binding-envelope', 'binder');
    const { envelope } = envelopeMessage;
    const permAuthKeyId = longFromJson(m.Long, envelope.permAuthKeyId);
    const encryptedMessage = new Uint8Array(Buffer.from(envelope.encryptedMessage, 'base64'));

    assert.notEqual(
      permAuthKeyId.toString(),
      m.longFromBuffer(connection._session._authKey.id).toString(),
      'Random sentinel must not equal the binder permanent key id.',
    );

    const pending = new DeferredLike();
    connection._session.pendingMessages.set(msgId, { _: 'bind', promise: pending });
    const bindRequest = {
      _: 'auth.bindTempAuthKey',
      permAuthKeyId,
      nonce,
      expiresAt,
      encryptedMessage,
    };
    const reqSize = m.TlSerializationCounter.countNeededBytes(m.__tlWriterMap, bindRequest);
    const reqWriter = m.TlBinaryWriter.alloc(m.__tlWriterMap, reqSize + 16);
    reqWriter.long(connection._registerOutgoingMsgId(msgId));
    reqWriter.uint(connection._session.getSeqNo());
    reqWriter.uint(reqSize);
    reqWriter.object(bindRequest);

    const requestEncrypted = tempKey.encryptMessage(
      reqWriter.result(),
      tempServerSalt,
      connection._session._sessionId,
    );
    await connection.send(requestEncrypted);

    const bindResult = await timeout(pending.promise, 'auth.bindTempAuthKey response');
    connection._session.pendingMessages.delete(msgId);
    if (typeof bindResult === 'object') {
      throw new Error(`Telegram rejected split bind: ${bindResult.errorCode}:${bindResult.errorMessage}`);
    }
    assert.equal(bindResult, true, 'Telegram must return boolTrue for the split bind.');

    // Reproduce mtcute's successful PFS key swap. MtprotoSession.encryptMessage()
    // automatically prefers _authKeyTemp when it is ready. Keep the random
    // sentinel in _authKey only to satisfy the 0.31.0 decrypt readiness guard.
    connection._session._authKeyTempSecondary = connection._session._authKeyTemp;
    connection._session._authKeyTemp = tempKey;
    connection._salts.currentSalt = tempServerSalt;
    // Do not wrap the client request with initConnection: that would require
    // sending an application API id to the device, which Task 5.1 forbids.
    connection._session.initConnectionCalled = true;
    connection.onConnectionUsable();

    const selfResult = await timeout(
      connection.sendRpc({
        _: 'users.getUsers',
        id: [{ _: 'inputUserSelf' }],
      }, 30_000),
      'bound-temp bot self query',
    );

    if (selfResult?._ === 'mt_rpc_error') {
      throw new Error(`Bound-temp bot RPC rejected: ${selfResult.errorCode}:${selfResult.errorMessage}`);
    }
    assert.ok(Array.isArray(selfResult), 'users.getUsers must return a user vector.');
    assert.equal(selfResult.length, 1, 'users.getUsers(inputUserSelf) must return one identity.');
    const self = selfResult[0];
    assert.equal(self?._, 'user', 'Returned identity must be a Telegram user object.');
    assert.equal(self?.bot, true, 'Bound temporary key must inherit bot identity.');

    process.send?.({
      type: 'client-proof',
      userId: String(self.id),
      bot: true,
    });
  } finally {
    tempAuthKeyBytes?.fill(0);
    await connection.destroy().catch(() => {});
  }
}

async function binderMain() {
  assert.ok(globalThis.WebSocket, 'Node runtime must provide WebSocket.');
  const apiIdRaw = requiredSecret('BEATGALER_M0_B2_API_ID');
  const apiHash = requiredSecret('BEATGALER_M0_B2_API_HASH');
  const botToken = requiredSecret('BEATGALER_M0_B2_BOT_TOKEN');
  const apiId = Number(apiIdRaw);
  assert.ok(Number.isInteger(apiId) && apiId > 0, 'BEATGALER_M0_B2_API_ID must be a positive integer.');

  const m = await loadMtcuteInternals();
  const crypto = await makeCrypto(m);
  const connection = await makeManualConnection(m, crypto, 'binder', apiId);
  let permanentKeyBytes;
  let client;

  try {
    const [generatedPermanentKey, permanentServerSalt, permanentTimeOffset] = await timeout(
      m.doAuthorization(connection, crypto),
      'permanent auth generation',
    );
    permanentKeyBytes = generatedPermanentKey;
    connection._session._authKey.setup(permanentKeyBytes);
    connection._salts.currentSalt = permanentServerSalt;
    connection._session.updateTimeOffset(permanentTimeOffset, true);
    connection.onConnectionUsable();

    const authorization = await timeout(
      connection.sendRpc({
        _: 'auth.importBotAuthorization',
        flags: 0,
        apiId,
        apiHash,
        botAuthToken: botToken,
      }, 30_000),
      'bot authorization',
    );
    if (authorization?._ === 'mt_rpc_error') {
      throw new Error(`Bot authorization rejected: ${authorization.errorCode}:${authorization.errorMessage}`);
    }
    assert.equal(authorization?._, 'auth.authorization', 'Expected auth.authorization for bot login.');
    assert.equal(authorization?.user?._, 'user', 'Bot login must return a user object.');
    assert.equal(authorization?.user?.bot, true, 'Authorized permanent identity must be a bot.');
    const authorizedBotId = String(authorization.user.id);

    client = fork(fileURLToPath(import.meta.url), ['--client'], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: sanitizedClientEnv(),
    });

    const bindingRequest = await waitForProcessMessage(client, 'build-binding', 'client');
    const envelope = await buildBindingEnvelope(m, crypto, permanentKeyBytes, bindingRequest.metadata);
    client.send({ type: 'binding-envelope', envelope });

    const proof = await waitForProcessMessage(client, 'client-proof', 'client');
    assert.equal(proof.bot, true);
    assert.equal(proof.userId, authorizedBotId, 'Temporary key must resolve to the same bot identity as binder authorization.');

    console.log('PASS M0-B2 bot temp-auth proof: authorized bot identity and direct RPC succeeded while permanent credentials stayed binder-side');
    console.log(JSON.stringify({
      mode: 'M0-B2 isolated production-DC bot identity proof',
      bot_identity_proven: true,
      network_bind_proven: true,
      direct_mtproto_operation_proven: true,
      direct_rpc_method: 'users.getUsers(inputUserSelf)',
      permanent_auth_reaches_client: false,
      bot_token_reaches_client: false,
      api_hash_reaches_client: false,
      galer_file_bytes: false,
      vault_used: false,
      token_rotation_or_revoke: false,
      next_gate: 'M0-C: renewal, early expiration and long-operation behavior before data-plane transfer tests.',
    }));
  } finally {
    permanentKeyBytes?.fill(0);
    if (client?.connected) client.disconnect();
    if (client && !client.killed) client.kill('SIGTERM');
    await connection.destroy().catch(() => {});
  }
}

if (process.argv.includes('--client') || process.env.BEATGALER_M0_B2_CLIENT === '1') {
  await clientMain();
} else {
  await binderMain();
}
