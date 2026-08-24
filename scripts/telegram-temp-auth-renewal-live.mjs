import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Task 5.1 M0-C live proof only.
//
// Security boundary:
// - The parent process is the binder/control side and is the ONLY process that
//   receives the dedicated API id, API hash and bot token.
// - The child process is the simulated device. It is forked with those secrets
//   explicitly removed from its environment.
// - The parent creates and bot-authorizes the permanent MTProto auth key.
// - The child creates and retains temporary MTProto auth keys A/B/C.
// - The child sends only binding metadata to the parent; never temp-key bytes.
// - The parent returns only permanent key id + encrypted binding envelope.
// - A is used for a direct bot RPC, B is bound while A remains active and then
//   promoted for the next RPC, and A is retained in the secondary temp-key slot.
// - A controlled fault then invalidates local temp-key state before any further
//   RPC; C is freshly created/bound and the logical operation continues.
// - The fault is a client-side simulation of early expiry/loss. It does NOT prove
//   that Telegram itself expired a key early.
// - No BeatGaler user, vault, message mutation, file transfer, token rotation or
//   revocation is involved.
//
// This is probe code, not production runtime.

const SECRET_NAMES = [
  'BEATGALER_M0_C_API_ID',
  'BEATGALER_M0_C_API_HASH',
  'BEATGALER_M0_C_BOT_TOKEN',
  // Strip the preceding probe aliases too if a runner happens to define them.
  'BEATGALER_M0_B2_API_ID',
  'BEATGALER_M0_B2_API_HASH',
  'BEATGALER_M0_B2_BOT_TOKEN',
  // Also strip product-style names defensively.
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_BOT_TOKEN',
];
const TEMP_EXPIRY_SECONDS = 10 * 60;
const TIMEOUT_MS = 60_000;
const DEFAULT_PROD_DC_ID = 2;
const BIND_ROUNDS = ['A', 'B', 'C'];
const PROD_DC_SUBDOMAINS = {
  1: 'pluto',
  2: 'venus',
  3: 'aurora',
  4: 'vesta',
  5: 'flora',
};

function productionDc(dcId) {
  const subdomain = PROD_DC_SUBDOMAINS[dcId];
  assert.ok(subdomain, `Unsupported Telegram production DC ${dcId}.`);
  return {
    id: dcId,
    ipAddress: `${subdomain}.web.telegram.org`,
    port: 443,
    testMode: false,
    mediaOnly: false,
    ipv6: false,
  };
}

function parseProductionDcId(value, label) {
  const dcId = Number(value);
  assert.ok(
    Number.isInteger(dcId) && PROD_DC_SUBDOMAINS[dcId],
    `${label} must be a Telegram production DC id from 1 to 5.`,
  );
  return dcId;
}

function requiredSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required M0-C secret: ${name}`);
  return value;
}

function sanitizedClientEnv(dcId) {
  const env = {
    ...process.env,
    BEATGALER_M0_C_CLIENT: '1',
    BEATGALER_M0_C_DC_ID: String(dcId),
  };
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
    error(...args) { console.error('[mtcute-m0c-probe]', ...args); },
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

async function makeManualConnection(m, crypto, label, apiId = 0, dcId = DEFAULT_PROD_DC_ID) {
  class ManualSessionConnection extends m.SessionConnection {
    onConnected() {
      // The probe explicitly drives permanent or temporary key generation.
    }
  }

  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => `BeatGaler M0-C ${label}`,
    getDefaultLogLevel: () => null,
  };
  const transport = new m.WebSocketTransport({ ws: globalThis.WebSocket });
  const connection = new ManualSessionConnection({
    crypto,
    initConnection: {
      _: 'initConnection',
      apiId,
      deviceModel: `BeatGaler M0-C ${label}`,
      systemVersion: process.version,
      appVersion: '0.8.0-alpha.1-probe',
      systemLangCode: 'en',
      langPack: '',
      langCode: 'en',
      query: { _: 'help.getNearestDc' },
    },
    transport,
    dc: productionDc(dcId),
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

function authKeyIdHex(key) {
  return Buffer.from(key.id).toString('hex');
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

async function generateAndBindTempKey(m, crypto, connection, label) {
  const candidate = connection._session._authKeyTempSecondary;
  assert.equal(candidate.ready, false, `${label} requires a free secondary temp-key slot.`);

  const [generatedTempKey, tempServerSalt] = await timeout(
    m.doAuthorization(connection, crypto, TEMP_EXPIRY_SECONDS),
    `temporary auth generation ${label}`,
  );

  // Preserve the exact ordering proven by M0-B2 for the first temp handshake:
  // do not arm mtcute's random permanent-slot sentinel until fresh temp-key
  // generation has finished. Before A exists, an invalid sentinel can make
  // background encrypted traffic interfere with the unencrypted auth handshake.
  if (!connection._session._authKey.ready) {
    connection._session._authKey.setup(crypto.randomBytes(256));
  }

  candidate.setup(generatedTempKey);
  const keyId = authKeyIdHex(candidate);

  const msgId = connection._session.getMessageId();
  const nonce = m.randomLong();
  const expiresAt = Math.floor(Date.now() / 1000) + TEMP_EXPIRY_SECONDS;
  const metadata = {
    msgId: longJson(msgId),
    nonce: longJson(nonce),
    tempAuthKeyId: longJson(m.longFromBuffer(candidate.id)),
    tempSessionId: longJson(connection._session._sessionId),
    expiresAt,
  };

  process.send?.({ type: 'build-binding', label, metadata });
  const envelopeMessage = await waitForProcessMessage(process, 'binding-envelope', 'binder');
  assert.equal(envelopeMessage.label, label, `Binding response label mismatch for ${label}.`);
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

  const requestEncrypted = candidate.encryptMessage(
    reqWriter.result(),
    tempServerSalt,
    connection._session._sessionId,
  );
  await connection.send(requestEncrypted);

  const bindResult = await timeout(pending.promise, `auth.bindTempAuthKey response ${label}`);
  connection._session.pendingMessages.delete(msgId);
  if (typeof bindResult === 'object') {
    throw new Error(`Telegram rejected split bind ${label}: ${bindResult.errorCode}:${bindResult.errorMessage}`);
  }
  assert.equal(bindResult, true, `Telegram must return boolTrue for split bind ${label}.`);

  return {
    label,
    keyBytes: generatedTempKey,
    keyId,
    tempServerSalt,
    expiresAt,
  };
}

function activateBoundTempKey(connection, boundKey, expectedPreviousPrimaryId = null) {
  const candidate = connection._session._authKeyTempSecondary;
  assert.equal(authKeyIdHex(candidate), boundKey.keyId, `${boundKey.label} must occupy the secondary slot before swap.`);
  const oldPrimary = connection._session._authKeyTemp;

  connection._session._authKeyTempSecondary = oldPrimary;
  connection._session._authKeyTemp = candidate;
  connection._salts.currentSalt = boundKey.tempServerSalt;
  // Keep the client application-id-free. B2 proved that the harmless identity RPC
  // succeeds directly under the bound temp key without exposing API id/hash.
  connection._session.initConnectionCalled = true;
  connection.onConnectionUsable();

  assert.equal(authKeyIdHex(connection._session._authKeyTemp), boundKey.keyId, `${boundKey.label} must become primary.`);
  if (expectedPreviousPrimaryId) {
    assert.equal(
      authKeyIdHex(connection._session._authKeyTempSecondary),
      expectedPreviousPrimaryId,
      `${boundKey.label} swap must retain the previous primary in the secondary slot.`,
    );
  }
}

async function querySelf(connection, label) {
  const selfResult = await timeout(
    connection.sendRpc({
      _: 'users.getUsers',
      id: [{ _: 'inputUserSelf' }],
    }, 30_000),
    `bound-temp bot self query ${label}`,
  );

  if (selfResult?._ === 'mt_rpc_error') {
    throw new Error(`Bound-temp bot RPC ${label} rejected: ${selfResult.errorCode}:${selfResult.errorMessage}`);
  }
  assert.ok(Array.isArray(selfResult), `users.getUsers ${label} must return a user vector.`);
  assert.equal(selfResult.length, 1, `users.getUsers(inputUserSelf) ${label} must return one identity.`);
  const self = selfResult[0];
  assert.equal(self?._, 'user', `Returned identity ${label} must be a Telegram user object.`);
  assert.equal(self?.bot, true, `Bound temporary key ${label} must inherit bot identity.`);
  return String(self.id);
}

async function clientMain() {
  assertClientHasNoSecrets();
  assert.ok(globalThis.WebSocket, 'Node runtime must provide WebSocket.');
  const dcId = parseProductionDcId(process.env.BEATGALER_M0_C_DC_ID, 'BEATGALER_M0_C_DC_ID');

  const m = await loadMtcuteInternals();
  const crypto = await makeCrypto(m);
  const connection = await makeManualConnection(m, crypto, 'client', 0, dcId);
  const tempKeyBuffers = [];

  try {
    const operationId = Buffer.from(crypto.randomBytes(8)).toString('hex');
    const checkpoints = [];

    // Checkpoint 1: operation starts under temp key A. generateAndBindTempKey()
    // arms the harness-only decrypt sentinel only after A's fresh handshake,
    // matching the ordering already proven in M0-B2.
    const tempA = await generateAndBindTempKey(m, crypto, connection, 'A');
    tempKeyBuffers.push(tempA.keyBytes);
    activateBoundTempKey(connection, tempA);
    const userA = await querySelf(connection, 'A');
    checkpoints.push({ phase: 'start', key: 'A', userId: userA });

    // Proactive renewal: create/bind B while A is still the active primary.
    assert.equal(authKeyIdHex(connection._session._authKeyTemp), tempA.keyId, 'A must still be primary while B is being bound.');
    const tempB = await generateAndBindTempKey(m, crypto, connection, 'B');
    tempKeyBuffers.push(tempB.keyBytes);
    assert.notEqual(tempB.keyId, tempA.keyId, 'B must be a fresh temporary auth key.');
    assert.equal(authKeyIdHex(connection._session._authKeyTemp), tempA.keyId, 'A must remain primary until B bind succeeds.');
    activateBoundTempKey(connection, tempB, tempA.keyId);
    const oldKeyRetainedAsSecondary = authKeyIdHex(connection._session._authKeyTempSecondary) === tempA.keyId;
    assert.equal(oldKeyRetainedAsSecondary, true, 'A must remain available in the secondary slot after B promotion.');

    const userB = await querySelf(connection, 'B');
    assert.equal(userB, userA, 'Bot identity must remain stable across proactive renewal A -> B.');
    checkpoints.push({ phase: 'after-proactive-renewal', key: 'B', userId: userB });

    // Controlled early-expiry/loss simulation. No RPC is sent after invalidation
    // until a fresh C key has been generated, bound and promoted.
    assert.equal(authKeyIdHex(connection._session._authKeyTemp), tempB.keyId, 'B must be active before fault injection.');
    connection._session._authKeyTemp.reset();
    connection._session._authKeyTempSecondary.reset();
    assert.equal(connection._session._authKeyTemp.ready, false, 'Fault injection must invalidate active temp key B locally.');
    assert.equal(connection._session._authKeyTempSecondary.ready, false, 'Fault injection must clear the fallback temp-key slot locally.');

    // Erase the client-held A/B byte buffers once the simulated loss is active.
    tempA.keyBytes.fill(0);
    tempB.keyBytes.fill(0);

    const tempC = await generateAndBindTempKey(m, crypto, connection, 'C');
    tempKeyBuffers.push(tempC.keyBytes);
    assert.notEqual(tempC.keyId, tempA.keyId, 'C must differ from A.');
    assert.notEqual(tempC.keyId, tempB.keyId, 'C must differ from B.');
    activateBoundTempKey(connection, tempC);
    const userC = await querySelf(connection, 'C');
    assert.equal(userC, userA, 'Bot identity must survive simulated early temp-key loss and recovery.');
    checkpoints.push({ phase: 'after-simulated-early-expiry-recovery', key: 'C', userId: userC });

    assert.equal(checkpoints.length, 3, 'Logical operation must cross all three temp-key checkpoints.');

    process.send?.({
      type: 'client-proof',
      userId: userC,
      bot: true,
      operationId,
      checkpointCount: checkpoints.length,
      proactiveRenewalProven: true,
      oldKeySecondarySlotRetentionProven: oldKeyRetainedAsSecondary,
      logicalOperationContinuityProven: true,
      earlyExpirationRecoverySimulated: true,
      serverEarlyExpirationProven: false,
      wallClockExpiryWaited: false,
    });
  } finally {
    for (const bytes of tempKeyBuffers) bytes?.fill(0);
    connection._session._authKeyTemp?.reset();
    connection._session._authKeyTempSecondary?.reset();
    await connection.destroy().catch(() => {});
  }
}

async function binderMain() {
  assert.ok(globalThis.WebSocket, 'Node runtime must provide WebSocket.');
  const apiIdRaw = requiredSecret('BEATGALER_M0_C_API_ID');
  const apiHash = requiredSecret('BEATGALER_M0_C_API_HASH');
  const botToken = requiredSecret('BEATGALER_M0_C_BOT_TOKEN');
  const apiId = Number(apiIdRaw);
  assert.ok(Number.isInteger(apiId) && apiId > 0, 'BEATGALER_M0_C_API_ID must be a positive integer.');

  const m = await loadMtcuteInternals();
  const crypto = await makeCrypto(m);
  let connection;
  let permanentKeyBytes;
  let client;
  let dcId = DEFAULT_PROD_DC_ID;
  let authorizedBotId;

  try {
    const visitedDcs = new Set();
    while (!authorizedBotId) {
      if (visitedDcs.has(dcId)) {
        throw new Error(`Bot authorization migration loop detected at DC ${dcId}.`);
      }
      visitedDcs.add(dcId);

      connection = await makeManualConnection(m, crypto, 'binder', apiId, dcId);
      const [generatedPermanentKey, permanentServerSalt, permanentTimeOffset] = await timeout(
        m.doAuthorization(connection, crypto),
        `permanent auth generation on DC ${dcId}`,
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
        `bot authorization on DC ${dcId}`,
      );

      if (authorization?._ === 'mt_rpc_error') {
        const migrate = /^USER_MIGRATE_(\d+)$/.exec(String(authorization.errorMessage || ''));
        if (migrate) {
          const nextDcId = parseProductionDcId(migrate[1], 'USER_MIGRATE target');
          await connection.destroy().catch(() => {});
          connection = undefined;
          permanentKeyBytes.fill(0);
          permanentKeyBytes = undefined;
          dcId = nextDcId;
          continue;
        }
        throw new Error(`Bot authorization rejected: ${authorization.errorCode}:${authorization.errorMessage}`);
      }

      assert.equal(authorization?._, 'auth.authorization', 'Expected auth.authorization for bot login.');
      assert.equal(authorization?.user?._, 'user', 'Bot login must return a user object.');
      assert.equal(authorization?.user?.bot, true, 'Authorized permanent identity must be a bot.');
      authorizedBotId = String(authorization.user.id);
    }

    assert.ok(connection && permanentKeyBytes, 'Authorized binder connection/key must be available.');

    client = fork(fileURLToPath(import.meta.url), ['--client'], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: sanitizedClientEnv(dcId),
    });

    for (const expectedLabel of BIND_ROUNDS) {
      const bindingRequest = await waitForProcessMessage(client, 'build-binding', 'client');
      assert.equal(bindingRequest.label, expectedLabel, `Expected temp-key bind round ${expectedLabel}.`);
      const envelope = await buildBindingEnvelope(m, crypto, permanentKeyBytes, bindingRequest.metadata);
      client.send({ type: 'binding-envelope', label: expectedLabel, envelope });
    }

    const proof = await waitForProcessMessage(client, 'client-proof', 'client');
    assert.equal(proof.bot, true);
    assert.equal(proof.userId, authorizedBotId, 'All temporary keys must resolve to the same bot identity as binder authorization.');
    assert.equal(proof.proactiveRenewalProven, true);
    assert.equal(proof.oldKeySecondarySlotRetentionProven, true);
    assert.equal(proof.logicalOperationContinuityProven, true);
    assert.equal(proof.earlyExpirationRecoverySimulated, true);
    assert.equal(proof.serverEarlyExpirationProven, false);
    assert.equal(proof.wallClockExpiryWaited, false);
    assert.equal(proof.checkpointCount, 3);

    console.log('PASS M0-C temp-auth renewal proof: A -> B proactive renewal and simulated early-loss recovery to C preserved bot identity without client permanent credentials');
    console.log(JSON.stringify({
      mode: 'M0-C isolated production-DC temp-auth renewal/recovery proof',
      production_dc_id: dcId,
      bot_identity_preserved_across_temp_keys: true,
      network_bind_count: 3,
      proactive_renewal_proven: true,
      old_key_secondary_slot_retention_proven: true,
      logical_operation_continuity_proven: true,
      logical_operation_checkpoint_count: 3,
      early_expiration_recovery_simulated: true,
      server_early_expiration_proven: false,
      wall_clock_expiry_waited: false,
      permanent_auth_reaches_client: false,
      bot_token_reaches_client: false,
      api_hash_reaches_client: false,
      galer_file_bytes: false,
      vault_used: false,
      token_rotation_or_revoke: false,
      next_gate: 'M0-D: direct data-plane transfer evidence up to the 1.9 GB product limit, still without Galer file relay.',
    }));
  } finally {
    permanentKeyBytes?.fill(0);
    if (client?.connected) client.disconnect();
    if (client && !client.killed) client.kill('SIGTERM');
    if (connection) {
      await Promise.race([
        connection.destroy().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
  }
}

if (process.argv.includes('--client') || process.env.BEATGALER_M0_C_CLIENT === '1') {
  await clientMain();
} else {
  await binderMain();
  // Probe-only hard stop: success/failure evidence has already been emitted and
  // secrets/keys were cleared best-effort; do not let mtcute handles retain CI.
  process.exit(0);
}
