import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const WRY_VERSION = "0.54.2";
const ORIGINAL_SHA256 = "ec03770d82dbbf47cbc3932a1b709bd8aed5a0914e20b6afdcc6629fed99c7ee";
const PATCHED_SHA256 = "2f1aec33cb5096e1a79343d64880ee7eb2d4c7515caabc2f827571cc9fb47887";
const PATCH_MARKER = "BEATGALER_OPTION2_PATCH_V2";
const PATCH_MARKER_PREFIX = "BEATGALER_OPTION2_PATCH_";
const MAC_ORIGINAL_SHA256 = "10bf1524a41d586810cae18d318629da3768e69a1b0ab59ad04dfd69840d83c7";
const MAC_PATCHED_SHA256 = "ef5b9952767ceb123dbd7f0c577c2020a99972fb354190cbb18926155b16a524";
const MAC_PATCH_MARKER_PREFIX = "BEATGALER_MAC_EXTERNAL_IMAGE_PATCH_";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const patchSource = path.join(scriptDir, "wry-patches", `wry-${WRY_VERSION}-drag_drop.rs`);
const macPatchSource = path.join(scriptDir, "wry-patches", `wry-${WRY_VERSION}-macos-drag_drop.rs`);

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function cargoHome() {
  return process.env.CARGO_HOME?.trim() || path.join(os.homedir(), ".cargo");
}

