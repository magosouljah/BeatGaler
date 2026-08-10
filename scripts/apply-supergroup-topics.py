#!/usr/bin/env python3
from pathlib import Path
import re, shutil, sys

ROOT = Path.cwd()
SERVER = ROOT / "cloud-server" / "server.js"
RUST = ROOT / "src-tauri" / "src" / "commands.rs"
APP = ROOT / "src" / "App.tsx"

def die(msg):
    print(f"[ERROR] {msg}")
    sys.exit(1)

def backup(path):
    bak = path.with_suffix(path.suffix + ".topics-pass.bak")
    if not bak.exists():
        shutil.copy2(path, bak)

def replace_once(text, old, new, label):
    if new in text:
        print(f"[SKIP] {label}: already applied")
        return text, False
    count = text.count(old)
    if count != 1:
        die(f"{label}: expected exactly 1 match, found {count}. No blind patch applied.")
    print(f"[OK]   {label}")
    return text.replace(old, new, 1), True

def regex_once(text, pattern, repl, label, flags=re.S):
    matches = list(re.finditer(pattern, text, flags))
    if len(matches) != 1:
        die(f"{label}: expected exactly 1 regex match, found {len(matches)}. No blind patch applied.")
    print(f"[OK]   {label}")
    return re.sub(pattern, repl, text, count=1, flags=flags), True

if not SERVER.exists() or not RUST.exists():
    die("Run this script from the BeatGaler repository root.")

server = SERVER.read_text(encoding="utf-8")
server_changed = False

if "const beatTopics = new Map();" not in server:
    old = "const uploadedFiles = new Map();"
    new = """const uploadedFiles = new Map();

// One Telegram forum topic per BeatGaler beat.
// key = `${beatgalerUserId}:${beatId}`
const beatTopics = new Map();"""
    server, c = replace_once(server, old, new, "Server: add beat topic map")
    server_changed |= c

if "parsed.beatTopics" not in server:
    old = """    for (const [key, value] of Object.entries(parsed.uploadedFiles || {})) {
      uploadedFiles.set(key, value);
    }"""
    new = """    for (const [key, value] of Object.entries(parsed.uploadedFiles || {})) {
      uploadedFiles.set(key, value);
    }
    for (const [key, value] of Object.entries(parsed.beatTopics || {})) {
      beatTopics.set(key, value);
    }"""
    server, c = replace_once(server, old, new, "Server: load persisted beat topics")
    server_changed |= c

if "beatTopics: Object.fromEntries(beatTopics)" not in server:
    old = """    linkedAccounts: Object.fromEntries(linkedAccounts),
    uploadedFiles: Object.fromEntries(uploadedFiles),"""
    new = """    linkedAccounts: Object.fromEntries(linkedAccounts),
    uploadedFiles: Object.fromEntries(uploadedFiles),
    beatTopics: Object.fromEntries(beatTopics),"""
    server, c = replace_once(server, old, new, "Server: persist beat topics")
    server_changed |= c

if "storage_ready:" not in server:
    old = """      telegram_user_id: String(account.telegramUserId),
      connected_at: account.connectedAt,"""
    new = """      telegram_user_id: String(account.telegramUserId),
      connected_at: account.connectedAt,
      storage_ready: !!account.storageChatId,
      storage_chat_id: account.storageChatId ? String(account.storageChatId) : null,
      storage_chat_title: account.storageChatTitle || null,"""
    server, c = replace_once(server, old, new, "Server: expose supergroup storage status")
    server_changed |= c

