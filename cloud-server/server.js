// BeatGaler Cloud — backend local de prueba (Fase 5-9 del plan)
//
// Este servidor es el ÚNICO lugar donde vive el token del bot de Telegram.
// BeatGaler (la app de escritorio) nunca lo ve — solo habla HTTPS con este
// servidor, y este servidor habla con la Telegram Bot API.
//
// Cómo correrlo:
//   1. cd cloud-server
//   2. cp .env.example .env   y pega tu TELEGRAM_BOT_TOKEN
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
const multer = require("multer");
const TelegramBot = require("node-telegram-bot-api");

const PORT = process.env.PORT || 4000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME; // sin @, ej: BeatGalerBot
const TELEGRAM_BOT_API_BASE = String(
  process.env.TELEGRAM_BOT_API_BASE || "http://127.0.0.1:8081"
).replace(/\/$/, "");
const TELEGRAM_BOT_API_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(TELEGRAM_BOT_API_BASE);
const TELEGRAM_MAX_UPLOAD_BYTES = 2000 * 1024 * 1024;


if (!BOT_TOKEN) {
  console.error("Falta TELEGRAM_BOT_TOKEN en .env — crea el bot con @BotFather primero.");
  process.exit(1);
}
if (!BOT_USERNAME) {
  console.error("Falta TELEGRAM_BOT_USERNAME en .env (el username del bot, sin @).");
  process.exit(1);
}

const app = express();
app.use(express.json());
const upload = multer({ dest: "uploads-tmp/" });
const DATA_FILE = path.join(__dirname, "cloud-data.json");

function telegramMethodUrl(method) {
  return `${TELEGRAM_BOT_API_BASE}/bot${BOT_TOKEN}/${method}`;
}

function localTelegramPath(filePath) {
  if (!filePath) return null;
  const value = String(filePath);
  if (path.isAbsolute(value)) return value;
  return null;
}


// ── Fase 6: almacenamiento temporal de connect_token ──
// token -> { beatgalerUserId, createdAt, expiresAt, used }
const pendingConnections = new Map();

// ── Fase 8/10: cuentas ya vinculadas ──
// beatgalerUserId -> { telegramUserId, telegramUsername, connectedAt }
const linkedAccounts = new Map();

// telegram_file_id -> { beatgalerUserId, telegramMessageId, filename, createdAt }
// Esto evita que un usuario descargue un file_id que no le pertenece.
const uploadedFiles = new Map();

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

