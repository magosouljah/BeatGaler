from pathlib import Path
import re, shutil, subprocess, sys

ROOT = Path.cwd()
SERVER = ROOT/"cloud-server"/"server.js"
COMMANDS = ROOT/"src-tauri"/"src"/"commands.rs"
PUBLIC = ROOT/"public"/"beatgaler-icons"
PATCH = ROOT/"patch-files"/"public"/"beatgaler-icons"

def fail(msg):
    print("[ERROR]", msg)
    sys.exit(1)

def backup(path):
    dst = Path(str(path)+".pre-ratelimit-icons.bak")
    if not dst.exists():
        shutil.copy2(path,dst)

if not SERVER.exists() or not COMMANDS.exists():
    fail("Run this from the BeatGaler repo root.")

backup(SERVER)
backup(COMMANDS)

PUBLIC.mkdir(parents=True, exist_ok=True)
shutil.copy2(PATCH/"cloud.png", PUBLIC/"cloud.png")
shutil.copy2(PATCH/"box.png", PUBLIC/"box.png")
print("[OK] transparent PNG icons installed")

server = SERVER.read_text(encoding="utf-8")

if "function telegramRetryAfterSeconds" not in server:
    marker = "function telegramJsonMethod(method, payload) {"
    if marker not in server:
        fail("Current server.js is not the Topics version expected by this patch.")
    helper = '''function telegramRetryAfterSeconds(error) {
  const direct = Number(error?.retryAfter || error?.response?.body?.parameters?.retry_after);
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);
  const text = String(error?.message || error || "");
  const match = text.match(/retry after\\s+(\\d+)/i);
  return match ? Math.max(1, Number(match[1])) : 0;
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTelegramRateLimitRetry(label, operation) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const retryAfter = telegramRetryAfterSeconds(error);
      if (!retryAfter) throw error;
      attempt += 1;
      const waitSeconds = retryAfter + 1;
      console.warn(`[telegram] ${label} rate-limited; waiting ${waitSeconds}s (attempt ${attempt})`);
      await sleepMs(waitSeconds * 1000);
    }
  }
}

'''
    server = server.replace(marker, helper+marker, 1)
    print("[OK] Telegram rate-limit wait/retry helper")

old = '''        if (!parsed.ok) return reject(new Error(parsed.description || `Telegram ${method} failed`));
        resolve(parsed.result);'''
new = '''        if (!parsed.ok) {
          const error = new Error(parsed.description || `Telegram ${method} failed`);
          const retryAfter = Number(parsed?.parameters?.retry_after);
          if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
          return reject(error);
        }
        resolve(parsed.result);'''
if old in server:
    server = server.replace(old,new,1)
    print("[OK] raw Bot API retry_after preserved")
elif new not in server:
    fail("telegramJsonMethod response block changed.")

server = server.replace(
'''        await telegramJsonMethod("editForumTopic", {
          chat_id: chatId,
          message_thread_id: Number(current.messageThreadId),
          name,
        });''',
'''        await withTelegramRateLimitRetry("edit topic", () => telegramJsonMethod("editForumTopic", {
          chat_id: chatId,
          message_thread_id: Number(current.messageThreadId),
          name,
        }));''',1)

server = server.replace(
'''  const result = await telegramJsonMethod("createForumTopic", { chat_id: chatId, name });''',
'''  const result = await withTelegramRateLimitRetry(
    "create topic",
    () => telegramJsonMethod("createForumTopic", { chat_id: chatId, name })
  );''',1)

server = server.replace(
'''      const sent = await editTelegramDocumentInPlace({
        chatId, messageId: existing, filePath, filename, caption
      });''',
'''      const sent = await withTelegramRateLimitRetry(
        `replace ${filename || "file"}`,
        () => editTelegramDocumentInPlace({
          chatId, messageId: existing, filePath, filename, caption
        })
      );''',1)

server = server.replace(
'''  const sent = await bot.sendDocument(chatId, filePath, options, {
    filename, contentType: "application/octet-stream"
  });''',
'''  const sent = await withTelegramRateLimitRetry(
    `upload ${filename || "file"}`,
    () => bot.sendDocument(chatId, filePath, options, {
      filename, contentType: "application/octet-stream"
    })
  );''',1)

server = server.replace(
'''        sent = await editTelegramDocumentInPlace({
          chatId: artworkChatId,
          messageId: existing,
          filePath: req.file.path,
          filename,
          caption,
        });''',
'''        sent = await withTelegramRateLimitRetry(
          `replace artwork ${beatId}`,
          () => editTelegramDocumentInPlace({
            chatId: artworkChatId,
            messageId: existing,
            filePath: req.file.path,
            filename,
            caption,
          })
        );''',1)

server = server.replace(
'''      sent = await bot.sendDocument(
        artworkChatId,
        req.file.path,
        options,
        { filename, contentType: "application/octet-stream" }
      );''',
'''      sent = await withTelegramRateLimitRetry(
        `upload artwork ${beatId}`,
        () => bot.sendDocument(
          artworkChatId,
          req.file.path,
          options,
          { filename, contentType: "application/octet-stream" }
        )
      );''',1)

server = server.replace(
'''        await bot.editMessageText(text, { chat_id: metadataChatId, message_id: existing });''',
'''        await withTelegramRateLimitRetry(
          `replace metadata ${beatId}`,
          () => bot.editMessageText(text, { chat_id: metadataChatId, message_id: existing })
        );''',1)

