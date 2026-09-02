"use strict";

const assert = require("node:assert/strict");
const { readFile, readdir } = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const TARGET_ROUTES = new Set([
  "/transport/session/start",
  "/transport/session/heartbeat",
  "/transport/operation/begin",
]);
const DEFAULT_PROD_DC_ID = 2;
const TIMEOUT_MS = 60_000;
const PROD_DC_SUBDOMAINS = {
  1: "pluto",
  2: "venus",
  3: "aurora",
  4: "vesta",
  5: "flora",
};
const permanentByTransport = new Map();
let permanentAuthorizationTail = Promise.resolve();
let mtcutePromise = null;

function timeout(promise, label, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function serializePermanentAuthorization(task) {
  const run = permanentAuthorizationTail.then(task, task);
  permanentAuthorizationTail = run.then(() => undefined, () => undefined);
  return run;
}

function productionDc(dcId) {
  const subdomain = PROD_DC_SUBDOMAINS[dcId];
  assert.ok(subdomain, `Unsupported production DC ${dcId}.`);
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
  assert.ok(Number.isInteger(dcId) && PROD_DC_SUBDOMAINS[dcId], `${label} must be a production DC id from 1 to 5.`);
  return dcId;
}

function silentLogger(prefix = "") {
  return {
    prefix,
    mgr: { level: 0 },
    create(child) { return silentLogger(prefix ? `${prefix}:${child}` : child); },
    verbose() {}, debug() {}, info() {}, warn() {},
    error(...args) { console.error("[direct-temp-auth]", ...args); },
  };
}

async function findPackageRoot(entryPath, expectedName) {
  let current = path.dirname(entryPath);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(path.join(current, "package.json"), "utf8"));
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
      else if (entry.name.endsWith(".wasm")) return full;
    }
  }
  throw new Error("Could not locate @mtcute/wasm binary.");
}

async function loadMtcuteInternals() {
  if (mtcutePromise) return mtcutePromise;
  mtcutePromise = (async () => {
    const requireFromHere = createRequire(__filename);
    const webEntry = requireFromHere.resolve("@mtcute/web");
    const webPkg = await findPackageRoot(webEntry, "@mtcute/web");
    assert.equal(webPkg.manifest.version, "0.31.0", "Productive temp-auth seam is pinned to @mtcute/web 0.31.0.");
    const requireFromWeb = createRequire(pathToFileURL(path.join(webPkg.root, "package.json")));
    const coreEntry = requireFromWeb.resolve("@mtcute/core");
    const corePkg = await findPackageRoot(coreEntry, "@mtcute/core");
    assert.equal(corePkg.manifest.version, "0.31.0", "Productive temp-auth seam is pinned to @mtcute/core 0.31.0.");
    const requireFromCore = createRequire(pathToFileURL(path.join(corePkg.root, "package.json")));
    const Long = requireFromCore("long");
    const web = await import(pathToFileURL(webEntry).href);
    const apiSchemaPath = requireFromWeb.resolve("@mtcute/core/tl/api-schema.json");
    const apiSchema = JSON.parse(await readFile(apiSchemaPath, "utf8"));
    assert.ok(Number.isInteger(apiSchema.l) && apiSchema.l > 0, "Could not resolve MTProto API layer.");
    const { SessionConnection } = requireFromCore(path.join(corePkg.root, "network/session-connection.cjs"));
    const { doAuthorization } = requireFromCore(path.join(corePkg.root, "network/authorization.cjs"));
    const { ServerSaltManager } = requireFromCore(path.join(corePkg.root, "network/server-salt.cjs"));
    const { __tlReaderMap } = requireFromCore(path.join(corePkg.root, "tl/binary/reader.cjs"));
    const { __tlWriterMap } = requireFromCore(path.join(corePkg.root, "tl/binary/writer.cjs"));
    const { createAesIgeForMessageOld } = requireFromCore(path.join(corePkg.root, "utils/crypto/mtproto.cjs"));
    const { longFromBuffer } = requireFromCore(path.join(corePkg.root, "utils/long-utils.cjs"));
    const { defaultReconnectionStrategy } = requireFromCore("@fuman/net");
    const { TlBinaryWriter } = requireFromCore("@mtcute/tl-runtime");
    const wasmEntry = requireFromWeb.resolve("@mtcute/wasm");
    const wasmPkg = await findPackageRoot(wasmEntry, "@mtcute/wasm");
    const wasmBytes = await readFile(await findFirstWasm(wasmPkg.root));
    return {
      ...web,
      Long,
      SessionConnection,
      doAuthorization,
      ServerSaltManager,
      __tlReaderMap,
      __tlWriterMap,
      createAesIgeForMessageOld,
      longFromBuffer,
      defaultReconnectionStrategy,
      TlBinaryWriter,
      wasmBytes,
      apiLayer: apiSchema.l,
    };
  })();
  return mtcutePromise;
}

