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

console.log("PASS Windows packaging guard: pinned Node and Telegram Bot API runtimes are bundled and verified after NSIS installation");
