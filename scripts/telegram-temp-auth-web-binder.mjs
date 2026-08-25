import assert from "node:assert/strict";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Task 5.1 M0-E2 control-side binder only.
// Permanent bot credentials and the permanent MTProto auth key stay in this
// Node process. The browser/Worker receives only DC routing metadata, the bot
// identity to verify, and the encrypted bind envelope. No file bytes/vaults.

const PORT = 4180;
const HOST = "127.0.0.1";
const DEFAULT_PROD_DC_ID = 2;
const TIMEOUT_MS = 60_000;
const PROD_DC_SUBDOMAINS = {
  1: "pluto",
  2: "venus",
  3: "aurora",
  4: "vesta",
  5: "flora",
};

function requiredSecret(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required M0-E2 secret: ${name}`);
  return value;
}

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
  assert.ok(Number.isInteger(dcId) && PROD_DC_SUBDOMAINS[dcId], `${label} must be a production DC id from 1 to 5.`);
  return dcId;
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
    error(...args) { console.error("[mtcute-m0-e2-binder]", ...args); },
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
  const web = await import("@mtcute/web");
  const webEntry = import.meta.resolve("@mtcute/web");
  const webPkg = await findPackageRoot(webEntry, "@mtcute/web");
  const requireFromWeb = createRequire(pathToFileURL(path.join(webPkg.root, "package.json")));
  const coreEntry = requireFromWeb.resolve("@mtcute/core");
  const corePkg = await findPackageRoot(pathToFileURL(coreEntry), "@mtcute/core");
  const requireFromCore = createRequire(pathToFileURL(path.join(corePkg.root, "package.json")));

  assert.equal(webPkg.manifest.version, "0.31.0");
  assert.equal(corePkg.manifest.version, "0.31.0");

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
  const wasmPkg = await findPackageRoot(pathToFileURL(wasmEntry), "@mtcute/wasm");
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
    defaultReconnectionStrategy,
    TlBinaryWriter,
    wasmBytes,
  };
}

async function makeCrypto(m) {
  const response = new Response(m.wasmBytes, { headers: { "Content-Type": "application/wasm" } });
  const crypto = new m.WebCryptoProvider({ wasmInput: response });
  await crypto.initialize();
  return crypto;
}

async function makeManualConnection(m, crypto, apiId, dcId) {
  class ManualSessionConnection extends m.SessionConnection {
    onConnected() {
      // Probe drives authorization explicitly.
    }
  }

  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => "BeatGaler M0-E2 binder",
    getDefaultLogLevel: () => null,
  };
  const connection = new ManualSessionConnection({
    crypto,
    initConnection: {
      _: "initConnection",
      apiId,
      deviceModel: "BeatGaler M0-E2 binder",
      systemVersion: process.version,
      appVersion: "0.8.0-alpha.1-probe",
      systemLangCode: "en",
      langPack: "",
      langCode: "en",
      query: { _: "help.getNearestDc" },
    },
    transport: new m.WebSocketTransport({ ws: globalThis.WebSocket }),
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
  }, silentLogger("binder"));

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("binder socket open timeout")), TIMEOUT_MS);
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
  assert.ok(metadata && typeof metadata === "object", "Binding metadata must be an object.");
  assert.ok(Number.isInteger(metadata.expiresAt), "Binding expiresAt must be an integer.");
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
    permAuthKeyId: longJson(permAuthKeyId),
    encryptedMessage: Buffer.from(encryptedMessage).toString("base64"),
  };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error("M0-E2 binder request too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function main() {
  assert.ok(globalThis.WebSocket, "Node runtime must provide WebSocket.");
  const apiIdRaw = requiredSecret("BEATGALER_M0_B2_API_ID");
  const apiHash = requiredSecret("BEATGALER_M0_B2_API_HASH");
  const botToken = requiredSecret("BEATGALER_M0_B2_BOT_TOKEN");
  const apiId = Number(apiIdRaw);
  assert.ok(Number.isInteger(apiId) && apiId > 0, "BEATGALER_M0_B2_API_ID must be a positive integer.");

  const m = await loadMtcuteInternals();
  const crypto = await makeCrypto(m);
  let connection;
  let permanentKeyBytes;
  let dcId = DEFAULT_PROD_DC_ID;
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
      botAuthToken: botToken,
    }, 30_000), `bot authorization on DC ${dcId}`);

    if (authorization?._ === "mt_rpc_error") {
      const migrate = /^USER_MIGRATE_(\d+)$/.exec(String(authorization.errorMessage || ""));
      if (migrate) {
        const nextDcId = parseProductionDcId(migrate[1], "USER_MIGRATE target");
        await connection.destroy().catch(() => {});
        connection = undefined;
        permanentKeyBytes.fill(0);
        permanentKeyBytes = undefined;
        dcId = nextDcId;
        continue;
      }
      throw new Error(`Bot authorization rejected: ${authorization.errorCode}:${authorization.errorMessage}`);
    }

    assert.equal(authorization?._, "auth.authorization");
    assert.equal(authorization?.user?._, "user");
    assert.equal(authorization?.user?.bot, true);
    authorizedBotId = String(authorization.user.id);
  }

  assert.ok(connection && permanentKeyBytes && authorizedBotId);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, 200, { ok: true, dcId, authorizedBotId });
      }
      if (req.method === "POST" && req.url === "/bind") {
        const body = await readJson(req);
        const envelope = await buildBindingEnvelope(m, crypto, permanentKeyBytes, body.metadata);
        return sendJson(res, 200, { ok: true, envelope });
      }
      return sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      console.error("[m0-e2-binder] request failed:", error?.message || error);
      return sendJson(res, 400, { ok: false, error: "binder_request_failed" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log(`M0-E2_BINDER_READY host=${HOST} port=${PORT} dc=${dcId} permanent_credentials_browser=false`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise(resolve => server.close(() => resolve()));
    permanentKeyBytes?.fill(0);
    if (connection) {
      await Promise.race([
        connection.destroy().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

await main();
