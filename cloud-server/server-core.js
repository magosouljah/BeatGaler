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
const { createPrivateUserStorageGroup, ensurePrivateUserStorageBotAbsent, masterStorageReady } = require("./master-storage");
const { withTelegramFloodWait } = require("./telegram-retry");
const directTransport = require("./direct-transport-control");
const { wrapWebTransportSession } = require("./web-transport-envelope");
const { ensurePlanState, publicPlanState, publicPlanCatalog, setBasePlanForUser, CODE_POLICY } = require("./plans");
const { hashPassword, verifyPassword } = require("./password-kdf");

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
    if (isUpload || res.statusCode >= 400) {
      console.log(
        `[http ${requestId}] ${req.method} ${req.path} -> ${res.statusCode} ` +
        `${Date.now() - started}ms`
      );
    }
  });
  next();
});

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-BeatGaler-Installation-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(express.json({ limit: "256kb" }));
const upload = multer({
  dest: "uploads-tmp/",
  limits: {
    files: 1,
    fields: 24,
    fieldSize: 64 * 1024,
    fileSize: TELEGRAM_MAX_UPLOAD_BYTES,
  },
});
const DATA_FILE = path.join(__dirname, "cloud-data.json");
const AUTH_DATA_FILE = path.join(__dirname, "accounts-data.json");
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


