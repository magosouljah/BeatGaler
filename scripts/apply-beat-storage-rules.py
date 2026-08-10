#!/usr/bin/env python3
from pathlib import Path
import re, shutil, subprocess, sys, json

ROOT = Path.cwd()
APP = ROOT / 'src' / 'App.tsx'
SERVER = ROOT / 'cloud-server' / 'server.js'
COMMANDS = ROOT / 'src-tauri' / 'src' / 'commands.rs'
PATCH = Path(__file__).resolve().parent.parent / 'patches' / 'commands-storage-rules.patch'


def die(msg):
    print(f'[ERROR] {msg}')
    sys.exit(1)


def backup(path):
    bak = path.with_suffix(path.suffix + '.storage-rules.bak')
    if not bak.exists():
        shutil.copy2(path, bak)


def replace_once(text, old, new, label):
    if new in text:
        print(f'[SKIP] {label}: already applied')
        return text, False
    count = text.count(old)
    if count != 1:
        die(f'{label}: expected exactly 1 match, found {count}. Your branch changed; no blind patch was applied.')
    print(f'[OK]   {label}')
    return text.replace(old, new, 1), True


def regex_replace_once(text, pattern, replacement, label, flags=re.S):
    if re.search(pattern, text, flags) is None:
        # Some transformations have an explicit marker in the replacement.
        marker = replacement.splitlines()[0].strip() if replacement.strip() else ''
        if marker and marker in text:
            print(f'[SKIP] {label}: already applied')
            return text, False
        die(f'{label}: target block not found. Your branch changed; no blind patch was applied.')
    out, n = re.subn(pattern, replacement, text, count=1, flags=flags)
    if n != 1:
        die(f'{label}: expected one block, replaced {n}.')
    print(f'[OK]   {label}')
    return out, True


for path in (APP, SERVER, COMMANDS, PATCH):
    if not path.exists():
        die(f'Missing {path}. Extract this ZIP into the BeatGaler repository root and run again.')

# ────────────────────────────────────────────────────────────────────────────
# Rust: storage model, PROJECT rules, unique names, manifest v2 + Trash.
# Previous Stability Pass 1 did not touch commands.rs, so use a strict git patch.
# ────────────────────────────────────────────────────────────────────────────
patch_text = PATCH.read_text(encoding='utf-8')
if 'BeatGaler storage rules v2' in COMMANDS.read_text(encoding='utf-8'):
    print('[SKIP] Rust storage model: already applied')
else:
    backup(COMMANDS)
    check = subprocess.run(['git', 'apply', '--check', str(PATCH)], cwd=ROOT, capture_output=True, text=True)
    if check.returncode != 0:
        die('Rust patch does not match this commands.rs. Restore/use beatgaler-cloud-beta plus Stability Pass 1.\n' + (check.stderr or check.stdout))
    apply = subprocess.run(['git', 'apply', str(PATCH)], cwd=ROOT, capture_output=True, text=True)
    if apply.returncode != 0:
        die('Could not apply Rust patch:\n' + (apply.stderr or apply.stdout))
    # Marker for idempotence and future audits.
    s = COMMANDS.read_text(encoding='utf-8')
    marker = '// BeatGaler storage rules v2: canonical MASTER/WAV/PROJECT/METADATA/ARTWORK/TRASH slots.\n'
    insert_at = s.find('\n') + 1
    s = s[:insert_at] + marker + s[insert_at:]
    COMMANDS.write_text(s, encoding='utf-8', newline='\n')
    print('[OK]   Rust storage model + PROJECT/Trash/name rules')

# ────────────────────────────────────────────────────────────────────────────
# App.tsx: Spotify-style offline visibility, project assets, master-only play,
# and index sync even when the last active beat moves into Trash.
# ────────────────────────────────────────────────────────────────────────────
app = APP.read_text(encoding='utf-8')
app_changed = False

if 'const [cloudAvailable, setCloudAvailable]' not in app:
    app, changed = replace_once(
        app,
        '  const [settings, setSettings] = useState<AppSettings | null>(null);\n',
        '  const [settings, setSettings] = useState<AppSettings | null>(null);\n  // Network visibility is separate from durable local cache. Offline hides the vault; it never deletes it.\n  const [cloudAvailable, setCloudAvailable] = useState(false);\n',
        'App: add cloudAvailable state',
    )
    app_changed |= changed
