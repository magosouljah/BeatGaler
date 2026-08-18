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

const workflow = read(".github/workflows/release-windows-updater.yml");
if (!workflow.includes("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}")) fail("Release workflow does not source private key from GitHub Secrets.");
if (workflow.includes("BEGIN PRIVATE KEY") || workflow.includes("untrusted comment: minisign secret key")) fail("Private signing key material was embedded in workflow source.");
if (!workflow.includes("npm run updater:verify-artifacts")) fail("Release workflow does not verify .sig output.");
if (!workflow.includes("latest.json")) fail("Release workflow does not publish a static updater manifest.");
if (!workflow.includes("PUBLIC_RELEASE_REPO: magosouljah/galer")) fail("Release workflow is no longer bound to the public release repository.");
if (!workflow.includes("PUBLIC_RELEASE_TOKEN: ${{ secrets.PUBLIC_RELEASE_TOKEN }}")) fail("Release workflow no longer authenticates cross-repository publishing through the dedicated secret.");
if (!workflow.includes("GH_TOKEN: ${{ secrets.PUBLIC_RELEASE_TOKEN }}")) fail("Public GitHub Release publishing no longer uses the dedicated cross-repository token.");
if (!workflow.includes("permissions:\n  contents: read")) fail("Private source workflow must keep its own repository permissions read-only.");

console.log("PASS Phase 12B updater signing pipeline: updater artifacts are enabled, keys stay outside repo, CI uses secrets, signatures are verified, and latest.json is published to the dedicated public release repository");