function telegramJsonMethodOnce(method, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), "utf8");
    const endpoint = new URL(telegramMethodUrl(method));
    const transport = endpoint.protocol === "https:" ? https : http;
    const request = transport.request({
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
      path: endpoint.pathname + endpoint.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { return reject(new Error(`Invalid Telegram ${method} response: ${raw}`)); }
        if (!parsed.ok) {
          const error = new Error(parsed.description || `Telegram ${method} failed`);
          error.retry_after = Number(parsed?.parameters?.retry_after) || undefined;
          error.response = { body: parsed, statusCode: response.statusCode };
          return reject(error);
        }
        resolve(parsed.result);
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function telegramJsonMethod(method, payload) {
  return withTelegramFloodWait(
    `Bot API ${method}`,
    () => telegramJsonMethodOnce(method, payload),
    {
      onWait: ({ retryAfter, attempt }) => {
        console.warn(`[telegram] ${method} rate limited; waiting ${retryAfter}s before retry ${attempt}.`);
      },
    },
  );
}

function topicKey(userId, beatId) {
  return `${String(userId)}:${String(beatId)}`;
}

function storageChatId(account) {
  const value = Number(account?.storageChatId);
  if (!Number.isFinite(value) || value === 0) {
    throw new Error("BeatGaler private storage is not provisioned for this account.");
  }
  return value;
}

function topicName(value) {
  return (String(value || "Untitled Beat").trim().replace(/\s+/g, " ") || "Untitled Beat").slice(0, 128);
}

function isMissingTopicError(error) {
  const message = String(error?.message || error || "");
  return /message thread not found|topic.*not found|MESSAGE_THREAD_INVALID|message_thread_id_invalid/i.test(message);
}

function forgetBeatTopic(userId, beatId) {
  beatTopics.delete(topicKey(userId, beatId));
  savePersistentData();
}

async function ensureBeatTopic(account, userId, beatId, beatName) {
  if (!beatId) throw new Error("beatId is required for Telegram Topic storage.");
  const chatId = storageChatId(account);
  const key = topicKey(userId, beatId);
  const name = topicName(beatName || beatId);
  const current = beatTopics.get(key);

  if (current && Number(current.chatId) === chatId && Number(current.messageThreadId) > 0) {
    if (String(current.beatName || "") === name) return Number(current.messageThreadId);
    try {
      await directTransport.editForumTopic(chatId, Number(current.messageThreadId), name);
      current.beatName = name;
      current.updatedAt = Date.now();
      beatTopics.set(key, current);
      savePersistentData();
      return Number(current.messageThreadId);
    } catch (error) {
      if (!isMissingTopicError(error)) {
        console.warn("[topics] MASTER rename failed:", error?.message || error);
        return Number(current.messageThreadId);
      }
      console.warn("[topics] stored topic no longer exists; recreating:", error?.message || error);
      forgetBeatTopic(userId, beatId);
    }
  }

  const messageThreadId = await directTransport.createForumTopic(chatId, name);
  if (!Number.isFinite(messageThreadId) || messageThreadId <= 0) throw new Error("MASTER returned no forum topic id.");
  beatTopics.set(key, { chatId, messageThreadId, beatName: name, updatedAt: Date.now() });
  savePersistentData();
  return messageThreadId;
}

function injectTopicIds(userId, manifest) {
  const apply = beat => {
    if (!beat?.id) return;
    const current = beatTopics.get(topicKey(userId, beat.id));
    if (current?.messageThreadId) beat.telegram_topic_id = Number(current.messageThreadId);
  };
  (manifest?.beats || []).forEach(apply);
  (manifest?.trash || []).forEach(item => apply(item?.beat));
}

function rebuildTopicMap(userId, account, manifest) {
  const chatId = Number(account?.storageChatId);
  if (!Number.isFinite(chatId)) return;
  const apply = beat => {
    const beatId = String(beat?.id || "");
    const messageThreadId = Number(beat?.telegram_topic_id);
    if (!beatId || !Number.isFinite(messageThreadId) || messageThreadId <= 0) return;
    beatTopics.set(topicKey(userId, beatId), {
      chatId, messageThreadId, beatName: topicName(beat?.name || beatId), updatedAt: Date.now()
    });
  };
  (manifest?.beats || []).forEach(apply);
  (manifest?.trash || []).forEach(item => apply(item?.beat));
  savePersistentData();
}

async function deleteBeatTopic(account, userId, beatId, topicIdHint) {
  const key = topicKey(userId, beatId);
  const current = beatTopics.get(key);
  const messageThreadId = Number(topicIdHint || current?.messageThreadId);
  if (!Number.isFinite(messageThreadId) || messageThreadId <= 0) {
    beatTopics.delete(key);
    pendingTopicDeletes.delete(key);
    savePersistentData();
    return { deleted: false, missing: true };
  }

  try {
    await directTransport.deleteForumTopic(storageChatId(account), messageThreadId);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/message thread not found|topic.*not found|MESSAGE_THREAD_INVALID|TOPIC_ID_INVALID/i.test(message)) throw error;
  }

  beatTopics.delete(key);
  pendingTopicDeletes.delete(key);
  for (const [fileId, entry] of uploadedFiles) {
    if (entry?.beatgalerUserId === userId && String(entry?.beatId || "") === String(beatId)) {
      uploadedFiles.delete(fileId);
    }
  }
  savePersistentData();
  return { deleted: true, message_thread_id: messageThreadId };
}

function queueRemovedTrashTopics(userId, previousManifest, nextManifest) {
  if (!Array.isArray(previousManifest?.trash)) return;
  const keep = new Set([
    ...(nextManifest?.beats || []).map(beat => String(beat?.id || "")),
    ...(nextManifest?.trash || []).map(item => String(item?.beat?.id || "")),
  ].filter(Boolean));

  for (const item of previousManifest.trash) {
    const beat = item?.beat;
    const beatId = String(beat?.id || "");
    if (!beatId || keep.has(beatId)) continue;
    const current = beatTopics.get(topicKey(userId, beatId));
    const telegramTopicId = Number(beat?.telegram_topic_id || current?.messageThreadId);
    if (!Number.isFinite(telegramTopicId) || telegramTopicId <= 0) continue;
    pendingTopicDeletes.set(topicKey(userId, beatId), { beatId, telegramTopicId, queuedAt: Date.now() });
  }
  savePersistentData();
}


function normalizeDeletedBeatTombstones(manifest) {
  const rows = Array.isArray(manifest?.deleted) ? manifest.deleted : [];
  const byId = new Map();
  for (const row of rows) {
    const beatId = String(row?.beat_id || row?.id || "").trim();
    if (!beatId) continue;
    const deletedAt = Number(row?.deleted_at || row?.at || 0);
    const current = byId.get(beatId);
    if (!current || deletedAt > Number(current.deleted_at || 0)) {
      byId.set(beatId, {
        beat_id: beatId,
        deleted_at: Number.isFinite(deletedAt) && deletedAt > 0
          ? deletedAt
          : Math.floor(Date.now() / 1000),
      });
    }
  }
  return [...byId.values()];
}

function mergeDeletedBeatTombstones(previousManifest, incomingManifest) {
  const merged = new Map();
  for (const row of [
    ...normalizeDeletedBeatTombstones(previousManifest),
    ...normalizeDeletedBeatTombstones(incomingManifest),
  ]) {
    const current = merged.get(row.beat_id);
    if (!current || row.deleted_at > current.deleted_at) merged.set(row.beat_id, row);
  }
  incomingManifest.deleted = [...merged.values()];
  return incomingManifest.deleted;
}

function applyDeletedBeatTombstones(manifest) {
  const deleted = normalizeDeletedBeatTombstones(manifest);
  manifest.deleted = deleted;
  if (deleted.length === 0) return { suppressed: 0, deleted };

  const ids = new Set(deleted.map(row => row.beat_id));
  const beforeBeats = Array.isArray(manifest.beats) ? manifest.beats.length : 0;
  const beforeTrash = Array.isArray(manifest.trash) ? manifest.trash.length : 0;
  manifest.beats = (Array.isArray(manifest.beats) ? manifest.beats : [])
    .filter(beat => !ids.has(String(beat?.id || "")));
  manifest.trash = (Array.isArray(manifest.trash) ? manifest.trash : [])
    .filter(item => !ids.has(String(item?.beat?.id || "")));
  return {
    suppressed: (beforeBeats - manifest.beats.length) + (beforeTrash - manifest.trash.length),
    deleted,
  };
}

async function flushPendingTopicDeletes(account, userId) {
  const prefix = `${String(userId)}:`;
  const entries = [...pendingTopicDeletes.entries()]
    .filter(([key]) => key.startsWith(prefix));
  if (entries.length === 0) return { attempted: 0, deleted: 0, failed: 0 };

  // Physical Telegram topic deletion is cleanup, not a UI-blocking action.
  // Keep concurrency bounded so a large Trash clears faster without creating
  // an unbounded burst of Telegram requests.
  let cursor = 0;
  let deleted = 0;
  let failed = 0;
  const workerCount = Math.min(4, entries.length);
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= entries.length) return;
      const [key, entry] = entries[index];
      try {
        await deleteBeatTopic(account, userId, entry.beatId, entry.telegramTopicId);
        deleted += 1;
      } catch (error) {
        const message = String(error?.message || error || "");
        if (message.includes("TOPIC_ID_INVALID")) {
          pendingTopicDeletes.delete(key);
          beatTopics.delete(topicKey(userId, entry.beatId));
          savePersistentData();
          deleted += 1;
          console.log("[topics] topic already absent; cleared pending delete:", entry.beatId);
          continue;
        }
        failed += 1;
        console.warn("[topics] permanent delete failed; kept for retry:", message);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { attempted: entries.length, deleted, failed };
}

function schedulePendingTopicDeletes(account, userId, reason = "background") {
  setImmediate(() => {
    void flushPendingTopicDeletes(account, userId)
      .then(summary => {
        if (summary.attempted > 0) {
          console.log(
            `[trash] ${reason} Telegram cleanup attempted=${summary.attempted} ` +
            `deleted=${summary.deleted} failed=${summary.failed}`
          );
        }
      })
      .catch(error => {
        console.warn(`[trash] ${reason} Telegram cleanup crashed; queue kept for retry:`, error?.message || error);
      });
  });
}

function redirectMessageId(userId, messageId) {
  const id = Number(messageId);
  if (!Number.isFinite(id) || id <= 0) return id;
  const redirected = Number(messageRedirects.get(`${String(userId)}:${id}`));
  return Number.isFinite(redirected) && redirected > 0 ? redirected : id;
}

function rememberMessageRedirect(userId, oldMessageId, newMessageId) {
  const oldId = Number(oldMessageId);
  const newId = Number(newMessageId);
  if (!Number.isFinite(oldId) || oldId <= 0 || !Number.isFinite(newId) || newId <= 0) return;
  if (oldId === newId) return;
  messageRedirects.set(`${String(userId)}:${oldId}`, newId);
}

async function readLibraryManifestFromChat(chatId) {
  try {
    const pinned = await directTransport.getPinnedMessage(Number(chatId));
    if (!pinned?.message_id) return null;
    const caption = String(pinned.caption || pinned.text || "");
    if (!caption.startsWith(LIBRARY_INDEX_CAPTION)) return null;
    const raw = await directTransport.downloadMessageBuffer(Number(chatId), Number(pinned.message_id));
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    console.warn(`[migration] could not read library index from chat ${chatId}:`, error?.message || error);
    return null;
  }
}

async function resendStoredDocument(chatId, topicId, telegramFileId, filename, caption) {
  if (!telegramFileId) return null;
  const sent = await bot.sendDocument(
    chatId,
    telegramFileId,
    { caption, message_thread_id: topicId },
    filename ? { filename, contentType: "application/octet-stream" } : {}
  );
  return sent;
}

async function migrateManifestBeatToTopic(account, userId, beat) {
  if (!beat?.id) return false;
  const key = topicKey(userId, beat.id);
  if (beatTopics.has(key)) return false; // already migrated/created

  const chatId = storageChatId(account);
  const topicId = await ensureBeatTopic(account, userId, beat.id, beat.name);
  beat.telegram_topic_id = topicId;

  const migratePart = async (part, caption) => {
    if (!part?.telegram_file_id) return;
    const oldId = Number(part.telegram_message_id);
    const sent = await resendStoredDocument(
      chatId,
      topicId,
      part.telegram_file_id,
      part.filename || undefined,
      caption
    );
    if (!sent) return;
    rememberMessageRedirect(userId, oldId, sent.message_id);
    part.telegram_file_id = sent?.document?.file_id || part.telegram_file_id;
    part.telegram_message_id = sent.message_id;
  };

  if (beat.master?.telegram_file_id) {
    const oldId = Number(beat.master.telegram_message_id);
    const sent = await resendStoredDocument(
      chatId,
      topicId,
      beat.master.telegram_file_id,
      beat.master.filename || `${beat.name || beat.id}.mp3`,
      ` ${beat.name || beat.id}`
    );
    if (sent) {
      rememberMessageRedirect(userId, oldId, sent.message_id);
      beat.master.telegram_file_id = sent?.document?.file_id || beat.master.telegram_file_id;
      beat.master.telegram_message_id = sent.message_id;
    }
  }

  for (const file of beat.files || []) {
    const parts = file?.manifest?.parts || [];
    for (const part of parts) {
      await migratePart(part, `${String(file.type || "FILE")} • ${beat.name || beat.id}`);
    }
  }

  if (beat.project?.manifest?.parts) {
    for (const part of beat.project.manifest.parts) {
      await migratePart(part, ` ${beat.name || beat.id}`);
    }
  }

  if (beat.artwork?.telegram_file_id) {
    const oldId = Number(beat.artwork.telegram_message_id);
    const sent = await resendStoredDocument(
      chatId,
      topicId,
      beat.artwork.telegram_file_id,
      `beatgaler-artwork-${beat.id}`,
      ` Artwork • ${beat.name || beat.id}`
    );
    if (sent) {
      rememberMessageRedirect(userId, oldId, sent.message_id);
      beat.artwork.telegram_file_id = sent?.document?.file_id || beat.artwork.telegram_file_id;
      beat.artwork.telegram_message_id = sent.message_id;
    }
  }

  if (beat.metadata_message_id) {
    const oldId = Number(beat.metadata_message_id);
    const metadata = {
      name: beat.name || "",
      bpm: beat.bpm || "",
      key: beat.key || "",
      tags: Array.isArray(beat.tags) ? beat.tags : [],
      rating: Number(beat.rating || 0),
      color: beat.color || "",
      color2: beat.color2 || "",
    };
    const sent = await bot.sendMessage(
      chatId,
      `BEATGALER_METADATA_V1\n${JSON.stringify(metadata)}`,
      { message_thread_id: topicId }
    );
    rememberMessageRedirect(userId, oldId, sent.message_id);
    beat.metadata_message_id = sent.message_id;
  }

  savePersistentData();
  return true;
}

async function writeMigratedLibraryIndex(account, manifest) {
  validateLibraryManifest(manifest);
  const chatId = storageChatId(account);
  const tempDir = path.join(__dirname, "uploads-tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `beatgaler-library-migrated-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(tempPath, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));

  try {
    const existing = await getPinnedLibraryIndex(account);
    const existingCaption = String(existing?.caption || existing?.text || "");
    const previousId = Number(existing?.message_id || 0) || null;
    const oldBackupIds = [
      ...parseCowBackupMessageIds(existingCaption),
      ...parseLegacyLibraryBackupPointers(existingCaption).map(item => item.m),
    ];
    const { caption } = buildCowIndexCaption([previousId, ...oldBackupIds]);

    await directTransport.commitIndexCopyOnWrite({
      chatId,
      filePath: tempPath,
      caption,
      previousMessageId: previousId,
      backupMessageIds: oldBackupIds,
      keep: LIBRARY_INDEX_BACKUP_LIMIT,
    });
  } finally {
    fs.unlink(tempPath, () => {});
  }
}

async function migrateCurrentLibraryToTopics(account, userId, previousPrivateChatId) {
  // Prefer an already-existing storage-group index (current source of truth).
  let manifest = await readLibraryManifestFromChat(account.storageChatId);
  if (!manifest && previousPrivateChatId) {
    manifest = await readLibraryManifestFromChat(previousPrivateChatId);
  }
  if (!manifest) return { migrated: 0 };

  let migrated = 0;
  for (const beat of manifest.beats || []) {
    if (await migrateManifestBeatToTopic(account, userId, beat)) migrated += 1;
  }
  for (const item of manifest.trash || []) {
    if (await migrateManifestBeatToTopic(account, userId, item?.beat)) migrated += 1;
  }

  injectTopicIds(userId, manifest);
  await writeMigratedLibraryIndex(account, manifest);
  savePersistentData();
  return { migrated };
}

function telegramMethodUrl(method) {
  throw new Error(`Legacy service-bot method ${method} is disabled; 001BeatGaler is manager-only.`);
}

function localTelegramPath(filePath) {
  if (!filePath) return null;
  const value = String(filePath);
  if (path.isAbsolute(value)) return value;
  return null;
}

async function resolveTelegramReadableFile(fileId, attempts = 3) {
  let lastFile = null;
  let lastLocalPath = null;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const tgFile = await bot.getFile(fileId);
      lastFile = tgFile;
      if (!tgFile?.file_path) throw new Error("Telegram returned no file_path");
      const localPath = localTelegramPath(tgFile.file_path);
      lastLocalPath = localPath;
      if (!localPath) return { tgFile, localPath: null, stat: null };
      try {
        const stat = await fs.promises.stat(localPath);
        if (stat.isFile() && stat.size > 0) return { tgFile, localPath, stat };
        lastError = new Error("Telegram local file is empty or not a file");
      } catch (error) {
        lastError = error;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) {
      await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }

  if (lastFile?.file_path && !lastLocalPath) {
    return { tgFile: lastFile, localPath: null, stat: null };
  }
  const detail = String(lastError?.message || lastError || "local file was not materialized");
  const error = new Error(`Telegram local file is not ready yet: ${detail}`);
  error.code = "TELEGRAM_LOCAL_FILE_NOT_READY";
  throw error;
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

function broadcastCloudEvent(beatgalerUserId, eventName, data = {}, excludeSourceId = "") {
  const clients = cloudEventClients.get(beatgalerUserId);
  if (!clients) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    if (excludeSourceId && client.sourceId === excludeSourceId) continue;
    try { client.res.write(payload); } catch {}
  }
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

function validBeatGalerUsername(username) {
  return /^[a-z0-9._]{3,20}#\d{4}$/.test(username) || /^[a-z0-9_]{1,15}$/.test(username);
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

function safeDisplayText(value, field = "value", max = 256) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw Object.assign(new Error(`${field} is invalid.`), { status: 400 });
  }
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

async function ensureUserStorage(user) {
  if (user.storageChatId) {
    const account = {
      telegramUserId: botApiChatIdFromStored(user.storageChatId),
      storageChatId: botApiChatIdFromStored(user.storageChatId),
      storageChatTitle: user.storageChatTitle,
    };

    // Migration invariant: the manager bot (001BeatGaler) never belongs to a
    // user vault. If an older BeatGaler build left it there, MASTER removes it.
    const managerBotUsername = MANAGER_BOT_USERNAME;
    if (managerBotUsername) {
      try {
        await ensurePrivateUserStorageBotAbsent({
          botApiChatId: user.storageChatId,
          botUsername: managerBotUsername,
        });
      } catch (error) {
        console.warn(`[storage] manager-bot cleanup deferred for @${user.username}:`, error?.message || error);
      }
    }

    try {
      await ensureEmptyIndexForStorage(account);
      return user;
    } catch (error) {
      const message = String(error?.message || error);
      if (/could not be found|group chat was deleted|supergroup chat was deleted|CHANNEL_INVALID|CHANNEL_PRIVATE|peer id invalid/i.test(message)) {
        console.warn(`[storage] vault no longer exists for @${user.username}; provisioning a replacement vault`);
        user.storageChatId = null;
        user.storageChatTitle = null;
        user.storageCreatedAt = null;
        saveAuthData();
        return ensureUserStorage(user);
      }
      throw error;
    }
  }

  const used = [...beatGalerUsers.values()].filter(entry => entry.storageChatId).length;
  if (used >= MASTER_STORAGE_GROUP_LIMIT) {
    throw new Error(`Master Telegram storage account is full (${MASTER_STORAGE_GROUP_LIMIT} user groups). Add master account #2 before registering more users.`);
  }
  if (!masterStorageReady()) {
    throw new Error("Master Telegram storage account is not configured. Run: node setup-master-account.js");
  }

  const created = await createPrivateUserStorageGroup({ username: user.username, accountId: user.id });
  user.storageChatId = String(created.botApiChatId);
  user.storageChatTitle = created.title;
  user.storageCreatedAt = Date.now();
  saveAuthData();

  const account = {
    telegramUserId: botApiChatIdFromStored(user.storageChatId),
    storageChatId: botApiChatIdFromStored(user.storageChatId),
    storageChatTitle: user.storageChatTitle,
  };
  await ensureEmptyIndexForStorage(account);
  return user;
}

function accountPublicPayload(user, token) {
  return {
    ok: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      username_source: user.usernameSource || "beatgaler",
      official_username: user.usernameSource === "x",
      email: user.email || null,
      storage_ready: !!user.storageChatId,
      has_password: !!user.passwordHash,
      mfa_enabled: !!user.mfaSecret,
      plan: publicPlanState(user),
      providers: {
        google: userProvider(user, "google") ? { connected: true, email: userProvider(user, "google").email || null, name: userProvider(user, "google").name || null } : { connected: false },
        x: userProvider(user, "x") ? { connected: true, username: userProvider(user, "x").username || null, name: userProvider(user, "x").name || null } : { connected: false },
      },
    },
  };
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

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutos (Fase 6)

function generateToken() {
  return crypto.randomBytes(8).toString("hex"); // ej: 6efc4cb2a91844f7
}

function cleanupExpired() {
  const now = Date.now();
  for (const [token, entry] of pendingConnections) {
    if (entry.expiresAt < now) pendingConnections.delete(token);
  }
}

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

app.get("/plans/catalog", (_req, res) => {
  res.json({
    ok: true,
    plans: publicPlanCatalog(),
    code_policy: {
      existing_user_default_days: CODE_POLICY.existing_user_default_days,
      welcome: CODE_POLICY.welcome,
      code_types: CODE_POLICY.code_types,
    },
  });
});

app.get("/plans/me", (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  return res.json({ ok: true, plan: publicPlanState(user) });
});

// Development-only simulated checkout. It deliberately changes the plan on the
// server so Desktop/Web never learn to trust a client-side plan flag.
app.post("/plans/dev-switch", (req, res) => {
  if (process.env.BEATGALER_DEV_PLAN_SWITCH !== "1") {
    return res.status(404).json({ error: "Not available." });
  }
  const token = bearerToken(req);
  const user = getAuthUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  try {
    setBasePlanForUser(user, req.body?.plan_id);
    saveAuthData();
    return res.json(accountPublicPayload(user, token));
  } catch (error) {
    return res.status(400).json({ error: error?.message || String(error) });
  }
});

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
  ensurePlanState(user, { newAccount: true });

  beatGalerUsers.set(username, user);
  beatGalerUsersById.set(user.id, user);
  saveAuthData();

  try {
    await ensureUserStorage(user);
    bindInstallationToBeatGalerUser(user, beatgalerUserId);
    const token = createAuthSession(user.id);
    return res.status(201).json(accountPublicPayload(user, token));
  } catch (error) {
    console.error("[auth] storage provisioning failed:", error?.message || error);
    return res.status(503).json({ error: `BeatGaler account created, but private cloud storage could not be provisioned: ${error?.message || error}`, account_created: true, username });
  }
});

app.post("/auth/login", async (req, res) => {
  const identifier = String(req.body?.identifier || req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const beatgalerUserId = String(req.body?.beatgalerUserId || "");
  const normalizedIdentifier = normalizeBeatGalerUsername(identifier);
  const user = identifier.includes("@") ? findUserByEmail(identifier) : (beatGalerUsers.get(normalizedIdentifier) || findUserByEmail(identifier));

  if (!user || !user.passwordHash || !(await verifyPassword(password, user))) {
    return res.status(401).json({ error: "Invalid username/email or password." });
  }
  if (user.mfaSecret && !verifyTotp(user.mfaSecret, req.body?.mfaCode)) {
    return res.status(401).json({ error: "MFA code required or invalid.", mfa_required: true });
  }
  if (!beatgalerUserId) {
    return res.status(400).json({ error: "beatgalerUserId is required." });
  }

  try {
    await syncXIdentity(user).catch(() => false);
    await ensureUserStorage(user);
    bindInstallationToBeatGalerUser(user, beatgalerUserId);
    const token = createAuthSession(user.id);
    res.json(accountPublicPayload(user, token));
  } catch (error) {
    res.status(503).json({ error: `Private cloud storage is not ready: ${error?.message || error}` });
  }
});

app.post("/auth/session", async (req, res) => {
  const token = bearerToken(req);
  const beatgalerUserId = String(req.body?.beatgalerUserId || req.headers["x-beatgaler-installation-id"] || "");
  const user = getAuthUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  if (!beatgalerUserId) return res.status(400).json({ error: "beatgalerUserId is required." });

  try {
    await syncXIdentity(user).catch(() => false);
    await ensureUserStorage(user);
    bindInstallationToBeatGalerUser(user, beatgalerUserId);
    res.json(accountPublicPayload(user, token));
  } catch (error) {
    res.status(503).json({ error: `Private cloud storage is not ready: ${error?.message || error}` });
  }
});

app.post("/auth/account", async (req, res) => {
  const user = getAuthUserFromToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: "Session expired. Sign in again." });
  await syncXIdentity(user).catch(() => false);
  res.json(accountPublicPayload(user, bearerToken(req)));
});

