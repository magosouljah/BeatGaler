import * as web from "@mtcute/web";
import { SessionConnection } from "@m0e/session-connection";
import { doAuthorization } from "@m0e/authorization";
import { ServerSaltManager } from "@m0e/server-salt";
import { __tlReaderMap } from "@m0e/tl-reader";
import { __tlWriterMap } from "@m0e/tl-writer";
import { longFromBuffer, randomLong } from "@m0e/long-utils";
import { defaultReconnectionStrategy } from "@fuman/net";
import { TlBinaryWriter, TlSerializationCounter } from "@mtcute/tl-runtime";

const TEMP_EXPIRY_SECONDS = 2 * 60 * 60;
const PART_SIZE_BYTES = 512 * 1024;
const TOTAL_PARTS = 32;
const BINDER = "http://127.0.0.1:43151";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function timeout(promise, label, ms = 60_000) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function silentLogger(prefix = "") {
  return {
    prefix,
    mgr: { level: 0 },
    create(child) { return silentLogger(prefix ? `${prefix}:${child}` : child); },
    verbose() {}, debug() {}, info() {}, warn() {},
    error(...args) { console.error("[m0e-web]", ...args); },
  };
}

function hex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value) {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function longJson(value) {
  return { low: value.low, high: value.high, unsigned: Boolean(value.unsigned) };
}

function longFromJson(value) {
  return new web.Long(value.low, value.high, Boolean(value.unsigned));
}

function productionDc(dcId) {
  const names = { 1: "pluto", 2: "venus", 3: "aurora", 4: "vesta", 5: "flora" };
  assert(names[dcId], `Unsupported DC ${dcId}`);
  return {
    id: dcId,
    ipAddress: `${names[dcId]}.web.telegram.org`,
    port: 443,
    testMode: false,
    mediaOnly: false,
    ipv6: false,
  };
}

class ManualSessionConnection extends SessionConnection {
  onConnected() {}
  waitForUnencryptedMessage(timeoutMs = 30_000) {
    return super.waitForUnencryptedMessage(timeoutMs);
  }
}

async function makeCrypto() {
  const crypto = new web.WebCryptoProvider();
  await crypto.initialize();
  return crypto;
}

async function makeConnection(crypto, dcId) {
  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => "BeatGaler M0-E browser",
    getDefaultLogLevel: () => null,
  };
  const connection = new ManualSessionConnection({
    crypto,
    initConnection: {
      _: "initConnection",
      apiId: 0,
      deviceModel: "BeatGaler M0-E browser",
      systemVersion: navigator.userAgent,
      appVersion: "0.8.0-alpha.1-probe",
      systemLangCode: "en",
      langPack: "",
      langCode: "en",
      query: { _: "help.getNearestDc" },
    },
    transport: new web.WebSocketTransport({ ws: globalThis.WebSocket }),
    dc: productionDc(dcId),
    testMode: false,
    reconnectionStrategy: defaultReconnectionStrategy,
    layer: web.tl.LAYER,
    disableUpdates: true,
    readerMap: __tlReaderMap,
    writerMap: __tlWriterMap,
    usePfs: false,
    isMainConnection: true,
    isMainDcConnection: true,
    inactivityTimeout: 180_000,
    salts: new ServerSaltManager(),
    platform,
    pingInterval: 60_000,
  }, silentLogger("browser"));

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("browser socket open timeout")), 60_000);
    connection.onUsable.add(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  connection.connect();
  await opened;
  return connection;
}