else:
    print('[SKIP] App: cloudAvailable state already exists')

startup_pattern = r'''  useEffect\(\(\) => \{\n    let cancelled = false;\n    void \(async \(\) => \{.*?\n  \}, \[\]\);\n\n  useEffect\(\(\) => \{\n    const styleId = "beatgaler-custom-cursor-style";'''
startup_replacement = '''  useEffect(() => {\n    let cancelled = false;\n    void (async () => {\n      try {\n        // Paint cached/local data immediately, but the grid remains hidden until Cloud is reachable.\n        const local = await getSettings();\n        if (cancelled) return;\n        setSettings(local);\n        setSetupDone(true);\n        setLoading(false);\n\n        let status: Awaited<ReturnType<typeof pollTelegramCloudStatus>>;\n        try {\n          status = await pollTelegramCloudStatus();\n        } catch (error) {\n          console.warn("Telegram startup status check failed; keeping cache hidden, not deleting it:", error);\n          if (!cancelled) setCloudAvailable(false);\n          return;\n        }\n        if (cancelled) return;\n\n        if (!status.connected) {\n          // Disconnected/unreachable is a visibility state, NOT a delete operation.\n          setCloudAvailable(false);\n          setSettings(current => current\n            ? { ...current, telegram_cloud_connected: false, telegram_cloud_username: null }\n            : local\n          );\n          return;\n        }\n\n        await restoreLibraryFromTelegram();\n        const restored = await loadLibrary();\n        if (cancelled) return;\n        setBeats(restored);\n        setCloudAvailable(true);\n        setSettings(current => current\n          ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username }\n          : local\n        );\n      } catch (error) {\n        console.warn("Telegram vault startup check failed:", error);\n        if (!cancelled) {\n          setCloudAvailable(false);\n          setSetupDone(true);\n          setLoading(false);\n        }\n      }\n    })();\n    return () => { cancelled = true; };\n  }, []);\n\n  useEffect(() => {\n    const styleId = "beatgaler-custom-cursor-style";'''
if 'keeping cache hidden, not deleting it' not in app:
    app, changed = regex_replace_once(app, startup_pattern, startup_replacement, 'App: Spotify-style startup/offline behavior')
    app_changed |= changed
else:
    print('[SKIP] App: Spotify startup already applied')

sse_pattern = r'''  // Telegram/BeatGaler synchronization is push-based\.\n  // There is no timer and no focus-triggered full library scan\.\n  useEffect\(\(\) => \{.*?\n  \}, \[setupDone, settings\?\.beatgaler_user_id\]\);'''
sse_replacement = '''  // Telegram/BeatGaler synchronization is push-based.\n  // EventSource connectivity controls VISIBILITY only; SQLite/cache is never erased here.\n  useEffect(() => {\n    const userId = settings?.beatgaler_user_id;\n    if (!setupDone || !userId) {\n      setCloudAvailable(false);\n      return;\n    }\n    const sourceId = getCloudClientId();\n    const url =\n      `https://desktop-7l93a0j.tailabe8ff.ts.net/events?beatgalerUserId=${encodeURIComponent(userId)}` +\n      `&sourceId=${encodeURIComponent(sourceId)}`;\n    const events = new EventSource(url);\n    let cancelled = false;\n\n    const applyRemoteLibraryChange = async () => {\n      if (cancelled || cloudPullInFlightRef.current) return;\n      cloudPullInFlightRef.current = true;\n      try {\n        await restoreLibraryFromTelegram();\n        const merged = await loadLibrary();\n        if (!cancelled) {\n          setCloudAvailable(true);\n          const nextFingerprint = libraryViewFingerprint(merged);\n          if (nextFingerprint !== visibleLibraryFingerprintRef.current) {\n            visibleLibraryFingerprintRef.current = nextFingerprint;\n            setBeats(merged);\n          }\n        }\n      } catch (error) {\n        if (!cancelled) setCloudAvailable(false);\n        console.warn("Telegram event sync failed:", error);\n      } finally {\n        cloudPullInFlightRef.current = false;\n      }\n    };\n\n    const verifyConnection = async () => {\n      try {\n        const status = await pollTelegramCloudStatus();\n        if (cancelled) return;\n        setCloudAvailable(!!status.connected);\n        setSettings(current => current\n          ? { ...current, telegram_cloud_connected: !!status.connected, telegram_cloud_username: status.connected ? status.username : null }\n          : current\n        );\n        if (status.connected) await applyRemoteLibraryChange();\n      } catch (error) {\n        if (!cancelled) setCloudAvailable(false);\n        console.warn("Cloud connection verification failed:", error);\n      }\n    };\n\n    const onLibraryChanged = () => { void applyRemoteLibraryChange(); };\n    const onTelegramConnected = () => { void verifyConnection(); };\n    events.onopen = () => { void verifyConnection(); };\n    events.addEventListener("library_changed", onLibraryChanged);\n    events.addEventListener("telegram_connected", onTelegramConnected);\n    events.onerror = () => {\n      // EventSource reconnects automatically. Hide the vault while the connection is down.\n      if (!cancelled) setCloudAvailable(false);\n    };\n\n    return () => {\n      cancelled = true;\n      events.removeEventListener("library_changed", onLibraryChanged);\n      events.removeEventListener("telegram_connected", onTelegramConnected);\n      events.close();\n    };\n  }, [setupDone, settings?.beatgaler_user_id]);'''
if 'EventSource connectivity controls VISIBILITY only' not in app:
    app, changed = regex_replace_once(app, sse_pattern, sse_replacement, 'App: Cloud push connection controls vault visibility')
    app_changed |= changed