app.post("/auth/email/change", (req, res) => {
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
  res.json(accountPublicPayload(user, bearerToken(req)));
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
        ensurePlanState(user, { newAccount: true });
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
  res.json({ ...accountPublicPayload(user, token), linked: !result.token });
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

function authenticatedTransportAccount(req, res) {
  return authenticatedInstallation(req, res);
}

// ── Telegram Direct Prototype integration ────────────────────────────────
// The server is now a control plane for large media. It leases a Managed Bot,
// adds it to the user's private vault, and returns only an ephemeral runtime
// credential. MP3/WAV/PROJECT bytes go Desktop -> Telegram directly.
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

app.post("/transport/session/start", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId, account } = auth;
  try {
    const session = await directTransport.startSession({
      installationId: beatgalerUserId,
      chatId: storageChatId(account),
    });
    res.json(wrapWebTransportSession(session, req.body?.webTransportPublicKey));
  } catch (error) {
    console.error("[direct] session start failed:", error?.message || error);
    res.status(503).json({ error: "Galer Cloud session unavailable. Please try again." });
  }
});

app.post("/transport/session/activate", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId } = auth;
  try {
    res.json(await directTransport.activateSession({
      installationId: beatgalerUserId,
      sessionId: String(req.body?.sessionId || ""),
      generation: Number(req.body?.generation || 0),
    }));
  } catch (error) {
    console.error("[direct] session activation failed:", error?.message || error);
    res.status(409).json({ error: "Galer Cloud could not activate this storage session. Please try again." });
  }
});

