#!/usr/bin/env python3
from pathlib import Path
import re, shutil, sys

ROOT = Path.cwd()
APP = ROOT / "src" / "App.tsx"
SERVER = ROOT / "cloud-server" / "server.js"

def die(msg):
    print(f"[ERROR] {msg}")
    sys.exit(1)

def backup(path):
    bak = path.with_suffix(path.suffix + ".storage-rules-resume.bak")
    if not bak.exists():
        shutil.copy2(path, bak)

def replace_once(text, old, new, label):
    if new in text:
        print(f"[SKIP] {label}: already applied")
        return text, False
    count = text.count(old)
    if count != 1:
        die(f"{label}: expected exactly 1 match, found {count}.")
    print(f"[OK]   {label}")
    return text.replace(old, new, 1), True

def regex_replace_once(text, pattern, replacement, label, flags=re.S):
    matches = list(re.finditer(pattern, text, flags))
    if len(matches) != 1:
        die(f"{label}: expected exactly 1 regex match, found {len(matches)}.")
    print(f"[OK]   {label}")
    return re.sub(pattern, replacement, text, count=1, flags=flags), True

if not APP.exists() or not SERVER.exists():
    die("Run this from the BeatGaler repository root.")

app = APP.read_text(encoding="utf-8")
changed_any = False

if "PROJECT can be FLP/ALS and/or Audio/Sample/Samples" not in app:
    pattern = r'(?ms)^(\s*)const hasProjectSource\s*=\s*\n\s*!!uploaded\.flp_path\s*\|\|\s*!!uploaded\.als_path\s*\|\|\s*uploaded\.has_flp\s*\|\|\s*uploaded\.has_als;\s*\n\s*if\s*\(hasProjectSource\)\s*\{\s*\n\s*uploadStage\s*=\s*"Check PROJECT cloud state";\s*\n\s*const currentProject\s*=\s*await getProjectCloudStatus\(uploaded\);\s*\n\s*if\s*\(!currentProject\?\.synced\)\s*\{\s*\n\s*uploadStage\s*=\s*"Build and upload PROJECT\.zip";\s*\n\s*await uploadProjectToTelegram\(uploaded\);\s*\n\s*\}\s*\n\s*\}'
    m = re.search(pattern, app)
    if not m:
        die("App PROJECT resume: could not find current hasProjectSource block.")
    indent = m.group(1)
    replacement = f'''{indent}// PROJECT can be FLP/ALS and/or Audio/Sample/Samples. Rust is the single authority.
{indent}uploadStage = "Check PROJECT cloud state";
{indent}const currentProject = await getProjectCloudStatus(uploaded);
{indent}if (!currentProject?.synced) {{
{indent}  try {{
{indent}    uploadStage = "Build and upload PROJECT.zip";
{indent}    await uploadProjectToTelegram(uploaded);
{indent}  }} catch (projectError) {{
{indent}    const projectMessage = String(projectError instanceof Error ? projectError.message : projectError);
{indent}    if (!projectMessage.includes("No PROJECT assets were found")) throw projectError;
{indent}  }}
{indent}}}'''
    app = app[:m.start()] + replacement + app[m.end():]
    print("[OK]   App: Audio/Samples-only folders count as PROJECT")
    changed_any = True
else:
    print("[SKIP] App: PROJECT asset detection already applied")

if "self-contained v2 library index" not in app:
    pattern = r'(?ms)  // Keep one self-contained library index pinned in Telegram\. IMPORTANT:.*?\n  \}, \[beats, loading\]\);'
    replacement = '''  // Keep one self-contained v2 library index pinned in Telegram. It contains
  // active beats AND Trash, so an empty active library must still be synced.
  useEffect(() => {
    if (loading || !cloudAvailable || !settings?.telegram_cloud_connected) return;
    const cloudBacked = beats.filter(beat => !!beat.telegram_file_id);
    const fingerprint = cloudBacked.map(cloudBeatFingerprint).join("\\u001c");
    if (cloudLibrarySnapshotRef.current === fingerprint) return;
    cloudLibrarySnapshotRef.current = fingerprint;
    if (cloudLibraryTimerRef.current) window.clearTimeout(cloudLibraryTimerRef.current);
    cloudLibraryTimerRef.current = window.setTimeout(() => {
      cloudLibraryTimerRef.current = null;
      void syncCloudLibraryIndex(beats).catch(error => {
        console.warn("Telegram library index sync failed:", error);
      });
    }, 1800);
    return () => {
      if (cloudLibraryTimerRef.current) {
        window.clearTimeout(cloudLibraryTimerRef.current);
        cloudLibraryTimerRef.current = null;
      }
    };
  }, [beats, loading, cloudAvailable, settings?.telegram_cloud_connected]);'''
    app, _ = regex_replace_once(app, pattern, replacement, "App: sync Telegram index even for trash-only/empty active library")
    changed_any = True
else:
    print("[SKIP] App: v2 index sync already applied")

old_import = '''  const importDroppedPaths = useCallback(async (paths: string[]) => {
    const normalized = Array.from(new Set(paths.map(p => p.trim()).filter(Boolean)));'''
new_import = '''  const importDroppedPaths = useCallback(async (paths: string[]) => {
    if (!cloudAvailable) {
      await appAlert({ title: "You're offline", message: "Connect to the internet before importing beats." });
      return;
    }
    const normalized = Array.from(new Set(paths.map(p => p.trim()).filter(Boolean)));'''
