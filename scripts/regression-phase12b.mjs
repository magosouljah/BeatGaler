import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = message => { throw new Error(`Phase 12B regression failed: ${message}`); };
const read = rel => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const config = JSON.parse(read("src-tauri/tauri.conf.json"));
if (config.bundle?.createUpdaterArtifacts !== true) fail("bundle.createUpdaterArtifacts must be true.");

const keygen = read("scripts/setup-updater-signing.ps1");
if (!keygen.includes('Join-Path $HOME ".beatgaler\\updater-signing"')) fail("Updater private key is no longer kept outside the repository.");
if (keygen.includes("--force")) fail("Key generation must never overwrite the existing updater key automatically.");

const tauriWrapper = read("scripts/run-tauri.ps1");
if (tauriWrapper.includes("[Parameter(ValueFromRemainingArguments")) fail("Tauri wrapper must not use advanced-parameter binding because CLI flags such as -w collide with PowerShell common parameters.");
if (!tauriWrapper.includes("$TauriArgs = @($args)")) fail("Tauri wrapper no longer forwards raw CLI arguments through PowerShell $args.");

const verifier = read("scripts/verify-updater-artifacts.mjs");
if (!verifier.includes("No .sig updater signatures found")) fail("Release artifact verifier no longer requires signatures.");
if (!verifier.includes("fs.existsSync(`${file}.sig`)")) fail("Release artifact verifier no longer pairs artifacts with signatures.");

const windowsBuild = read(".github/workflows/build-windows.yml");
const macBuild = read(".github/workflows/build-macos.yml");
const releaseWorkflow = read(".github/workflows/release-desktop-updater.yml");
if (!windowsBuild.includes("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}")) fail("Windows Build does not source the updater private key from GitHub Secrets.");
if (!macBuild.includes("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}")) fail("macOS Build does not source the updater private key from GitHub Secrets.");
if ([windowsBuild, macBuild, releaseWorkflow].some(source => source.includes("BEGIN PRIVATE KEY") || source.includes("untrusted comment: minisign secret key"))) fail("Private signing key material was embedded in workflow source.");
if (!windowsBuild.includes("npm run updater:verify-artifacts")) fail("Windows Build does not verify signed updater artifacts.");
if (!releaseWorkflow.includes("Download Windows build") || !releaseWorkflow.includes("BeatGaler-Windows-x64")) fail("Desktop Release no longer consumes the prebuilt Windows artifact.");
if (!releaseWorkflow.includes("Download macOS build") || !releaseWorkflow.includes("BeatGaler-macOS-Universal")) fail("Desktop Release no longer consumes the prebuilt macOS artifact.");
if (!releaseWorkflow.includes("latest.json")) fail("Desktop Release does not publish a static updater manifest.");
if (!releaseWorkflow.includes("PUBLIC_RELEASE_REPO: magosouljah/galer")) fail("Desktop Release is no longer bound to the public release repository.");
if (!releaseWorkflow.includes("GH_TOKEN: ${{ secrets.PUBLIC_RELEASE_TOKEN }}")) fail("Public GitHub Release publishing no longer uses the dedicated cross-repository token.");
if (!releaseWorkflow.includes("contents: read") || !releaseWorkflow.includes("actions: read")) fail("Desktop Release must keep source contents read-only while allowing artifact reads.");

console.log("PASS Phase 12B updater signing pipeline: signed Windows/macOS builds stay separate from publishing, release consumes verified artifacts, and latest.json is published to the dedicated public release repository");
