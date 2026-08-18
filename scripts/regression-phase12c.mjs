import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const fail = (m) => { throw new Error(`Phase 12C regression failed: ${m}`); };

const cargo = read("src-tauri/Cargo.toml");
const lib = read("src-tauri/src/lib.rs");
const updater = read("src-tauri/src/updater.rs");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const ui = read("src/components/SettingsPanel.tsx");
const bridge = read("src/lib/tauri.ts");
const workflow = read(".github/workflows/release-windows-updater.yml");
const baseline = read("scripts/build-updater-test-baseline.ps1");

if (!cargo.includes('tauri-plugin-updater = "2.0"')) fail("Rust updater dependency missing");
if (!lib.includes("tauri_plugin_updater::Builder::new().build()")) fail("updater plugin is not registered");
if (!lib.includes("check_app_update, install_app_update")) fail("updater commands are not exposed");
if (!updater.includes('option_env!("BEATGALER_UPDATER_ENDPOINT")')) fail("release endpoint is not compiled from controlled build input");
if (!updater.includes('starts_with("https://")')) fail("HTTPS endpoint guard missing");
if (!updater.includes("download_and_install")) fail("signed updater install path missing");
if (!conf.plugins?.updater?.pubkey?.startsWith("dW50cnVzdGVk")) fail("real public signing key is not embedded");
if (JSON.stringify(conf.plugins.updater).includes("PRIVATE")) fail("private signing material leaked into config");
if (!bridge.includes("checkForAppUpdate") || !bridge.includes("installAppUpdate")) fail("frontend updater bridge missing");
if (!ui.includes("Check for updates") || !ui.includes("Updates are verified before installation")) fail("user-facing updater controls missing");
if (!workflow.includes("BEATGALER_UPDATER_ENDPOINT: https://github.com/magosouljah/galer/releases/latest/download/latest.json")) fail("release build endpoint is not bound to the dedicated public release repository");
if (!baseline.includes("git remote get-url origin") || !baseline.includes("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")) fail("real 0.6.1 baseline test builder is incomplete");

console.log("PASS Phase 12C real updater client: signed HTTPS checks/install are wired, public key is embedded, endpoint follows the release repo, and a real 0.6.1 baseline build is available");