async function makeCrypto(m) {
  const response = new Response(m.wasmBytes, { headers: { "Content-Type": "application/wasm" } });
  const crypto = new m.WebCryptoProvider({ wasmInput: response });
  await crypto.initialize();
  return crypto;
}

async function makeManualConnection(m, crypto, apiId, dcId) {
  class ManualSessionConnection extends m.SessionConnection {
    onConnected() {}
  }
  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => "BeatGaler controlled temp-auth binder",
    getDefaultLogLevel: () => null,
  };
  const connection = new ManualSessionConnection({
    crypto,
    initConnection: {
      _: "initConnection",
      apiId,
      deviceModel: "BeatGaler controlled temp-auth binder",
      systemVersion: process.version,
      appVersion: "0.8.0-alpha.1",
      systemLangCode: "en",
      langPack: "",
      langCode: "en",
      query: { _: "help.getNearestDc" },
    },
    transport: new m.WebSocketTransport({ ws: globalThis.WebSocket }),
    dc: productionDc(dcId),
    testMode: false,
    reconnectionStrategy: m.defaultReconnectionStrategy,
    layer: m.apiLayer,
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
  }, silentLogger("binder"));
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("controlled binder socket open timeout")), TIMEOUT_MS);
    connection.onUsable.add(() => { clearTimeout(timer); resolve(); });
  });
  connection.connect();
  await opened;
  return connection;
}

function longJson(value) {
  return { low: value.low, high: value.high, unsigned: Boolean(value.unsigned) };
}

function longFromJson(Long, value) {
  assert.ok(value && Number.isInteger(value.low) && Number.isInteger(value.high), "Invalid temporary-auth long metadata.");
  return new Long(value.low, value.high, Boolean(value.unsigned));
}

async function authorizePermanent(session) {
  const transportId = String(session.transport_id || "");
  const credentialVersion = Number(session.credential_version || 0);
  const token = String(session.bot_token || "");
  const apiId = Number(session.telegram_api_id || 0);
  const apiHash = String(session.telegram_api_hash || "");
  assert.ok(transportId && token && Number.isInteger(apiId) && apiId > 0 && apiHash, "Incomplete controlled-side transport credentials.");
  const cacheKey = `${transportId}:${credentialVersion}`;
  const cached = permanentByTransport.get(cacheKey);
  if (cached) return cached;

  const promise = serializePermanentAuthorization(async () => {
    assert.ok(globalThis.WebSocket, "Node runtime must provide WebSocket for productive temporary auth.");
    const m = await loadMtcuteInternals();
    const crypto = await makeCrypto(m);
    let dcId = DEFAULT_PROD_DC_ID;
    let connection;
    let permanentKeyBytes;
    let authorizedBotId;
    const visitedDcs = new Set();
    while (!authorizedBotId) {
      if (visitedDcs.has(dcId)) throw new Error(`Bot authorization migration loop at DC ${dcId}.`);
      visitedDcs.add(dcId);
      connection = await makeManualConnection(m, crypto, apiId, dcId);
      const [generatedPermanentKey, permanentServerSalt, permanentTimeOffset] = await timeout(
        m.doAuthorization(connection, crypto),
        `permanent auth generation on DC ${dcId}`,
      );
      permanentKeyBytes = generatedPermanentKey;
      connection._session._authKey.setup(permanentKeyBytes);
      connection._salts.currentSalt = permanentServerSalt;
      connection._session.updateTimeOffset(permanentTimeOffset, true);
      connection.onConnectionUsable();
      const authorization = await timeout(connection.sendRpc({
        _: "auth.importBotAuthorization",
        flags: 0,
        apiId,
        apiHash,
        botAuthToken: token,
      }, 30_000), `bot authorization on DC ${dcId}`);
      if (authorization?._ === "mt_rpc_error") {
        const migrate = /^USER_MIGRATE_(\d+)$/.exec(String(authorization.errorMessage || ""));
        if (migrate) {
          const nextDcId = parseProductionDcId(migrate[1], "USER_MIGRATE target");
          await connection.destroy().catch(() => {});
          permanentKeyBytes.fill(0);
          connection = undefined;
          permanentKeyBytes = undefined;
          dcId = nextDcId;
          continue;
        }
        throw new Error(`Bot authorization rejected: ${authorization.errorCode}:${authorization.errorMessage}`);
      }
      assert.equal(authorization?._, "auth.authorization");
      assert.equal(authorization?.user?.bot, true);
      authorizedBotId = String(authorization.user.id);
    }
    const expected = session.transport_user_id == null ? "" : String(session.transport_user_id);
    if (expected && expected !== authorizedBotId) throw new Error("Controlled temporary-auth binder resolved the wrong transport bot identity.");
    return { m, crypto, connection, permanentKeyBytes, dcId, apiId, authorizedBotId };
  });
  permanentByTransport.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    permanentByTransport.delete(cacheKey);
    throw error;
  }
}