if "async function ensureBeatTopic" not in server:
    marker = "function telegramMethodUrl(method) {"
    helpers = r"""function topicKey(beatgalerUserId, beatId) {
  return `${String(beatgalerUserId)}:${String(beatId)}`;
}

function telegramStorageChatId(account) {
  const id = Number(account?.storageChatId);
  if (!Number.isFinite(id) || id === 0) {
    throw new Error(
      "Telegram storage supergroup is not configured. Create a private supergroup, enable Topics, add the BeatGaler bot as admin, then send /beatgaler_storage in that group."
    );
  }
  return id;
}

function cleanTopicName(name) {
  const value = String(name || "Untitled Beat").trim().replace(/\s+/g, " ");
  return (value || "Untitled Beat").slice(0, 128);
}

async function ensureBeatTopic(account, beatgalerUserId, beatId, beatName) {
  if (!beatId) throw new Error("beatId is required to resolve the Telegram topic.");
  const chatId = telegramStorageChatId(account);
  const key = topicKey(beatgalerUserId, beatId);
  const expectedName = cleanTopicName(beatName || beatId);
  const current = beatTopics.get(key);

  if (current && Number(current.chatId) === Number(chatId) && Number(current.messageThreadId) > 0) {
    if (String(current.beatName || "") !== expectedName) {
      try {
        await bot.editForumTopic(chatId, Number(current.messageThreadId), { name: expectedName });
        current.beatName = expectedName;
        current.updatedAt = Date.now();
        beatTopics.set(key, current);
        savePersistentData();
      } catch (error) {
        console.warn(`[topics] could not rename topic ${current.messageThreadId}:`, error?.message || error);
      }
    }
    return Number(current.messageThreadId);
  }

  const topic = await bot.createForumTopic(chatId, expectedName);
  const messageThreadId = Number(topic?.message_thread_id);
  if (!Number.isFinite(messageThreadId) || messageThreadId <= 0) {
    throw new Error("Telegram created a topic but returned no message_thread_id.");
  }

  beatTopics.set(key, {
    chatId,
    messageThreadId,
    beatName: expectedName,
    updatedAt: Date.now(),
  });
  savePersistentData();
  console.log(`[topics] created topic ${messageThreadId} for beat ${beatId}`);
  return messageThreadId;
}

function injectTopicIdsIntoManifest(beatgalerUserId, manifest) {
  if (!manifest || !Array.isArray(manifest.beats)) return manifest;
  const apply = beat => {
    if (!beat || !beat.id) return;
    const topic = beatTopics.get(topicKey(beatgalerUserId, beat.id));
    if (topic?.messageThreadId) beat.telegram_topic_id = Number(topic.messageThreadId);
  };
  manifest.beats.forEach(apply);
  if (Array.isArray(manifest.trash)) manifest.trash.forEach(item => apply(item?.beat));
  return manifest;
}

function rebuildTopicsFromManifest(beatgalerUserId, account, manifest) {
  const chatId = Number(account?.storageChatId);
  if (!Number.isFinite(chatId) || !manifest) return;

  const apply = beat => {
    const beatId = String(beat?.id || "");
    const threadId = Number(beat?.telegram_topic_id);
    if (!beatId || !Number.isFinite(threadId) || threadId <= 0) return;

    beatTopics.set(topicKey(beatgalerUserId, beatId), {
      chatId,
      messageThreadId: threadId,
      beatName: cleanTopicName(beat?.name || beatId),
      updatedAt: Date.now(),
    });
  };

  (manifest.beats || []).forEach(apply);
  (manifest.trash || []).forEach(item => apply(item?.beat));
  savePersistentData();
}

async function deleteBeatTopic(account, beatgalerUserId, beatId, topicIdHint) {
  const chatId = telegramStorageChatId(account);
  const key = topicKey(beatgalerUserId, beatId);
  const saved = beatTopics.get(key);
  const threadId = Number(topicIdHint || saved?.messageThreadId);

  if (!Number.isFinite(threadId) || threadId <= 0) {
    beatTopics.delete(key);
    savePersistentData();
    return { deleted: false, missing: true };
  }

  try {
    await bot.deleteForumTopic(chatId, threadId);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/message thread not found|topic.*not found|MESSAGE_THREAD_INVALID/i.test(message)) {
      throw error;
    }
  }

  beatTopics.delete(key);
  for (const [fileId, entry] of uploadedFiles) {
    if (entry.beatgalerUserId === beatgalerUserId && entry.beatId === beatId) {
      uploadedFiles.delete(fileId);
    }
  }
  savePersistentData();
  return { deleted: true, message_thread_id: threadId };
}

async function purgeRemovedTrashTopics(account, beatgalerUserId, previousManifest, nextManifest) {
  if (!previousManifest || !Array.isArray(previousManifest.trash)) return;

  const keep = new Set([
    ...(nextManifest?.beats || []).map(b => String(b?.id || "")),
    ...(nextManifest?.trash || []).map(item => String(item?.beat?.id || "")),
  ].filter(Boolean));

  for (const item of previousManifest.trash) {
    const beat = item?.beat;
    const beatId = String(beat?.id || "");
    if (!beatId || keep.has(beatId)) continue;
    await deleteBeatTopic(account, beatgalerUserId, beatId, beat?.telegram_topic_id);
  }
}

"""
    if marker not in server:
        die("Could not find telegramMethodUrl insertion point.")
    server = server.replace(marker, helpers + marker, 1)
    print("[OK]   Server: add supergroup/topic helpers")
    server_changed = True

