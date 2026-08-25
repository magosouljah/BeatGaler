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

const windowsConfig = JSON.parse(read("src-tauri/tauri.windows-release.conf.json"));
const resources = windowsConfig?.bundle?.resources ?? {};
for (const [source, target] of [
  ["resources/windows/node.exe", "node.exe"],
  ["resources/windows/telegram-bot-api.exe", "telegram-bot-api.exe"],
  ["direct-transport/transport-helper.cjs", "direct-transport/transport-helper.cjs"],
  ["direct-transport/runtime-watchdog.cjs", "direct-transport/runtime-watchdog.cjs"],
]) {
  if (resources[source] !== target) throw new Error(`Windows bundle is missing ${source} -> ${target}`);
}

const rust = read("src-tauri/src/commands.rs");
requireText(rust, 'if cfg!(target_os = "windows") { "node.exe" }', "Windows runtime lookup does not select node.exe");
requireText(rust, 'if cfg!(target_os = "windows") { "telegram-bot-api.exe" }', "Windows runtime lookup does not select telegram-bot-api.exe");

const workflow = read(".github/workflows/build-windows.yml");
for (const [needle, message] of [
  ["tdlib/telegram-bot-api.git", "Workflow must build the official Telegram Bot API source"],
  ["BOT_API_COMMIT", "Telegram Bot API source must be pinned"],
  ["VCPKG_COMMIT", "vcpkg must be pinned"],
  ["x64-windows-static", "Telegram Bot API must be built as a standalone static Windows executable"],
  ['$resourceDir = "src-tauri/resources/windows"', "Workflow must stage runtimes in the Windows Tauri resource directory"],
  ["$resourceDir/node.exe", "Workflow must stage node.exe for Tauri"],
  ["$resourceDir/telegram-bot-api.exe", "Workflow must stage telegram-bot-api.exe for Tauri"],
  ["tauri.windows-release.conf.json", "Windows build must use the release-only Windows resource config"],
  ["Verify installed Windows runtimes", "Workflow must inspect the completed installer"],
  ["& $bot --help", "Installed Telegram Bot API must be executable"],
]) requireText(workflow, needle, message);

const devLauncher = read("scripts/run-tauri.ps1");
const devBootstrap = read("scripts/ensure-windows-direct-runtime.ps1");
for (const [needle, message] of [
  ["ensure-windows-direct-runtime.ps1", "Tauri dev launcher must bootstrap the Windows Direct runtime"],
  ["-BuildIfMissing", "Tauri dev launcher must create a missing runtime without a manual environment override"],
]) requireText(devLauncher, needle, message);
for (const [needle, message] of [
  ["runtime\\windows-bot-api", "Dev bootstrap must reuse the ignored runtime cache"],
  ["src-tauri\\resources\\windows", "Dev bootstrap must stage into the Tauri Windows resource directory"],
  ["x64-windows-static", "Dev bootstrap must build the standalone static Windows runtime"],
  ["adfd7f6a8e990272851777eeb3ae0def4216f161", "Dev bootstrap must pin the same Bot API source as release CI"],
  ["7f3781e19cc7d4e4882a4caec01668c6f7b5c163", "Dev bootstrap must pin the same vcpkg source as release CI"],
]) requireText(devBootstrap, needle, message);

console.log("PASS Windows packaging guard: pinned Node and local data-plane runtimes are bundled for release and bootstrapped for dev");
