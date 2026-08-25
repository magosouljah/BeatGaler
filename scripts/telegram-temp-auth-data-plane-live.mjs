import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Task 5.1 M0-D live proof only.
//
// Security boundary:
// - The parent process is the binder/control side and is the ONLY process that
//   receives the dedicated API id, API hash and bot token.
// - The child process is the simulated device. It is forked with those secrets
//   explicitly removed from its environment.
// - The parent creates and bot-authorizes the permanent MTProto auth key.
// - The child creates and retains temporary MTProto auth keys A/B.
// - The child uploads synthetic bytes directly to Telegram with
//   upload.saveBigFilePart. File bytes are never sent over IPC to the binder.
// - One logical upload uses the same file_id across A -> B. B is bound while A
//   remains active, then promoted before the second half of the transfer.
// - No BeatGaler vault, user file, message, token rotation or revoke is used.
// - The full mode matches the existing Web product ceiling exactly:
//   1900 * 1024 * 1024 = 1,992,294,400 bytes = 3800 * 512 KiB parts.
//
// This is probe code, not production runtime.

const SECRET_NAMES = [
  'BEATGALER_M0_D_API_ID',
  'BEATGALER_M0_D_API_HASH',
  'BEATGALER_M0_D_BOT_TOKEN',
  'BEATGALER_M0_C_API_ID',
  'BEATGALER_M0_C_API_HASH',
  'BEATGALER_M0_C_BOT_TOKEN',
  'BEATGALER_M0_B2_API_ID',
  'BEATGALER_M0_B2_API_HASH',
  'BEATGALER_M0_B2_BOT_TOKEN',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_BOT_TOKEN',
];

const TEMP_EXPIRY_SECONDS = 2 * 60 * 60;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const FULL_CLIENT_PROGRESS_TIMEOUT_MS = 10 * 60 * 1000;
const PART_RPC_TIMEOUT_MS = 90_000;
const DEFAULT_PROD_DC_ID = 2;
const PART_SIZE_BYTES = 512 * 1024;
const FULL_TARGET_BYTES = 1900 * 1024 * 1024;
const FULL_PART_COUNT = FULL_TARGET_BYTES / PART_SIZE_BYTES;
const SMOKE_PART_COUNT = 32;
const UPLOAD_CONCURRENCY = 2;
const LOG_EVERY_PARTS = 200;
const MAX_FLOOD_RETRIES_PER_PART = 8;
const MAX_CUMULATIVE_FLOOD_WAIT_MS = 60_000;
const BIND_ROUNDS = ['A', 'B'];

assert.equal(Number.isInteger(FULL_PART_COUNT), true);
assert.equal(FULL_PART_COUNT, 3800);
assert.ok(FULL_PART_COUNT < 4000, 'Product ceiling must remain below Telegram normal 4000-part boundary.');

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
  assert.ok(Number.isInteger(dcId) && PROD_DC_SUBDOMAINS[dcId], `${label} must be a Telegram production DC id from 1 to 5.`);
  return dcId;
}

function requiredSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required M0-D secret: ${name}`);
  return value;
}

function probeMode() {
  const mode = String(process.env.BEATGALER_M0_D_MODE || 'smoke').trim().toLowerCase();
  assert.ok(mode === 'smoke' || mode === 'full', 'BEATGALER_M0_D_MODE must be smoke or full.');
  return mode;
}

function sanitizedClientEnv(dcId, mode) {
  const env = {
    ...process.env,
    BEATGALER_M0_D_CLIENT: '1',
    BEATGALER_M0_D_DC_ID: String(dcId),
    BEATGALER_M0_D_MODE: mode,
  };
  for (const name of SECRET_NAMES) delete env[name];
  return env;
}

function assertClientHasNoSecrets() {
  for (const name of SECRET_NAMES) {
    assert.equal(process.env[name], undefined, `${name} must not reach the client process.`);
  }
}

function assertControlOnlyIpc(message) {
  const encoded = JSON.stringify(message ?? null);
  assert.ok(encoded.length < 64 * 1024, 'Probe IPC must remain control-plane sized.');
  assert.equal(/"(?:bytes|chunk|fileData|fileBytes)"\s*:/.test(encoded), false, 'File payload must never cross binder IPC.');
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
    error(...args) { console.error('[mtcute-m0d-probe]', ...args); },
  };
}

function timeout(promise, label, ms = HANDSHAKE_TIMEOUT_MS) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const response = new Response(m.wasmBytes, { headers: { 'Content-Type': 'application/wasm' } });
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
    getDeviceModel: () => `BeatGaler M0-D ${label}`,
    getDefaultLogLevel: () => null,
  };
  const transport = new m.WebSocketTransport({ ws: globalThis.WebSocket });
  const connection = new ManualSessionConnection({
    crypto,
    initConnection: {
      _: 'initConnection',
      apiId,
      deviceModel: `BeatGaler M0-D ${label}`,
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
    inactivityTimeout: 180_000,
    salts: new m.ServerSaltManager(),
    platform,
    pingInterval: 60_000,
  }, silentLogger(label));

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} socket open timeout`)), HANDSHAKE_TIMEOUT_MS);
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