app.post("/transport/session/heartbeat", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId } = auth;
  try {
    const heartbeat = await directTransport.heartbeat({
      installationId: beatgalerUserId,
      sessionId: String(req.body?.sessionId || ""),
      generation: Number(req.body?.generation || 0),
      credentialVersion: Number(req.body?.credentialVersion || 0),
    });
    if (heartbeat?.credential_refresh) {
      heartbeat.credential_refresh = wrapWebTransportSession(
        heartbeat.credential_refresh,
        req.body?.webTransportPublicKey,
      );
    }
    res.json(heartbeat);
  } catch (error) {
    console.error("[direct] heartbeat failed:", error?.message || error);
    res.status(500).json({ error: "Cloud session heartbeat failed." });
  }
});

app.post("/transport/session/stop", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId } = auth;
  const sessionId = String(req.body?.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId is required." });
  try {
    res.json(await directTransport.stopSession({
      installationId: beatgalerUserId,
      sessionId,
      generation: Number(req.body?.generation || 0),
    }));
  } catch (error) {
    console.error("[direct] session release failed:", error?.message || error);
    res.status(500).json({ error: "BeatGaler Cloud cleanup is pending." });
  }
});

app.post("/transport/operation/begin", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId } = auth;
  try {
    const operation = await directTransport.beginOperation({
      installationId: beatgalerUserId,
      sessionId: String(req.body?.sessionId || ""),
      generation: Number(req.body?.generation || 0),
      credentialVersion: Number(req.body?.credentialVersion || 0),
      kind: String(req.body?.kind || "data"),
    });
    if (operation?.credential_refresh) {
      operation.credential_refresh = wrapWebTransportSession(
        operation.credential_refresh,
        req.body?.webTransportPublicKey,
      );
    }
    res.json(operation);
  } catch (error) {
    const message = String(error?.message || error || "");
    console.error("[direct] operation begin failed:", message);
    // Pool-state file contention is normal backpressure when heartbeat/index/data
    // operations land together. Tell the Desktop to wait/retry the SAME lease
    // instead of surfacing a fake upload/network failure.
    if (message.includes("transport pool lock")) {
      return res.json({ ok: false, wait: true, retry_after_ms: 250, reason: "pool_lock_busy" });
    }
    res.status(500).json({ error: "Galer Storage operation unavailable. Please try again." });
  }
});

app.post("/transport/operation/end", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId } = auth;
  try {
    res.json(await directTransport.endOperation({
      installationId: beatgalerUserId,
      sessionId: String(req.body?.sessionId || ""),
      generation: Number(req.body?.generation || 0),
      operationId: String(req.body?.operationId || ""),
    }));
  } catch (error) {
    console.error("[direct] operation end failed:", error?.message || error);
    res.status(500).json({ error: "Could not finish the transport operation." });
  }
});

app.post("/transport/index/commit", (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId, account } = auth;
  const messageId = Number(req.body?.messageId || 0);
  const fileId = String(req.body?.fileId || "").trim();
  if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: "messageId is required." });
  try {
    directTransport.recordIndexPointer(storageChatId(account), { messageId, fileId });
  } catch (error) {
    console.warn("[direct] index pointer persistence failed:", error?.message || error);
  }
  broadcastCloudEvent(
    beatgalerUserId,
    "library_changed",
    { telegram_message_id: messageId, beat_count: Number(req.body?.beatCount || 0), transport: "direct-single-index" },
    String(req.body?.sourceId || "")
  );
  res.json({ ok: true });
});

app.post("/transport/topic/ensure", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId, account } = auth;
  const beatId = String(req.body?.beatId || "");
  const beatName = String(req.body?.beatName || beatId);
  if (!beatId) return res.status(400).json({ error: "beatId is required." });
  try {
    const messageThreadId = await ensureBeatTopic(account, beatgalerUserId, beatId, beatName);
    res.json({ ok: true, message_thread_id: messageThreadId });
  } catch (error) {
    console.error("[direct] topic ensure failed:", error?.message || error);
    res.status(500).json({ error: "Could not prepare BeatGaler Cloud storage for this beat." });
  }
});

app.post("/transport/upload/confirm", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const { beatgalerUserId, account } = auth;
  const sessionId = String(req.body?.sessionId || "");
  const messageId = Number(req.body?.messageId);
  const filename = String(req.body?.filename || "file");
  const beatId = String(req.body?.beatId || "");
  const kind = String(req.body?.kind || "FILE").toUpperCase();
  if (!sessionId || !Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: "sessionId and a valid messageId are required." });
  try {
    await directTransport.verifyMessage({ installationId: beatgalerUserId, sessionId, messageId });
    const locator = `direct:${messageId}`;
    uploadedFiles.set(locator, {
      beatgalerUserId,
      telegramUserId: account.telegramUserId,
      telegramMessageId: messageId,
      filename,
      beatId,
      kind,
      direct: true,
      createdAt: Date.now(),
    });
    savePersistentData();
    res.json({ ok: true, telegram_file_id: locator, telegram_message_id: messageId });
  } catch (error) {
    console.error("[direct] upload confirmation failed:", error?.message || error);
    res.status(409).json({ error: "BeatGaler Cloud could not verify the completed upload." });
  }
});