if "bot.getChat(telegramStorageChatId(account))" not in server:
    old = "const chat = await bot.getChat(account.telegramUserId);"
    if old not in server:
        die("Could not patch pinned library chat.")
    server = server.replace(old, "const chat = await bot.getChat(telegramStorageChatId(account));", 1)
    print("[OK]   Server: pinned index reads from storage supergroup")
    server_changed = True

sender_pattern = r"async function sendOrReplaceTelegramDocument\(\{.*?\n\}"
sender_match = re.search(sender_pattern, server, re.S)
if not sender_match:
    die("Could not find sendOrReplaceTelegramDocument.")
if "messageThreadId = await ensureBeatTopic" not in sender_match.group(0):
    replacement = r"""async function sendOrReplaceTelegramDocument({
  account,
  beatgalerUserId,
  beatId,
  beatName,
  existingMessageId,
  filePath,
  filename,
  caption,
  replyToMessageId,
}) {
  const chatId = telegramStorageChatId(account);
  const messageThreadId = await ensureBeatTopic(account, beatgalerUserId, beatId, beatName);
  const existing = Number(existingMessageId);

  if (Number.isFinite(existing) && existing > 0) {
    try {
      const sent = await editTelegramDocumentInPlace({
        chatId,
        messageId: existing,
        filePath,
        filename,
        caption,
      });
      return { message: sent, updated: true, messageThreadId };
    } catch (err) {
      const message = String(err?.message || err);
      if (!/message (?:to edit )?not found|message_id_invalid/i.test(message)) throw err;
      console.warn(`[topics] slot message ${existing} missing; recreating in topic ${messageThreadId}`);
    }
  }

  const options = { caption, message_thread_id: messageThreadId };
  const reply = Number(replyToMessageId);
  if (Number.isFinite(reply) && reply > 0) options.reply_to_message_id = reply;

  const sent = await bot.sendDocument(
    chatId,
    filePath,
    options,
    { filename, contentType: "application/octet-stream" }
  );
  return { message: sent, updated: false, messageThreadId };
}"""
    server, c = regex_once(server, sender_pattern, replacement, "Server: route documents through beat topic")
    server_changed |= c
else:
    print("[SKIP] Server: topic-aware sender already applied")

if "injectTopicIdsIntoManifest(beatgalerUserId, parsedManifest)" not in server:
    target = "    const existing = await getPinnedLibraryIndex(account);"
    if server.count(target) != 1:
        die("Could not uniquely locate library/upsert existing index line.")
    insert = """    const rawIncoming = await fs.promises.readFile(req.file.path, "utf8");
    const parsedManifest = typeof validateLibraryManifest === "function"
      ? validateLibraryManifest(JSON.parse(rawIncoming))
      : JSON.parse(rawIncoming);
    injectTopicIdsIntoManifest(beatgalerUserId, parsedManifest);
    await fs.promises.writeFile(req.file.path, JSON.stringify(parsedManifest, null, 2), "utf8");

    const existing = await getPinnedLibraryIndex(account);
    let previousManifest = null;
    if (existing?.document?.file_id) {
      try {
        const previousRaw = await downloadTelegramFileBuffer(existing.document.file_id);
        previousManifest = JSON.parse(previousRaw.toString("utf8"));
      } catch (error) {
        console.warn("[library] could not read previous storage index:", error?.message || error);
      }
    }"""
    server = server.replace(target, insert, 1)
    print("[OK]   Server: library index injects telegram_topic_id")
    server_changed = True

for old, new, label in [
    ("chatId: account.telegramUserId,\n        messageId: existing.message_id,",
     "chatId: telegramStorageChatId(account),\n        messageId: existing.message_id,",
     "Server: edit pinned index in storage group"),
    ("        account.telegramUserId,\n        req.file.path,\n        { caption: LIBRARY_INDEX_CAPTION },",
     "        telegramStorageChatId(account),\n        req.file.path,\n        { caption: LIBRARY_INDEX_CAPTION },",
     "Server: create pinned index in storage group"),
    ("await bot.pinChatMessage(account.telegramUserId, sent.message_id",
     "await bot.pinChatMessage(telegramStorageChatId(account), sent.message_id",
     "Server: pin index in storage group"),
]:
    if old in server:
        server = server.replace(old, new, 1)
        print(f"[OK]   {label}")
        server_changed = True
    elif new in server:
        print(f"[SKIP] {label}: already applied")
    else:
        die(f"{label}: expected code not found.")

