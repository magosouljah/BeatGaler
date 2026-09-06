import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function requireText(value, text, message) {
  if (!value.includes(text)) throw new Error(message);
}

function rejectText(value, text, message) {
  if (value.includes(text)) throw new Error(message);
}

const windowsConfig = JSON.parse(read("src-tauri/tauri.windows-release.conf.json"));
const resources = windowsConfig?.bundle?.resources ?? {};
for (const [source, target] of [
  ["resources/windows/ffmpeg.exe", "ffmpeg.exe"],
  ["resources/windows/node.exe", "node.exe"],
  ["resources/windows/telegram-bot-api.exe", "telegram-bot-api.exe"],
  ["resources/windows/libssl-3-x64.dll", "libssl-3-x64.dll"],
  ["resources/windows/libcrypto-3-x64.dll", "libcrypto-3-x64.dll"],
  ["resources/windows/z.dll", "z.dll"],
  ["direct-transport/transport-helper.cjs", "direct-transport/transport-helper.cjs"],
  ["direct-transport/runtime-watchdog.cjs", "direct-transport/runtime-watchdog.cjs"],
]) {
  if (resources[source] !== target) throw new Error(`Windows bundle is missing ${source} -> ${target}`);
}

const rust = read("src-tauri/src/commands.rs");
requireText(rust, 'if cfg!(target_os = "windows") { "ffmpeg.exe" }', "Windows runtime lookup does not select ffmpeg.exe");
requireText(rust, 'if cfg!(target_os = "windows") { "node.exe" }', "Windows runtime lookup does not select node.exe");
requireText(rust, 'if cfg!(target_os = "windows") { "telegram-bot-api.exe" }', "Windows runtime lookup does not select telegram-bot-api.exe");

const workflow = read(".github/workflows/build-windows.yml");
for (const [needle, message] of [
  ["release-manifest.mjs github-env", "Workflow must load the canonical release manifest"],
  ["BEATGALER_BOT_API_COMMIT", "Telegram Bot API source must come from the canonical runtime manifest"],
  ["BEATGALER_VCPKG_COMMIT", "vcpkg source must come from the canonical runtime manifest"],
  ["BEATGALER_FFMPEG_WINDOWS_ASSET", "FFmpeg source must come from the canonical runtime manifest"],
  ["gperf:x64-windows openssl:x64-windows zlib:x64-windows", "Telegram Bot API must use the official Windows dynamic dependency triplet"],
  ["-DVCPKG_TARGET_TRIPLET=x64-windows", "Telegram Bot API CMake build must use x64-windows"],
  ["libssl-3-x64.dll", "Workflow must carry the OpenSSL runtime DLL"],
  ["libcrypto-3-x64.dll", "Workflow must carry the OpenSSL crypto runtime DLL"],
  ["z.dll", "Workflow must carry the zlib runtime DLL"],
  ['$resourceDir = "src-tauri/resources/windows"', "Workflow must stage runtimes in the Windows Tauri resource directory"],
  ["$resourceDir/ffmpeg.exe", "Workflow must stage ffmpeg.exe for Tauri"],
  ["$resourceDir/node.exe", "Workflow must stage node.exe for Tauri"],
  ["$resourceDir/telegram-bot-api.exe", "Workflow must stage telegram-bot-api.exe for Tauri"],
  ["tauri.windows-release.conf.json", "Windows build must use the release-only Windows resource config"],
  ["Verify installed Windows runtimes", "Workflow must inspect the completed installer"],
  ["& $ffmpeg -version", "Installed FFmpeg must be executable"],
  ["& $bot --help", "Installed Telegram Bot API must be executable"],
]) requireText(workflow, needle, message);
rejectText(workflow, "x64-windows-static", "Telegram Bot API must not use the incompatible x64-windows-static recipe");

const devLauncher = read("scripts/run-tauri.ps1");
requireText(devLauncher, "prepare-windows-bot-api-runtime.ps1", "Desktop dev must prepare the pinned Bot API runtime before Tauri starts");
const devRuntime = read("scripts/prepare-windows-bot-api-runtime.ps1");
for (const [needle, message] of [
  ["supply-chain\\runtime-sources.json", "Dev runtime must use the canonical runtime source manifest"],
  ['$triplet = "x64-windows"', "Dev runtime must use the known-good dynamic Windows triplet"],
  ["telegram-bot-api.provenance.json", "Dev runtime must persist provenance instead of trusting an arbitrary ignored executable"],
  ["libssl-3-x64.dll", "Dev runtime must stage libssl"],
  ["libcrypto-3-x64.dll", "Dev runtime must stage libcrypto"],
  ["z.dll", "Dev runtime must stage zlib"],
  ["Get-FileHash", "Dev runtime provenance must verify file content hashes"],
]) requireText(devRuntime, needle, message);
rejectText(devRuntime, "D:\\BeatGalerBotAPI", "Dev runtime must not depend on the historical D:\\BeatGalerBotAPI build");

console.log("PASS Windows packaging guard: pinned dynamic Telegram Bot API runtime + DLL bundle is prepared for dev, bundled for release, and digest-verified");