else:
    print('[SKIP] App: push/offline visibility already applied')

# Stop audio immediately when Cloud disappears.
anchor = '''  useEffect(() => {\n    visibleLibraryFingerprintRef.current = libraryViewFingerprint(beats);\n  }, [beats]);'''
stop_effect = anchor + '''\n\n  useEffect(() => {\n    if (!cloudAvailable) releaseFile();\n  }, [cloudAvailable, releaseFile]);'''
if 'if (!cloudAvailable) releaseFile();' not in app:
    app, changed = replace_once(app, anchor, stop_effect, 'App: stop playback when offline')
    app_changed |= changed
else:
    print('[SKIP] App: offline playback stop already applied')

# Play only the canonical MASTER path, and never when offline.
play_pattern = r'''  const handlePlay = useCallback\(async \(beat: Beat\) => \{.*?\n  \}, \[play\]\);\n  const handleUpload = useCallback'''
play_replacement = '''  const handlePlay = useCallback(async (beat: Beat) => {\n    if (!cloudAvailable) {\n      await appAlert({ title: "You're offline", message: "Connect to the internet to access your BeatGaler library." });\n      return;\n    }\n    try {\n      const ready = await prepareBeatForPlayback(beat);\n      if (ready.cloud_status !== beat.cloud_status) {\n        setBeats(bs => bs.map(b => b.id === ready.id ? { ...b, cloud_status: ready.cloud_status } : b));\n      }\n      // MASTER is the only playback source. WAV is storage/HQ only.\n      play(ready.id, [ready.playback_path]);\n    } catch (e: any) {\n      await appAlert({\n        title: "Beat unavailable",\n        message: String(e?.message || e),\n        danger: true,\n      });\n    }\n  }, [cloudAvailable, play]);\n  const handleUpload = useCallback'''
if 'MASTER is the only playback source. WAV is storage/HQ only.' not in app:
    app, changed = regex_replace_once(app, play_pattern, play_replacement, 'App: canonical MASTER-only playback + offline guard')
    app_changed |= changed
else:
    print('[SKIP] App: MASTER-only play guard already applied')

