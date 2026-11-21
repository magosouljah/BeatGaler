// BeatGaler Cloud — backend/control plane.
//
// The long-lived bot/manager/MASTER secrets live only here. When Telegram
// Direct is enabled, Desktop receives one ephemeral transport credential in
// Rust memory for the active session; large media then bypasses this HTTP
// server and travels Desktop <-> Telegram by MTProto.
//
// Cómo correrlo:
//   1. cd cloud-server
//   2. cp .env.example .env   y configura MASTER + MANAGER_BOT_TOKEN_1
//   3. npm install
//   4. node server.js
//
// Las conexiones y referencias de archivos se persisten en cloud-data.json
// para que reiniciar el backend no desconecte a los usuarios. En producción
// esto debe migrarse a una base de datos real.

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const net = require("net");
const dns = require("dns").promises;
const multer = require("multer");
const { createPrivateUserStorageGroup, ensurePrivateUserStorageBotAbsent, verifyPrivateUserStorageGroup, masterStorageReady } = require("./master-storage");

const directTransport = require("./direct-transport-control");


const { assertVaultRebindAllowedIfConfigured, currentCatalogAuthority } = require("./catalog/authority");
const { currentCatalogQueries } = require("./catalog/queries");
const { currentCatalogCommands } = require("./catalog/commands");
const { currentCatalogOperations } = require("./catalog/operations");
const { currentCatalogPlayback } = require("./catalog/playback");
const { currentCatalogMedia } = require("./catalog/media");
const { currentCatalogPurge } = require("./catalog/purge");
const { currentCatalogDirect } = require("./catalog/direct");
const { currentPrefixPacks } = require("./catalog/prefix-packs");

const { createCatalogRouter } = require("./catalog/routes");
const { currentNativeTransportProvisioner } = require("./catalog/native-transport-provisioning");


const { ensurePlanState, CODE_POLICY } = require("./plans");
const accessGrants = require("./access-grant-runtime");
const accessRuntime = require("./access-runtime");
const webBillingRuntime = require("./billing-web-runtime");
const webCheckoutRuntime = require("./billing-web-checkout-runtime");
const { createCheckoutHandlers } = require("./billing-web-checkout-route");
const webPortalRuntime = require("./billing-web-portal-runtime");
const { createPortalHandlers } = require("./billing-web-portal-route");
const webhookRuntime = require("./billing-webhook-runtime");
const { installPolarWebhookRoute } = require("./billing-webhook-route");
const { createPlanCatalogHandler } = require("./billing-plan-catalog-route");
const { createPlanMeHandler, createAccountHandler, accountPublicPayload: buildAccountPublicPayload } = require("./access-consumer-handlers");
const { hashPassword, verifyPassword } = require("./password-kdf");
const { createUserStorageLifecycle } = require("./user-storage-lifecycle");

const PORT = process.env.PORT || 4000;
const MANAGER_BOT_USERNAME = String(process.env.MANAGER_BOT_USERNAME_1 || process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim();
const TELEGRAM_MAX_UPLOAD_BYTES = 2000 * 1024 * 1024;


// 001BeatGaler is manager-only. The cloud server intentionally has no service
// bot runtime: no polling, no /start, no vault membership and no media fallback.
// Its secret exists only as MANAGER_BOT_TOKEN_1 inside direct-transport-control.js.
const bot = new Proxy({}, {
  get: (_target, operation) => (..._args) => Promise.reject(
    new Error(`Legacy service-bot operation ${String(operation)} is disabled; 001BeatGaler is manager-only.`)
  ),
});

const app = express();
const criticalPathTrace = require("./stage1-critical-path-trace");
const { operationsRuntime } = require('./operations-runtime');

// Diagnostic request IDs. Never logs bot tokens or file contents.
app.use((req, res, next) => {
  const requestId = crypto.randomBytes(4).toString("hex");
  req.beatgalerRequestId = requestId;
  const started = Date.now();
  const isUpload = req.method === "POST" && (
    req.path === "/beats/upload" ||
    req.path === "/projects/upload" ||
    req.path === "/cloud-files/upload"
  );

  if (isUpload) {
    console.log(
      `[upload ${requestId}] incoming ${req.method} ${req.path} ` +
      `content-length=${req.headers["content-length"] || "unknown"}`
    );
  }

  res.on("finish", () => {
    operationsRuntime.recordHttp({ statusCode: res.statusCode, durationMs: Date.now() - started,
      authRoute: req.path.startsWith('/auth/'), path: req.path });
    if (isUpload || res.statusCode >= 400) {
      console.log(
        `[http ${requestId}] ${req.method} ${req.path} -> ${res.statusCode} ` +
        `${Date.now() - started}ms`
      );
    }
  });
  next();
});
criticalPathTrace.install(app);

const ALLOWED_ORIGINS = new Set(
  String(process.env.BEATGALER_ALLOWED_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean)
);
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  const devOrigin = process.env.NODE_ENV !== "production" && (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) || origin === "tauri://localhost" || origin === "http://tauri.localhost");
  if (origin && (ALLOWED_ORIGINS.has(origin) || devOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, If-Match, X-Catalog-Era, X-Catalog-Epoch, X-BeatGaler-Installation-Id, X-BeatGaler-CSRF, X-BeatGaler-Project-Operation, X-BeatGaler-Project-Session, X-BeatGaler-Project-Generation, X-BeatGaler-Project-Beat, X-BeatGaler-Project-Kind, X-BeatGaler-Project-Thread");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

installPolarWebhookRoute(app, express, { currentInbox: webhookRuntime.current });
// E75: el ticket del MAIN de prefijos lleva una entrada de metadatos por beat (sin bytes de audio): límite propio, acotado.
app.use('/catalog/v1/prefix-packs/main', express.json({ limit: '6mb' }));
app.use(express.json({ limit: "256kb" }));
// T06: API nativa /catalog/v1 (solo lectura + provision). Sin autoridad configurada responde 503 CATALOG_UNAVAILABLE.
// T16: rondas, medios, purge y transferencias montados; sin gateway real responden 503 TRANSFER_UNAVAILABLE / jobs en reintento (fail-closed).
app.use(createCatalogRouter({ authority: currentCatalogAuthority(), queries: currentCatalogQueries(), commands: currentCatalogCommands(), operations: currentCatalogOperations(), direct: currentCatalogDirect(), transportProvisioner: currentNativeTransportProvisioner(), prefixPacks: currentPrefixPacks(), playback: currentCatalogPlayback(), media: currentCatalogMedia(), purge: currentCatalogPurge(), authenticate: (req, res) => authenticatedUser(req, res), log: console.warn }));
const upload = multer({
  dest: "uploads-tmp/",
  limits: {
    files: 1,
    fields: 24,
    fieldSize: 64 * 1024,
    fileSize: TELEGRAM_MAX_UPLOAD_BYTES,
  },
});
const { statePath } = require("./state-dir");
const DATA_FILE = statePath("cloud-data.json");
const AUTH_DATA_FILE = statePath("accounts-data.json");
const MASTER_STORAGE_GROUP_LIMIT = Math.max(1, Math.min(450, Number(process.env.BEATGALER_MASTER_GROUP_LIMIT || 450)));
const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const OAUTH_PUBLIC_BASE = String(process.env.BEATGALER_OAUTH_PUBLIC_BASE || process.env.BEATGALER_PUBLIC_BASE || "").replace(/\/$/, "");
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "");
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "");
const X_CLIENT_ID = String(process.env.X_CLIENT_ID || "");
const X_CLIENT_SECRET = String(process.env.X_CLIENT_SECRET || "");
const pendingOAuthFlows = new Map();
const completedOAuthFlows = new Map();