// Use Telegram's native multipart editMessageMedia request for artwork.
// Passing a local path directly inside InputMedia can be interpreted as a
// string/file_id by wrapper libraries. attach://artwork guarantees that the
// NEW bytes replace the media of the EXISTING Telegram message.
function editTelegramDocumentInPlace({ chatId, messageId, filePath, filename, caption }) {
  return new Promise((resolve, reject) => {
    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(filePath);
    } catch (err) {
      return reject(err);
    }

    const boundary = `----BeatGaler${crypto.randomBytes(12).toString("hex")}`;
    const chunks = [];

    const addField = (name, value) => {
      chunks.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
      ));
    };

    addField("chat_id", String(chatId));
    addField("message_id", String(messageId));
    addField("media", JSON.stringify({
      type: "document",
      media: "attach://artwork",
      caption: caption || undefined,
    }));

    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="artwork"; filename="${String(filename).replace(/"/g, "")}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    ));
    chunks.push(fileBuffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);
    const endpoint = new URL(telegramMethodUrl("editMessageMedia"));
    const transport = endpoint.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
      path: endpoint.pathname + endpoint.search,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    }, (resp) => {
      const parts = [];
      resp.on("data", chunk => parts.push(chunk));
      resp.on("end", () => {
        const raw = Buffer.concat(parts).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return reject(new Error(`Invalid Telegram response (${resp.statusCode}): ${raw}`));
        }
        if (!parsed.ok) {
          return reject(new Error(parsed.description || `Telegram editMessageMedia failed (${resp.statusCode})`));
        }
        resolve(parsed.result);
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function existingMessageMatchesSlot(beatgalerUserId, beatId, messageId, expectedKind) {
  const id = Number(messageId);
  if (!Number.isFinite(id) || id <= 0 || !expectedKind) return false;
  const kind = String(expectedKind).toLowerCase();
  for (const entry of uploadedFiles.values()) {
    if (String(entry.beatgalerUserId || "") !== String(beatgalerUserId || "")) continue;
    if (String(entry.beatId || "") !== String(beatId || "")) continue;
    if (Number(entry.telegramMessageId) !== id) continue;
    return String(entry.kind || "").toLowerCase() === kind;
  }
  return false;
}

async function sendOrReplaceTelegramDocument({
  account, beatgalerUserId, beatId, beatName,
  existingMessageId, filePath, filename, caption, replyToMessageId, expectedKind
}) {
  const chatId = storageChatId(account);
  let messageThreadId = await ensureBeatTopic(account, beatgalerUserId, beatId, beatName);
  const redirectedExisting = redirectMessageId(beatgalerUserId, existingMessageId);
  // Never trust a client-provided Telegram message id across logical slots.
  // A WAV must never edit the MASTER message, PROJECT must never edit WAV, etc.
  // If local SQLite is stale/corrupt, create the correct slot instead of
  // mutating a different Telegram document.
  const existing = existingMessageMatchesSlot(beatgalerUserId, beatId, redirectedExisting, expectedKind)
    ? redirectedExisting
    : null;

  if (Number.isFinite(existing) && existing > 0) {
    try {
      const sent = await withTelegramFloodWait(
        `edit ${expectedKind || "document"}`,
        () => editTelegramDocumentInPlace({
          chatId, messageId: existing, filePath, filename, caption
        }),
        { onWait: ({ retryAfter, attempt }) => console.warn(`[telegram] edit document rate limited; waiting ${retryAfter}s before retry ${attempt}.`) },
      );
      rememberMessageRedirect(beatgalerUserId, existingMessageId, sent.message_id);
      return { message: sent, updated: true, messageThreadId };
    } catch (error) {
      const message = String(error?.message || error);
      if (!/message (?:to edit )?not found|message_id_invalid/i.test(message)) throw error;
    }
  }

  const sendNewDocument = async (threadId) => {
    const options = { caption, message_thread_id: threadId };
    const reply = Number(replyToMessageId);
    if (Number.isFinite(reply) && reply > 0) options.reply_to_message_id = reply;
    return withTelegramFloodWait(
      `send ${expectedKind || "document"}`,
      () => bot.sendDocument(chatId, filePath, options, {
        filename, contentType: "application/octet-stream"
      }),
      { onWait: ({ retryAfter, attempt }) => console.warn(`[telegram] send document rate limited; waiting ${retryAfter}s before retry ${attempt}.`) },
    );
  };

  try {
    const sent = await sendNewDocument(messageThreadId);
    return { message: sent, updated: false, messageThreadId };
  } catch (error) {
    if (!isMissingTopicError(error)) throw error;

    // The user may have manually deleted the Topic while cloud-data.json still
    // remembers its old message_thread_id. Invalidate that cache, create a new
    // Topic for the SAME permanent beatId, and retry the upload once.
    console.warn(`[topics] recreating deleted topic for beat ${beatId}:`, error?.message || error);
    forgetBeatTopic(beatgalerUserId, beatId);
    messageThreadId = await ensureBeatTopic(account, beatgalerUserId, beatId, beatName);
    const sent = await sendNewDocument(messageThreadId);
    return { message: sent, updated: false, messageThreadId };
  }
}


const LIBRARY_INDEX_CAPTION = "BEATGALER_LIBRARY_INDEX_V1";
const LIBRARY_INDEX_BACKUP_POINTER_PREFIX = "BG_BACKUPS_V1="; // legacy reader only
const LIBRARY_INDEX_COW_PREFIX = "BG_COW_V1=";
const LIBRARY_INDEX_BACKUP_LIMIT = Math.max(1, Math.min(10, Number(process.env.INDEX_BACKUP_COUNT || 3)));
const LIBRARY_INDEX_CAPTION_MAX = 1000;

function validateLibraryManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Library index root must be a JSON object.");
  }
  if (manifest.schema !== "beatgaler.telegram.library") {
    throw new Error("Library index schema is invalid.");
  }
  if (!Array.isArray(manifest.beats)) {
    throw new Error("Library index beats must be an array.");
  }
  if (manifest.trash !== undefined && !Array.isArray(manifest.trash)) {
    throw new Error("Library index trash must be an array.");
  }
  if (manifest.garbage !== undefined && !Array.isArray(manifest.garbage)) {
    throw new Error("Library index garbage must be an array.");
  }
  return manifest;
}

function parseLibraryManifestBuffer(raw) {
  const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || ""));
  return validateLibraryManifest(parsed);
}

function parseLegacyLibraryBackupPointers(caption) {
  const line = String(caption || "").split(/\r?\n/)
    .find(value => value.startsWith(LIBRARY_INDEX_BACKUP_POINTER_PREFIX));
  if (!line) return [];
  try {
    const payload = JSON.parse(line.slice(LIBRARY_INDEX_BACKUP_POINTER_PREFIX.length));
    if (!Array.isArray(payload)) return [];
    return payload.map(item => ({
      f: String(item?.f || "").trim(),
      m: Number(item?.m || 0),
      t: Number(item?.t || 0),
    })).filter(item => Number.isInteger(item.m) && item.m > 0);
  } catch { return []; }
}

function parseCowBackupMessageIds(caption) {
  const line = String(caption || "").split(/\r?\n/)
    .find(value => value.startsWith(LIBRARY_INDEX_COW_PREFIX));
  if (!line) return [];
  try {
    const payload = JSON.parse(line.slice(LIBRARY_INDEX_COW_PREFIX.length));
    const ids = Array.isArray(payload) ? payload : payload?.backups;
    return [...new Set((Array.isArray(ids) ? ids : []).map(Number)
      .filter(id => Number.isInteger(id) && id > 0))]
      .slice(0, LIBRARY_INDEX_BACKUP_LIMIT);
  } catch { return []; }
}