# Background project upload: always ask Rust whether a canonical PROJECT can be built.
old_project = '''              const hasProjectSource =\n                !!uploaded.flp_path || !!uploaded.als_path || uploaded.has_flp || uploaded.has_als;\n              if (hasProjectSource) {\n                uploadStage = "Check PROJECT cloud state";\n                const currentProject = await getProjectCloudStatus(uploaded);\n                if (!currentProject?.synced) {\n                  uploadStage = "Build and upload PROJECT.zip";\n                  await uploadProjectToTelegram(uploaded);\n                }\n              }'''
new_project = '''              // PROJECT can be FLP/ALS and/or Audio/Sample/Samples. Rust is the single authority.\n              uploadStage = "Check PROJECT cloud state";\n              const currentProject = await getProjectCloudStatus(uploaded);\n              if (!currentProject?.synced) {\n                try {\n                  uploadStage = "Build and upload PROJECT.zip";\n                  await uploadProjectToTelegram(uploaded);\n                } catch (projectError) {\n                  const projectMessage = String(projectError instanceof Error ? projectError.message : projectError);\n                  // A beat is allowed to have no PROJECT slot at all.\n                  if (!projectMessage.includes("No PROJECT assets were found")) throw projectError;\n                }\n              }'''
if 'PROJECT can be FLP/ALS and/or Audio/Sample/Samples' not in app:
    app, changed = replace_once(app, old_project, new_project, 'App: Audio/Samples-only folders count as PROJECT')
    app_changed |= changed
else:
    print('[SKIP] App: PROJECT asset detection already applied')

# Sync the pinned index even when active cloud list becomes empty; trash may still exist.
index_pattern = r'''  // Keep one self-contained library index pinned in Telegram\. IMPORTANT:.*?\n  \}, \[beats, loading\]\);'''
index_replacement = '''  // Keep one self-contained v2 library index pinned in Telegram. It contains\n  // active beats AND Trash, so an empty active library must still be synced.\n  useEffect(() => {\n    if (loading || !cloudAvailable || !settings?.telegram_cloud_connected) return;\n    const cloudBacked = beats.filter(beat => !!beat.telegram_file_id);\n    const fingerprint = cloudBacked.map(cloudBeatFingerprint).join("\\u001c");\n    if (cloudLibrarySnapshotRef.current === fingerprint) return;\n    cloudLibrarySnapshotRef.current = fingerprint;\n    if (cloudLibraryTimerRef.current) window.clearTimeout(cloudLibraryTimerRef.current);\n    cloudLibraryTimerRef.current = window.setTimeout(() => {\n      cloudLibraryTimerRef.current = null;\n      void syncCloudLibraryIndex(beats).catch(error => {\n        console.warn("Telegram library index sync failed:", error);\n      });\n    }, 1800);\n    return () => {\n      if (cloudLibraryTimerRef.current) {\n        window.clearTimeout(cloudLibraryTimerRef.current);\n        cloudLibraryTimerRef.current = null;\n      }\n    };\n  }, [beats, loading, cloudAvailable, settings?.telegram_cloud_connected]);'''
if 'self-contained v2 library index' not in app:
    app, changed = regex_replace_once(app, index_pattern, index_replacement, 'App: sync Telegram index even for trash-only/empty active library')
    app_changed |= changed
else:
    print('[SKIP] App: v2 index sync already applied')

# Drag/drop import guard while offline.
old_import = '''  const importDroppedPaths = useCallback(async (paths: string[]) => {\n    const normalized = Array.from(new Set(paths.map(p => p.trim()).filter(Boolean)));'''
new_import = '''  const importDroppedPaths = useCallback(async (paths: string[]) => {\n    if (!cloudAvailable) {\n      await appAlert({ title: "You're offline", message: "Connect to the internet before importing beats." });\n      return;\n    }\n    const normalized = Array.from(new Set(paths.map(p => p.trim()).filter(Boolean)));'''
if 'Connect to the internet before importing beats.' not in app:
    app, changed = replace_once(app, old_import, new_import, 'App: block imports while offline')
    app_changed |= changed
    app = app.replace('  }, [addBeatsAndReview, dropImporting]);\n', '  }, [addBeatsAndReview, dropImporting, cloudAvailable]);\n', 1)
else:
    print('[SKIP] App: offline import guard already applied')

# Offline screen before empty/search state.
offline_old = '''        {loading ? (\n          <div style={{ textAlign: "center", paddingTop: 80, color: "#333", fontSize: 13 }}>Loading library…</div>\n        ) : filteredBeats.length === 0 ? ('''
offline_new = '''        {loading ? (\n          <div style={{ textAlign: "center", paddingTop: 80, color: "#333", fontSize: 13 }}>Loading library…</div>\n        ) : !cloudAvailable ? (\n          <div style={{ textAlign: "center", paddingTop: 80, color: "#777", fontSize: 13 }}>\n            <div style={{ color: "#ddd", fontSize: 17, fontWeight: 650 }}>You're offline</div>\n            <div style={{ marginTop: 8 }}>Connect to the internet to access your BeatGaler library.</div>\n            <div style={{ marginTop: 5, color: "#4f4f4f", fontSize: 11 }}>Your local cache is preserved; it is only hidden while Cloud is unavailable.</div>\n          </div>\n        ) : filteredBeats.length === 0 ? ('''
if 'Your local cache is preserved; it is only hidden' not in app:
    app, changed = replace_once(app, offline_old, offline_new, 'App: Spotify-style offline screen')
    app_changed |= changed