async function buildBindingEnvelope(state, metadata) {
  assert.ok(metadata && typeof metadata === "object", "Binding metadata must be an object.");
  assert.ok(Number.isInteger(metadata.expiresAt), "Binding expiresAt must be an integer.");
  const now = Math.floor(Date.now() / 1000);
  assert.ok(metadata.expiresAt > now + 30 && metadata.expiresAt <= now + 15 * 60, "Temporary auth expiry is outside the allowed window.");
  const { m, crypto, permanentKeyBytes } = state;
  const permAuthKeyIdBytes = crypto.sha1(permanentKeyBytes).subarray(-8);
  const permAuthKeyId = m.longFromBuffer(permAuthKeyIdBytes);
  const msgId = longFromJson(m.Long, metadata.msgId);
  const nonce = longFromJson(m.Long, metadata.nonce);
  const tempAuthKeyId = longFromJson(m.Long, metadata.tempAuthKeyId);
  const tempSessionId = longFromJson(m.Long, metadata.tempSessionId);
  const inner = {
    _: "mt_bind_auth_key_inner",
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
    perm_auth_key_id: longJson(permAuthKeyId),
    encrypted_message: Buffer.from(encryptedMessage).toString("base64"),
  };
}

function stripPermanentSecrets(session) {
  if (!session || typeof session !== "object") return session;
  const {
    bot_token: _botToken,
    telegram_api_id: _apiId,
    telegram_api_hash: _apiHash,
    credential_envelope: _legacyEnvelope,
    ...safe
  } = session;
  return safe;
}

async function transformSession(session, metadata) {
  if (!session || typeof session !== "object") return session;
  const safe = stripPermanentSecrets(session);
  if (session.ok !== true) return safe;
  const state = await authorizePermanent(session);
  const bootstrap = {
    version: 1,
    dc_id: state.dcId,
    // initConnection transmits the numeric application id after every temp-key
    // bind. The API hash/token/permanent key stay controlled-side.
    api_id: state.apiId,
    expected_bot_id: state.authorizedBotId,
    expires_at: null,
    binding: null,
  };
  if (!metadata) {
    return {
      ...safe,
      mode: "galer-direct-temp-mtproto",
      temp_auth_required: true,
      temp_auth: bootstrap,
    };
  }
  const binding = await buildBindingEnvelope(state, metadata);
  return {
    ...safe,
    mode: "galer-direct-temp-mtproto",
    temp_auth_required: false,
    temp_auth: {
      ...bootstrap,
      expires_at: metadata.expiresAt,
      binding,
    },
  };
}

async function transformTransportBody(req, body) {
  if (!body || typeof body !== "object") return body;
  const metadata = req.body?.tempAuthMetadata || null;
  if (req.path === "/transport/session/start") return transformSession(body, metadata);
  if (body.credential_refresh) {
    const { credential_refresh: refresh, ...safeBody } = body;
    if (!metadata) {
      return {
        ...stripPermanentSecrets(safeBody),
        refresh_required: true,
        temp_auth_required: true,
      };
    }
    return {
      ...stripPermanentSecrets(safeBody),
      refresh_required: true,
      credential_refresh: await transformSession(refresh, metadata),
      temp_auth_required: false,
    };
  }
  return stripPermanentSecrets(body);
}

function installProductiveTempAuthBoundary(express) {
  const application = express?.application;
  if (!application || application.__beatgalerTempAuthBoundaryInstalled) return;
  application.__beatgalerTempAuthBoundaryInstalled = true;
  const originalPost = application.post;
  application.post = function patchedPost(route, ...handlers) {
    if (!TARGET_ROUTES.has(route)) return originalPost.call(this, route, ...handlers);
    const boundary = (req, res, next) => {
      const originalJson = res.json.bind(res);
      let sent = false;
      res.json = body => {
        if (sent) return res;
        sent = true;
        void transformTransportBody(req, body).then(
          transformed => originalJson(transformed),
          error => {
            console.error(`[direct-temp-auth] ${route} boundary failed:`, error?.message || error);
            if (!res.headersSent) res.status(503);
            originalJson({ ok: false, error: "Temporary transport authorization is unavailable." });
          },
        );
        return res;
      };
      next();
    };
    return originalPost.call(this, route, boundary, ...handlers);
  };
}

module.exports = {
  installProductiveTempAuthBoundary,
  stripPermanentSecrets,
};