function storageChatId(account) {
  const value = Number(account?.storageChatId);
  if (!Number.isFinite(value) || value === 0) {
    throw new Error("BeatGaler private storage is not provisioned for this account.");
  }
  return value;
}


// ── Fase 6: almacenamiento temporal de connect_token ──
// token -> { beatgalerUserId, createdAt, expiresAt, used }
const pendingConnections = new Map();

// ── Fase 8/10: cuentas ya vinculadas ──
// beatgalerUserId -> { telegramUserId, telegramUsername, connectedAt }
const linkedAccounts = new Map();

// BeatGaler accounts are independent from Telegram. End users never join or
// control the private Telegram storage group assigned to their BeatGaler account.
const beatGalerUsers = new Map();       // normalized username -> user record
const beatGalerUsersById = new Map();   // account id -> same record
const authSessions = new Map();         // sha256(session token) -> session record
// telegram_file_id -> { beatgalerUserId, telegramMessageId, filename, createdAt }
// Esto evita que un usuario descargue un file_id que no le pertenece.
const uploadedFiles = new Map();
const beatTopics = new Map();
const pendingTopicDeletes = new Map();
const messageRedirects = new Map(); // `${beatgalerUserId}:${oldMessageId}` -> newMessageId

// Event-driven desktop updates. BeatGaler holds one lightweight SSE connection;
// it does NOT poll the whole Telegram library on a timer.
const cloudEventClients = new Map();

function addCloudEventClient(beatgalerUserId, sourceId, res) {
  if (!cloudEventClients.has(beatgalerUserId)) {
    cloudEventClients.set(beatgalerUserId, new Set());
  }
  const client = { sourceId: sourceId || "", res };
  cloudEventClients.get(beatgalerUserId).add(client);
  return client;
}

function removeCloudEventClient(beatgalerUserId, client) {
  const clients = cloudEventClients.get(beatgalerUserId);
  if (!clients) return;
  clients.delete(client);
  if (clients.size === 0) cloudEventClients.delete(beatgalerUserId);
}


app.post("/events/ticket", (req, res) => {
  const auth = authenticatedInstallation(req, res);
  if (!auth) return;
  return res.json({ ok: true, ticket: issueEventTicket(auth.user.id, auth.beatgalerUserId), expires_in_ms: EVENT_TICKET_TTL_MS });
});

app.get("/events", (req, res) => {
  let beatgalerUserId;
  try { beatgalerUserId = safeRequestId(req.query.beatgalerUserId, "installationId"); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const sourceId = String(req.query.sourceId || "").slice(0, 160);
  const ticket = consumeEventTicket(req.query.ticket, beatgalerUserId);
  if (!ticket) return res.status(401).json({ error: "Event authorization expired. Reconnect." });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write('event: ready\ndata: {"ok":true}\n\n');

  const client = addCloudEventClient(beatgalerUserId, sourceId, res);
  const keepAlive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch {}
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    removeCloudEventClient(beatgalerUserId, client);
  });
});


function normalizeBeatGalerUsername(raw) {
  return String(raw || "").trim().replace(/^@+/, "").toLowerCase();
}

function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function validHandleBase(value) {
  return /^[a-z0-9._]{3,20}$/.test(value);
}


function findUserByEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return null;
  for (const user of beatGalerUsersById.values()) {
    if (normalizeEmail(user.email) === email) return user;
  }
  return null;
}

function setUserUsername(user, rawUsername, source = "beatgaler") {
  const next = normalizeBeatGalerUsername(rawUsername);
  if (!next) throw new Error("Username cannot be empty.");
  const previous = normalizeBeatGalerUsername(user.username);
  if (previous && beatGalerUsers.get(previous)?.id === user.id) beatGalerUsers.delete(previous);
  user.username = next;
  user.usernameSource = source;
  beatGalerUsers.set(next, user);
  return { previous, next };
}

function generateBeatGalerHandle(rawBase) {
  let base = normalizeBeatGalerUsername(rawBase).replace(/[^a-z0-9._]/g, "").slice(0, 20);
  if (!validHandleBase(base)) throw new Error("Username must be 3-20 characters using letters, numbers, dot or underscore.");
  for (let i = 0; i < 10000; i += 1) {
    const discriminator = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    const candidate = `${base}#${discriminator}`;
    if (!beatGalerUsers.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a BeatGaler username. Try another name.");
}

function sessionKey(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, acc = 0;
  const out = [];
  for (const char of String(value || "").replace(/=+$/g, "").toUpperCase()) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) continue;
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secret, timestamp = Date.now()) {
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 30000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1000000).padStart(6, "0");
}

function verifyTotp(secret, code) {
  const normalized = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const now = Date.now();
  return [-1, 0, 1].some(step => {
    const expected = Buffer.from(totpCode(secret, now + step * 30000));
    const actual = Buffer.from(normalized);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  });
}

function userProvider(user, provider) {
  const value = user?.providers?.[provider];
  return value && value.id ? value : null;
}

function findUserByProvider(provider, providerId) {
  for (const user of beatGalerUsersById.values()) {
    if (String(userProvider(user, provider)?.id || "") === String(providerId || "")) return user;
  }
  return null;
}

function uniqueUsername(raw, provider) {
  let base = normalizeBeatGalerUsername(raw).replace(/[^a-z0-9._]/g, "").slice(0, 20);
  if (base.length < 3) base = `${provider || "user"}.${crypto.randomBytes(3).toString("hex")}`.slice(0, 20);
  return generateBeatGalerHandle(base);
}

