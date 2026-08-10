from pathlib import Path
import re, shutil, subprocess, sys

ROOT = Path.cwd()
SRC = ROOT / "src"
SERVER = ROOT / "cloud-server" / "server.js"
PUBLIC = ROOT / "public" / "beatgaler-icons"
PATCH_ICONS = ROOT / "patch-files" / "public" / "beatgaler-icons"

def fail(msg):
    print("[ERROR]", msg)
    sys.exit(1)

def backup(path):
    bak = Path(str(path) + ".pre-no-emoji-strict.bak")
    if not bak.exists():
        shutil.copy2(path, bak)

if not SRC.exists():
    fail("Run this from the BeatGaler repo root.")

PUBLIC.mkdir(parents=True, exist_ok=True)
shutil.copy2(PATCH_ICONS/"cloud.png", PUBLIC/"cloud.png")
shutil.copy2(PATCH_ICONS/"box.png", PUBLIC/"box.png")
print("[OK] installed transparent PNG icons")

icon_file = SRC / "components" / "BeatGalerIcon.tsx"
if icon_file.exists():
    backup(icon_file)
icon_file.write_text("""import React from "react";

export type BeatGalerIconName = "cloud" | "box";

export default function BeatGalerIcon({
  name,
  size = 14,
  title,
}: {
  name: BeatGalerIconName;
  size?: number;
  title?: string;
}) {
  return (
    <img
      src={`/beatgaler-icons/${name}.png`}
      alt=""
      aria-hidden={title ? undefined : true}
      title={title}
      style={{
        width: size,
        height: size,
        display: "inline-block",
        objectFit: "contain",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    />
  );
}
""", encoding="utf-8")
print("[OK] added BeatGalerIcon component")

emoji_re = re.compile(
    "["
    "\U0001F000-\U0001FAFF"
    "\U00002700-\U000027BF"
    "\U00002300-\U000023FF"
    "\U000025A0-\U000025FF"
    "\u2600-\u2604"
    "\u2607-\u26FF"
    "\uFE0E\uFE0F"
    "]"
)

changed = []

for path in list(SRC.rglob("*.tsx")) + list(SRC.rglob("*.ts")):
    text = path.read_text(encoding="utf-8")
    original = text

    if path.suffix == ".tsx":
        rel = path.relative_to(SRC)
        import_path = "./components/BeatGalerIcon" if len(rel.parts) == 1 else "./BeatGalerIcon"
        need_import = False

        replacements = [
            (r'>\s*(?:☁️|☁︎|☁)\s*<', '><BeatGalerIcon name="cloud" /><'),
            (r'>\s*📦\s*<', '><BeatGalerIcon name="box" /><'),
            (r'\{\s*["\'](?:☁️|☁︎|☁)["\']\s*\}', '<BeatGalerIcon name="cloud" />'),
            (r'\{\s*["\']📦["\']\s*\}', '<BeatGalerIcon name="box" />'),
        ]
        for pat, repl in replacements:
            new_text, n = re.subn(pat, repl, text)
            if n:
                text = new_text
                need_import = True

        if need_import and "import BeatGalerIcon" not in text:
            imports = list(re.finditer(r'^import .*?;\s*$', text, flags=re.M))
            line = f'import BeatGalerIcon from "{import_path}";'
            if imports:
                pos = imports[-1].end()
                text = text[:pos] + "\n" + line + text[pos:]
            else:
                text = line + "\n" + text

    text = emoji_re.sub("", text)
    text = text.replace("\u200d", "").replace("\u20e3", "")

    if text != original:
        backup(path)
        path.write_text(text, encoding="utf-8")
        changed.append(str(path.relative_to(ROOT)))

if SERVER.exists():
    text = SERVER.read_text(encoding="utf-8")
    original = text
    text = emoji_re.sub("", text).replace("\u200d", "").replace("\u20e3", "")
    if text != original:
        backup(SERVER)
        SERVER.write_text(text, encoding="utf-8")
        changed.append(str(SERVER.relative_to(ROOT)))

print(f"[OK] cleaned {len(changed)} source file(s)")

remaining = []
audit_files = list(SRC.rglob("*.tsx")) + list(SRC.rglob("*.ts"))
if SERVER.exists():
    audit_files.append(SERVER)

for path in audit_files:
    txt = path.read_text(encoding="utf-8")
    for m in emoji_re.finditer(txt):
        remaining.append((str(path.relative_to(ROOT)), f"U+{ord(m.group(0)):04X}", m.group(0)))
        if len(remaining) >= 30:
            break
    if len(remaining) >= 30:
        break

if remaining:
    print("[ERROR] emoji audit still found characters:")
    for item in remaining:
        print(" ", item)
    sys.exit(2)

print("[OK] strict emoji audit: 0 remaining emoji-range characters")

npm = "npm.cmd" if sys.platform.startswith("win") else "npm"
if (ROOT/"package.json").exists():
    result = subprocess.run([npm, "run", "build"])
    if result.returncode != 0:
        fail("npm run build failed; backups were preserved.")
    print("[OK] npm run build")

if SERVER.exists():
    result = subprocess.run(["node", "--check", str(SERVER)])
    if result.returncode != 0:
        fail("server.js syntax check failed.")
    print("[OK] node --check server.js")

print("")
print("No-emoji strict pass complete.")
print("Cloud uses /beatgaler-icons/cloud.png")
print("Project/package uses /beatgaler-icons/box.png")
print("Star symbols are preserved for ratings/upload animation.")
