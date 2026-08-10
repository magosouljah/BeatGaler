#!/usr/bin/env python3
# BeatGaler Stability Pass 1
# Target: branch beatgaler-cloud-beta
#
# Run from the repository root:
#   python scripts/apply-stability-pass-1.py

from pathlib import Path
import shutil
import sys

ROOT = Path.cwd()
APP = ROOT / "src" / "App.tsx"
SERVER = ROOT / "cloud-server" / "server.js"

def die(msg):
    print(f"[ERROR] {msg}")
    sys.exit(1)

def backup(path):
    bak = path.with_suffix(path.suffix + ".stability-pass1.bak")
    if not bak.exists():
        shutil.copy2(path, bak)

def replace_once(text, old, new, label):
    if new in text:
        print(f"[SKIP] {label}: already applied")
        return text, False
    count = text.count(old)
    if count != 1:
        die(f"{label}: expected exactly 1 match, found {count}. Branch may have changed.")
    print(f"[OK]   {label}")
    return text.replace(old, new, 1), True

if not APP.exists() or not SERVER.exists():
    die("Run this script from the BeatGaler repository root.")

app = APP.read_text(encoding="utf-8")
app_changed = False

old = '''const status = await pollTelegramCloudStatus().catch(error => {

console.warn("Telegram startup status check failed:", error);

return { connected: false, username: null };

});

if (cancelled) return;
await clearLocalCloudVault().catch(() => {});

if (!status.connected) {

setBeats([]);'''

new = '''let status: Awaited<ReturnType<typeof pollTelegramCloudStatus>> | null = null;
try {
status = await pollTelegramCloudStatus();
} catch (error) {
console.warn("Telegram startup status check failed; preserving local vault:", error);
// A network/server failure is NOT the same as "Telegram disconnected".
// Keep the current local DB/UI intact and let push/reconnect recover later.
return;
}

if (cancelled) return;

if (!status.connected) {
await clearLocalCloudVault().catch(error => {
console.warn("Could not clear disconnected Telegram vault:", error);
});
if (cancelled) return;

setBeats([]);'''

app, changed = replace_once(
    app, old, new,
    "P0 startup: never clear local vault when cloud status request fails"
)
app_changed |= changed

app, changed = replace_once(
    app,
    'play(ready.id, [ready.playback_path, ready.mp3_path, ready.wav_path ?? ""]);',
    'play(ready.id, [ready.playback_path]);',
    "P1 playback: MASTER MP3 path only; remove WAV fallback"
)
app_changed |= changed

old = 'setBeats(bs => bs.map(b => b.id === updated.id ? updated : b));'
new = '''setBeats(bs => bs.map(b => b.id === updated.id ? {
...b,
telegram_file_id: updated.telegram_file_id,
telegram_message_id: updated.telegram_message_id,
cloud_status: updated.cloud_status,
} : b));'''
app, changed = replace_once(
    app, old, new,
    "P0/P1 uploader: merge only cloud fields instead of overwriting newer beat edits"
)
app_changed |= changed

if app_changed:
    backup(APP)
    APP.write_text(app, encoding="utf-8", newline="\n")

server = SERVER.read_text(encoding="utf-8")
server_changed = False

old = '''app.use(express.json());
const upload = multer({ dest: "uploads-tmp/" });
const DATA_FILE = path.join(__dirname, "cloud-data.json");'''

new = '''// Reject obviously oversized uploads BEFORE multer writes them to disk.
// Multipart overhead is small, so allow 1 MiB above the actual file limit.
const MAX_MULTIPART_REQUEST_BYTES = TELEGRAM_MAX_UPLOAD_BYTES + (1024 * 1024);
const UPLOAD_PATHS = new Set([
  "/beats/upload",
  "/projects/upload",
  "/cloud-files/upload",
  "/metadata/artwork",
  "/library/upsert",
]);
const uploadRateBuckets = new Map();

app.use((req, res, next) => {
  if (!UPLOAD_PATHS.has(req.path) || req.method !== "POST") return next();

  const contentLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_REQUEST_BYTES) {
    return res.status(413).json({
      error: `UPLOAD_TOO_LARGE:${contentLength}:request exceeds BeatGaler's 2000 MB upload limit.`,
    });
  }

  // Basic protection for the public Funnel endpoint. This is intentionally
  // dependency-free; installation-secret auth will replace IP as the stronger key.
  const key = String(req.ip || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 20;
  let bucket = uploadRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    uploadRateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return res.status(429).json({ error: "Too many upload requests. Try again in a minute." });
  }
  next();
});

app.use(express.json({ limit: "2mb" }));
const upload = multer({
  dest: "uploads-tmp/",
  limits: {
    fileSize: TELEGRAM_MAX_UPLOAD_BYTES,
    files: 1,
    fields: 24,
    fieldSize: 1024 * 1024,
  },
});
const DATA_FILE = path.join(__dirname, "cloud-data.json");'''