function oauthProviderConfig(provider) {
  const callbackBase = OAUTH_PUBLIC_BASE;
  if (!callbackBase) throw new Error("BEATGALER_OAUTH_PUBLIC_BASE is not configured on the cloud server.");
  if (provider === "google") {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("Google sign-in is not configured on the cloud server.");
    return {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      callbackUrl: `${callbackBase}/auth/oauth/google/callback`,
    };
  }
  if (provider === "x") {
    if (!X_CLIENT_ID) throw new Error("X sign-in is not configured on the cloud server.");
    return {
      clientId: X_CLIENT_ID,
      clientSecret: X_CLIENT_SECRET,
      authUrl: "https://x.com/i/oauth2/authorize",
      tokenUrl: "https://api.x.com/2/oauth2/token",
      callbackUrl: `${callbackBase}/auth/oauth/x/callback`,
    };
  }
  throw new Error("Unsupported sign-in provider.");
}

async function postForm(url, values, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(values).toString(),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) throw new Error(body.error_description || body.error || `OAuth token exchange failed (${response.status}).`);
  return body;
}

async function fetchOAuthIdentity(provider, token) {
  if (provider === "google") {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!response.ok || !body.sub) throw new Error(body.error_description || body.error || "Google identity could not be read.");
    return { id: String(body.sub), email: body.email || null, name: body.name || null, username: null };
  }
  const response = await fetch("https://api.x.com/2/users/me?user.fields=name,username,profile_image_url", { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (!response.ok || !body?.data?.id) throw new Error(body?.detail || body?.title || "X identity could not be read.");
  return { id: String(body.data.id), email: null, name: body.data.name || null, username: body.data.username || null };
}

async function refreshXProviderToken(providerRecord) {
  if (!providerRecord?.refreshToken) return null;
  const cfg = oauthProviderConfig("x");
  const form = { grant_type: "refresh_token", refresh_token: providerRecord.refreshToken, client_id: cfg.clientId };
  const headers = {};
  if (cfg.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  const tokenBody = await postForm(cfg.tokenUrl, form, headers);
  providerRecord.accessToken = tokenBody.access_token || providerRecord.accessToken;
  providerRecord.refreshToken = tokenBody.refresh_token || providerRecord.refreshToken;
  providerRecord.tokenExpiresAt = Date.now() + Math.max(60, Number(tokenBody.expires_in || 7200)) * 1000;
  return providerRecord.accessToken;
}

async function syncXIdentity(user, force = false) {
  const provider = userProvider(user, "x");
  if (!provider) return false;
  const lastSync = Number(provider.profileSyncedAt || 0);
  if (!force && Date.now() - lastSync < 5 * 60 * 1000) return false;
  let accessToken = provider.accessToken || "";
  if (!accessToken || Number(provider.tokenExpiresAt || 0) <= Date.now() + 30000) {
    try { accessToken = await refreshXProviderToken(provider) || ""; }
    catch (error) { console.warn(`[auth] X token refresh failed for ${user.id}:`, error?.message || error); return false; }
  }
  if (!accessToken) return false;
  try {
    const identity = await fetchOAuthIdentity("x", accessToken);
    provider.username = identity.username || provider.username;
    provider.name = identity.name || provider.name;
    provider.profileSyncedAt = Date.now();
    if (identity.username && normalizeBeatGalerUsername(identity.username) !== normalizeBeatGalerUsername(user.username)) {
      setUserUsername(user, identity.username, "x");
    } else if (user.usernameSource !== "x") {
      user.usernameSource = "x";
    }
    saveAuthData();
    return true;
  } catch (error) {
    console.warn(`[auth] X profile sync failed for ${user.id}:`, error?.message || error);
    return false;
  }
}

function cleanupOAuthFlows() {
  const now = Date.now();
  for (const [key, flow] of pendingOAuthFlows) if (flow.expiresAt <= now) pendingOAuthFlows.delete(key);
  for (const [key, result] of completedOAuthFlows) if (result.expiresAt <= now) completedOAuthFlows.delete(key);
}

function loadAuthData() {
  try {
    if (!fs.existsSync(AUTH_DATA_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(AUTH_DATA_FILE, "utf8"));
    for (const user of parsed.users || []) {
      if (!user?.id || !user?.username) continue;
      user.username = normalizeBeatGalerUsername(user.username);
      ensurePlanState(user);
      if (!user.usernameSource) user.usernameSource = user.providers?.x?.id && !user.username.includes("#") ? "x" : "beatgaler";
      beatGalerUsers.set(user.username, user);
      beatGalerUsersById.set(user.id, user);
    }
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed.sessions || {})) {
      if (Number(value?.expiresAt || 0) > now) authSessions.set(key, value);
    }
  } catch (error) {
    console.error("Could not read accounts-data.json:", error?.message || error);
  }
}

function saveAuthData() {
  const tmp = `${AUTH_DATA_FILE}.tmp`;
  const payload = JSON.stringify({
    users: [...beatGalerUsers.values()],
    sessions: Object.fromEntries(authSessions),
  }, null, 2);
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, AUTH_DATA_FILE);
}

function createAuthSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  authSessions.set(sessionKey(token), {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
  });
  saveAuthData();
  return token;
}

function getAuthUserFromToken(token) {
  const key = sessionKey(token);
  const session = authSessions.get(key);
  if (!session) return null;
  if (Number(session.expiresAt || 0) <= Date.now()) {
    authSessions.delete(key);
    saveAuthData();
    return null;
  }
  return beatGalerUsersById.get(session.userId) || null;
}