server = server.replace(
'''    const sent = await bot.sendMessage(metadataChatId, text, opts);''',
'''    const sent = await withTelegramRateLimitRetry(
      `upload metadata ${beatId}`,
      () => bot.sendMessage(metadataChatId, text, opts)
    );''',1)

for a,b in {
    "🎵 ":"", "📦 ":"", "🖼 ":"", "💿":"", "🔁":"", "🎚":"", "📎":"",
    "✅ ":"", "❌ ":"", "👋 ":""
}.items():
    server = server.replace(a,b)

server = re.sub(
    r'const CLOUD_ROLE_META = \\{\\s*WAV:\\s*\\{ icon: "[^"]*", label: "WAV HQ" \\},\\s*LOOP:\\s*\\{ icon: "[^"]*", label: "Loop" \\},\\s*PROJECT:\\s*\\{ icon: "[^"]*", label: "Project" \\},\\s*STEMS:\\s*\\{ icon: "[^"]*", label: "Stems" \\},\\s*OTHER:\\s*\\{ icon: "[^"]*", label: "Other" \\},\\s*\\};',
    '''const CLOUD_ROLE_META = {
  WAV:     { label: "WAV HQ" },
  LOOP:    { label: "Loop" },
  PROJECT: { label: "Project" },
  STEMS:   { label: "Stems" },
  OTHER:   { label: "Other" },
};''',
    server, count=1, flags=re.S
)
server = server.replace(
'caption: `${roleMeta.icon} ${beatName || "Beat"} — ${roleMeta.label}`',
'caption: `${beatName || "Beat"} — ${roleMeta.label}`'
)

SERVER.write_text(server, encoding="utf-8", newline="\\n")

check = subprocess.run(["node","--check",str(SERVER)])
if check.returncode != 0:
    shutil.copy2(Path(str(SERVER)+".pre-ratelimit-icons.bak"), SERVER)
    fail("server.js syntax failed; original server restored.")
print("[OK] server.js syntax")

commands = COMMANDS.read_text(encoding="utf-8")
old_audio = '"recording" | "recordings" | "audio files" |'
new_audio = '"recording" | "recordings" | "audio" | "audio files" |'
if old_audio in commands:
    commands = commands.replace(old_audio,new_audio,1)
    print("[OK] Audio/ excluded from beat discovery")
elif new_audio in commands:
    print("[SKIP] Audio/ scanner fix already present")
COMMANDS.write_text(commands, encoding="utf-8", newline="\\n")

ICON_CLOUD = '<img src="/beatgaler-icons/cloud.png" alt="" aria-hidden="true" style={{ width: 14, height: 14, objectFit: "contain", display: "inline-block", verticalAlign: "middle" }} />'
ICON_BOX = '<img src="/beatgaler-icons/box.png" alt="" aria-hidden="true" style={{ width: 14, height: 14, objectFit: "contain", display: "inline-block", verticalAlign: "middle" }} />'

changed_files=[]
for path in (ROOT/"src").rglob("*.tsx"):
    text=path.read_text(encoding="utf-8")
    original=text

    for cloud in ["☁️","☁︎","☁"]:
        text=text.replace(f'>{cloud}<',f'>{ICON_CLOUD}<')
        text=text.replace('{"'+cloud+'"}',ICON_CLOUD)
        text=text.replace("{'"+cloud+"'}",ICON_CLOUD)
    text=text.replace('>📦<',f'>{ICON_BOX}<')
    text=text.replace('{"📦"}',ICON_BOX)
    text=text.replace("{'📦'}",ICON_BOX)

    text = re.sub(
        r'\\{([^{}\\n]+?)\\?\\s*["\\'](?:☁️|☁︎|☁)["\\']\\s*:\\s*["\\']["\\']\\}',
        lambda m: '{'+m.group(1)+'? '+ICON_CLOUD+' : null}',
        text
    )

    for emoji in ["☁️","☁︎","☁","📦","💿","🔁","🎚️","🎚","📎","🎵","🖼️","🖼","✅","❌","👋","⚠️","⚠","🗑️","🗑","🚫","🔗","📁","📂"]:
        text=text.replace(emoji,"")

    if text != original:
        backup(path)
        path.write_text(text,encoding="utf-8",newline="\\n")
        changed_files.append(str(path.relative_to(ROOT)))

print(f"[OK] frontend icon/emoji pass changed {len(changed_files)} TSX file(s)")
for p in changed_files:
    print("     ",p)

remaining=[]
for path in list((ROOT/"src").rglob("*.tsx"))+list((ROOT/"src").rglob("*.ts")):
    txt=path.read_text(encoding="utf-8")
    for emoji in ["☁","📦","💿","🔁","🎚","📎","🎵","🖼","✅","❌","👋","⚠","🗑","🚫","🔗","📁","📂"]:
        if emoji in txt:
            remaining.append((str(path.relative_to(ROOT)),emoji))
if remaining:
    print("[WARN] Remaining emoji-like occurrences:")
    for p,e in sorted(set(remaining)):
        print("      ",p,repr(e))
else:
    print("[OK] no known colorful emoji left in src/")

print()
print("Patch applied.")
print("Run:")
print("  npm run build")
print("  node --check .\\\\cloud-server\\\\server.js")
print("  npm run tauri dev")