server, changed = replace_once(
    server, old, new,
    "P0 upload hardening: preflight size limit + multer limits + basic rate-limit"
)
server_changed |= changed

old = '''async function sendOrReplaceTelegramDocument({ account, existingMessageId, filePath, filename, caption, replyToMessageId }) {
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
}'''

new = '''async function sendOrReplaceTelegramDocument({ account, existingMessageId, filePath, filename, caption, replyToMessageId }) {
  const existing = Number(existingMessageId);
  if (Number.isFinite(existing) && existing > 0) {
    try {
      const sent = await editTelegramDocumentInPlace({
        chatId: account.telegramUserId,
        messageId: existing,
        filePath,
        filename,
        caption,
      });
      return { message: sent, updated: true };
    } catch (err) {
      const message = String(err?.message || err);
      if (!/message (?:to edit )?not found|message_id_invalid/i.test(message)) {
        throw err;
      }
      console.warn(`[telegram] message ${existing} no longer exists; creating replacement`);
    }
  }

  const options = { caption };
  const reply = Number(replyToMessageId);
  if (Number.isFinite(reply) && reply > 0) options.reply_to_message_id = reply;
  const sent = await bot.sendDocument(
    account.telegramUserId,
    filePath,
    options,
    { filename, contentType: "application/octet-stream" }
  );
  return { message: sent, updated: false };
}'''

server, changed = replace_once(
    server, old, new,
    "P1 Telegram repair: recreate a deleted MASTER/WAV/PROJECT message"
)
server_changed |= changed

anchor = '''async function getPinnedLibraryIndex(account) {
  const chat = await bot.getChat(account.telegramUserId);
  const pinned = chat?.pinned_message;
  if (!pinned) return null;
  const caption = String(pinned.caption || pinned.text || "");
  if (!caption.startsWith(LIBRARY_INDEX_CAPTION) || !pinned.document?.file_id) return null;
  return pinned;
}'''

helper = anchor + r'''

function validateLibraryManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Library manifest must be a JSON object.");
  }
  if (!Array.isArray(manifest.beats)) {
    throw new Error("Library manifest must contain a beats array.");
  }
  if (manifest.revision !== undefined &&
      (!Number.isSafeInteger(manifest.revision) || manifest.revision < 0)) {
    throw new Error("Library manifest revision must be a non-negative integer.");
  }

  const ids = new Set();
  for (const beat of manifest.beats) {
    if (!beat || typeof beat !== "object" || Array.isArray(beat)) {
      throw new Error("Every beat in the library manifest must be an object.");
    }
    const id = String(beat.id || "").trim();
    if (!id) throw new Error("Every beat in the library manifest must have an id.");
    if (ids.has(id)) throw new Error(`Duplicate beat id in library manifest: ${id}`);
    ids.add(id);
  }
  return manifest;
}

function collectTelegramFileIds(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectTelegramFileIds(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      typeof child === "string" &&
      child.length > 0 &&
      normalized.includes("telegram") &&
      normalized.includes("file") &&
      normalized.includes("id")
    ) {
      out.add(child);
    }
    collectTelegramFileIds(child, out);
  }
  return out;
}

function rebuildOwnershipFromManifest({ beatgalerUserId, account, manifest }) {
  const fileIds = collectTelegramFileIds(manifest);
  for (const fileId of fileIds) {
    const current = uploadedFiles.get(fileId);
    uploadedFiles.set(fileId, {
      ...(current || {}),
      beatgalerUserId,
      telegramUserId: account.telegramUserId,
      filename: current?.filename || "beat",
      restoredFromLibraryIndex: true,
      restoredAt: Date.now(),
    });
  }
  if (fileIds.size > 0) savePersistentData();
  return fileIds;
}

async function readValidatedPinnedLibraryManifest(account) {
  const pinned = await getPinnedLibraryIndex(account);
  if (!pinned) return { pinned: null, manifest: null };
  const raw = await downloadTelegramFileBuffer(pinned.document.file_id);
  const parsed = validateLibraryManifest(JSON.parse(raw.toString("utf8")));
  return { pinned, manifest: parsed };
}'''