if "purgeRemovedTrashTopics(account, beatgalerUserId, previousManifest, parsedManifest)" not in server:
    needle = '    const document = sent?.document;\n    if (!document?.file_id) throw new Error("Telegram returned no library index file_id");'
    replacement = needle + "\n    await purgeRemovedTrashTopics(account, beatgalerUserId, previousManifest, parsedManifest);"
    server, c = replace_once(server, needle, replacement, "Server: Empty Trash deletes whole topic")
    server_changed |= c

if "rebuildTopicsFromManifest(beatgalerUserId, account, parsed)" not in server:
    candidates = [
        """    const parsed = JSON.parse(raw.toString("utf8"));
    res.json(parsed);""",
        """    const parsed = validateLibraryManifest(JSON.parse(raw.toString("utf8")));
    rebuildOwnershipFromManifest({ beatgalerUserId, account, manifest: parsed });
    res.json(parsed);"""
    ]
    done = False
    for old in candidates:
        if old in server:
            new = old.replace("    res.json(parsed);", "    rebuildTopicsFromManifest(beatgalerUserId, account, parsed);\n    res.json(parsed);")
            server = server.replace(old, new, 1)
            done = True
            break
    if not done:
        die("Could not add topic reconstruction to library/get.")
    print("[OK]   Server: restore topic map from library index")
    server_changed = True

old = "const { beatgalerUserId, beatName, existingMessageId } = req.body || {};"
new = "const { beatgalerUserId, beatId, beatName, existingMessageId } = req.body || {};"
if old in server:
    server = server.replace(old, new, 1)
    print("[OK]   Server: MASTER accepts beatId")
    server_changed = True
elif new in server:
    print("[SKIP] Server: MASTER already accepts beatId")
else:
    die("MASTER request shape changed.")

upload_replacements = [
    (
        'const { message: sentMessage, updated } = await sendOrReplaceTelegramDocument({ account, existingMessageId, filePath: req.file.path, filename: telegramFilename, caption: beatName ? `🎵 ${beatName}` : undefined });',
        'const { message: sentMessage, updated, messageThreadId } = await sendOrReplaceTelegramDocument({ account, beatgalerUserId, beatId, beatName, existingMessageId, filePath: req.file.path, filename: telegramFilename, caption: beatName ? `🎵 ${beatName}` : undefined });',
        "Server: MASTER routed to beat topic"
    ),
    (
        'const { message: sent, updated } = await sendOrReplaceTelegramDocument({ account, existingMessageId, filePath: req.file.path, filename: originalName, caption: `📦 ${beatName || "Project"}`, replyToMessageId: parentMessageId });',
        'const { message: sent, updated } = await sendOrReplaceTelegramDocument({ account, beatgalerUserId, beatId, beatName, existingMessageId, filePath: req.file.path, filename: originalName, caption: `📦 ${beatName || "Project"}`, replyToMessageId: parentMessageId });',
        "Server: PROJECT routed to beat topic"
    ),
    (
        'const { message: sent, updated } = await sendOrReplaceTelegramDocument({ account, existingMessageId, filePath: req.file.path, filename: originalName, caption: `${roleMeta.icon} ${beatName || "Beat"} — ${roleMeta.label}`, replyToMessageId: parentMessageId });',
        'const { message: sent, updated } = await sendOrReplaceTelegramDocument({ account, beatgalerUserId, beatId, beatName, existingMessageId, filePath: req.file.path, filename: originalName, caption: `${roleMeta.icon} ${beatName || "Beat"} — ${roleMeta.label}`, replyToMessageId: parentMessageId });',
        "Server: WAV/other slots routed to beat topic"
    ),
]
for old,new,label in upload_replacements:
    if old in server:
        server = server.replace(old,new,1)
        print(f"[OK]   {label}")
        server_changed = True
    elif new in server:
        print(f"[SKIP] {label}: already applied")
    else:
        die(f"{label}: upload call not found.")

