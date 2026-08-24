import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// M0-B1 protocol probe only.
// - Telegram TEST DC only.
// - No bot token, API hash, BeatGaler user, vault or user file.
// - Permanent MTProto auth key exists only inside the binder child process.
// - Temporary MTProto auth key exists only inside the client process.
// - The client sends auth.bindTempAuthKey directly to Telegram.
//
// This is deliberately NOT production code. A random, unauthorized sentinel is
// placed in mtcute's permanent-key slot client-side solely because mtcute 0.31.0
// currently refuses to decrypt a temp-key response unless that slot is marked
// ready. The real permanent key never enters the client process.

const TEMP_EXPIRY_SECONDS = 10 * 60;
const TIMEOUT_MS = 45_000;
const TEST_DC = {
  id: 2,
  ipAddress: '149.154.167.40',
  port: 443,
  testMode: true,
  mediaOnly: false,
  ipv6: false,
};

function silentLogger(prefix = '') {
  return {
    prefix,
    mgr: { level: 0 },
    create(child) { return silentLogger(prefix ? `${prefix}:${child}` : child); },
    verbose() {},
    debug() {},
    info() {},
    warn() {},
    error(...args) { console.error('[mtcute-probe]', ...args); },
  };
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

class DeferredLike {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function timeout(promise, label, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function makeCrypto(m) {
  const crypto = new m.WebCryptoProvider({ wasmInput: m.wasmBytes });
  await crypto.initialize();
  return crypto;
}

async function makeManualConnection(m, crypto, label) {
  class ManualSessionConnection extends m.SessionConnection {
    onConnected() {
      // Suppress mtcute's automatic permanent authorization. M0-B1 explicitly
      // drives either permanent OR temporary key generation on this connection.
    }
  }

  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => `BeatGaler M0-B1 ${label}`,
    getDefaultLogLevel: () => null,
  };
  const transport = new m.WebSocketTransport({ ws: globalThis.WebSocket });
  const connection = new ManualSessionConnection({
    crypto,
    initConnection: {
      _: 'initConnection',
      apiId: 0,
      deviceModel: `BeatGaler M0-B1 ${label}`,
      systemVersion: process.version,
      appVersion: '0.8.0-alpha.1-probe',
      systemLangCode: 'en',
      langPack: '',
      langCode: 'en',
      query: { _: 'help.getNearestDc' },
    },
    transport,
    dc: TEST_DC,
    testMode: true,
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

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
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

async function binderMain() {
  const m = await loadMtcuteInternals();
  const crypto = await makeCrypto(m);
  const connection = await makeManualConnection(m, crypto, 'binder');
  let permanentKeyBytes;
  try {
    [permanentKeyBytes] = await timeout(m.doAuthorization(connection, crypto), 'permanent auth generation');
    process.send?.({ type: 'binder-ready' });

    const request = await timeout(new Promise((resolve, reject) => {
      const onMessage = message => {
        if (message?.type !== 'build-binding') return;
        process.off('message', onMessage);
        resolve(message.metadata);
      };
      process.on('message', onMessage);
      process.once('disconnect', () => reject(new Error('client disconnected before binding request')));
    }), 'binder metadata');

    const envelope = await buildBindingEnvelope(m, crypto, permanentKeyBytes, request);
    process.send?.({ type: 'binding-envelope', envelope });
  } finally {
    permanentKeyBytes?.fill(0);
    await connection.destroy().catch(() => {});
  }
}

async function waitForChildMessage(child, type) {
  return timeout(new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`binder exited before ${type} (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  }), `binder ${type}`);
}

async function clientMain() {
  assert.ok(globalThis.WebSocket, 'Node runtime must provide WebSocket for the isolated test-DC probe.');
  const m = await loadMtcuteInternals();
  const crypto = await makeCrypto(m);
  const connection = await makeManualConnection(m, crypto, 'client');
  const binder = fork(fileURLToPath(import.meta.url), ['--binder'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, BEATGALER_M0_B1_BINDER: '1' },
  });

  let tempAuthKeyBytes;
  try {
    await waitForChildMessage(binder, 'binder-ready');

    const [generatedTempKey, tempServerSalt] = await timeout(
      m.doAuthorization(connection, crypto, TEMP_EXPIRY_SECONDS),
      'temporary auth generation',
    );
    tempAuthKeyBytes = generatedTempKey;

    // Real temp key stays client-side. The random sentinel below is NOT a
    // permanent Telegram credential and is never sent as one. It exists only to
    // satisfy mtcute 0.31.0's decryptMessage readiness guard.
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

    binder.send({ type: 'build-binding', metadata });
    const { envelope } = await waitForChildMessage(binder, 'binding-envelope');
    const permAuthKeyId = longFromJson(m.Long, envelope.permAuthKeyId);
    const encryptedMessage = new Uint8Array(Buffer.from(envelope.encryptedMessage, 'base64'));

    // Verify the binder returned an envelope for a DIFFERENT key id than the
    // client's random sentinel. This catches accidental local use of the real
    // permanent key material without ever exposing the material itself.
    assert.notEqual(permAuthKeyId.toString(), m.longFromBuffer(connection._session._authKey.id).toString());

    const pending = new DeferredLike();
    connection._session.pendingMessages.set(msgId, { _: 'bind', promise: pending });
    const request = {
      _: 'auth.bindTempAuthKey',
      permAuthKeyId,
      nonce,
      expiresAt,
      encryptedMessage,
    };
    const reqSize = m.TlSerializationCounter.countNeededBytes(m.__tlWriterMap, request);
    const reqWriter = m.TlBinaryWriter.alloc(m.__tlWriterMap, reqSize + 16);
    reqWriter.long(connection._registerOutgoingMsgId(msgId));
    reqWriter.uint(connection._session.getSeqNo());
    reqWriter.uint(reqSize);
    reqWriter.object(request);

    const requestEncrypted = tempKey.encryptMessage(
      reqWriter.result(),
      tempServerSalt,
      connection._session._sessionId,
    );
    await connection.send(requestEncrypted);

    const result = await timeout(pending.promise, 'auth.bindTempAuthKey response');
    connection._session.pendingMessages.delete(msgId);
    if (typeof result === 'object') {
      throw new Error(`Telegram rejected split bind: ${result.errorCode}:${result.errorMessage}`);
    }
    assert.equal(result, true, 'Telegram must return boolTrue for the split bind.');

    console.log('PASS M0-B1 split network bind: Telegram accepted auth.bindTempAuthKey while permanent auth stayed binder-side');
    console.log(JSON.stringify({
      mode: 'M0-B1 isolated TEST-DC network bind',
      test_dc: true,
      bot_identity_proven: false,
      permanent_auth_reaches_client: false,
      temp_auth_key_reaches_binder: false,
      galer_file_bytes: false,
      network_bind_proven: true,
      direct_mtproto_operation_proven: false,
      mtcute_stock_pfs_used: false,
      mtcute_decrypt_guard_workaround: 'random unauthorized sentinel only',
      next_gate: 'M0-B2: prove an authorized bot operation directly with Telegram while permanent bot credentials remain controlled-side.',
    }));
  } finally {
    tempAuthKeyBytes?.fill(0);
    binder.disconnect();
    binder.kill('SIGTERM');
    await connection.destroy().catch(() => {});
  }
}

if (process.argv.includes('--binder') || process.env.BEATGALER_M0_B1_BINDER === '1') {
  await binderMain();
} else {
  await clientMain();
}
