from pathlib import Path
import re, shutil, subprocess, sys

ROOT = Path.cwd()
APP = ROOT / "src" / "App.tsx"
TAURI = ROOT / "src" / "lib" / "tauri.ts"

for p in (APP, TAURI):
    if not p.exists():
        print(f"[ERROR] Missing {p}")
        sys.exit(1)

def backup(path):
    bak = Path(str(path) + ".pre-card-folder-update-v3.bak")
    if not bak.exists():
        shutil.copy2(path, bak)

backup(APP)
backup(TAURI)

# 1) Fix App.tsx declaration order.
app = APP.read_text(encoding="utf-8")

refresh_start = app.find("  const refreshOpenableCloudProjects = useCallback(async () => {")
update_start = app.find("  const updateExistingBeatFromFolder = useCallback")

if refresh_start < 0:
    print("[ERROR] Could not locate refreshOpenableCloudProjects in App.tsx")
    sys.exit(2)
if update_start < 0:
    print("[ERROR] Could not locate updateExistingBeatFromFolder in App.tsx")
    sys.exit(2)

refresh_end_marker = "  }, [beats, refreshOpenableCloudProjects]);"
refresh_end = app.find(refresh_end_marker, refresh_start)
if refresh_end < 0:
    print("[ERROR] Could not locate refreshOpenableCloudProjects effect end")
    sys.exit(2)
refresh_end += len(refresh_end_marker)

# Include trailing blank lines.
while refresh_end < len(app) and app[refresh_end] in "\r\n":
    refresh_end += 1

if refresh_start > update_start:
    refresh_block = app[refresh_start:refresh_end]
    app = app[:refresh_start] + app[refresh_end:]
    update_start = app.find("  const updateExistingBeatFromFolder = useCallback")
    app = app[:update_start] + refresh_block + "\n" + app[update_start:]
    print("[OK] moved refreshOpenableCloudProjects before folder-update handler")
else:
    print("[SKIP] refreshOpenableCloudProjects already appears first")

APP.write_text(app, encoding="utf-8", newline="\n")

# 2) Remove only redundant wrappers inserted by v2.
ts = TAURI.read_text(encoding="utf-8")

start = ts.find("export interface BeatFolderUpdatePreview")
end = ts.find("export interface ImportBatchPreview", start)

if start < 0 or end < 0:
    print("[ERROR] Could not locate BeatFolderUpdatePreview block in tauri.ts")
    sys.exit(3)

block = ts[start:end]

def remove_exported_async_function(text, name):
    marker = f"export async function {name}"
    pos = text.find(marker)
    if pos < 0:
        return text, False

    brace = text.find("{", pos)
    if brace < 0:
        return text, False

    depth = 0
    i = brace
    in_string = None
    escape = False
    while i < len(text):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
        else:
            if ch in ("'", '"', "`"):
                in_string = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    j = i + 1
                    while j < len(text) and text[j] in " \t\r\n":
                        j += 1
                    return text[:pos] + text[j:], True
        i += 1
    return text, False

for fn in (
    "uploadProjectToTelegram",
    "syncBeatMetadataToTelegram",
    "uploadDroppedFileToTelegram",
):
    removed_any = False
    while True:
        block2, removed = remove_exported_async_function(block, fn)
        if not removed:
            break
        block = block2
        removed_any = True
    if removed_any:
        print(f"[OK] removed redundant inserted wrapper: {fn}")
    else:
        print(f"[SKIP] no redundant {fn} wrapper inside inserted block")

ts = ts[:start] + block + ts[end:]

for fn in (
    "uploadProjectToTelegram",
    "syncBeatMetadataToTelegram",
    "uploadDroppedFileToTelegram",
):
    count = len(re.findall(rf"export async function {re.escape(fn)}\s*\(", ts))
    if count != 1:
        print(f"[ERROR] Expected exactly 1 {fn}, found {count}")
        sys.exit(4)
    print(f"[OK] {fn}: exactly one implementation remains")

for fn in (
    "inspectBeatUpdateFolder",
    "mergeFolderIntoExistingBeat",
    "listOpenableCloudProjectBeatIds",
):
    count = len(re.findall(rf"export async function {re.escape(fn)}\s*\(", ts))
    if count != 1:
        print(f"[ERROR] Expected exactly 1 {fn}, found {count}")
        sys.exit(5)
    print(f"[OK] {fn}: exactly one implementation exists")

TAURI.write_text(ts, encoding="utf-8", newline="\n")

npm = "npm.cmd" if sys.platform.startswith("win") else "npm"

print()
print("Running npm run build...")
result = subprocess.run([npm, "run", "build"])
if result.returncode != 0:
    print("[ERROR] npm build still fails. Do not restore; send me the new output.")
    sys.exit(result.returncode)

print()
print("Running cargo check...")
result = subprocess.run([
    "cargo", "check",
    "--manifest-path", str(ROOT / "src-tauri" / "Cargo.toml")
])
if result.returncode != 0:
    print("[ERROR] cargo check failed. Send me the full Rust error output.")
    sys.exit(result.returncode)

print()
print("[OK] v3 repair complete.")
print("Run:")
print("  npm run tauri dev")
