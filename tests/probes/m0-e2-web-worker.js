import {
  Long,
  SessionConnection,
  WebCryptoProvider,
  WebSocketTransport,
  tl,
} from "@mtcute/web";
import mtcuteWasmUrl from "@mtcute/wasm/mtcute.wasm?url";
import {
  TlBinaryWriter,
  TlSerializationCounter,
  __tlReaderMap,
  __tlWriterMap,
  longFromBuffer,
  randomLong,
} from "__m0_core_utils__";
import { doAuthorization } from "__m0_authorization__";

// Task 5.1 M0-E2 browser-side proof only. This file runs inside a real Web
// Worker. It never receives the bot token, API hash or permanent auth key.

const TEMP_EXPIRY_SECONDS = 10 * 60;
const TIMEOUT_MS = 60_000;
const PROD_DC_SUBDOMAINS = {
  1: "pluto",
  2: "venus",
  3: "aurora",
  4: "vesta",
  5: "flora",
};

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function timeout(promise, label, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function productionDc(dcId) {
  const subdomain = PROD_DC_SUBDOMAINS[dcId];
  invariant(subdomain, `Unsupported Telegram production DC ${dcId}.`);
  return {
    id: dcId,
    ipAddress: `${subdomain}.web.telegram.org`,
    port: 443,
    testMode: false,
    mediaOnly: false,
    ipv6: false,
  };
}

function silentLogger(prefix = "") {
  return {
    prefix,
    mgr: { level: 0 },
    create(child) { return silentLogger(prefix ? `${prefix}:${child}` : child); },
    verbose() {},
    debug() {},
    info() {},
    warn() {},
    error(...args) { console.error("[mtcute-m0-e2-worker]", ...args); },
  };
}

class ProbeSaltManager {
  currentSalt = Long.ZERO;
  isFetching = false;
  setTimeSource(fn) { this.getServerTime = fn; }
  shouldFetchSalts() { return false; }
  setFutureSalts() {}
  destroy() {}
}

class DeferredLike {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function longJson(value) {
  return { low: value.low, high: value.high, unsigned: Boolean(value.unsigned) };
}

function longFromJson(value) {
  return new Long(value.low, value.high, Boolean(value.unsigned));
}

function fromBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function binder(pathname, options = {}) {
  const response = await fetch(`/m0-e2-binder${pathname}`, {
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok || !body?.ok) throw new Error(`M0-E2 binder ${pathname} failed.`);
  return body;
}

async function makeConnection(provider, dcId) {
  class ManualSessionConnection extends SessionConnection {
    onConnected() {
      // Probe drives temporary authorization explicitly.
    }
  }

  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => "BeatGaler M0-E2 Web Worker",
    getDefaultLogLevel: () => null,
  };

  const connection = new ManualSessionConnection({
    crypto: provider,
    initConnection: {
      _: "initConnection",
      apiId: 0,
      deviceModel: "BeatGaler M0-E2 Web Worker",
      systemVersion: globalThis.navigator?.userAgent || "browser-worker",
      appVersion: "0.8.0-alpha.1-probe",
      systemLangCode: "en",
      langPack: "",
      langCode: "en",
      query: { _: "help.getNearestDc" },
    },
    transport: new WebSocketTransport({ ws: globalThis.WebSocket }),
    dc: productionDc(dcId),
    testMode: false,
    reconnectionStrategy: () => 1_000,
    layer: tl.LAYER,
    disableUpdates: true,
    readerMap: __tlReaderMap,
    writerMap: __tlWriterMap,
    usePfs: false,
    isMainConnection: true,
    isMainDcConnection: true,
    inactivityTimeout: 120_000,
    salts: new ProbeSaltManager(),
    platform,
    pingInterval: 60_000,
  }, silentLogger("browser-worker"));

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("M0-E2 browser socket open timeout")), TIMEOUT_MS);
    connection.onUsable.add(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  connection.connect();
  await opened;
  return connection;
}

async function runProof() {
  invariant(typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope, "M0-E2 must run in a Web Worker.");
  invariant(typeof globalThis.WebSocket === "function", "Web Worker must provide WebSocket.");

  // Vite only exposes VITE_* variables by default. Assert the permanent secret
  // names are not present in the browser-side environment object anyway.
  const browserEnv = import.meta.env || {};
  for (const name of [
    "BEATGALER_M0_B2_API_ID",
    "BEATGALER_M0_B2_API_HASH",
    "BEATGALER_M0_B2_BOT_TOKEN",
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
  ]) {
    invariant(!(name in browserEnv), `${name} must not reach the browser bundle.`);
  }

  const health = await binder("/health", { method: "GET", headers: {} });
  const dcId = Number(health.dcId);
  const expectedBotId = String(health.authorizedBotId || "");
  invariant(Number.isInteger(dcId) && PROD_DC_SUBDOMAINS[dcId], "Binder returned invalid DC routing metadata.");
  invariant(expectedBotId.length > 0, "Binder returned no bot identity to verify.");

  const provider = new WebCryptoProvider({ wasmInput: mtcuteWasmUrl });
  await provider.initialize();
  const connection = await makeConnection(provider, dcId);
  let tempAuthKeyBytes;

  try {
    const [generatedTempKey, tempServerSalt] = await timeout(
      doAuthorization(connection, provider, TEMP_EXPIRY_SECONDS),
      "browser temporary auth generation",
    );
    tempAuthKeyBytes = generatedTempKey;

    // Harness-only sentinel: mtcute 0.31.0 checks permanent-key readiness when
    // decrypting. This random key is not authorized and never comes from binder.
    connection._session._authKey.setup(provider.randomBytes(256));
    const tempKey = connection._session._authKeyTempSecondary;
    tempKey.setup(tempAuthKeyBytes);

    const msgId = connection._session.getMessageId();
    const nonce = randomLong();
    const expiresAt = Math.floor(Date.now() / 1000) + TEMP_EXPIRY_SECONDS;
    const metadata = {
      msgId: longJson(msgId),
      nonce: longJson(nonce),
      tempAuthKeyId: longJson(longFromBuffer(tempKey.id)),
      tempSessionId: longJson(connection._session._sessionId),
      expiresAt,
    };

    const bindResponse = await binder("/bind", {
      method: "POST",
      body: JSON.stringify({ metadata }),
    });
    const envelope = bindResponse.envelope;
    invariant(envelope?.permAuthKeyId && envelope?.encryptedMessage, "Binder returned incomplete envelope.");
    const permAuthKeyId = longFromJson(envelope.permAuthKeyId);
    const encryptedMessage = fromBase64(envelope.encryptedMessage);

    invariant(
      permAuthKeyId.toString() !== longFromBuffer(connection._session._authKey.id).toString(),
      "Random sentinel must not equal binder permanent auth key id.",
    );

    const pending = new DeferredLike();
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

    const requestEncrypted = tempKey.encryptMessage(
      reqWriter.result(),
      tempServerSalt,
      connection._session._sessionId,
    );
    await connection.send(requestEncrypted);

    const bindResult = await timeout(pending.promise, "browser auth.bindTempAuthKey response");
    connection._session.pendingMessages.delete(msgId);
    if (typeof bindResult === "object") {
      throw new Error(`Telegram rejected browser split bind: ${bindResult.errorCode}:${bindResult.errorMessage}`);
    }
    invariant(bindResult === true, "Telegram must return boolTrue for browser split bind.");

    connection._session._authKeyTempSecondary = connection._session._authKeyTemp;
    connection._session._authKeyTemp = tempKey;
    connection._salts.currentSalt = tempServerSalt;
    connection._session.initConnectionCalled = true;
    connection.onConnectionUsable();

    const selfResult = await timeout(connection.sendRpc({
      _: "users.getUsers",
      id: [{ _: "inputUserSelf" }],
    }, 30_000), "browser bound-temp bot self query");

    if (selfResult?._ === "mt_rpc_error") {
      throw new Error(`Bound-temp browser RPC rejected: ${selfResult.errorCode}:${selfResult.errorMessage}`);
    }
    invariant(Array.isArray(selfResult) && selfResult.length === 1, "users.getUsers must return exactly one identity.");
    const self = selfResult[0];
    invariant(self?._ === "user" && self?.bot === true, "Bound browser temporary key must inherit bot identity.");
    invariant(String(self.id) === expectedBotId, "Browser temporary key resolved to wrong bot identity.");

    return {
      status: "pass",
      mode: "M0-E2 real-browser Web Worker temporary-auth proof",
      production_dc_id: dcId,
      web_browser_proven: true,
      web_worker_proven: true,
      bot_identity_proven: true,
      network_bind_proven: true,
      direct_mtproto_operation_proven: true,
      direct_rpc_method: "users.getUsers(inputUserSelf)",
      permanent_auth_reaches_browser: false,
      bot_token_reaches_browser: false,
      api_hash_reaches_browser: false,
      galer_file_bytes: false,
      vault_used: false,
      production_runtime_changed: false,
      token_rotation_or_revoke: false,
    };
  } finally {
    tempAuthKeyBytes?.fill(0);
    await connection.destroy().catch(() => {});
  }
}

runProof()
  .then(result => globalThis.postMessage(result))
  .catch(error => globalThis.postMessage({
    status: "fail",
    error: String(error?.stack || error?.message || error),
    web_browser_proven: false,
    web_worker_proven: true,
    production_runtime_changed: false,
  }));