function findWryDragDrop() {
  const registrySrc = path.join(cargoHome(), "registry", "src");
  if (!existsSync(registrySrc)) return null;
  for (const indexDir of readdirSync(registrySrc, { withFileTypes: true })) {
    if (!indexDir.isDirectory()) continue;
    const candidate = path.join(
      registrySrc,
      indexDir.name,
      `wry-${WRY_VERSION}`,
      "src",
      "webview2",
      "drag_drop.rs",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureFetched() {
  let target = findWryDragDrop();
  if (target) return target;

  console.log(`[wry-pinterest] wry ${WRY_VERSION} is not cached yet; running cargo fetch`);
  const result = spawnSync(
    "cargo",
    ["fetch", "--manifest-path", path.join(repoRoot, "src-tauri", "Cargo.toml")],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo fetch failed with exit code ${result.status ?? "unknown"}`);
  }

  target = findWryDragDrop();
  if (!target) throw new Error(`Could not locate wry-${WRY_VERSION}/src/webview2/drag_drop.rs after cargo fetch.`);
  return target;
}

function findWryMacDragDrop() {
  const registrySrc = path.join(cargoHome(), "registry", "src");
  if (!existsSync(registrySrc)) return null;
  for (const indexDir of readdirSync(registrySrc, { withFileTypes: true })) {
    if (!indexDir.isDirectory()) continue;
    const candidate = path.join(
      registrySrc,
      indexDir.name,
      `wry-${WRY_VERSION}`,
      "src",
      "wkwebview",
      "drag_drop.rs",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureMacFetched() {
  let target = findWryMacDragDrop();
  if (target) return target;

  console.log(`[wry-pinterest] wry ${WRY_VERSION} macOS source is not cached yet; running cargo fetch`);
  const result = spawnSync(
    "cargo",
    ["fetch", "--manifest-path", path.join(repoRoot, "src-tauri", "Cargo.toml")],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo fetch failed with exit code ${result.status ?? "unknown"}`);
  }

  target = findWryMacDragDrop();
  if (!target) throw new Error(`Could not locate wry-${WRY_VERSION}/src/wkwebview/drag_drop.rs after cargo fetch.`);
  return target;
}

function installMacPatch() {
  if (!existsSync(macPatchSource)) throw new Error(`Missing BeatGaler macOS WRY patch source: ${macPatchSource}`);
  const sourceHash = sha256(macPatchSource);
  if (sourceHash !== MAC_PATCHED_SHA256) {
    throw new Error(`BeatGaler macOS WRY patch source changed unexpectedly (${sourceHash}). Expected ${MAC_PATCHED_SHA256}.`);
  }

  const target = ensureMacFetched();
  const currentHash = sha256(target);
  if (currentHash === MAC_PATCHED_SHA256) {
    console.log(`[wry-pinterest] OK: WRY ${WRY_VERSION} macOS external-image patch already active`);
    return;
  }

  const currentText = readFileSync(target, "utf8");
  if (currentHash !== MAC_ORIGINAL_SHA256 && !currentText.includes(MAC_PATCH_MARKER_PREFIX)) {
    throw new Error(
      `Refusing to overwrite unexpected WRY ${WRY_VERSION} macOS source (${currentHash}). ` +
      `Expected pristine ${MAC_ORIGINAL_SHA256}. Clean/re-fetch the Cargo registry copy first.`,
    );
  }

  const backup = `${target}.beatgaler-upstream`;
  if (!existsSync(backup) && currentHash === MAC_ORIGINAL_SHA256) copyFileSync(target, backup);
  const temp = `${target}.beatgaler-tmp`;
  writeFileSync(temp, readFileSync(macPatchSource));
  copyFileSync(temp, target);
  try {
    unlinkSync(temp);
  } catch {}

  const installedHash = sha256(target);
  if (installedHash !== MAC_PATCHED_SHA256) {
    throw new Error(`WRY macOS patch verification failed after write (${installedHash}).`);
  }
  console.log(`[wry-pinterest] PATCHED wry ${WRY_VERSION} src/wkwebview/drag_drop.rs`);
  console.log("[wry-pinterest] Finder filesystem paths remain first; browser image URL/HTML/string are bridged only when no file path exists");
}

const patchPlatform = process.env.BEATGALER_WRY_PATCH_PLATFORM?.trim() || process.platform;

if (patchPlatform === "darwin") {
  installMacPatch();
  process.exit(0);
}

if (patchPlatform !== "win32") {
  console.log("[wry-pinterest] non-Windows build: no WRY WebView2 patch needed");
  process.exit(0);
}

if (!existsSync(patchSource)) throw new Error(`Missing BeatGaler WRY patch source: ${patchSource}`);
const sourceHash = sha256(patchSource);
if (sourceHash !== PATCHED_SHA256) {
  throw new Error(`BeatGaler WRY patch source changed unexpectedly (${sourceHash}). Expected ${PATCHED_SHA256}.`);
}

const target = ensureFetched();
const currentHash = sha256(target);
if (currentHash === PATCHED_SHA256) {
  console.log(`[wry-pinterest] OK: WRY ${WRY_VERSION} Option 2 patch already active`);
  process.exit(0);
}

const currentText = readFileSync(target, "utf8");
if (currentHash !== ORIGINAL_SHA256 && !currentText.includes(PATCH_MARKER_PREFIX)) {
  throw new Error(
    `Refusing to overwrite unexpected WRY ${WRY_VERSION} source (${currentHash}). ` +
    `Expected pristine ${ORIGINAL_SHA256}. Clean/re-fetch the Cargo registry copy first.`,
  );
}

const backup = `${target}.beatgaler-upstream`;
if (!existsSync(backup) && currentHash === ORIGINAL_SHA256) {
  copyFileSync(target, backup);
}

// Write through a sibling temp file so an interrupted npm command cannot leave
// the Cargo registry source half-written.
const temp = `${target}.beatgaler-tmp`;
writeFileSync(temp, readFileSync(patchSource));
copyFileSync(temp, target);
try {
  // Keeping the tiny temp cleanup dependency-free and Windows-safe.
  const { unlinkSync } = await import("node:fs");
  unlinkSync(temp);
} catch {}

const installedHash = sha256(target);
if (installedHash !== PATCHED_SHA256) {
  throw new Error(`WRY patch verification failed after write (${installedHash}).`);
}

console.log(`[wry-pinterest] PATCHED wry ${WRY_VERSION} src/webview2/drag_drop.rs`);
console.log("[wry-pinterest] CF_HDROP local fast path remains first and bypasses all browser-format probes");

// Cargo registry crates are normally immutable. When replacing an older
// BeatGaler WRY patch, explicitly invalidate only WRY once so the new native
// DragEnter code cannot be hidden behind a stale compiled dependency.
if (currentText.includes(PATCH_MARKER_PREFIX)) {
  console.log(`[wry-pinterest] previous BeatGaler patch detected; cleaning compiled wry ${WRY_VERSION}`);
  const clean = spawnSync(
    "cargo",
    ["clean", "-p", "wry", "--manifest-path", path.join(repoRoot, "src-tauri", "Cargo.toml")],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (clean.error) throw clean.error;
  if (clean.status !== 0) {
    throw new Error(`cargo clean -p wry failed with exit code ${clean.status ?? "unknown"}`);
  }
}