old = 'filename: telegramFilename, kind: "master", createdAt: Date.now()'
new = 'filename: telegramFilename, kind: "master", beatId, topicId: messageThreadId, createdAt: Date.now()'
if old in server:
    server = server.replace(old,new,1)
    print("[OK]   Server: MASTER ownership stores beat/topic")
    server_changed = True
elif new in server:
    print("[SKIP] Server: MASTER ownership already stores beat/topic")

if "const artworkTopicId = await ensureBeatTopic" not in server:
    old = """  try {
    let sent;
    let updated = false;"""
    new = """  try {
    const artworkTopicId = await ensureBeatTopic(account, beatgalerUserId, beatId, beatName);
    const artworkChatId = telegramStorageChatId(account);
    let sent;
    let updated = false;"""
    server, c = replace_once(server, old, new, "Server: artwork resolves beat topic")
    server_changed |= c

    artwork_start = server.find('app.post("/metadata/artwork"')
    artwork_end = server.find('app.post("/metadata/upsert"', artwork_start)
    if artwork_start < 0 or artwork_end < 0:
        die("Artwork route bounds not found.")
    block = server[artwork_start:artwork_end]
    block = block.replace("chatId: account.telegramUserId,", "chatId: artworkChatId,", 1)
    block = block.replace("const options = { caption };", "const options = { caption, message_thread_id: artworkTopicId };", 1)
    block = block.replace("        account.telegramUserId,\n        req.file.path,", "        artworkChatId,\n        req.file.path,", 1)
    server = server[:artwork_start] + block + server[artwork_end:]

if "const metadataTopicId = await ensureBeatTopic" not in server:
    old = """  const existing = Number(metadataMessageId);
  try {"""
    new = """  const existing = Number(metadataMessageId);
  try {
    const metadataTopicId = await ensureBeatTopic(
      account,
      beatgalerUserId,
      beatId,
      metadata?.name || metadata?.beat_name || beatId
    );
    const metadataChatId = telegramStorageChatId(account);"""
    server, c = replace_once(server, old, new, "Server: metadata resolves beat topic")
    server_changed |= c

    metadata_start = server.find('app.post("/metadata/upsert"')
    metadata_end = server.find("app.listen(", metadata_start)
    if metadata_start < 0 or metadata_end < 0:
        die("Metadata route bounds not found.")
    block = server[metadata_start:metadata_end]
    block = block.replace("chat_id: account.telegramUserId", "chat_id: metadataChatId")
    block = block.replace("const opts = {};", "const opts = { message_thread_id: metadataTopicId };", 1)
    block = block.replace("bot.sendMessage(account.telegramUserId, text, opts)", "bot.sendMessage(metadataChatId, text, opts)", 1)
    server = server[:metadata_start] + block + server[metadata_end:]

if 'app.post("/beats/delete-topic"' not in server:
    marker = "// ── Fase 18: download del MP3/WAV principal"
    route = r"""// Permanent remote delete: one beat == one Telegram forum topic.
app.post("/beats/delete-topic", async (req, res) => {
  const { beatgalerUserId, beatId, telegramTopicId } = req.body || {};
  if (!beatgalerUserId || !beatId) {
    return res.status(400).json({ error: "beatgalerUserId and beatId are required" });
  }
  const account = linkedAccounts.get(beatgalerUserId);
  if (!account) return res.status(400).json({ error: "Telegram is not connected." });

  try {
    const result = await deleteBeatTopic(account, beatgalerUserId, beatId, telegramTopicId);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: `Could not delete Telegram beat topic: ${error?.message || error}` });
  }
});

"""
    if marker not in server:
        die("Could not insert delete-topic endpoint.")
    server = server.replace(marker, route + marker, 1)
    print("[OK]   Server: add permanent beat topic delete endpoint")
    server_changed = True