function bearerToken(req) {
  const raw = String(req.headers.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

// ── Security boundary v1 ────────────────────────────────────────────────────
// The browser/Desktop may REQUEST an operation, but only the backend decides
// whether the signed-in account owns the installation and may access its data.
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const EVENT_TICKET_TTL_MS = 60 * 1000;
const eventTickets = new Map();

function safeRequestId(value, field = "id") {
  const text = String(value || "").trim();
  if (!SAFE_ID_RE.test(text)) throw Object.assign(new Error(`${field} is invalid.`), { status: 400 });
  return text;
}


function authenticatedUser(req, res) {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) {
    res.status(401).json({ error: "Session expired. Sign in again." });
    return null;
  }
  return user;
}

function authenticatedInstallation(req, res) {
  const user = authenticatedUser(req, res);
  if (!user) return null;
  let installationId;
  try {
    installationId = safeRequestId(
      req.body?.beatgalerUserId || req.query?.beatgalerUserId || req.headers["x-beatgaler-installation-id"],
      "installationId",
    );
  } catch (error) {
    res.status(400).json({ error: error.message });
    return null;
  }
  const account = linkedAccounts.get(installationId);
  if (!account || !account.beatgalerAccountId) {
    res.status(403).json({ error: "This installation is not authorized for the signed-in account." });
    return null;
  }
  if (String(account.beatgalerAccountId) !== String(user.id)) {
    res.status(403).json({ error: "This installation belongs to another account." });
    return null;
  }
  return { user, account, beatgalerUserId: installationId };
}

function issueEventTicket(userId, installationId) {
  const ticket = crypto.randomBytes(24).toString("base64url");
  eventTickets.set(ticket, { userId: String(userId), installationId: String(installationId), expiresAt: Date.now() + EVENT_TICKET_TTL_MS });
  return ticket;
}

function consumeEventTicket(ticket, installationId) {
  const key = String(ticket || "");
  const entry = eventTickets.get(key);
  eventTickets.delete(key);
  if (!entry || entry.expiresAt <= Date.now() || String(entry.installationId) !== String(installationId)) return null;
  return entry;
}

function botApiChatIdFromStored(value) {
  const text = String(value || "").trim();
  if (!/^-100\d+$/.test(text)) throw new Error("Invalid Telegram storage chat id.");
  const numeric = Number(text);
  if (!Number.isSafeInteger(numeric)) throw new Error("Telegram storage chat id is outside JavaScript safe integer range.");
  return numeric;
}

function bindInstallationToBeatGalerUser(user, beatgalerUserId) {
  if (!beatgalerUserId || !user?.storageChatId) {
    throw new Error("BeatGaler account storage is not ready.");
  }
  const storageChatId = botApiChatIdFromStored(user.storageChatId);
  linkedAccounts.set(String(beatgalerUserId), {
    beatgalerAccountId: user.id,
    beatgalerUsername: user.username,
    // Compatibility with the existing desktop/cloud code: this field used to
    // mean the end user's Telegram chat. It now points at that user's private
    // storage supergroup. The end user never receives Telegram access.
    telegramUserId: storageChatId,
    telegramUsername: user.username,
    connectedAt: Date.now(),
    storageChatId,
    storageChatTitle: user.storageChatTitle || user.username,
    storageLinkedAt: user.storageCreatedAt || Date.now(),
  });
  savePersistentData();
}

async function ensureEmptyIndexForStorage(_account) {
  // Direct V4.2: MASTER intentionally creates NO index. On the first desktop
  // Direct session, the transport bot reads the vault and creates exactly one
  // empty index if none exists. MASTER stays completely out of index bytes.
  return null;
}

function clearStorageBindingsForUser(user) {
  const accountId = String(user?.id || '');
  let changed = 0;

  for (const [installationId, linked] of linkedAccounts.entries()) {
    if (String(linked?.beatgalerAccountId || '') !== accountId) continue;

    linkedAccounts.set(installationId, {
      ...linked,
      telegramUserId: null,
      storageChatId: null,
      storageChatTitle: null,
    });
    changed += 1;
  }

  if (changed) {
    savePersistentData();
    console.warn(`[storage] cleared ${changed} stale installation binding(s) for @${user.username}`);
  }
}

function rebindStorageBindingsForUser(user) {
  const accountId = String(user?.id || '');
  const storageChatId = botApiChatIdFromStored(user.storageChatId);
  let changed = 0;

  for (const [installationId, linked] of linkedAccounts.entries()) {
    if (String(linked?.beatgalerAccountId || '') !== accountId) continue;

    linkedAccounts.set(installationId, {
      ...linked,
      beatgalerAccountId: user.id,
      beatgalerUsername: user.username,
      telegramUserId: storageChatId,
      storageChatId,
      storageChatTitle: user.storageChatTitle,
    });
    changed += 1;
  }

  if (changed) {
    savePersistentData();
    console.log(`[storage] rebound ${changed} installation binding(s) for @${user.username} -> ${storageChatId}`);
  }
}

const userStorageLifecycle = createUserStorageLifecycle({
  validateStoredChatId: botApiChatIdFromStored,
  createPrivateUserStorageGroup,
  verifyPrivateUserStorageGroup,
  ensurePrivateUserStorageBotAbsent,
  masterStorageReady,
  managerBotUsername: MANAGER_BOT_USERNAME,
  storageGroupLimit: MASTER_STORAGE_GROUP_LIMIT,
  getProvisionedStorageCount: () => [...beatGalerUsers.values()].filter(entry => entry.storageChatId).length,
  saveAuthData,
  clearStorageBindingsForUser,
  rebindStorageBindingsForUser,
  ensureEmptyIndexForStorage,
  // T05-N (NATIVO r2.1 §6.2.1): rechazo en origen del cambio de chat de un vault con biblioteca nativa.
  assertVaultRebindAllowed: input => assertVaultRebindAllowedIfConfigured(input),
  logger: console,
});

async function ensureUserStorage(user) {
  return userStorageLifecycle.ensureAssigned(user);
}

function accountPublicPayload(user, token) {
  return buildAccountPublicPayload(user, token, { resolveUserPlan: accessRuntime.resolveUserPlan, userProvider });
}

function loadPersistentData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const [key, value] of Object.entries(parsed.linkedAccounts || {})) {
      linkedAccounts.set(key, value);
    }
    for (const [key, value] of Object.entries(parsed.uploadedFiles || {})) {
      uploadedFiles.set(key, value);
    }
    for (const [key, value] of Object.entries(parsed.beatTopics || {})) beatTopics.set(key, value);
    for (const [key, value] of Object.entries(parsed.pendingTopicDeletes || {})) pendingTopicDeletes.set(key, value);
    for (const [key, value] of Object.entries(parsed.messageRedirects || {})) messageRedirects.set(key, value);
  } catch (err) {
    console.error("No se pudo leer cloud-data.json:", err.message || err);
  }
}

function savePersistentData() {
  const tmp = `${DATA_FILE}.tmp`;
  const payload = JSON.stringify({
    linkedAccounts: Object.fromEntries(linkedAccounts),
    uploadedFiles: Object.fromEntries(uploadedFiles),
    beatTopics: Object.fromEntries(beatTopics),
    pendingTopicDeletes: Object.fromEntries(pendingTopicDeletes),
    messageRedirects: Object.fromEntries(messageRedirects),
  }, null, 2);
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

loadPersistentData();
loadAuthData();

const TOKEN_TTL_MS = 10 * 60 * 1000;


// ── BeatGaler account authentication ─────────────────────────────────────
app.get("/auth/health", (_req, res) => {
  res.json({
    ok: true,
    account_auth: true,
    storage_mode: "private-group-per-user",
    master_group_limit: MASTER_STORAGE_GROUP_LIMIT,
    master_storage_ready: masterStorageReady(),
  });
});

function privateOrLocalIp(address) {
  const value = String(address || "").toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  if (net.isIPv6(value)) {
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  }
  return true;
}

async function assertPublicImageUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || "")); }
  catch { throw new Error("Invalid image URL."); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http/https image URLs are supported.");
  if (!url.hostname || url.username || url.password) throw new Error("Invalid image URL.");
  if (/^(localhost|.*\.localhost)$/i.test(url.hostname)) throw new Error("Local image URLs are not allowed.");

  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => privateOrLocalIp(record.address))) {
    throw new Error("Private or local image URLs are not allowed.");
  }
  return url;
}

function decodeInternetImageHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function resolveInternetImageFromHtml(html, baseUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<img[^>]+(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match?.[1]) continue;
    try {
      return new URL(decodeInternetImageHtml(match[1]), baseUrl).toString();
    } catch {}
  }
  return null;
}

async function fetchRemoteImageDataUrl(rawUrl, redirectsLeft = 3, pageResolveLeft = 1) {
  const url = await assertPublicImageUrl(rawUrl);
  const transport = url.protocol === "https:" ? https : http;
  const maxImageBytes = 15 * 1024 * 1024;
  const maxHtmlBytes = 2 * 1024 * 1024;

  return await new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 BeatGaler/0.2",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.9,text/html;q=0.8,*/*;q=0.1",
      },
      timeout: 10000,
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error("Too many image redirects."));
        const next = new URL(response.headers.location, url).toString();
        fetchRemoteImageDataUrl(next, redirectsLeft - 1, pageResolveLeft).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return reject(new Error(`Image server returned HTTP ${status}.`));
      }

      const contentType = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const isImage = contentType.startsWith("image/");
      const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
      if (!isImage && !isHtml) {
        response.resume();
        return reject(new Error(`The dragged URL returned unsupported content (${contentType || "unknown"}).`));
      }

      const maxBytes = isImage ? maxImageBytes : maxHtmlBytes;
      const contentLength = Number(response.headers["content-length"] || 0);
      if (contentLength > maxBytes) {
        response.resume();
        return reject(new Error(isImage ? "Internet image is larger than 15 MB." : "Internet page is too large to inspect."));
      }

      const chunks = [];
      let total = 0;
      response.on("data", chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new Error(isImage ? "Internet image is larger than 15 MB." : "Internet page is too large to inspect."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const data = Buffer.concat(chunks);
        if (!data.length) return reject(new Error(isImage ? "Internet image was empty." : "Internet page was empty."));

        if (isImage) {
          resolve(`data:${contentType};base64,${data.toString("base64")}`);
          return;
        }

        if (pageResolveLeft <= 0) {
          reject(new Error("The dragged page did not resolve to an image."));
          return;
        }

        const imageUrl = resolveInternetImageFromHtml(data.toString("utf8"), url.toString());
        if (!imageUrl) {
          reject(new Error("No image was found on the dragged web page."));
          return;
        }

        // Re-enter the same guarded fetch path. assertPublicImageUrl() runs for
        // the resolved image too, so Pinterest/page resolution cannot bypass
        // BeatGaler's private/local-network URL protection.
        fetchRemoteImageDataUrl(imageUrl, 3, pageResolveLeft - 1).then(resolve, reject);
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Internet image download timed out.")));
    request.on("error", reject);
  });
}

app.get("/plans/catalog", createPlanCatalogHandler({
  usesPostgresAccess: accessGrants.usesPostgresAccess,
  webPlanCatalog: () => webBillingRuntime.planCatalog().map(plan => ({
    ...plan, checkout_available: plan.checkout_available && webCheckoutRuntime.status().ready,
  })),
  legacyPlanCatalog: accessRuntime.planCatalog,
  codePolicy: CODE_POLICY,
}));

app.get("/plans/me", createPlanMeHandler({
  getUser: getAuthUserFromToken, bearerToken, resolveUserPlan: accessRuntime.resolveUserPlan,
}));

const webCheckoutHandlers = createCheckoutHandlers({
  getUser: req => getAuthUserFromToken(bearerToken(req)),
  currentCheckout: webCheckoutRuntime.current,
});
app.post("/billing/checkout", webCheckoutHandlers.create);
app.get("/billing/checkout/:requestId", webCheckoutHandlers.get);
const webPortalHandlers = createPortalHandlers({
  getUser: req => getAuthUserFromToken(bearerToken(req)),
  currentPortal: webPortalRuntime.current,
});
app.get("/billing/portal/availability", webPortalHandlers.availability);
app.post("/billing/portal", webPortalHandlers.create);

app.post("/image/fetch", async (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ error: "Image URL is required." });

  try {
    const dataUrl = await fetchRemoteImageDataUrl(url);
    res.json({ ok: true, data_url: dataUrl });
  } catch (error) {
    res.status(400).json({ error: `Could not import internet image: ${error?.message || error}` });
  }
});

app.post("/auth/register", async (req, res) => {
  const usernameBase = normalizeBeatGalerUsername(req.body?.usernameBase || req.body?.username);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const beatgalerUserId = String(req.body?.beatgalerUserId || "");

  if (!validHandleBase(usernameBase)) return res.status(400).json({ error: "Username must be 3-20 characters using only letters, numbers, dot or underscore." });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (findUserByEmail(email)) return res.status(409).json({ error: "That email is already attached to a BeatGaler account." });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (!beatgalerUserId) return res.status(400).json({ error: "beatgalerUserId is required." });

  const username = generateBeatGalerHandle(usernameBase);
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: `usr_${crypto.randomBytes(12).toString("hex")}`,
    username,
    usernameSource: "beatgaler",
    email,
    passwordSalt: salt,
    passwordHash: await hashPassword(password, salt),
    createdAt: Date.now(),
    storageChatId: null,
    storageChatTitle: null,
    storageCreatedAt: null,
    providers: {},
  };
  // New accounts start Free; already-issued grants are preserved.
  ensurePlanState(user);

  beatGalerUsers.set(username, user);
  beatGalerUsersById.set(user.id, user);
  saveAuthData();

  try {
    await ensureUserStorage(user);
    bindInstallationToBeatGalerUser(user, beatgalerUserId);
    const token = createAuthSession(user.id);
    return res.status(201).json(await accountPublicPayload(user, token));
  } catch (error) {
    console.error("[auth] storage provisioning failed:", error?.message || error);
    return res.status(503).json({ error: `BeatGaler account created, but private cloud storage could not be provisioned: ${error?.message || error}`, account_created: true, username });
  }
});