async function waitForProcessMessage(proc, acceptedTypes, label, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  const types = new Set(Array.isArray(acceptedTypes) ? acceptedTypes : [acceptedTypes]);
  return timeout(new Promise((resolve, reject) => {
    const onMessage = message => {
      assertControlOnlyIpc(message);
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
  }), `${label} message`, timeoutMs);
}

async function generateAndBindTempKey(m, crypto, connection, label) {
  const candidate = connection._session._authKeyTempSecondary;
  assert.equal(candidate.ready, false, `${label} requires a free secondary temp-key slot.`);

  const [generatedTempKey, tempServerSalt] = await timeout(
    m.doAuthorization(connection, crypto, TEMP_EXPIRY_SECONDS),
    `temporary auth generation ${label}`,
  );

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

  return { label, keyBytes: generatedTempKey, keyId, tempServerSalt, expiresAt };
}

function activateBoundTempKey(connection, boundKey, expectedPreviousPrimaryId = null) {
  const candidate = connection._session._authKeyTempSecondary;
  assert.equal(authKeyIdHex(candidate), boundKey.keyId, `${boundKey.label} must occupy the secondary slot before swap.`);
  const oldPrimary = connection._session._authKeyTemp;

  connection._session._authKeyTempSecondary = oldPrimary;
  connection._session._authKeyTemp = candidate;
  connection._salts.currentSalt = boundKey.tempServerSalt;
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

function makeSyntheticPart(workerId) {
  const bytes = new Uint8Array(PART_SIZE_BYTES);
  for (let offset = 16; offset < bytes.length; offset += 4096) {
    bytes[offset] = (workerId * 29 + offset / 4096) & 0xff;
  }
  return bytes;
}

async function uploadPart(connection, fileId, totalParts, partIndex, bytes, floodStats) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, partIndex, true);
  view.setUint32(4, totalParts, true);
  view.setUint32(8, PART_SIZE_BYTES, true);
  view.setUint32(12, 0x4d304431, true); // "M0D1" marker, synthetic only.

  let floodRetries = 0;
  while (true) {
    const result = await timeout(
      connection.sendRpc({
        _: 'upload.saveBigFilePart',
        fileId,
        filePart: partIndex,
        fileTotalParts: totalParts,
        bytes,
      }, PART_RPC_TIMEOUT_MS),
      `upload.saveBigFilePart ${partIndex + 1}/${totalParts}`,
      PART_RPC_TIMEOUT_MS + 5_000,
    );

    if (result?._ === 'mt_rpc_error') {
      const flood = /^FLOOD_WAIT_(\d+)$/.exec(String(result.errorMessage || ''));
      if (Number(result.errorCode) === 420 && flood) {
        const waitMs = Number(flood[1]) * 1000;
        floodRetries += 1;
        floodStats.events += 1;
        floodStats.waitMs += waitMs;
        if (floodRetries > MAX_FLOOD_RETRIES_PER_PART) {
          throw new Error(`Part ${partIndex} exceeded ${MAX_FLOOD_RETRIES_PER_PART} FLOOD_WAIT retries.`);
        }
        if (floodStats.waitMs > MAX_CUMULATIVE_FLOOD_WAIT_MS) {
          throw new Error(`M0-D exceeded cumulative FLOOD_WAIT budget of ${MAX_CUMULATIVE_FLOOD_WAIT_MS}ms.`);
        }
        console.log(`M0-D FLOOD_WAIT: part ${partIndex + 1}/${totalParts}, wait ${waitMs}ms, retry ${floodRetries}/${MAX_FLOOD_RETRIES_PER_PART}`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`Part ${partIndex} rejected: ${result.errorCode}:${result.errorMessage}`);
    }
    assert.equal(result, true, `Telegram must acknowledge part ${partIndex}.`);
    return;
  }
}

async function uploadRange(connection, fileId, totalParts, startPart, endPartExclusive, phaseLabel, floodStats) {
  assert.ok(startPart >= 0 && endPartExclusive <= totalParts && endPartExclusive > startPart);
  const phaseStarted = Date.now();
  let nextPart = startPart;
  let acceptedParts = 0;
  let acceptedBytes = 0;
  let lastLoggedAt = 0;
  const phasePartCount = endPartExclusive - startPart;

  const worker = async workerId => {
    const bytes = makeSyntheticPart(workerId);
    while (true) {
      const partIndex = nextPart;
      nextPart += 1;
      if (partIndex >= endPartExclusive) break;
      await uploadPart(connection, fileId, totalParts, partIndex, bytes, floodStats);
      acceptedParts += 1;
      acceptedBytes += PART_SIZE_BYTES;
      if (acceptedParts === phasePartCount || acceptedParts - lastLoggedAt >= LOG_EVERY_PARTS) {
        lastLoggedAt = acceptedParts;
        console.log(`M0-D ${phaseLabel}: accepted ${acceptedParts}/${phasePartCount} parts (${acceptedBytes} bytes)`);
      }
    }
    bytes.fill(0);
  };

  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, (_, index) => worker(index + 1)));
  const durationMs = Date.now() - phaseStarted;
  assert.equal(acceptedParts, phasePartCount);
  assert.equal(acceptedBytes, phasePartCount * PART_SIZE_BYTES);
  return { acceptedParts, acceptedBytes, durationMs };
}