if "BeatGaler Storage connected." not in server:
    marker = r'bot.onText(/\/start(?:\s+(\S+))?/, async (msg, match) => {'
    if marker not in server:
        die("Could not find /start handler.")
    command = r"""bot.onText(/\/beatgaler_storage(?:@\w+)?/, async (msg) => {
  const chatId = Number(msg.chat?.id);
  const fromId = Number(msg.from?.id);

  try {
    const chat = await bot.getChat(chatId);
    if (chat?.type !== "supergroup" || !chat?.is_forum) {
      await bot.sendMessage(chatId, "❌ This must be a supergroup with Topics enabled.");
      return;
    }

    const ownerEntry = [...linkedAccounts.entries()].find(([, account]) =>
      Number(account.telegramUserId) === fromId
    );
    if (!ownerEntry) {
      await bot.sendMessage(
        chatId,
        "❌ Connect this Telegram account to BeatGaler first, then run /beatgaler_storage again."
      );
      return;
    }

    const me = await bot.getMe();
    const member = await bot.getChatMember(chatId, me.id);
    const isAdmin = member?.status === "creator" || member?.status === "administrator";
    const canManageTopics = member?.status === "creator" || member?.can_manage_topics === true;
    const canDelete = member?.status === "creator" || member?.can_delete_messages === true;

    if (!isAdmin || !canManageTopics || !canDelete) {
      await bot.sendMessage(
        chatId,
        "❌ Make the BeatGaler bot an administrator with Manage Topics and Delete Messages permissions, then run /beatgaler_storage again."
      );
      return;
    }

    const [beatgalerUserId, account] = ownerEntry;
    account.storageChatId = chatId;
    account.storageChatTitle = chat.title || "BeatGaler Storage";
    account.storageLinkedAt = Date.now();
    linkedAccounts.set(beatgalerUserId, account);
    savePersistentData();

    broadcastCloudEvent(beatgalerUserId, "telegram_storage_connected", {
      storage_chat_id: String(chatId),
      storage_chat_title: account.storageChatTitle,
    });

    await bot.sendMessage(
      chatId,
      "✅ BeatGaler Storage connected.\n\nFrom now on every beat gets its own Topic. MASTER, WAV, PROJECT, artwork and metadata stay inside that beat's Topic.",
      msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}
    );
  } catch (error) {
    console.error("[storage] registration failed:", error?.message || error);
    try {
      await bot.sendMessage(chatId, `❌ Could not configure BeatGaler Storage: ${error?.message || error}`);
    } catch {}
  }
});

"""
    server = server.replace(marker, command + marker, 1)
    print("[OK]   Server: add /beatgaler_storage registration")
    server_changed = True

server = server.replace(
    "We keep ONE JSON document pinned in the user's private chat with the bot.",
    "We keep ONE JSON document pinned in the user's BeatGaler Storage supergroup."
)

if server_changed:
    backup(SERVER)
    SERVER.write_text(server, encoding="utf-8", newline="\n")

rust = RUST.read_text(encoding="utf-8")
rust_changed = False

old_fields = """    let mut fields = vec![
        ("beatgalerUserId", user_id.clone()),
        ("beatName", beat.name.clone()),
    ];"""
new_fields = """    let mut fields = vec![
        ("beatgalerUserId", user_id.clone()),
        ("beatId", beat.id.clone()),
        ("beatName", beat.name.clone()),
    ];"""

while old_fields in rust:
    rust = rust.replace(old_fields, new_fields, 1)
    rust_changed = True
    print("[OK]   Rust: MASTER upload path sends beatId")

if rust.count(new_fields) < 2:
    die("Expected two MASTER upload field blocks after patching.")

if rust_changed:
    backup(RUST)
    RUST.write_text(rust, encoding="utf-8", newline="\n")

if APP.exists():
    app = APP.read_text(encoding="utf-8")
    old_msg = "Its Telegram files will stay stored. The active cloud-library index will stop listing this beat after the next sync."
    new_msg = "Its Telegram files will stay inside its BeatGaler Storage topic while the beat is in Trash. Empty Trash permanently deletes that topic and every Telegram file inside it."
    if old_msg in app:
        backup(APP)
        app = app.replace(old_msg, new_msg, 1)
        APP.write_text(app, encoding="utf-8", newline="\n")
        print("[OK]   App: update Trash explanation for topic storage")

print()
print("BeatGaler Supergroup Topics Pass applied.")
print()
print("Run:")
print("  npm run build")
print("  node --check .\\cloud-server\\server.js")
print("  npm run tauri dev")
print()
print("Telegram setup:")
print("  1. Create a PRIVATE supergroup.")
print("  2. Enable Topics.")
print("  3. Add the BeatGaler bot as administrator.")
print("  4. Grant Manage Topics + Delete Messages.")
print("  5. Send /beatgaler_storage in that group.")