app.post("/auth/login", async (req, res) => {
  criticalPathTrace.write(req, "cloud_handler_start");
  const identifier = String(req.body?.identifier || req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const beatgalerUserId = String(req.body?.beatgalerUserId || "");
  const normalizedIdentifier = normalizeBeatGalerUsername(identifier);
  const user = identifier.includes("@") ? findUserByEmail(identifier) : (beatGalerUsers.get(normalizedIdentifier) || findUserByEmail(identifier));

  if (!user || !user.passwordHash || !(await criticalPathTrace.step(req, "auth_password_verify", () => verifyPassword(password, user)))) {
    return res.status(401).json({ error: "Invalid username/email or password." });
  }
  if (user.mfaSecret && !verifyTotp(user.mfaSecret, req.body?.mfaCode)) {
    return res.status(401).json({ error: "MFA code required or invalid.", mfa_required: true });
  }
  if (!beatgalerUserId) {
    return res.status(400).json({ error: "beatgalerUserId is required." });
  }

  try {
    await criticalPathTrace.step(req, "auth_sync_identity", () => syncXIdentity(user).catch(() => false));
    await criticalPathTrace.step(req, "auth_ensure_storage", () => ensureUserStorage(user));
    criticalPathTrace.write(req, "auth_bind_installation_begin");
    bindInstallationToBeatGalerUser(user, beatgalerUserId);
    criticalPathTrace.write(req, "auth_bind_installation_done");
    const token = createAuthSession(user.id);
    criticalPathTrace.write(req, "cloud_handler_finished");
    res.json(await accountPublicPayload(user, token));
  } catch (error) {
    res.status(503).json({ error: `Private cloud storage is not ready: ${error?.message || error}` });
  }
});

app.post("/auth/session", async (req, res) => {
  criticalPathTrace.write(req, "cloud_handler_start");
  const token = bearerToken(req);
  const beatgalerUserId = String(req.body?.beatgalerUserId || req.headers["x-beatgaler-installation-id"] || "");
  const user = getAuthUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  if (!beatgalerUserId) return res.status(400).json({ error: "beatgalerUserId is required." });

  try {
    await criticalPathTrace.step(req, "auth_sync_identity", () => syncXIdentity(user).catch(() => false));
    await criticalPathTrace.step(req, "auth_ensure_storage", () => ensureUserStorage(user));
    criticalPathTrace.write(req, "auth_bind_installation_begin");
    bindInstallationToBeatGalerUser(user, beatgalerUserId);
    criticalPathTrace.write(req, "auth_bind_installation_done");
    criticalPathTrace.write(req, "cloud_handler_finished");
    res.json(await accountPublicPayload(user, token));
  } catch (error) {
    res.status(503).json({ error: `Private cloud storage is not ready: ${error?.message || error}` });
  }
});

app.post("/auth/account", createAccountHandler({
  getUser: getAuthUserFromToken, bearerToken, resolveUserPlan: accessRuntime.resolveUserPlan,
  userProvider, syncIdentity: syncXIdentity,
}));

app.post("/auth/email/change", async (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  const email = normalizeEmail(req.body?.email);
  const confirmEmail = normalizeEmail(req.body?.confirmEmail);
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (email !== confirmEmail) return res.status(400).json({ error: "Email addresses do not match." });
  const existing = findUserByEmail(email);
  if (existing && existing.id !== user.id) return res.status(409).json({ error: "That email is already attached to another BeatGaler account." });
  user.email = email;
  saveAuthData();
  res.json(await accountPublicPayload(user, bearerToken(req)));
});

app.post("/auth/password/change", async (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (user.passwordHash && !(await verifyPassword(currentPassword, user))) return res.status(401).json({ error: "Current password is incorrect." });
  if (newPassword.length < 8 || newPassword.length > 200) return res.status(400).json({ error: "New password must be at least 8 characters." });
  const salt = crypto.randomBytes(16).toString("hex");
  user.passwordSalt = salt;
  user.passwordHash = await hashPassword(newPassword, salt);
  saveAuthData();
  res.json({ ok: true });
});

app.post("/auth/mfa/setup", (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  const secret = base32Encode(crypto.randomBytes(20));
  user.pendingMfaSecret = secret;
  saveAuthData();
  const label = encodeURIComponent(`BeatGaler:${user.username}`);
  const issuer = encodeURIComponent("BeatGaler");
  res.json({ ok: true, secret, otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30` });
});

app.post("/auth/mfa/enable", (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  if (!user.pendingMfaSecret || !verifyTotp(user.pendingMfaSecret, req.body?.code)) return res.status(400).json({ error: "That authentication code is invalid." });
  user.mfaSecret = user.pendingMfaSecret;
  delete user.pendingMfaSecret;
  saveAuthData();
  res.json({ ok: true });
});

app.post("/auth/mfa/disable", (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  if (!user.mfaSecret) return res.json({ ok: true });
  if (!verifyTotp(user.mfaSecret, req.body?.code)) return res.status(400).json({ error: "That authentication code is invalid." });
  delete user.mfaSecret;
  delete user.pendingMfaSecret;
  saveAuthData();
  res.json({ ok: true });
});

app.post("/auth/oauth/start", (req, res) => {
  cleanupOAuthFlows();
  const provider = String(req.body?.provider || "").toLowerCase();
  const beatgalerUserId = String(req.body?.beatgalerUserId || "");
  const linkUser = getAuthUserFromToken(bearerToken(req));
  if (!beatgalerUserId) return res.status(400).json({ error: "beatgalerUserId is required." });
  try {
    const cfg = oauthProviderConfig(provider);
    const flowId = crypto.randomBytes(24).toString("base64url");
    const state = crypto.randomBytes(24).toString("base64url");
    const flow = { flowId, state, provider, beatgalerUserId, linkUserId: linkUser?.id || null, expiresAt: Date.now() + OAUTH_FLOW_TTL_MS };
    const params = new URLSearchParams();
    params.set("client_id", cfg.clientId);
    params.set("redirect_uri", cfg.callbackUrl);
    params.set("response_type", "code");
    params.set("state", state);
    if (provider === "google") {
      params.set("scope", "openid email profile");
      params.set("prompt", "select_account");
    } else {
      const verifier = crypto.randomBytes(48).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      flow.codeVerifier = verifier;
      params.set("scope", "tweet.read users.read offline.access");
      params.set("code_challenge", challenge);
      params.set("code_challenge_method", "S256");
    }
    pendingOAuthFlows.set(state, flow);
    res.json({ ok: true, flow_id: flowId, authorization_url: `${cfg.authUrl}?${params.toString()}` });
  } catch (error) {
    res.status(503).json({ error: error?.message || String(error) });
  }
});

app.get("/auth/oauth/:provider/callback", async (req, res) => {
  cleanupOAuthFlows();
  const provider = String(req.params.provider || "").toLowerCase();
  const state = String(req.query.state || "");
  const flow = pendingOAuthFlows.get(state);
  if (!flow || flow.provider !== provider) return res.status(400).send("BeatGaler sign-in request expired. Return to BeatGaler and try again.");
  pendingOAuthFlows.delete(state);
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const code = String(req.query.code || "");
    const cfg = oauthProviderConfig(provider);
    const form = { grant_type: "authorization_code", code, redirect_uri: cfg.callbackUrl, client_id: cfg.clientId };
    const headers = {};
    if (provider === "google") form.client_secret = cfg.clientSecret;
    if (provider === "x") {
      form.code_verifier = flow.codeVerifier;
      if (cfg.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
    }
    const tokenBody = await postForm(cfg.tokenUrl, form, headers);
    const identity = await fetchOAuthIdentity(provider, tokenBody.access_token);
    // Installation ownership is not proof of account ownership. When a
    // returning browser signs in without a live session, require the provider's
    // verified identity to resolve to exactly the existing installation owner
    // BEFORE any account mutation or installation binding.
    const expectedOwnerId = String(req.beatgalerOAuthExpectedOwnerId || "");
    if (expectedOwnerId) {
      const verifiedAccount = findUserByProvider(provider, identity.id);
      if (!verifiedAccount || String(verifiedAccount.id) !== expectedOwnerId) {
        throw new Error("This X or Google identity does not match the account already linked to this installation.");
      }
    }
    let user;
    if (flow.linkUserId) {
      user = beatGalerUsersById.get(flow.linkUserId);
      if (!user) throw new Error("BeatGaler account no longer exists.");
      const existing = findUserByProvider(provider, identity.id);
      if (existing && existing.id !== user.id) throw new Error(`That ${provider === "x" ? "X" : "Google"} account is already connected to another BeatGaler account.`);
    } else {
      user = findUserByProvider(provider, identity.id);
      if (!user) {
        const preferred = provider === "x" ? identity.username : (identity.email ? identity.email.split("@")[0] : identity.name);
        const username = provider === "x" && identity.username ? normalizeBeatGalerUsername(identity.username) : uniqueUsername(preferred, provider);
        user = {
          id: `usr_${crypto.randomBytes(12).toString("hex")}`,
          username,
          usernameSource: provider === "x" ? "x" : "beatgaler",
          email: provider === "google" ? normalizeEmail(identity.email) : null,
          passwordSalt: null,
          passwordHash: null,
          createdAt: Date.now(),
          storageChatId: null,
          storageChatTitle: null,
          storageCreatedAt: null,
          providers: {},
        };
        ensurePlanState(user);
        beatGalerUsers.set(username, user);
        beatGalerUsersById.set(user.id, user);
      }
    }
    user.providers = user.providers || {};
    user.providers[provider] = {
      ...identity,
      connectedAt: Date.now(),
      accessToken: tokenBody.access_token || null,
      refreshToken: tokenBody.refresh_token || user.providers?.[provider]?.refreshToken || null,
      tokenExpiresAt: Date.now() + Math.max(60, Number(tokenBody.expires_in || 7200)) * 1000,
      profileSyncedAt: Date.now(),
    };
    if (provider === "google" && !user.email && identity.email) user.email = normalizeEmail(identity.email);
    if (provider === "x" && identity.username) setUserUsername(user, identity.username, "x");
    saveAuthData();
    await ensureUserStorage(user);
    // OAuth activation does not automatically issue promotional access.
    bindInstallationToBeatGalerUser(user, flow.beatgalerUserId);
    const token = flow.linkUserId ? null : createAuthSession(user.id);
    completedOAuthFlows.set(flow.flowId, { ok: true, userId: user.id, token, expiresAt: Date.now() + OAUTH_FLOW_TTL_MS });
    res.status(200).send(`<html><body style="background:#0b0b0b;color:#ddd;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Connected to BeatGaler</h2><p style="color:#777">You can close this window and return to the app.</p></div></body></html>`);
  } catch (error) {
    completedOAuthFlows.set(flow.flowId, { ok: false, error: error?.message || String(error), expiresAt: Date.now() + OAUTH_FLOW_TTL_MS });
    res.status(400).send(`<html><body style="background:#0b0b0b;color:#ddd;font-family:system-ui;padding:40px"><h2>BeatGaler sign-in failed</h2><p>${String(error?.message || error).replace(/[<>]/g, "")}</p></body></html>`);
  }
});

app.post("/auth/oauth/poll", async (req, res) => {
  cleanupOAuthFlows();
  const flowId = String(req.body?.flowId || "");
  const beatgalerUserId = String(req.body?.beatgalerUserId || "");
  const result = completedOAuthFlows.get(flowId);
  if (!result) return res.json({ ok: true, pending: true });
  completedOAuthFlows.delete(flowId);
  if (!result.ok) return res.status(400).json({ error: result.error || "OAuth sign-in failed." });
  const user = beatGalerUsersById.get(result.userId);
  if (!user) return res.status(404).json({ error: "BeatGaler account not found." });
  if (beatgalerUserId) bindInstallationToBeatGalerUser(user, beatgalerUserId);
  const token = result.token || bearerToken(req);
  res.json({ ...await accountPublicPayload(user, token), linked: !result.token });
});

app.post("/auth/oauth/disconnect", (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  const provider = String(req.body?.provider || "").toLowerCase();
  if (!user.providers?.[provider]) return res.json({ ok: true });
  const remainingProviderCount = Object.keys(user.providers || {}).filter(key => key !== provider && user.providers[key]?.id).length;
  if (!user.passwordHash && remainingProviderCount === 0) return res.status(400).json({ error: "Set a password or connect another sign-in method before disconnecting this account." });
  delete user.providers[provider];
  if (provider === "x" && user.usernameSource === "x") {
    const fallbackBase = normalizeBeatGalerUsername(user.username).replace(/[^a-z0-9._]/g, "").slice(0, 20) || "user";
    setUserUsername(user, generateBeatGalerHandle(fallbackBase.length >= 3 ? fallbackBase : `user.${crypto.randomBytes(2).toString("hex")}`), "beatgaler");
  }
  saveAuthData();
  res.json({ ok: true });
});

app.post("/auth/logout", (req, res) => {
  const token = bearerToken(req);
  const user = getAuthUserFromToken(token);
  const beatgalerUserId = String(req.body?.beatgalerUserId || "").trim();
  if (user && beatgalerUserId) {
    const linked = linkedAccounts.get(beatgalerUserId);
    if (linked && String(linked.beatgalerAccountId || "") === String(user.id)) linkedAccounts.delete(beatgalerUserId);
  }
  if (token) authSessions.delete(sessionKey(token));
  saveAuthData();
  savePersistentData();
  res.json({ ok: true });
});

// ── Fase 6/7: BeatGaler pide iniciar la conexión ──
app.post("/telegram/connect/start", (req, res) => {
  const auth = authenticatedInstallation(req, res);
  if (!auth) return;
  const { beatgalerUserId } = auth;
  // Telegram identity linking is no longer part of the product architecture.
  // BeatGaler account login provisions/binds storage through MASTER directly.
  const account = linkedAccounts.get(beatgalerUserId);
  if (account?.storageChatId) {
    return res.json({ connected: true, storage_ready: true, manager_only: true });
  }
  return res.status(409).json({ error: "Sign in to BeatGaler to prepare private cloud storage." });
});

// Runtime Telegram transport health. A LOCAL Bot API process can keep answering
// getChat/getMe from its own state after the PC loses Internet, so those calls
// are not enough to decide whether BeatGaler is truly online. Probe Telegram's
// public edge first, then (for linked accounts) verify the local Bot API too.
// Only an in-flight probe is shared; we deliberately do not cache a positive
// result across app restarts/Wi-Fi changes.
let telegramReachabilityProbe = { pending: null };

function telegramPublicEdgeReachable(timeoutMs = 1800) {
  if (telegramReachabilityProbe.pending) return telegramReachabilityProbe.pending;
  telegramReachabilityProbe.pending = new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      telegramReachabilityProbe.pending = null;
      resolve(value === true);
    };
    const req = https.request({
      hostname: "api.telegram.org",
      port: 443,
      path: "/",
      method: "HEAD",
      timeout: timeoutMs,
      headers: { "User-Agent": "BeatGaler-Connectivity-Probe/1" },
    }, response => {
      response.resume();
      // Any HTTP response proves DNS/TLS/route reachability to Telegram.
      finish(true);
    });
    req.on("timeout", () => { req.destroy(); finish(false); });
    req.on("error", () => finish(false));
    req.end();
  });
  return telegramReachabilityProbe.pending;
}