function buildCowIndexCaption(backups) {
  let ids = [...new Set((backups || []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
    .slice(0, LIBRARY_INDEX_BACKUP_LIMIT);
  while (ids.length >= 0) {
    const caption = ids.length
      ? `${LIBRARY_INDEX_CAPTION}\n${LIBRARY_INDEX_COW_PREFIX}${JSON.stringify({ backups: ids })}`
      : LIBRARY_INDEX_CAPTION;
    if (caption.length <= LIBRARY_INDEX_CAPTION_MAX) return { caption, backups: ids };
    if (!ids.length) break;
    ids = ids.slice(0, -1);
  }
  return { caption: LIBRARY_INDEX_CAPTION, backups: [] };
}

function directMessageIdFromLocator(value) {
  const match = /^direct:(\d+)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function collectManifestMediaMessageIds(manifest) {
  const out = new Set();
  const add = value => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) out.add(n);
  };
  const addBeat = beat => {
    if (!beat || typeof beat !== "object") return;
    add(beat?.master?.telegram_message_id);
    add(beat?.artwork?.telegram_message_id);
    add(beat?.metadata_message_id);
    for (const file of beat?.files || []) {
      add(file?.telegram_message_id);
      for (const part of file?.parts || []) add(part?.telegram_message_id);
    }
    const project = beat?.project?.manifest || beat?.project;
    for (const part of project?.parts || []) add(part?.telegram_message_id);
  };
  for (const beat of manifest?.beats || []) addBeat(beat);
  for (const item of manifest?.trash || []) addBeat(item?.beat);
  return out;
}

function mergeCopyOnWriteGarbage(previousManifest, incomingManifest) {
  const previousGarbage = Array.isArray(previousManifest?.garbage) ? previousManifest.garbage : [];
  const currentRefs = collectManifestMediaMessageIds(incomingManifest);
  const previousRefs = collectManifestMediaMessageIds(previousManifest);
  const garbageById = new Map();
  for (const item of previousGarbage) {
    const id = Number(item?.message_id);
    if (Number.isInteger(id) && id > 0 && !currentRefs.has(id)) garbageById.set(id, item);
  }
  for (const id of previousRefs) {
    if (currentRefs.has(id)) continue;
    if (!garbageById.has(id)) {
      garbageById.set(id, {
        message_id: id,
        reason: "replaced_or_removed",
        marked_at: new Date().toISOString(),
      });
    }
  }
  incomingManifest.garbage = [...garbageById.values()];
}

function downloadTelegramFileBuffer(_fileId) {
  return Promise.reject(new Error(
    "Legacy Bot API file locators are disabled. 001BeatGaler is manager-only; migrate/re-upload this asset through Telegram Direct."
  ));
}


async function getPinnedLibraryIndex(account) {
  const pinned = await directTransport.getPinnedMessage(storageChatId(account));
  if (!pinned) return null;
  const caption = String(pinned.caption || pinned.text || "");
  if (!caption.startsWith(LIBRARY_INDEX_CAPTION) || !Number(pinned.message_id)) return null;
  return pinned;
}

async function downloadIndexMessage(account, message) {
  return directTransport.downloadMessageBuffer(storageChatId(account), Number(message?.message_id));
}

async function recoverLibraryIndexFromBackups(account, pinned) {
  const caption = String(pinned?.caption || pinned?.text || "");
  const cowIds = parseCowBackupMessageIds(caption);
  for (const id of cowIds) {
    try {
      const raw = await directTransport.downloadMessageBuffer(storageChatId(account), id);
      const manifest = parseLibraryManifestBuffer(raw);
      console.warn(`[library] pinned index invalid; recovered copy-on-write backup ${id}`);
      return manifest;
    } catch (error) {
      console.warn(`[library] COW backup ${id} unreadable:`, error?.message || error);
    }
  }

  // One-release migration compatibility with v0.3.9's old file_id backup caption.
  for (const pointer of parseLegacyLibraryBackupPointers(caption)) {
    try {
      const raw = await directTransport.downloadMessageBuffer(storageChatId(account), pointer.m);
      const manifest = parseLibraryManifestBuffer(raw);
      console.warn(`[library] recovered legacy backup ${pointer.m}`);
      return manifest;
    } catch (error) {
      console.warn(`[library] legacy backup ${pointer.m} unreadable:`, error?.message || error);
    }
  }
  return null;
}

// Telegram remains the durable root pointer, but index mutation is now always
// copy-on-write. MASTER sends a NEW JSON document, verifies it, pins it, then
// unpins the previous current index. Previous copies become bounded backups.
app.post("/library/upsert", upload.single("file"), (req, res) => {
  if (req.file) fs.unlink(req.file.path, () => {});
  return res.status(410).json({
    error: "Legacy server-side library index upload is disabled. BeatGaler Desktop must publish the current library through its active Galer Cloud session."
  });
});

app.get("/library/get", (_req, res) => {
  return res.status(410).json({
    error: "Legacy server-side library index download is disabled. BeatGaler Desktop must read the current library through its active Galer Cloud session."
  });
});

app.post("/library/cleanup-garbage", (_req, res) => {
  // Direct V4 has no durable garbage queue: replace_index pins the new index
  // first and then deletes media that disappeared from the old manifest.
  return res.json({ ok: true, deleted: 0, direct_single_index: true });
});

// Artwork hydration for a restored cloud-only library. This endpoint exists so
// a new install doesn't need any previous local cloud-data.json ownership map.
app.post("/library/artwork", async (req, res) => {
  const { beatgalerUserId, telegramFileId } = req.body || {};
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) return res.status(400).json({ error: "Cloud storage is not connected for this BeatGaler installation." });
  if (!telegramFileId) return res.status(400).json({ error: "Cloud artwork reference is required." });
  try {
    const raw = await downloadTelegramFileBuffer(telegramFileId);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(raw.length));
    res.end(raw);
  } catch (err) {
    console.error("Cloud artwork download failed:", err);
    res.status(500).json({ error: "Could not download Cloud artwork. Please retry." });
  }
});

// ── LIVE BeatGaler metadata stored in Telegram ─────────────────────────────
app.post("/metadata/artwork", upload.single("file"), async (req, res) => {
  const { beatgalerUserId, beatId, beatName, parentMessageId, artworkMessageId } = req.body || {};
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  const account = linkedAccounts.get(beatgalerUserId);

  if (!account) { cleanup(); return res.status(400).json({ error: "Cloud storage is not connected for this BeatGaler installation." }); }
  if (!beatId) { cleanup(); return res.status(400).json({ error: "beatId is required" }); }
  if (!req.file) return res.status(400).json({ error: "No artwork file was uploaded." });

  const ext = path.extname(req.file.originalname || "") || ".png";
  const filename = `beatgaler-artwork-${beatId}${ext}`;
  const caption = ` Artwork • ${beatName || beatId}`;
  const existing = redirectMessageId(beatgalerUserId, artworkMessageId);

  try {
    const artworkTopicId = await ensureBeatTopic(account, beatgalerUserId, beatId, beatName);
    const artworkChatId = storageChatId(account);
    let sent;
    let updated = false;

    if (Number.isFinite(existing) && existing > 0) {
      console.log(`[artwork] replacing message ${existing} for beat ${beatId}`);
      try {
        sent = await withTelegramFloodWait(
          "artwork replace",
          () => editTelegramDocumentInPlace({
            chatId: artworkChatId,
            messageId: existing,
            filePath: req.file.path,
            filename,
            caption,
          }),
          { onWait: ({ retryAfter, attempt }) => console.warn(`[telegram] artwork replace rate limited; waiting ${retryAfter}s before retry ${attempt}.`) },
        );
        updated = true;
      } catch (error) {
        const message = String(error?.message || error);
        if (!/message (?:to edit )?not found|message_id_invalid/i.test(message)) throw error;
      }
    }
    if (!sent) {
      const options = { caption, message_thread_id: artworkTopicId };
      const parent = Number(parentMessageId);
      if (Number.isFinite(parent) && parent > 0) options.reply_to_message_id = parent;

      sent = await withTelegramFloodWait(
        "artwork send",
        () => bot.sendDocument(
          artworkChatId,
          req.file.path,
          options,
          { filename, contentType: "application/octet-stream" }
        ),
        { onWait: ({ retryAfter, attempt }) => console.warn(`[telegram] artwork send rate limited; waiting ${retryAfter}s before retry ${attempt}.`) },
      );
    }

    const media = sent?.document || (Array.isArray(sent?.photo) ? sent.photo[sent.photo.length - 1] : null);
    if (!media?.file_id) throw new Error("Telegram returned no artwork file_id");

    // A replaced Telegram document gets a new file_id but keeps the same
    // message_id. Remove stale ownership records for the same artwork message.
    const messageId = sent.message_id || existing;
    for (const [fileId, entry] of uploadedFiles) {
      if (entry.beatgalerUserId === beatgalerUserId && entry.telegramMessageId === messageId) {
        uploadedFiles.delete(fileId);
      }
    }
    uploadedFiles.set(media.file_id, {
      beatgalerUserId,
      telegramMessageId: messageId,
      filename,
      createdAt: Date.now(),
    });
    savePersistentData();
    cleanup();
    res.json({
      telegram_file_id: media.file_id,
      telegram_message_id: messageId,
      updated,
    });
  } catch (err) {
    cleanup();
    // Do NOT silently send a second artwork message when an edit fails. That
    // would bring back the duplicate-message problem this endpoint prevents.
    console.error("Cloud artwork update failed:", err);
    res.status(500).json({ error: "Cloud artwork update failed. Please retry." });
  }
});

