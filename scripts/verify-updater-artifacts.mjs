import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = path.join(root, "src-tauri", "target", "release", "bundle");

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(bundleRoot);
const installers = files.filter(f => /\.(exe|msi|AppImage|tar\.gz)$/i.test(f) && !/\.sig$/i.test(f));
const signatures = files.filter(f => /\.sig$/i.test(f));

if (installers.length === 0) {
  throw new Error(`No updater-capable release artifact found under ${bundleRoot}`);
}
if (signatures.length === 0) {
  throw new Error("No .sig updater signatures found. Ensure TAURI_SIGNING_PRIVATE_KEY is set and bundle.createUpdaterArtifacts=true.");
}

const missing = installers.filter(file => !fs.existsSync(`${file}.sig`));
if (missing.length) {
  throw new Error(`Unsigned updater artifact(s):\n${missing.map(f => ` - ${path.relative(root, f)}`).join("\n")}`);
}

for (const sig of signatures) {
  const text = fs.readFileSync(sig, "utf8").trim();
  if (text.length < 32) throw new Error(`Updater signature is empty/implausibly short: ${path.relative(root, sig)}`);
}

console.log(`PASS updater artifacts: ${installers.length} signed artifact(s), ${signatures.length} signature(s)`);
for (const file of installers) console.log(`  ${path.relative(root, file)}`);