async function bindTempKey(connection, crypto, label, dcId) {
  const candidate = connection._session._authKeyTempSecondary;
  assert(candidate.ready === false, `${label} secondary temp slot must be free`);

  const [generatedTempKey, tempServerSalt] = await timeout(
    doAuthorization(connection, crypto, TEMP_EXPIRY_SECONDS),
    `temporary auth generation ${label}`,
  );
  if (!connection._session._authKey.ready) {
    connection._session._authKey.setup(crypto.randomBytes(256));
  }
  candidate.setup(generatedTempKey);

  const msgId = connection._session.getMessageId();
  const nonce = randomLong();
  const expiresAt = Math.floor(Date.now() / 1000) + TEMP_EXPIRY_SECONDS;
  const metadata = {
    msgId: longJson(msgId),
    nonce: longJson(nonce),
    tempAuthKeyId: longJson(longFromBuffer(candidate.id)),
    tempSessionId: longJson(connection._session._sessionId),
    expiresAt,
    dcId,
    label,
  };

  const response = await fetch(`${BINDER}/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
  assert(response.ok, `binder rejected ${label}: ${response.status}`);
  const envelope = await response.json();

  const permAuthKeyId = longFromJson(envelope.permAuthKeyId);
  const encryptedMessage = base64ToBytes(envelope.encryptedMessage);
  const pending = {};
  pending.promise = new Promise((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
  connection._session.pendingMessages.set(msgId, { _: "bind", promise: pending });

  const bindRequest = {
    _: "auth.bindTempAuthKey",
    permAuthKeyId,
    nonce,
    expiresAt,
    encryptedMessage,
  };
  const reqSize = TlSerializationCounter.countNeededBytes(__tlWriterMap, bindRequest);
  const reqWriter = TlBinaryWriter.alloc(__tlWriterMap, reqSize + 16);
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
  const bindResult = await timeout(pending.promise, `bind response ${label}`);
  connection._session.pendingMessages.delete(msgId);
  if (typeof bindResult === "object") {
    throw new Error(`bind ${label} rejected: ${bindResult.errorCode}:${bindResult.errorMessage}`);
  }
  assert(bindResult === true, `bind ${label} must return true`);

  return { label, keyBytes: generatedTempKey, keyId: hex(candidate.id), tempServerSalt };
}

function activate(connection, bound, previousId = null) {
  const candidate = connection._session._authKeyTempSecondary;
  assert(hex(candidate.id) === bound.keyId, `${bound.label} must be secondary before swap`);
  const oldPrimary = connection._session._authKeyTemp;
  connection._session._authKeyTempSecondary = oldPrimary;
  connection._session._authKeyTemp = candidate;
  connection._salts.currentSalt = bound.tempServerSalt;
  connection._session.initConnectionCalled = true;
  connection.onConnectionUsable();
  assert(hex(connection._session._authKeyTemp.id) === bound.keyId, `${bound.label} must be primary`);
  if (previousId) assert(hex(connection._session._authKeyTempSecondary.id) === previousId, "previous temp key must remain secondary");
}

function syntheticPart(partIndex) {
  const bytes = new Uint8Array(PART_SIZE_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, partIndex, true);
  view.setUint32(4, TOTAL_PARTS, true);
  view.setUint32(8, PART_SIZE_BYTES, true);
  view.setUint32(12, 0x4d304531, true);
  for (let offset = 16; offset < bytes.length; offset += 4096) bytes[offset] = (partIndex + offset / 4096) & 0xff;
  return bytes;
}

async function uploadRange(connection, fileId, start, end) {
  for (let part = start; part < end; part += 1) {
    const bytes = syntheticPart(part);
    const result = await timeout(connection.sendRpc({
      _: "upload.saveBigFilePart",
      fileId,
      filePart: part,
      fileTotalParts: TOTAL_PARTS,
      bytes,
    }, 90_000), `part ${part}`, 95_000);
    assert(result === true, `part ${part} rejected`);
    bytes.fill(0);
  }
}

async function main() {
  assert(!window.__TAURI_INTERNALS__, "pure Web probe must not run in Tauri");
  assert(typeof window.process === "undefined", "pure Web probe must not expose Node process");

  const cfgRes = await fetch(`${BINDER}/config`);
  assert(cfgRes.ok, "binder config unavailable");
  const { dcId } = await cfgRes.json();
  const crypto = await makeCrypto();
  const connection = await makeConnection(crypto, dcId);
  const buffers = [];
  try {
    const fileId = randomLong();
    const a = await bindTempKey(connection, crypto, "A", dcId);
    buffers.push(a.keyBytes);
    activate(connection, a);
    await uploadRange(connection, fileId, 0, TOTAL_PARTS / 2);

    const b = await bindTempKey(connection, crypto, "B", dcId);
    buffers.push(b.keyBytes);
    assert(b.keyId !== a.keyId, "B must be fresh");
    activate(connection, b, a.keyId);
    await uploadRange(connection, fileId, TOTAL_PARTS / 2, TOTAL_PARTS);

    const result = {
      platform: "pure-web",
      hasTauriRuntime: false,
      hasNodeProcess: false,
      totalParts: TOTAL_PARTS,
      acceptedBytes: TOTAL_PARTS * PART_SIZE_BYTES,
      sameFileIdAcrossRenewal: true,
      proactiveRenewalDuringTransferProven: true,
      permanentAuthReachesBrowser: false,
      botTokenReachesBrowser: false,
      apiHashReachesBrowser: false,
      galerCloudFileBytes: 0,
      tokenRotationOrRevoke: false,
    };
    window.__M0E_RESULT__ = result;
    document.querySelector("#probe").textContent = `PASS ${JSON.stringify(result)}`;
  } finally {
    for (const bytes of buffers) bytes?.fill(0);
    connection._session._authKeyTemp?.reset();
    connection._session._authKeyTempSecondary?.reset();
    await connection.destroy().catch(() => {});
  }
}

main().catch(error => {
  window.__M0E_ERROR__ = String(error?.stack || error);
  document.querySelector("#probe").textContent = `FAIL ${window.__M0E_ERROR__}`;
  console.error(error);
});