app.post("/metadata/upsert", async (req, res) => {
  const { beatgalerUserId, beatId, parentMessageId, metadataMessageId, metadata } = req.body || {};
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) return res.status(400).json({ error: "Cloud storage is not connected for this BeatGaler installation." });
  if (!beatId || !metadata) return res.status(400).json({ error: "beatId and metadata are required" });

  const text = `BEATGALER_METADATA_V1\n${JSON.stringify(metadata)}`;
  if (text.length > 3900) {
    return res.status(400).json({ error: "Beat metadata is too large for cloud storage." });
  }

  const existing = redirectMessageId(beatgalerUserId, metadataMessageId);
  try {
    const metadataTopicId = await ensureBeatTopic(
      account, beatgalerUserId, beatId, metadata?.name || metadata?.beat_name || beatId
    );
    const metadataChatId = storageChatId(account);
    if (Number.isFinite(existing) && existing > 0) {
      try {
        await withTelegramFloodWait(
          "metadata edit",
          () => bot.editMessageText(text, { chat_id: metadataChatId, message_id: existing }),
          { onWait: ({ retryAfter, attempt }) => console.warn(`[telegram] metadata edit rate limited; waiting ${retryAfter}s before retry ${attempt}.`) },
        );
        return res.json({ telegram_metadata_message_id: existing, updated: true });
      } catch (editErr) {
        const message = String(editErr?.message || editErr);
        if (!/message (?:to edit )?not found|message_id_invalid/i.test(message)) throw editErr;
      }
    }

    const opts = { message_thread_id: metadataTopicId };
    const parent = Number(parentMessageId);
    if (Number.isFinite(parent) && parent > 0) opts.reply_to_message_id = parent;
    const sent = await withTelegramFloodWait(
      "metadata message",
      () => bot.sendMessage(metadataChatId, text, opts),
      { onWait: ({ retryAfter, attempt }) => console.warn(`[telegram] metadata rate limited; waiting ${retryAfter}s before retry ${attempt}.`) },
    );
    res.json({ telegram_metadata_message_id: sent.message_id, updated: false });
  } catch (err) {
    console.error("Cloud metadata sync failed:", err);
    res.status(500).json({ error: "Cloud metadata sync failed. Please retry." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BeatGaler Cloud API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`LAN para Mac: http://192.168.86.98:${PORT}`);
  console.log(`Transport: Telegram Direct MTProto (MASTER + managed bot pool)`);
});

// ── Fase 17: primer upload (solo el MP3/WAV principal) ──
// El archivo se envía como documento (no audio comprimido) al chat privado
// del usuario con el bot, para no perder calidad ni metadata.
app.post("/beats/upload", upload.single("file"), async (req, res) => {
  const requestId = req.beatgalerRequestId || "unknown";
  const { beatgalerUserId, beatId, beatName, existingMessageId } = req.body || {};
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };

  console.log(
    `[upload ${requestId}] MASTER parsed ` +
    `beat=${JSON.stringify(beatName || "")} ` +
    `file=${req.file ? JSON.stringify(req.file.originalname) : "NONE"} ` +
    `bytes=${req.file?.size ?? 0} ` +
    `client=${String(beatgalerUserId || "").slice(0, 10) || "missing"}`
  );
  if (!beatgalerUserId || !beatId) { cleanup(); return res.status(400).json({ error: "beatgalerUserId and beatId are required" }); }
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) { cleanup(); return res.status(400).json({ error: "Cloud storage is not connected for this BeatGaler installation." }); }
  if (!req.file) return res.status(400).json({ error: "No file was uploaded." });
  const originalName = req.file.originalname || beatName || "beat.mp3";
  const extension = path.extname(originalName) || ".mp3";
  const telegramFilename = `${beatName || path.basename(originalName, extension)}${extension}`;
  try {
    const { message: sentMessage, updated, messageThreadId } = await sendOrReplaceTelegramDocument({ account, beatgalerUserId, beatId, beatName, existingMessageId, filePath: req.file.path, filename: telegramFilename, caption: beatName ? ` ${beatName}` : undefined, expectedKind: "master" });
    const media = sentMessage?.document || sentMessage?.audio || null;
    if (!media?.file_id) throw new Error("Telegram returned no file_id for MASTER.");
    const messageId = sentMessage.message_id || Number(existingMessageId) || null;
    for (const [fileId, entry] of uploadedFiles) {
      if (String(entry.telegramUserId || "") === String(account.telegramUserId) && entry.telegramMessageId === messageId) uploadedFiles.delete(fileId);
    }
    uploadedFiles.set(media.file_id, { beatgalerUserId, telegramUserId: account.telegramUserId, telegramMessageId: messageId, filename: telegramFilename, kind: "master", beatId, topicId: messageThreadId, createdAt: Date.now() });
    savePersistentData();
    console.log(`[upload ${requestId}] MASTER Telegram success message=${messageId} updated=${!!updated}`);
    res.json({ telegram_file_id: media.file_id, telegram_message_id: messageId, updated });
  } catch (err) {
    console.error(`[upload ${requestId}] MASTER Telegram failure:`, err?.message || err);
    console.error("Cloud MASTER upload failed:", err);
    res.status(500).json({ error: "Cloud MASTER upload failed. Please retry." });
  } finally { cleanup(); }
});


// ── Project ZIP upload — exactly ONE Telegram document (Local Bot API) ──
async function sendProjectPart(account, sourcePath, telegramFilename, caption, replyToMessageId) {
  const options = { caption };
  if (replyToMessageId) options.reply_to_message_id = Number(replyToMessageId);

  const sentMessage = await bot.sendDocument(
    account.telegramUserId,
    sourcePath,
    options,
    { filename: telegramFilename, contentType: "application/octet-stream" }
  );

  const media = sentMessage?.document || sentMessage?.audio || null;
  if (!media?.file_id) throw new Error("Telegram accepted a project part but did not return file_id.");
  return { fileId: media.file_id, messageId: sentMessage.message_id ?? null };
}

app.post("/projects/upload", upload.single("file"), async (req, res) => {
  const { beatgalerUserId, beatId, beatName, parentMessageId, existingMessageId } = req.body || {};
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  if (!beatgalerUserId || !beatId) { cleanup(); return res.status(400).json({ error: "beatgalerUserId and beatId are required" }); }
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) { cleanup(); return res.status(400).json({ error: "Cloud storage is not connected for this BeatGaler installation." }); }
  if (!req.file) return res.status(400).json({ error: "No project ZIP was uploaded." });
  const originalName = `${beatName || path.basename(req.file.originalname || "project", ".zip")}.zip`;
  const stat = fs.statSync(req.file.path);

  if (stat.size > TELEGRAM_MAX_UPLOAD_BYTES) {
    cleanup();
    return res.status(413).json({
      error: `PROJECT_TOO_LARGE:${stat.size}:${originalName} exceeds BeatGaler's single-file cloud limit of 2000 MB.`,
    });
  }

  try {
    const { message: sent, updated } = await sendOrReplaceTelegramDocument({ account, beatgalerUserId, beatId, beatName, existingMessageId, filePath: req.file.path, filename: originalName, caption: ` ${beatName || "Project"}`, replyToMessageId: parentMessageId, expectedKind: "project" });
    const media = sent?.document || null;
    if (!media?.file_id) throw new Error("Telegram returned no file_id for PROJECT.");
    const messageId = sent.message_id || Number(existingMessageId) || null;
    for (const [fileId, entry] of uploadedFiles) {
      if (String(entry.telegramUserId || "") === String(account.telegramUserId) && entry.telegramMessageId === messageId) uploadedFiles.delete(fileId);
    }
    uploadedFiles.set(media.file_id, { beatgalerUserId, telegramUserId: account.telegramUserId, telegramMessageId: messageId, filename: originalName, kind: "project", beatId, partIndex: 0, totalParts: 1, originalName, createdAt: Date.now() });
    savePersistentData();
    res.json({ ok: true, updated, original_name: originalName, original_size: stat.size, parts: [{ telegram_file_id: media.file_id, telegram_message_id: messageId, index: 0, size: stat.size, filename: originalName }] });
  } catch (err) { console.error("Cloud PROJECT upload failed:", err); res.status(500).json({ error: "Cloud PROJECT upload failed. Please retry." }); }
  finally { cleanup(); }
});


// ── Generic beat cloud file upload — one Telegram document per slot ─────
const CLOUD_ROLE_META = {
  WAV:     { icon: "", label: "WAV HQ" },
  LOOP:    { icon: "", label: "Loop" },
  PROJECT: { icon: "", label: "Project" },
  STEMS:   { icon: "", label: "Stems" },
  OTHER:   { icon: "", label: "Other" },
};

async function sendCloudPart(account, sourcePath, telegramFilename, caption, replyToMessageId) {
  const options = { caption };
  if (replyToMessageId) options.reply_to_message_id = Number(replyToMessageId);

  const sentMessage = await bot.sendDocument(
    account.telegramUserId,
    sourcePath,
    options,
    { filename: telegramFilename, contentType: "application/octet-stream" }
  );
  const media = sentMessage?.document || sentMessage?.audio || sentMessage?.voice || null;
  if (!media?.file_id) throw new Error("Telegram accepted the file but did not return file_id.");
  return { fileId: media.file_id, messageId: sentMessage.message_id ?? null };
}