else:
    print('[SKIP] App: offline screen already applied')

# Hide player if cloud is unavailable.
if '{cloudAvailable && currentBeat && (' not in app:
    app, changed = replace_once(app, '      {currentBeat && (\n        <Player', '      {cloudAvailable && currentBeat && (\n        <Player', 'App: hide Player offline')
    app_changed |= changed
else:
    print('[SKIP] App: Player offline visibility already applied')

if app_changed:
    backup(APP)
    APP.write_text(app, encoding='utf-8', newline='\n')

# ────────────────────────────────────────────────────────────────────────────
# cloud-server/server.js: manifest v2 validation, unique names, Trash purge,
# and no duplicate metadata/artwork messages on transient edit errors.
# Requires Stability Pass 1 helpers (validateLibraryManifest, collectTelegramFileIds).
# ────────────────────────────────────────────────────────────────────────────
server = SERVER.read_text(encoding='utf-8')
server_changed = False

if 'function validateLibraryManifest(manifest)' not in server:
    die('cloud-server/server.js does not contain Stability Pass 1 validation helpers. Apply BeatGaler-Stability-Pass-1 first.')

validate_pattern = r'''function validateLibraryManifest\(manifest\) \{.*?\n\}\n\nfunction collectTelegramFileIds'''
validate_replacement = '''function normalizeBeatName(value) {\n  return String(value || "").trim().replace(/\\s+/g, " ").toLocaleLowerCase();\n}\n\nfunction validateLibraryManifest(manifest) {\n  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {\n    throw new Error("Library manifest must be a JSON object.");\n  }\n  if (!Array.isArray(manifest.beats)) {\n    throw new Error("Library manifest must contain a beats array.");\n  }\n  if (manifest.trash !== undefined && !Array.isArray(manifest.trash)) {\n    throw new Error("Library manifest trash must be an array.");\n  }\n  if (manifest.revision !== undefined &&\n      (!Number.isSafeInteger(manifest.revision) || manifest.revision < 0)) {\n    throw new Error("Library manifest revision must be a non-negative integer.");\n  }\n\n  const ids = new Set();\n  const names = new Set();\n  const validateBeat = (beat, location) => {\n    if (!beat || typeof beat !== "object" || Array.isArray(beat)) {\n      throw new Error(`${location} must be a beat object.`);\n    }\n    const id = String(beat.id || "").trim();\n    const name = String(beat.name || "").trim();\n    if (!id) throw new Error(`${location} must have an id.`);\n    if (!name) throw new Error(`${location} must have a name.`);\n    if (ids.has(id)) throw new Error(`Duplicate beat id in library manifest: ${id}`);\n    ids.add(id);\n    const normalizedName = normalizeBeatName(name);\n    if (names.has(normalizedName)) throw new Error(`Duplicate beat name in library manifest: ${name}`);\n    names.add(normalizedName);\n  };\n\n  manifest.beats.forEach((beat, index) => validateBeat(beat, `beats[${index}]`));\n  for (const [index, item] of (manifest.trash || []).entries()) {\n    if (!item || typeof item !== "object" || Array.isArray(item) || !item.beat) {\n      throw new Error(`trash[${index}] must contain a beat snapshot.`);\n    }\n    validateBeat(item.beat, `trash[${index}].beat`);\n  }\n  return manifest;\n}\n\nfunction collectTelegramFileIds'''
if 'function normalizeBeatName(value)' not in server:
    server, changed = regex_replace_once(server, validate_pattern, validate_replacement, 'Server: validate manifest v2 + unique beat names')
    server_changed |= changed
else:
    print('[SKIP] Server: v2 manifest validation already applied')

