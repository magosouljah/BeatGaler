import assert from "node:assert/strict";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = Number(process.env.BEATGALER_M0_E_BINDER_PORT || 43151);
const DEFAULT_DC = 2;
const MAX_BODY = 64 * 1024;

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function silentLogger(prefix = "") {
  return {
    prefix,
    mgr: { level: 0 },
    create(child) { return silentLogger(prefix ? `${prefix}:${child}` : child); },
    verbose() {}, debug() {}, info() {}, warn() {},
    error(...args) { console.error("[m0e-web-binder]", ...args); },
  };
}

function timeout(promise, label, ms = 60_000) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

async function packageRoot(entryUrl, expectedName) {
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
  throw new Error(`Could not locate ${expectedName}`);
}

async function findWasm(root) {
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name.endsWith(".wasm")) return full;
    }
  }
  throw new Error("Could not locate mtcute wasm");
}

async function loadMtcute() {
  const web = await import("@mtcute/web");
  const webPkg = await packageRoot(import.meta.resolve("@mtcute/web"), "@mtcute/web");
  const requireFromWeb = createRequire(pathToFileURL(path.join(webPkg.root, "package.json")));
  const coreEntry = requireFromWeb.resolve("@mtcute/core");
  const corePkg = await packageRoot(pathToFileURL(coreEntry), "@mtcute/core");
  const requireFromCore = createRequire(pathToFileURL(path.join(corePkg.root, "package.json")));
  const { SessionConnection } = requireFromCore(path.join(corePkg.root, "network/session-connection.cjs"));
  const { doAuthorization } = requireFromCore(path.join(corePkg.root, "network/authorization.cjs"));
  const { ServerSaltManager } = requireFromCore(path.join(corePkg.root, "network/server-salt.cjs"));
  const { __tlReaderMap } = requireFromCore(path.join(corePkg.root, "tl/binary/reader.cjs"));
  const { __tlWriterMap } = requireFromCore(path.join(corePkg.root, "tl/binary/writer.cjs"));
  const { createAesIgeForMessageOld } = requireFromCore(path.join(corePkg.root, "utils/crypto/mtproto.cjs"));
  const { longFromBuffer } = requireFromCore(path.join(corePkg.root, "utils/long-utils.cjs"));
  const { defaultReconnectionStrategy } = requireFromCore("@fuman/net");
  const { TlBinaryWriter } = requireFromCore("@mtcute/tl-runtime");
  const wasmPkg = await packageRoot(pathToFileURL(requireFromWeb.resolve("@mtcute/wasm")), "@mtcute/wasm");
  const wasmBytes = await readFile(await findWasm(wasmPkg.root));
  return { ...web, SessionConnection, doAuthorization, ServerSaltManager, __tlReaderMap, __tlWriterMap, createAesIgeForMessageOld, longFromBuffer, defaultReconnectionStrategy, TlBinaryWriter, wasmBytes };
}

const names = { 1: "pluto", 2: "venus", 3: "aurora", 4: "vesta", 5: "flora" };
function productionDc(dcId) {
  assert.ok(names[dcId], `Unsupported DC ${dcId}`);
  return { id: dcId, ipAddress: `${names[dcId]}.web.telegram.org`, port: 443, testMode: false, mediaOnly: false, ipv6: false };
}

async function makeCrypto(m) {
  const response = new Response(m.wasmBytes, { headers: { "Content-Type": "application/wasm" } });
  const crypto = new m.WebCryptoProvider({ wasmInput: response });
  await crypto.initialize();
  return crypto;
}

async function makeConnection(m, crypto, apiId, dcId) {
  class Manual extends m.SessionConnection { onConnected() {} }
  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => "BeatGaler M0-E binder",
    getDefaultLogLevel: () => null,
  };
  const connection = new Manual({
    crypto,
    initConnection: {
      _: "initConnection", apiId,
      deviceModel: "BeatGaler M0-E binder", systemVersion: process.version,
      appVersion: "0.8.0-alpha.1-probe", systemLangCode: "en", langPack: "", langCode: "en",
      query: { _: "help.getNearestDc" },
    },
    transport: new m.WebSocketTransport({ ws: globalThis.WebSocket }),
    dc: productionDc(dcId), testMode: false,
    reconnectionStrategy: m.defaultReconnectionStrategy,
    layer: m.tl.LAYER, disableUpdates: true,
    readerMap: m.__tlReaderMap, writerMap: m.__tlWriterMap,
    usePfs: false, isMainConnection: true, isMainDcConnection: true,
    inactivityTimeout: 180_000, salts: new m.ServerSaltManager(), platform, pingInterval: 60_000,
  }, silentLogger("binder"));
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("binder socket timeout")), 60_000);
    connection.onUsable.add(() => { clearTimeout(timer); resolve(); });
  });
  connection.connect();
  await opened;
  return connection;
}

function longJson(value) { return { low: value.low, high: value.high, unsigned: Boolean(value.unsigned) }; }
function longFromJson(m, value) { return new m.Long(value.low, value.high, Boolean(value.unsigned)); }