app.get("/events", (req, res) => {
  const beatgalerUserId = String(req.query.beatgalerUserId || "");
  const sourceId = String(req.query.sourceId || "");
  if (!beatgalerUserId) {
    return res.status(400).json({ error: "beatgalerUserId is required" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
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
  } catch (err) {
    console.error("No se pudo leer cloud-data.json:", err.message || err);
  }
}

function savePersistentData() {
  const tmp = `${DATA_FILE}.tmp`;
  const payload = JSON.stringify({
    linkedAccounts: Object.fromEntries(linkedAccounts),
    uploadedFiles: Object.fromEntries(uploadedFiles),
  }, null, 2);
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

loadPersistentData();

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

// ── Fase 6/7: BeatGaler pide iniciar la conexión ──
app.post("/telegram/connect/start", (req, res) => {
  cleanupExpired();

  const { beatgalerUserId } = req.body || {};
  if (!beatgalerUserId || typeof beatgalerUserId !== "string") {
    return res.status(400).json({ error: "beatgalerUserId is required" });
  }

  const token = generateToken();
  const now = Date.now();
  pendingConnections.set(token, {
    beatgalerUserId,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
    used: false,
  });

  const deepLink = `https://t.me/${BOT_USERNAME}?start=${token}`;

  res.json({
    connect_token: token,
    telegram_url: deepLink,
    expires_at: now + TOKEN_TTL_MS,
  });
});

// ── Fase 9: BeatGaler pregunta cada pocos segundos si ya se conectó ──
app.get("/telegram/connect/status", (req, res) => {
  const { beatgalerUserId } = req.query;
  if (!beatgalerUserId) {
    return res.status(400).json({ error: "beatgalerUserId is required" });
  }

  const account = linkedAccounts.get(beatgalerUserId);
  if (account) {
    return res.json({
      connected: true,
      telegram_username: account.telegramUsername,
      telegram_user_id: String(account.telegramUserId),
      connected_at: account.connectedAt,
    });
  }

  res.json({ connected: false });
});

// ── Fase 11 (paso 12/13): desconectar ──
app.post("/telegram/disconnect", (req, res) => {
  const { beatgalerUserId } = req.body || {};
  if (!beatgalerUserId) {
    return res.status(400).json({ error: "beatgalerUserId is required" });
  }
  linkedAccounts.delete(beatgalerUserId);
  savePersistentData();
  res.json({ ok: true });
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

async function sendOrReplaceTelegramDocument({ account, existingMessageId, filePath, filename, caption, replyToMessageId }) {
  const existing = Number(existingMessageId);
  if (Number.isFinite(existing) && existing > 0) {
    const sent = await editTelegramDocumentInPlace({ chatId: account.telegramUserId, messageId: existing, filePath, filename, caption });
    return { message: sent, updated: true };
  }
  const options = { caption };
  const reply = Number(replyToMessageId);
  if (Number.isFinite(reply) && reply > 0) options.reply_to_message_id = reply;
  const sent = await bot.sendDocument(account.telegramUserId, filePath, options, { filename, contentType: "application/octet-stream" });
  return { message: sent, updated: false };
}


const LIBRARY_INDEX_CAPTION = "BEATGALER_LIBRARY_INDEX_V1";

function downloadTelegramFileBuffer(fileId) {
  return bot.getFile(fileId).then(info => {
    if (!info?.file_path) throw new Error("Telegram returned no file_path");

    const localPath = localTelegramPath(info.file_path);
    if (localPath) {
      return fs.promises.readFile(localPath);
    }

    // Fallback only for a non-local Bot API endpoint.
    return new Promise((resolve, reject) => {
      const fileUrl = `${TELEGRAM_BOT_API_BASE}/file/bot${BOT_TOKEN}/${info.file_path}`;
      const endpoint = new URL(fileUrl);
      const transport = endpoint.protocol === "https:" ? https : http;
      const req = transport.get(endpoint, resp => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          resp.resume();
          return reject(new Error(`Telegram file download failed (${resp.statusCode})`));
        }
        const chunks = [];
        resp.on("data", chunk => chunks.push(chunk));
        resp.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", reject);
    });
  });
}

async function getPinnedLibraryIndex(account) {
  const chat = await bot.getChat(account.telegramUserId);
  const pinned = chat?.pinned_message;
  if (!pinned) return null;
  const caption = String(pinned.caption || pinned.text || "");
  if (!caption.startsWith(LIBRARY_INDEX_CAPTION) || !pinned.document?.file_id) return null;
  return pinned;
}

// Telegram itself is the durable root pointer for the whole BeatGaler library.
// We keep ONE JSON document pinned in the user's private chat with the bot.
// A new BeatGaler install can discover it with getChat() after /start linking.
app.post("/library/upsert", upload.single("file"), async (req, res) => {
  const { beatgalerUserId, sourceId } = req.body || {};
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) { cleanup(); return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." }); }
  if (!req.file) return res.status(400).json({ error: "Library manifest file is required." });

  try {
    const existing = await getPinnedLibraryIndex(account);
    let sent;
    let updated = false;
    const filename = "beatgaler-library.json";

    if (existing) {
      console.log(`[library] replacing pinned index message ${existing.message_id}`);
      sent = await editTelegramDocumentInPlace({
        chatId: account.telegramUserId,
        messageId: existing.message_id,
        filePath: req.file.path,
        filename,
        caption: LIBRARY_INDEX_CAPTION,
      });
      updated = true;
    } else {
      console.log("[library] creating pinned Telegram library index");
      sent = await bot.sendDocument(
        account.telegramUserId,
        req.file.path,
        { caption: LIBRARY_INDEX_CAPTION },
        { filename, contentType: "application/json" }
      );
      await bot.pinChatMessage(account.telegramUserId, sent.message_id, { disable_notification: true });
    }

    const document = sent?.document;
    if (!document?.file_id) throw new Error("Telegram returned no library index file_id");
    cleanup();
    const libraryMessageId = sent.message_id || existing?.message_id;
    broadcastCloudEvent(
      beatgalerUserId,
      "library_changed",
      { telegram_message_id: libraryMessageId, updated },
      sourceId || ""
    );
    res.json({
      telegram_file_id: document.file_id,
      telegram_message_id: libraryMessageId,
      updated,
    });
  } catch (err) {
    cleanup();
    res.status(500).json({ error: `Telegram library index sync failed: ${err.message || err}` });
  }
});

app.get("/library/get", async (req, res) => {
  const { beatgalerUserId } = req.query || {};
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." });

  try {
    const pinned = await getPinnedLibraryIndex(account);
    if (!pinned) return res.status(404).json({ error: "No BeatGaler Telegram library index is pinned yet." });
    const raw = await downloadTelegramFileBuffer(pinned.document.file_id);
    const parsed = JSON.parse(raw.toString("utf8"));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: `Could not restore Telegram library index: ${err.message || err}` });
  }
});

// Artwork hydration for a restored cloud-only library. This endpoint exists so
// a new install doesn't need any previous local cloud-data.json ownership map.
app.post("/library/artwork", async (req, res) => {
  const { beatgalerUserId, telegramFileId } = req.body || {};
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." });
  if (!telegramFileId) return res.status(400).json({ error: "telegramFileId is required" });
  try {
    const raw = await downloadTelegramFileBuffer(telegramFileId);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(raw.length));
    res.end(raw);
  } catch (err) {
    res.status(500).json({ error: `Could not download Telegram artwork: ${err.message || err}` });
  }
});

// ── LIVE BeatGaler metadata stored in Telegram ─────────────────────────────
app.post("/metadata/artwork", upload.single("file"), async (req, res) => {
  const { beatgalerUserId, beatId, beatName, parentMessageId, artworkMessageId } = req.body || {};
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  const account = linkedAccounts.get(beatgalerUserId);

  if (!account) { cleanup(); return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." }); }
  if (!beatId) { cleanup(); return res.status(400).json({ error: "beatId is required" }); }
  if (!req.file) return res.status(400).json({ error: "No artwork file was uploaded." });

  const ext = path.extname(req.file.originalname || "") || ".png";
  const filename = `beatgaler-artwork-${beatId}${ext}`;
  const caption = `🖼 Artwork • ${beatName || beatId}`;
  const existing = Number(artworkMessageId);

  try {
    let sent;
    let updated = false;

    if (Number.isFinite(existing) && existing > 0) {
      console.log(`[artwork] replacing message ${existing} for beat ${beatId}`);
      sent = await editTelegramDocumentInPlace({
        chatId: account.telegramUserId,
        messageId: existing,
        filePath: req.file.path,
        filename,
        caption,
      });
      updated = true;
      console.log(
        `[artwork] replaced message ${existing}; new file_id=${sent?.document?.file_id || "missing"}`
      );
    } else {
      console.log(`[artwork] creating first artwork message for beat ${beatId}`);
      const options = { caption };
      const parent = Number(parentMessageId);
      if (Number.isFinite(parent) && parent > 0) options.reply_to_message_id = parent;

      sent = await bot.sendDocument(
        account.telegramUserId,
        req.file.path,
        options,
        { filename, contentType: "application/octet-stream" }
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
    res.status(500).json({ error: `Telegram artwork update failed: ${err.message || err}` });
  }
});

app.post("/metadata/upsert", async (req, res) => {
  const { beatgalerUserId, beatId, parentMessageId, metadataMessageId, metadata } = req.body || {};
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." });
  if (!beatId || !metadata) return res.status(400).json({ error: "beatId and metadata are required" });

  const text = `BEATGALER_METADATA_V1\n${JSON.stringify(metadata)}`;
  if (text.length > 3900) {
    return res.status(400).json({ error: "Beat metadata is too large for a Telegram metadata message." });
  }

  const existing = Number(metadataMessageId);
  try {
    if (Number.isFinite(existing) && existing > 0) {
      try {
        await bot.editMessageText(text, { chat_id: account.telegramUserId, message_id: existing });
        return res.json({ telegram_metadata_message_id: existing, updated: true });
      } catch (editErr) {
        console.warn("Could not edit metadata message; creating a replacement:", editErr.message || editErr);
      }
    }

    const opts = {};
    const parent = Number(parentMessageId);
    if (Number.isFinite(parent) && parent > 0) opts.reply_to_message_id = parent;
    const sent = await bot.sendMessage(account.telegramUserId, text, opts);
    res.json({ telegram_metadata_message_id: sent.message_id, updated: false });
  } catch (err) {
    res.status(500).json({ error: `Telegram metadata sync failed: ${err.message || err}` });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BeatGaler Cloud API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`LAN para Mac: http://192.168.86.98:${PORT}`);
  console.log(`Telegram Bot API: ${TELEGRAM_BOT_API_BASE}${TELEGRAM_BOT_API_LOCAL ? " (LOCAL MODE expected)" : ""}`);
});

// ── Fase 17: primer upload (solo el MP3/WAV principal) ──
// El archivo se envía como documento (no audio comprimido) al chat privado
// del usuario con el bot, para no perder calidad ni metadata.
app.post("/beats/upload", upload.single("file"), async (req, res) => {
  const { beatgalerUserId, beatName, existingMessageId } = req.body || {};
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  if (!beatgalerUserId) { cleanup(); return res.status(400).json({ error: "beatgalerUserId is required" }); }
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) { cleanup(); return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." }); }
  if (!req.file) return res.status(400).json({ error: "No file was uploaded." });
  const originalName = req.file.originalname || beatName || "beat.mp3";
  const extension = path.extname(originalName) || ".mp3";
  const telegramFilename = `${beatName || path.basename(originalName, extension)}${extension}`;
  try {
    const { message: sentMessage, updated } = await sendOrReplaceTelegramDocument({ account, existingMessageId, filePath: req.file.path, filename: telegramFilename, caption: beatName ? `🎵 ${beatName}` : undefined });
    const media = sentMessage?.document || sentMessage?.audio || null;
    if (!media?.file_id) throw new Error("Telegram returned no file_id for MASTER.");
    const messageId = sentMessage.message_id || Number(existingMessageId) || null;
    for (const [fileId, entry] of uploadedFiles) {
      if (String(entry.telegramUserId || "") === String(account.telegramUserId) && entry.telegramMessageId === messageId) uploadedFiles.delete(fileId);
    }
    uploadedFiles.set(media.file_id, { beatgalerUserId, telegramUserId: account.telegramUserId, telegramMessageId: messageId, filename: telegramFilename, kind: "master", createdAt: Date.now() });
    savePersistentData();
    res.json({ telegram_file_id: media.file_id, telegram_message_id: messageId, updated });
  } catch (err) { res.status(500).json({ error: `Telegram MASTER upload failed: ${err.message || err}` }); }
  finally { cleanup(); }
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
  if (!account) { cleanup(); return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." }); }
  if (!req.file) return res.status(400).json({ error: "No project ZIP was uploaded." });
  const originalName = `${beatName || path.basename(req.file.originalname || "project", ".zip")}.zip`;
  const stat = fs.statSync(req.file.path);

  if (stat.size > TELEGRAM_MAX_UPLOAD_BYTES) {
    cleanup();
    return res.status(413).json({
      error: `PROJECT_TOO_LARGE:${stat.size}:${originalName} exceeds BeatGaler's single-file Telegram limit of 2000 MB.`,
    });
  }

  try {
    const { message: sent, updated } = await sendOrReplaceTelegramDocument({ account, existingMessageId, filePath: req.file.path, filename: originalName, caption: `📦 ${beatName || "Project"}`, replyToMessageId: parentMessageId });
    const media = sent?.document || null;
    if (!media?.file_id) throw new Error("Telegram returned no file_id for PROJECT.");
    const messageId = sent.message_id || Number(existingMessageId) || null;
    for (const [fileId, entry] of uploadedFiles) {
      if (String(entry.telegramUserId || "") === String(account.telegramUserId) && entry.telegramMessageId === messageId) uploadedFiles.delete(fileId);
    }
    uploadedFiles.set(media.file_id, { beatgalerUserId, telegramUserId: account.telegramUserId, telegramMessageId: messageId, filename: originalName, kind: "project", beatId, partIndex: 0, totalParts: 1, originalName, createdAt: Date.now() });
    savePersistentData();
    res.json({ ok: true, updated, original_name: originalName, original_size: stat.size, parts: [{ telegram_file_id: media.file_id, telegram_message_id: messageId, index: 0, size: stat.size, filename: originalName }] });
  } catch (err) { res.status(500).json({ error: `Telegram PROJECT upload failed: ${err.message || err}` }); }
  finally { cleanup(); }
});


// ── Generic beat cloud file upload — one Telegram document per slot ─────
const CLOUD_ROLE_META = {
  WAV:     { icon: "💿", label: "WAV HQ" },
  LOOP:    { icon: "🔁", label: "Loop" },
  PROJECT: { icon: "📦", label: "Project" },
  STEMS:   { icon: "🎚", label: "Stems" },
  OTHER:   { icon: "📎", label: "Other" },
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
  if (!account) { cleanup(); return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." }); }
  if (!req.file) return res.status(400).json({ error: "No file was uploaded." });
  const uploadedOriginalName = req.file.originalname || "file";
  const originalName = normalizedType === "PROJECT"
    ? `${beatName || path.basename(uploadedOriginalName, path.extname(uploadedOriginalName))}.zip`
    : uploadedOriginalName;
  const stat = fs.statSync(req.file.path);
  if (stat.size > TELEGRAM_MAX_UPLOAD_BYTES) {
    cleanup();
    return res.status(413).json({
      error: `FILE_TOO_LARGE:${stat.size}:${originalName} exceeds BeatGaler's single-file Telegram limit of 2000 MB.`,
    });
  }
  try {
    const { message: sent, updated } = await sendOrReplaceTelegramDocument({ account, existingMessageId, filePath: req.file.path, filename: originalName, caption: `${roleMeta.icon} ${beatName || "Beat"} — ${roleMeta.label}`, replyToMessageId: parentMessageId });
    const media = sent?.document || sent?.audio || null;
    if (!media?.file_id) throw new Error(`Telegram returned no file_id for ${normalizedType}.`);
    const messageId = sent.message_id || Number(existingMessageId) || null;
    for (const [fileId, entry] of uploadedFiles) {
      if (String(entry.telegramUserId || "") === String(account.telegramUserId) && entry.telegramMessageId === messageId) uploadedFiles.delete(fileId);
    }
    uploadedFiles.set(media.file_id, { beatgalerUserId, telegramUserId: account.telegramUserId, telegramMessageId: messageId, filename: originalName, kind: normalizedType.toLowerCase(), beatId, partIndex: 0, totalParts: 1, originalName, createdAt: Date.now() });
    savePersistentData();
    res.json({ ok: true, updated, file_type: normalizedType, original_name: originalName, original_size: stat.size, parts: [{ telegram_file_id: media.file_id, telegram_message_id: messageId, index: 0, size: stat.size, filename: originalName }] });
  } catch (err) { res.status(500).json({ error: `Telegram ${normalizedType.toLowerCase()} upload failed: ${err.message || err}` }); }
  finally { cleanup(); }
});

// ── Fase 18: download del MP3/WAV principal ──
// BeatGaler manda su user id + el file_id guardado en SQLite. El backend
// verifica que ese file_id pertenece a ese usuario y luego hace streaming
// directo desde Telegram hacia la app; el token del bot nunca sale del server.
app.post("/beats/download", async (req, res) => {
  const { beatgalerUserId, telegramFileId } = req.body || {};

  if (!beatgalerUserId || typeof beatgalerUserId !== "string") {
    return res.status(400).json({ error: "beatgalerUserId is required" });
  }
  if (!telegramFileId || typeof telegramFileId !== "string") {
    return res.status(400).json({ error: "telegramFileId is required" });
  }

  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) {
    return res.status(400).json({ error: "Telegram is not connected for this BeatGaler installation." });
  }

  const stored = uploadedFiles.get(telegramFileId);
  if (!stored || String(stored.telegramUserId || "") !== String(account.telegramUserId)) {
    return res.status(403).json({ error: "This Telegram file does not belong to the connected Telegram vault." });
  }

  try {
    const tgFile = await bot.getFile(telegramFileId);
    if (!tgFile || !tgFile.file_path) {
      return res.status(404).json({ error: "Telegram could not resolve this file." });
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(stored.filename || "beat")}`);

    const localPath = localTelegramPath(tgFile.file_path);
    if (localPath) {
      const stat = await fs.promises.stat(localPath);
      res.setHeader("Content-Length", stat.size);
      const stream = fs.createReadStream(localPath);
      stream.on("error", err => {
        if (!res.headersSent) {
          res.status(502).json({ error: `Telegram local-file read failed: ${err.message || err}` });
        } else {
          res.destroy(err);
        }
      });
      stream.pipe(res);
      return;
    }

    const fileUrl = `${TELEGRAM_BOT_API_BASE}/file/bot${BOT_TOKEN}/${tgFile.file_path}`;
    const endpoint = new URL(fileUrl);
    const transport = endpoint.protocol === "https:" ? https : http;
    const request = transport.get(endpoint, (tgRes) => {
      if (tgRes.statusCode !== 200) {
        res.status(tgRes.statusCode || 502).end();
        tgRes.resume();
        return;
      }
      if (tgRes.headers["content-length"]) {
        res.setHeader("Content-Length", tgRes.headers["content-length"]);
      }
      tgRes.pipe(res);
    });

    request.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: `Telegram download failed: ${err.message || err}` });
      } else {
        res.destroy(err);
      }
    });
  } catch (err) {
    res.status(500).json({ error: `Telegram download failed: ${err.message || err}` });
  }
});

// ── Telegram login: /start only prepares the login. The account is NOT
// linked until the user explicitly taps the inline "Log in to BeatGaler"
// button. The callback comes from Telegram itself, so we can bind the pending
// token to the exact Telegram user/chat that opened it.
if (TELEGRAM_BOT_API_LOCAL) {
  console.log(`Using local Telegram Bot API at ${TELEGRAM_BOT_API_BASE}`);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
  baseApiUrl: TELEGRAM_BOT_API_BASE,
});

bot.onText(/\/start(?:\s+(\S+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match && match[1];

  if (!token) {
    await bot.sendMessage(
      chatId,
      "Open BeatGaler → Settings → Connect Telegram to start a secure login."
    );
    return;
  }

  cleanupExpired();
  const entry = pendingConnections.get(token);

  if (!entry || entry.expiresAt < Date.now()) {
    pendingConnections.delete(token);
    await bot.sendMessage(
      chatId,
      "This BeatGaler login link expired. Return to BeatGaler and press Connect Telegram again."
    );
    return;
  }
  if (entry.used) {
    await bot.sendMessage(chatId, "This BeatGaler login link has already been used.");
    return;
  }

  // Bind the pending login to the Telegram account that opened /start.
  // Another Telegram account cannot later confirm the same token.
  entry.telegramUserId = msg.from.id;
  entry.telegramChatId = chatId;
  entry.telegramUsername = msg.from.username || msg.from.first_name || "Telegram user";
  entry.startedAt = Date.now();

  await bot.sendMessage(
    chatId,
    "BeatGaler is requesting access to this Telegram vault.\n\nOnly continue if you just pressed Connect Telegram inside BeatGaler.",
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "Log in to BeatGaler", callback_data: `beatgaler_login:${token}` }
        ]]
      }
    }
  );
});

bot.on("callback_query", async (query) => {
  const data = String(query.data || "");
  if (!data.startsWith("beatgaler_login:")) return;

  const token = data.slice("beatgaler_login:".length);
  cleanupExpired();
  const entry = pendingConnections.get(token);

  const deny = async (message) => {
    try { await bot.answerCallbackQuery(query.id, { text: message, show_alert: true }); } catch {}
  };

  if (!entry || entry.expiresAt < Date.now()) {
    pendingConnections.delete(token);
    await deny("This BeatGaler login expired. Start again from the app.");
    return;
  }
  if (entry.used) {
    await deny("This BeatGaler login has already been used.");
    return;
  }

  // Security boundary: the callback must come from the SAME Telegram account
  // and chat that opened the token with /start.
  if (
    Number(entry.telegramUserId) !== Number(query.from.id) ||
    Number(entry.telegramChatId) !== Number(query.message?.chat?.id)
  ) {
    await deny("This login belongs to a different Telegram account.");
    return;
  }

  entry.used = true;
  const username = query.from.username || query.from.first_name || entry.telegramUsername || "Telegram user";

  linkedAccounts.set(entry.beatgalerUserId, {
    telegramUserId: query.from.id,
    telegramUsername: username,
    connectedAt: Date.now(),
  });
  savePersistentData();

  const beatgalerUserId = entry.beatgalerUserId;
  pendingConnections.delete(token);

  // This is the event BeatGaler waits for. No polling loop is needed.
  broadcastCloudEvent(beatgalerUserId, "telegram_connected", {
    telegram_username: username,
    telegram_user_id: String(query.from.id),
  });

  try {
    await bot.answerCallbackQuery(query.id, { text: "Connected to BeatGaler" });
  } catch {}

  try {
    await bot.editMessageText(
      `✅ Connected to BeatGaler\n\nTelegram vault: @${query.from.username || username}`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      }
    );
  } catch {
    await bot.sendMessage(query.message.chat.id, "✅ Connected to BeatGaler.");
  }
});

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.message);
});