async function telegramTransportReachable(_account) {
  // 001BeatGaler is manager-only and is intentionally not a vault member, so
  // reachability must not be tested through that bot. The Direct session start
  // performs the authoritative MASTER + transport-bot vault check.
  return telegramPublicEdgeReachable();
}

// ── Fase 9: BeatGaler pregunta cada pocos segundos si ya se conectó ──
app.get("/telegram/connect/status", async (req, res) => {
  const auth = authenticatedInstallation(req, res);
  if (!auth) return;
  const { beatgalerUserId, account } = auth;
  if (account) {
    const reachable = await telegramTransportReachable(account);
    return res.json({
      connected: true,
      reachable,
      telegram_username: account.beatgalerUsername || account.telegramUsername,
      telegram_user_id: account.telegramUserId ? String(account.telegramUserId) : null,
      beatgaler_account_id: account.beatgalerAccountId || null,
      beatgaler_username: account.beatgalerUsername || account.telegramUsername || null,
      connected_at: account.connectedAt,
      storage_ready: !!account.storageChatId,
      storage_chat_id: account.storageChatId ? String(account.storageChatId) : null,
      storage_chat_title: account.storageChatTitle || null,
    });
  }

  // `connected:false` and `reachable:false` used to be ambiguous: it could mean
  // either "this installation is genuinely unlinked" or simply "Wi-Fi is off".
  // Report transport reachability even without an account so Desktop can keep
  // the persisted account/offline library instead of logging the user out.
  const reachable = await telegramTransportReachable(null);
  res.json({ connected: false, reachable });
});