server, changed = replace_once(
    server, anchor, helper,
    "Cloud truth helpers: validate index + discover Telegram file IDs"
)
server_changed |= changed

old = '''  if (!req.file) return res.status(400).json({ error: "Library manifest file is required." });
  try {
    const existing = await getPinnedLibraryIndex(account);'''

new = '''  if (!req.file) return res.status(400).json({ error: "Library manifest file is required." });
  try {
    const rawManifest = await fs.promises.readFile(req.file.path, "utf8");
    const parsedManifest = validateLibraryManifest(JSON.parse(rawManifest));
    rebuildOwnershipFromManifest({ beatgalerUserId, account, manifest: parsedManifest });

    const existing = await getPinnedLibraryIndex(account);'''

server, changed = replace_once(
    server, old, new,
    "P0 index safety: validate library JSON before replacing pinned index"
)
server_changed |= changed

old = '''    const raw = await downloadTelegramFileBuffer(pinned.document.file_id);
    const parsed = JSON.parse(raw.toString("utf8"));
    res.json(parsed);'''

new = '''    const raw = await downloadTelegramFileBuffer(pinned.document.file_id);
    const parsed = validateLibraryManifest(JSON.parse(raw.toString("utf8")));
    rebuildOwnershipFromManifest({ beatgalerUserId, account, manifest: parsed });
    res.json(parsed);'''

server, changed = replace_once(
    server, old, new,
    "P0 Telegram source-of-truth: rebuild download ownership from pinned index"
)
server_changed |= changed

old = '''  try {
    const raw = await downloadTelegramFileBuffer(telegramFileId);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(raw.length));
    res.end(raw);'''

new = '''  try {
    const { manifest } = await readValidatedPinnedLibraryManifest(account);
    if (!manifest) {
      return res.status(404).json({ error: "No BeatGaler Telegram library index is pinned yet." });
    }
    const allowedFileIds = collectTelegramFileIds(manifest);
    if (!allowedFileIds.has(String(telegramFileId))) {
      return res.status(403).json({
        error: "Requested artwork file is not referenced by this Telegram vault.",
      });
    }

    const raw = await downloadTelegramFileBuffer(telegramFileId);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(raw.length));
    res.end(raw);'''

server, changed = replace_once(
    server, old, new,
    "Security: artwork download must be referenced by this vault index"
)
server_changed |= changed

multer_handler = r'''

// Multer rejects oversized/malformed multipart requests before route handlers.
app.use((err, req, res, next) => {
  if (!(err instanceof multer.MulterError)) return next(err);
  if (req.file?.path) fs.unlink(req.file.path, () => {});
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "UPLOAD_TOO_LARGE:file exceeds BeatGaler's 2000 MB upload limit.",
    });
  }
  return res.status(400).json({ error: `Invalid upload: ${err.message || err.code}` });
});
'''

if "Invalid upload: ${err.message || err.code}" not in server:
    server = server.rstrip() + multer_handler + "\n"
    server_changed = True
    print("[OK]   Multer errors: explicit 400/413 responses")
else:
    print("[SKIP] Multer errors: already applied")

if server_changed:
    backup(SERVER)
    SERVER.write_text(server, encoding="utf-8", newline="\n")

print()
print("BeatGaler Stability Pass 1 applied.")
print("Next:")
print("  npm run build")
print("  node --check cloud-server/server.js")
print("  npm run tauri dev")