# Add message-id collection and Trash purge helper before ownership rebuild.
marker = 'async function purgeRemovedTrashMessages'
if marker not in server:
    anchor_pattern = r'''\nfunction rebuildOwnershipFromManifest\(\{ beatgalerUserId, account, manifest \}\) \{'''
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
      normalized.includes("telegram") && normalized.includes("message") && normalized.includes("id")
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
    if (!beatId || keepBeatIds.has(beatId)) continue; // restored or still in Trash
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
    server, changed = regex_replace_once(server, anchor_pattern, '\n' + helper, 'Server: add Telegram Trash purge helper')
    server_changed |= changed
else:
    print('[SKIP] Server: Trash purge helper already applied')

# Capture old manifest in /library/upsert after obtaining existing pinned document.
old_existing = '''    const existing = await getPinnedLibraryIndex(account);\n    let sent;'''
new_existing = '''    const existing = await getPinnedLibraryIndex(account);\n    let previousManifest = null;\n    if (existing?.document?.file_id) {\n      try {\n        const previousRaw = await downloadTelegramFileBuffer(existing.document.file_id);\n        previousManifest = validateLibraryManifest(JSON.parse(previousRaw.toString("utf8")));\n      } catch (error) {\n        console.warn("[library] could not read previous index for Trash reconciliation:", error?.message || error);\n      }\n    }\n    let sent;'''
if 'previousManifest = null;' not in server:
    server, changed = replace_once(server, old_existing, new_existing, 'Server: retain previous pinned index for Trash reconciliation')
    server_changed |= changed
else:
    print('[SKIP] Server: previous index capture already applied')

# After Telegram accepted the new root index, purge slots that expired from Trash.
old_document = '''    const document = sent?.document;\n    if (!document?.file_id) throw new Error("Telegram returned no library index file_id");\n    cleanup();'''
new_document = '''    const document = sent?.document;\n    if (!document?.file_id) throw new Error("Telegram returned no library index file_id");\n    // Only after the new index is durable may expired Trash slots be deleted.\n    await purgeRemovedTrashMessages(account, previousManifest, parsedManifest);\n    cleanup();'''
if 'purgeRemovedTrashMessages(account, previousManifest, parsedManifest)' not in server:
    server, changed = replace_once(server, old_document, new_document, 'Server: purge Telegram slot messages after 14-day Trash expiry')
    server_changed |= changed
else:
    print('[SKIP] Server: Trash purge call already applied')

# Metadata: only create a replacement when Telegram definitively says old message is gone.
metadata_old = '''      } catch (editErr) {\n        console.warn("Could not edit metadata message; creating a replacement:", editErr.message || editErr);\n      }'''
metadata_new = '''      } catch (editErr) {\n        const message = String(editErr?.message || editErr);\n        if (!/message (?:to edit )?not found|message_id_invalid/i.test(message)) {\n          throw editErr;\n        }\n        console.warn(`[metadata] message ${existing} no longer exists; creating one replacement`);\n      }'''
if 'creating one replacement' not in server:
    server, changed = replace_once(server, metadata_old, metadata_new, 'Server: metadata edit failures cannot create duplicates')
    server_changed |= changed
else:
    print('[SKIP] Server: metadata anti-duplicate rule already applied')

# Artwork: use the same controlled edit/repair path as MASTER/WAV/PROJECT.
art_pattern = r'''    let sent;\n    let updated = false;\n    if \(Number\.isFinite\(existing\) && existing > 0\) \{.*?\n    \}\n\n    const media = sent\?\.document'''
art_replacement = '''    const { message: sent, updated } = await sendOrReplaceTelegramDocument({\n      account,\n      existingMessageId: artworkMessageId,\n      filePath: req.file.path,\n      filename,\n      caption,\n      replyToMessageId: parentMessageId,\n    });\n\n    const media = sent?.document'''
if 'existingMessageId: artworkMessageId' not in server:
    server, changed = regex_replace_once(server, art_pattern, art_replacement, 'Server: artwork uses canonical edit/repair path')
    server_changed |= changed
else:
    print('[SKIP] Server: artwork canonical replacement already applied')

if server_changed:
    backup(SERVER)
    SERVER.write_text(server, encoding='utf-8', newline='\n')

print('\nBeatGaler Beat Storage Rules Pass applied.')
print('Run:')
print('  npm run build')
print('  node --check .\\cloud-server\\server.js')
print('  npm run tauri dev')