async function buildEnvelope(m, crypto, permanentKeyBytes, metadata) {
  const permAuthKeyIdBytes = crypto.sha1(permanentKeyBytes).subarray(-8);
  const permAuthKeyId = m.longFromBuffer(permAuthKeyIdBytes);
  const msgId = longFromJson(m, metadata.msgId);
  const nonce = longFromJson(m, metadata.nonce);
  const tempAuthKeyId = longFromJson(m, metadata.tempAuthKeyId);
  const tempSessionId = longFromJson(m, metadata.tempSessionId);
  const inner = { _: "mt_bind_auth_key_inner", nonce, tempAuthKeyId, permAuthKeyId, tempSessionId, expiresAt: metadata.expiresAt };
  const writer = m.TlBinaryWriter.alloc(m.__tlWriterMap, 80);
  writer.raw(crypto.randomBytes(16));
  writer.long(msgId);
  writer.int(0);
  writer.int(40);
  writer.object(inner);
  const withoutPadding = writer.result();
  writer.raw(crypto.randomBytes(8));
  const withPadding = writer.result();
  const msgKey = crypto.sha1(withoutPadding).subarray(4, 20);
  const ige = m.createAesIgeForMessageOld(crypto, permanentKeyBytes, msgKey, true);
  const encryptedData = ige.encrypt(withPadding);
  const encryptedMessage = new Uint8Array(8 + 16 + encryptedData.length);
  encryptedMessage.set(permAuthKeyIdBytes, 0);
  encryptedMessage.set(msgKey, 8);
  encryptedMessage.set(encryptedData, 24);
  return { permAuthKeyId: longJson(permAuthKeyId), encryptedMessage: Buffer.from(encryptedMessage).toString("base64") };
}

async function authorizeBinder() {
  const apiId = Number(required("BEATGALER_M0_D_API_ID"));
  const apiHash = required("BEATGALER_M0_D_API_HASH");
  const botToken = required("BEATGALER_M0_D_BOT_TOKEN");
  assert.ok(Number.isInteger(apiId) && apiId > 0);
  const m = await loadMtcute();
  const crypto = await makeCrypto(m);
  let dcId = DEFAULT_DC;
  let connection;
  let permanentKeyBytes;
  const visited = new Set();
  while (true) {
    if (visited.has(dcId)) throw new Error(`DC migration loop at ${dcId}`);
    visited.add(dcId);
    connection = await makeConnection(m, crypto, apiId, dcId);
    const [key, salt, offset] = await timeout(m.doAuthorization(connection, crypto), `permanent auth DC ${dcId}`);
    permanentKeyBytes = key;
    connection._session._authKey.setup(key);
    connection._salts.currentSalt = salt;
    connection._session.updateTimeOffset(offset, true);
    connection.onConnectionUsable();
    const auth = await timeout(connection.sendRpc({ _: "auth.importBotAuthorization", flags: 0, apiId, apiHash, botAuthToken: botToken }, 30_000), `bot auth DC ${dcId}`);
    if (auth?._ === "mt_rpc_error") {
      const migrate = /^USER_MIGRATE_(\d+)$/.exec(String(auth.errorMessage || ""));
      if (migrate) {
        await connection.destroy().catch(() => {});
        permanentKeyBytes.fill(0);
        dcId = Number(migrate[1]);
        continue;
      }
      throw new Error(`Bot auth rejected ${auth.errorCode}:${auth.errorMessage}`);
    }
    assert.equal(auth?._, "auth.authorization");
    assert.equal(auth?.user?.bot, true);
    break;
  }
  return { m, crypto, connection, permanentKeyBytes, dcId };
}

function cors(res) {
  res.setHeader("access-control-allow-origin", "http://127.0.0.1:4174");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function json(res, status, body) {
  cors(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("control request too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

const state = await authorizeBinder();
let binds = 0;
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") { cors(res); res.statusCode = 204; res.end(); return; }
    if (req.method === "GET" && req.url === "/health") { json(res, 200, { ok: true }); return; }
    if (req.method === "GET" && req.url === "/config") { json(res, 200, { dcId: state.dcId }); return; }
    if (req.method === "POST" && req.url === "/bind") {
      const body = await readJson(req);
      const encoded = JSON.stringify(body);
      assert.ok(encoded.length < MAX_BODY);
      assert.equal(/(?:bytes|chunk|fileData|fileBytes|bot_token|api_hash)/i.test(encoded), false, "Browser must send control metadata only");
      assert.equal(Number(body.dcId), state.dcId);
      assert.ok(body.label === "A" || body.label === "B");
      const envelope = await buildEnvelope(state.m, state.crypto, state.permanentKeyBytes, body);
      binds += 1;
      json(res, 200, envelope);
      return;
    }
    json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error("[m0e-web-binder]", error);
    json(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`M0-E binder ready on 127.0.0.1:${PORT}, dc=${state.dcId}`));

async function shutdown() {
  server.close();
  state.permanentKeyBytes?.fill(0);
  await state.connection?.destroy().catch(() => {});
  console.log(`M0-E binder stopped; bind envelopes served=${binds}; file bytes received=0; revoke/rotation=false`);
}
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