// ── Fase 11 (paso 12/13): desconectar ──
app.post("/telegram/disconnect", (req, res) => {
  const auth = authenticatedInstallation(req, res);
  if (!auth) return;
  const { beatgalerUserId } = auth;
  linkedAccounts.delete(beatgalerUserId);
  savePersistentData();
  res.json({ ok: true });
});


// ── Telegram Direct Prototype integration ────────────────────────────────
// The server is now a control plane for large media. It leases a Managed Bot,
// adds it to the user's private vault, and returns only an ephemeral runtime
// credential. Web MP3/WAV bytes go directly to Telegram; Web PROJECT bytes
// enter through the measured MASTER upload route below.
app.get("/transport/status", (req, res) => {
  const configuredKey = String(process.env.BEATGALER_ADMIN_KEY || "");
  const suppliedKey = String(req.headers["x-beatgaler-admin-key"] || "");
  const remote = String(req.socket?.remoteAddress || "");
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const adminMatch = configuredKey && suppliedKey && configuredKey.length === suppliedKey.length && crypto.timingSafeEqual(Buffer.from(configuredKey), Buffer.from(suppliedKey));
  if (!adminMatch && !(process.env.NODE_ENV !== "production" && loopback)) {
    return res.status(404).json({ error: "Not available." });
  }
  try {
    const pool = directTransport.poolStatus();
    res.json({ ok: true, direct: directTransport.enabled(), heartbeat_interval_ms: pool.heartbeat_interval_ms, heartbeat_timeout_ms: pool.heartbeat_timeout_ms, sessions: pool.sessions, operations: pool.operations, bots: pool.bots, queue: pool.queue });
  } catch (_error) {
    res.status(503).json({ ok: false, direct: false, error: "Cloud transport status is unavailable." });
  }
});


const LIBRARY_INDEX_CAPTION = "BEATGALER_LIBRARY_INDEX_V1";
const LIBRARY_INDEX_BACKUP_POINTER_PREFIX = "BG_BACKUPS_V1="; // legacy reader only
const LIBRARY_INDEX_COW_PREFIX = "BG_COW_V1=";
const LIBRARY_INDEX_BACKUP_LIMIT = Math.max(1, Math.min(10, Number(process.env.INDEX_BACKUP_COUNT || 3)));
const LIBRARY_INDEX_CAPTION_MAX = 1000;


app.listen(PORT, "0.0.0.0", () => {
  console.log(`BeatGaler Cloud API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`Transport: Telegram Direct MTProto (MASTER + managed bot pool)`);
});


// ── Generic beat cloud file upload — one Telegram document per slot ─────
const CLOUD_ROLE_META = {
  WAV:     { icon: "", label: "WAV HQ" },
  LOOP:    { icon: "", label: "Loop" },
  PROJECT: { icon: "", label: "Project" },
  STEMS:   { icon: "", label: "Stems" },
  OTHER:   { icon: "", label: "Other" },
};


// 001BeatGaler has no runtime connection here. It is used only as the manager
// credential for Managed Bot token issuance/rotation in direct-transport-control.js.
console.log("[manager] 001BeatGaler manager-only: no polling, no commands, no vault membership, no data plane");

// Final diagnostic error handler. Keeps unexpected upload/middleware failures
// machine-readable so the desktop can show the real cause in its red ! panel.
app.use((err, req, res, next) => {
  const requestId = req.beatgalerRequestId || "unknown";
  const message = err?.message || String(err || "Unknown server error");
  console.error(`[http ${requestId}] unhandled middleware/server error:`, message);
  if (res.headersSent) return next(err);

  const status =
    err?.code === "LIMIT_FILE_SIZE" ? 413 :
    Number(err?.status || err?.statusCode) >= 400 ? Number(err.status || err.statusCode) :
    500;

  res.status(status).json({
    error: status >= 500 ? `BeatGaler Cloud request failed [${requestId}].` : message,
    request_id: requestId,
  });
});