async function clientMain() {
  assertClientHasNoSecrets();
  assert.ok(globalThis.WebSocket, 'Node runtime must provide WebSocket.');
  const dcId = parseProductionDcId(process.env.BEATGALER_M0_D_DC_ID, 'BEATGALER_M0_D_DC_ID');
  const mode = probeMode();
  const totalParts = mode === 'full' ? FULL_PART_COUNT : SMOKE_PART_COUNT;
  const targetBytes = totalParts * PART_SIZE_BYTES;
  const splitPart = Math.floor(totalParts / 2);
  assert.ok(splitPart > 0 && splitPart < totalParts);

  const m = await loadMtcuteInternals();
  const crypto = await makeCrypto(m);
  const connection = await makeManualConnection(m, crypto, 'client', 0, dcId);
  const tempKeyBuffers = [];
  const floodStats = { events: 0, waitMs: 0 };
  const transferStarted = Date.now();

  try {
    const fileId = m.randomLong();
    const fileIdString = fileId.toString();

    const tempA = await generateAndBindTempKey(m, crypto, connection, 'A');
    tempKeyBuffers.push(tempA.keyBytes);
    activateBoundTempKey(connection, tempA);

    const phaseA = await uploadRange(connection, fileId, totalParts, 0, splitPart, 'A', floodStats);
    assert.equal(authKeyIdHex(connection._session._authKeyTemp), tempA.keyId, 'A must remain primary through first upload half.');

    const tempB = await generateAndBindTempKey(m, crypto, connection, 'B');
    tempKeyBuffers.push(tempB.keyBytes);
    assert.notEqual(tempB.keyId, tempA.keyId, 'B must be a fresh temporary auth key.');
    assert.equal(authKeyIdHex(connection._session._authKeyTemp), tempA.keyId, 'A must remain primary until B bind succeeds.');
    activateBoundTempKey(connection, tempB, tempA.keyId);
    const oldKeyRetainedAsSecondary = authKeyIdHex(connection._session._authKeyTempSecondary) === tempA.keyId;
    assert.equal(oldKeyRetainedAsSecondary, true);

    const phaseB = await uploadRange(connection, fileId, totalParts, splitPart, totalParts, 'B', floodStats);
    const acceptedParts = phaseA.acceptedParts + phaseB.acceptedParts;
    const acceptedBytes = phaseA.acceptedBytes + phaseB.acceptedBytes;
    assert.equal(acceptedParts, totalParts);
    assert.equal(acceptedBytes, targetBytes);

    process.send?.({
      type: 'client-proof',
      mode,
      fileId: fileIdString,
      targetBytes,
      totalParts,
      partSizeBytes: PART_SIZE_BYTES,
      acceptedParts,
      acceptedBytes,
      phaseAParts: phaseA.acceptedParts,
      phaseBParts: phaseB.acceptedParts,
      transferDurationMs: Date.now() - transferStarted,
      floodWaitEvents: floodStats.events,
      floodWaitTotalMs: floodStats.waitMs,
      proactiveRenewalDuringTransferProven: true,
      sameFileIdAcrossRenewal: true,
      oldKeySecondarySlotRetentionProven: oldKeyRetainedAsSecondary,
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
  const mode = probeMode();
  const apiIdRaw = requiredSecret('BEATGALER_M0_D_API_ID');
  const apiHash = requiredSecret('BEATGALER_M0_D_API_HASH');
  const botToken = requiredSecret('BEATGALER_M0_D_BOT_TOKEN');
  const apiId = Number(apiIdRaw);
  assert.ok(Number.isInteger(apiId) && apiId > 0, 'BEATGALER_M0_D_API_ID must be a positive integer.');

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
      if (visitedDcs.has(dcId)) throw new Error(`Bot authorization migration loop detected at DC ${dcId}.`);
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

    assert.ok(connection && permanentKeyBytes && authorizedBotId, 'Authorized binder connection/key must be available.');

    client = fork(fileURLToPath(import.meta.url), ['--client'], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: sanitizedClientEnv(dcId, mode),
    });

    for (let bindIndex = 0; bindIndex < BIND_ROUNDS.length; bindIndex += 1) {
      const expectedLabel = BIND_ROUNDS[bindIndex];
      const clientProgressTimeoutMs = mode === 'full' && bindIndex > 0
        ? FULL_CLIENT_PROGRESS_TIMEOUT_MS
        : HANDSHAKE_TIMEOUT_MS;
      const bindingRequest = await waitForProcessMessage(
        client,
        'build-binding',
        'client',
        clientProgressTimeoutMs,
      );
      assert.equal(bindingRequest.label, expectedLabel, `Expected temp-key bind round ${expectedLabel}.`);
      const envelope = await buildBindingEnvelope(m, crypto, permanentKeyBytes, bindingRequest.metadata);
      client.send({ type: 'binding-envelope', label: expectedLabel, envelope });
    }

    const clientProofTimeoutMs = mode === 'full'
      ? FULL_CLIENT_PROGRESS_TIMEOUT_MS
      : HANDSHAKE_TIMEOUT_MS;
    const proof = await waitForProcessMessage(client, 'client-proof', 'client', clientProofTimeoutMs);
    const expectedParts = mode === 'full' ? FULL_PART_COUNT : SMOKE_PART_COUNT;
    const expectedBytes = expectedParts * PART_SIZE_BYTES;
    assert.equal(proof.mode, mode);
    assert.equal(proof.totalParts, expectedParts);
    assert.equal(proof.targetBytes, expectedBytes);
    assert.equal(proof.acceptedParts, expectedParts);
    assert.equal(proof.acceptedBytes, expectedBytes);
    assert.equal(proof.proactiveRenewalDuringTransferProven, true);
    assert.equal(proof.sameFileIdAcrossRenewal, true);
    assert.equal(proof.oldKeySecondarySlotRetentionProven, true);
    assert.ok(Number.isInteger(proof.floodWaitEvents) && proof.floodWaitEvents >= 0);
    assert.ok(Number.isInteger(proof.floodWaitTotalMs) && proof.floodWaitTotalMs >= 0);
    assert.ok(proof.floodWaitTotalMs <= MAX_CUMULATIVE_FLOOD_WAIT_MS);

    const durationSeconds = Math.max(0.001, Number(proof.transferDurationMs) / 1000);
    const averageMbps = Number(((proof.acceptedBytes * 8) / durationSeconds / 1_000_000).toFixed(2));
    const fullProductLimitProven = mode === 'full' && proof.acceptedBytes === FULL_TARGET_BYTES;

    console.log(`PASS M0-D ${mode} direct data-plane proof: ${proof.acceptedParts} parts / ${proof.acceptedBytes} synthetic bytes accepted under one file_id across temp-key renewal`);
    console.log(JSON.stringify({
      mode: `M0-D ${mode} production-DC direct data-plane proof`,
      production_dc_id: dcId,
      product_limit_bytes: FULL_TARGET_BYTES,
      target_bytes: proof.targetBytes,
      part_size_bytes: PART_SIZE_BYTES,
      total_parts: proof.totalParts,
      accepted_parts: proof.acceptedParts,
      accepted_bytes: proof.acceptedBytes,
      average_mbps: averageMbps,
      flood_wait_events: proof.floodWaitEvents,
      flood_wait_total_ms: proof.floodWaitTotalMs,
      flood_wait_retry_cap_per_part: MAX_FLOOD_RETRIES_PER_PART,
      flood_wait_cumulative_cap_ms: MAX_CUMULATIVE_FLOOD_WAIT_MS,
      direct_mtproto_file_parts_proven: true,
      full_product_limit_proven: fullProductLimitProven,
      proactive_renewal_during_transfer_proven: true,
      same_file_id_across_renewal: true,
      old_key_secondary_slot_retention_proven: true,
      permanent_auth_reaches_client: false,
      bot_token_reaches_client: false,
      api_hash_reaches_client: false,
      galer_cloud_file_bytes: 0,
      vault_used: false,
      message_created: false,
      server_materialized_file_proven: false,
      token_rotation_or_revoke: false,
      note: 'All saveBigFilePart calls were acknowledged. FLOOD_WAIT responses, if any, were honored exactly and retried within strict probe-only caps. This probe does not claim a final vault message or later download because no vault/message is used.',
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

if (process.argv.includes('--client') || process.env.BEATGALER_M0_D_CLIENT === '1') {
  await clientMain();
} else {
  await binderMain();
  process.exit(0);
}