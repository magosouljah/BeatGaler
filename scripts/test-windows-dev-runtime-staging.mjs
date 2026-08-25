import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = readFileSync(path.join(root, "start-beatgaler-cloud.ps1"), "utf8");
const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
const releaseConfig = readFileSync(path.join(root, "src-tauri", "tauri.windows-release.conf.json"), "utf8");
const workflow = readFileSync(path.join(root, ".github", "workflows", "build-windows.yml"), "utf8");

const fail = message => { throw new Error(`Windows dev runtime staging regression: ${message}`); };

if (!gitignore.includes("/src-tauri/resources/windows/")) fail("staged runtime directory is no longer gitignored");
if (!launcher.includes('src-tauri\\resources\\windows')) fail("launcher no longer stages into the runtime path Rust searches");
if (!launcher.includes("BEATGALER_BOT_API_SOURCE_DIR")) fail("local Bot API source cannot be overridden without editing the repo");
if (!launcher.includes('Get-Command node.exe')) fail("Node runtime is no longer staged from the developer machine");
if (!launcher.includes('telegram-bot-api.exe')) fail("local data-plane executable is no longer staged");
for (const dll of ["libcrypto-3-x64.dll", "libssl-3-x64.dll", "z.dll"]) {
  if (!launcher.includes(dll)) fail(`${dll} is no longer copied when the local dynamic build needs it`);
}
if (!launcher.includes('& $stagedBot --help')) fail("staged data-plane runtime is not smoke-tested before Tauri starts");
if (!releaseConfig.includes('resources/windows/telegram-bot-api.exe')) fail("Windows release config lost the packaged data-plane runtime");
if (!workflow.includes('x64-windows-static')) fail("release workflow no longer builds the self-contained static Windows runtime");
if (!workflow.includes('src-tauri/resources/windows/telegram-bot-api.exe')) fail("release workflow no longer stages the built runtime into Tauri resources");

console.log("PASS Windows dev runtime staging: local exe/DLLs remain gitignored, launcher stages and smoke-tests them, release stays static and self-contained");