if "Connect to the internet before importing beats." not in app:
    app, _ = replace_once(app, old_import, new_import, "App: block imports while offline")
    app = app.replace(
        "  }, [addBeatsAndReview, dropImporting]);\n",
        "  }, [addBeatsAndReview, dropImporting, cloudAvailable]);\n",
        1,
    )
    changed_any = True
else:
    print("[SKIP] App: offline import guard already applied")

if changed_any:
    backup(APP)
    APP.write_text(app, encoding="utf-8", newline="\n")

server = SERVER.read_text(encoding="utf-8")
server_changed = False

if "function validateLibraryManifest(manifest)" not in server:
    die("server.js is missing Stability Pass 1 helpers. Do not continue.")

if "function normalizeBeatName(value)" not in server:
    pattern = r'function validateLibraryManifest\(manifest\) \{.*?\n\}\n\nfunction collectTelegramFileIds'
    replacement = '''function normalizeBeatName(value) {
  return String(value || "").trim().replace(/\\s+/g, " ").toLocaleLowerCase();
}

function validateLibraryManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Library manifest must be a JSON object.");
  }
  if (!Array.isArray(manifest.beats)) {
    throw new Error("Library manifest must contain a beats array.");
  }
  if (manifest.trash !== undefined && !Array.isArray(manifest.trash)) {
    throw new Error("Library manifest trash must be an array.");
  }
  if (manifest.revision !== undefined &&
      (!Number.isSafeInteger(manifest.revision) || manifest.revision < 0)) {
    throw new Error("Library manifest revision must be a non-negative integer.");
  }

  const ids = new Set();
  const names = new Set();
  const validateBeat = (beat, location) => {
    if (!beat || typeof beat !== "object" || Array.isArray(beat)) {
      throw new Error(`${location} must be a beat object.`);
    }
    const id = String(beat.id || "").trim();
    const name = String(beat.name || "").trim();
    if (!id) throw new Error(`${location} must have an id.`);
    if (!name) throw new Error(`${location} must have a name.`);
    if (ids.has(id)) throw new Error(`Duplicate beat id in library manifest: ${id}`);
    ids.add(id);
    const normalizedName = normalizeBeatName(name);
    if (names.has(normalizedName)) throw new Error(`Duplicate beat name in library manifest: ${name}`);
    names.add(normalizedName);
  };

  manifest.beats.forEach((beat, index) => validateBeat(beat, `beats[${index}]`));
  for (const [index, item] of (manifest.trash || []).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !item.beat) {
      throw new Error(`trash[${index}] must contain a beat snapshot.`);
    }
    validateBeat(item.beat, `trash[${index}].beat`);
  }
  return manifest;
}

function collectTelegramFileIds'''
    server, _ = regex_replace_once(server, pattern, replacement, "Server: manifest v2 + unique beat names")
    server_changed = True
else:
    print("[SKIP] Server: v2 manifest validation already applied")

if "async function purgeRemovedTrashMessages" not in server:
    pattern = r'\nfunction rebuildOwnershipFromManifest\(\{ beatgalerUserId, account, manifest \}\) \{'
    helper = r'''
function collectTelegramMessageIds(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectTelegramMessageIds(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      (typeof child === "number" || typeof child === "string") &&
      normalized.includes("telegram") &&
      normalized.includes("message") &&
      normalized.includes("id")
    ) {
      const id = Number(child);
      if (Number.isFinite(id) && id > 0) out.add(id);
    }
    collectTelegramMessageIds(child, out);
  }
  return out;
}

async function purgeRemovedTrashMessages(account, previousManifest, nextManifest) {
  if (!previousManifest || !Array.isArray(previousManifest.trash)) return;
  const keepBeatIds = new Set([
    ...(nextManifest.beats || []).map(beat => String(beat?.id || "")),
    ...(nextManifest.trash || []).map(item => String(item?.beat?.id || "")),
  ].filter(Boolean));

  for (const item of previousManifest.trash) {
    const beatId = String(item?.beat?.id || "");
    if (!beatId || keepBeatIds.has(beatId)) continue;
    const messageIds = collectTelegramMessageIds(item.beat);
    for (const messageId of messageIds) {
      try {
        await bot.deleteMessage(account.telegramUserId, messageId);
      } catch (error) {
        const message = String(error?.message || error);
        if (!/message to delete not found|message_id_invalid|message not found/i.test(message)) {
          console.warn(`[trash] could not delete Telegram message ${messageId} for ${beatId}:`, message);
        }
      }
    }
  }
}

function rebuildOwnershipFromManifest({ beatgalerUserId, account, manifest }) {'''
    server, _ = regex_replace_once(server, pattern, "\n" + helper, "Server: Telegram Trash purge helper")
    server_changed = True
else:
    print("[SKIP] Server: Trash purge helper already applied")

if "creating one replacement" not in server:
    old = '''      } catch (editErr) {
        console.warn("Could not edit metadata message; creating a replacement:", editErr.message || editErr);
      }'''
    new = '''      } catch (editErr) {
        const message = String(editErr?.message || editErr);
        if (!/message (?:to edit )?not found|message_id_invalid/i.test(message)) {
          throw editErr;
        }
        console.warn(`[metadata] message ${existing} no longer exists; creating one replacement`);
      }'''
    server, _ = replace_once(server, old, new, "Server: metadata anti-duplicate rule")
    server_changed = True
else:
    print("[SKIP] Server: metadata anti-duplicate rule already applied")

if server_changed:
    backup(SERVER)
    SERVER.write_text(server, encoding="utf-8", newline="\n")

print()
print("BeatGaler Storage Rules Resume applied.")
print("Run:")
print("  npm run build")
print("  node --check .\\cloud-server\\server.js")