app.post("/cloud-files/upload", upload.single("file"), async (req, res) => {
  const { beatgalerUserId, beatId, beatName, fileType, parentMessageId, existingMessageId } = req.body || {};
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  if (!beatgalerUserId || !beatId || !fileType) { cleanup(); return res.status(400).json({ error: "beatgalerUserId, beatId and fileType are required" }); }
  const normalizedType = String(fileType).toUpperCase();
  const roleMeta = CLOUD_ROLE_META[normalizedType];
  if (!roleMeta) { cleanup(); return res.status(400).json({ error: `Unsupported cloud file type: ${fileType}` }); }
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) { cleanup(); return res.status(400).json({ error: "Cloud storage is not connected for this BeatGaler installation." }); }
  if (!req.file) return res.status(400).json({ error: "No file was uploaded." });
  const uploadedOriginalName = req.file.originalname || "file";
  const originalName = normalizedType === "PROJECT"
    ? `${beatName || path.basename(uploadedOriginalName, path.extname(uploadedOriginalName))}.zip`
    : uploadedOriginalName;
  const stat = fs.statSync(req.file.path);
  if (stat.size > TELEGRAM_MAX_UPLOAD_BYTES) {
    cleanup();
    return res.status(413).json({
      error: `FILE_TOO_LARGE:${stat.size}:${originalName} exceeds BeatGaler's single-file cloud limit of 2000 MB.`,
    });
  }
  try {
    const { message: sent, updated } = await sendOrReplaceTelegramDocument({ account, beatgalerUserId, beatId, beatName, existingMessageId, filePath: req.file.path, filename: originalName, caption: `${roleMeta.icon} ${beatName || "Beat"} — ${roleMeta.label}`, replyToMessageId: parentMessageId, expectedKind: normalizedType.toLowerCase() });
    const media = sent?.document || sent?.audio || null;
    if (!media?.file_id) throw new Error(`Telegram returned no file_id for ${normalizedType}.`);
    const messageId = sent.message_id || Number(existingMessageId) || null;
    for (const [fileId, entry] of uploadedFiles) {
      if (String(entry.telegramUserId || "") === String(account.telegramUserId) && entry.telegramMessageId === messageId) uploadedFiles.delete(fileId);
    }
    uploadedFiles.set(media.file_id, { beatgalerUserId, telegramUserId: account.telegramUserId, telegramMessageId: messageId, filename: originalName, kind: normalizedType.toLowerCase(), beatId, partIndex: 0, totalParts: 1, originalName, createdAt: Date.now() });
    savePersistentData();
    res.json({ ok: true, updated, file_type: normalizedType, original_name: originalName, original_size: stat.size, parts: [{ telegram_file_id: media.file_id, telegram_message_id: messageId, index: 0, size: stat.size, filename: originalName }] });
  } catch (err) { console.error(`Cloud ${normalizedType.toLowerCase()} upload failed:`, err); res.status(500).json({ error: `Cloud ${normalizedType.toLowerCase()} upload failed. Please retry.` }); }
  finally { cleanup(); }
});

// Reconcile reversible Trash moves created while Desktop was offline.
// The desktop sends ONLY beat ids, never a stale full manifest. We read the
// current Telegram source of truth here and move its newest beat object into
// Trash. That preserves edits made by another online client while this device
// was disconnected.
app.post("/library/move-to-trash-batch", (_req, res) => {
  return res.status(410).json({
    error: "Offline Trash reconciliation moved to the active Galer Cloud session."
  });
});

// Batch permanent delete// Batch permanent delete for Settings -> Empty beat trash.
//
// Logical deletion is committed first (one Telegram index rewrite), then the
// expensive forum-topic deletion continues from the persisted
// `pendingTopicDeletes` queue after the response. The desktop can therefore
// keep working while Telegram performs physical cleanup. Failed topic deletes
// stay queued in cloud-data.json and are retried on later library activity.
app.post("/beats/delete-topics-batch", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const beatgalerUserId = auth.beatgalerUserId;
  const account = auth.account;
  const uniqueBeatIds = [...new Set(
    (Array.isArray(req.body?.beatIds) ? req.body.beatIds : [])
      .map(value => String(value || "").trim())
      .filter(Boolean)
  )];
  if (uniqueBeatIds.length === 0) {
    return res.status(400).json({ error: "At least one beatId is required." });
  }

  // IMPORTANT: the Desktop transport bot already removed these rows from the
  // single pinned index. MASTER only owns the administrative Topic cleanup.
  for (const beatId of uniqueBeatIds) {
    const current = beatTopics.get(topicKey(beatgalerUserId, beatId));
    const topicId = Number(current?.messageThreadId);
    if (Number.isFinite(topicId) && topicId > 0) {
      pendingTopicDeletes.set(topicKey(beatgalerUserId, beatId), {
        beatId,
        telegramTopicId: topicId,
        queuedAt: Date.now(),
      });
    } else {
      beatTopics.delete(topicKey(beatgalerUserId, beatId));
      for (const [fileId, entry] of uploadedFiles) {
        if (entry?.beatgalerUserId === beatgalerUserId && String(entry?.beatId || "") === beatId) {
          uploadedFiles.delete(fileId);
        }
      }
    }
  }
  savePersistentData();

  res.json({
    ok: true,
    requested: uniqueBeatIds.length,
    deleted: uniqueBeatIds.length,
    deleted_beat_ids: uniqueBeatIds,
    failed: [],
    index_updated: false,
    index_owner: "desktop-transport-bot",
    cleanup_background: true,
    cleanup_queued: [...pendingTopicDeletes.keys()]
      .filter(key => key.startsWith(`${String(beatgalerUserId)}:`)).length,
  });
  schedulePendingTopicDeletes(account, beatgalerUserId, "background");
});

app.post("/beats/delete-topic", async (req, res) => {
  const auth = authenticatedTransportAccount(req, res);
  if (!auth) return;
  const beatgalerUserId = auth.beatgalerUserId;
  const account = auth.account;
  const beatId = String(req.body?.beatId || "").trim();
  const telegramTopicId = Number(req.body?.telegramTopicId || 0) || undefined;
  if (!beatId) return res.status(400).json({ error: "beatId is required." });
  try {
    // Index/media cleanup is Direct and must happen on Desktop before this
    // administrative Topic cleanup request.
    const deleteResult = await deleteBeatTopic(account, beatgalerUserId, beatId, telegramTopicId);
    res.json({ ok: true, ...deleteResult, index_updated: false, index_owner: "desktop-transport-bot" });
  } catch (error) {
    res.status(500).json({ error: `Could not permanently delete beat storage data: ${error?.message || error}` });
  }
});

function findTelegramFileInManifest(manifest, telegramFileId) {
  const wanted = String(telegramFileId || "");
  if (!manifest || !wanted) return null;

  const inspectBeat = (beat) => {
    if (!beat || typeof beat !== "object") return null;
    if (String(beat.master?.telegram_file_id || "") === wanted) {
      return { beatId: beat.id || null, kind: "master", filename: beat.master?.filename || `${beat.name || "beat"}.mp3` };
    }
    const artworkId = String(beat.artwork?.telegram_file_id || "");
    if (artworkId === wanted) {
      return { beatId: beat.id || null, kind: "artwork", filename: `artwork-${beat.id || "beat"}` };
    }
    for (const file of Array.isArray(beat.files) ? beat.files : []) {
      const parts = Array.isArray(file?.manifest?.parts) ? file.manifest.parts : [];
      if (parts.some(part => String(part?.telegram_file_id || "") === wanted)) {
        return { beatId: beat.id || null, kind: String(file.type || "other").toLowerCase(), filename: file.filename || "file" };
      }
    }
    const projectParts = Array.isArray(beat.project?.manifest?.parts) ? beat.project.manifest.parts : [];
    if (projectParts.some(part => String(part?.telegram_file_id || "") === wanted)) {
      return { beatId: beat.id || null, kind: "project", filename: `${beat.name || "project"}.zip` };
    }
    return null;
  };

  for (const beat of Array.isArray(manifest.beats) ? manifest.beats : []) {
    const found = inspectBeat(beat);
    if (found) return found;
  }
  for (const item of Array.isArray(manifest.trash) ? manifest.trash : []) {
    const found = inspectBeat(item?.beat);
    if (found) return found;
  }
  return null;
}

async function verifyTelegramFileOwnershipFromIndex(account, beatgalerUserId, telegramFileId) {
  const manifest = await readLibraryManifestFromChat(storageChatId(account));
  const found = findTelegramFileInManifest(manifest, telegramFileId);
  if (!found) return null;
  const recovered = {
    beatgalerUserId,
    telegramUserId: account.telegramUserId,
    telegramMessageId: null,
    filename: found.filename,
    kind: found.kind,
    beatId: found.beatId,
    createdAt: Date.now(),
  };
  uploadedFiles.set(telegramFileId, recovered);
  savePersistentData();
  return recovered;
}

// Progressive MASTER playback. HTML5 Audio uses GET + Range requests; keep
// ownership validation identical to /beats/download, but serve byte ranges so
// playback and seek do not wait for the full MP3.
app.get("/beats/stream", async (_req, res) => {
  return res.status(410).json({
    error: "Legacy cloud streaming is disabled for this beat. Refresh or migrate the library entry."
  });
});

// ── Fase 18: download del MP3/WAV principal ──
// BeatGaler manda su user id + el file_id guardado en SQLite. El backend
// verifica que ese file_id pertenece a ese usuario y luego hace streaming
// directo desde Telegram hacia la app; el token del bot nunca sale del server.
app.post("/beats/download", async (_req, res) => {
  return res.status(410).json({
    error: "Legacy cloud downloads are disabled for this beat. Refresh or migrate the library entry."
  });
});

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
