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

function forbidText(value, text, message) {
  if (value.includes(text)) throw new Error(message);
}

const prepare = read("scripts/prepare-windows-authenticode-config.ps1");
for (const [needle, message] of [
  ["PENDING_OWNER_PROVIDER", "Public signing must fail closed while provider selection is deferred"],
  ["WINDOWS_AUTHENTICODE_CERT_SHA1", "Public signing config must select an external certificate without embedding it"],
  ['digestAlgorithm\"] = \"sha256\"', "Tauri Authenticode file digest must be SHA-256"],
  ['timestampUrl\"] = $timestampUrl', "Tauri Authenticode config must require a timestamp endpoint"],
  ['tsp\"] = $true', "Tauri Authenticode config must require RFC3161/TSP"],
  ["Scheme -ne \"https\"", "Timestamp endpoint must be HTTPS"],
  ["WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT", "Public signing must require an expected publisher subject"],
]) requireText(prepare, needle, message);

const baseTauriConfig = read("src-tauri/tauri.windows-release.conf.json");
forbidText(baseTauriConfig, "certificateThumbprint", "Repository Tauri config must not commit a production certificate selector");
forbidText(baseTauriConfig, "PRIVATE KEY", "Repository Tauri config must not contain private-key material");

const verifier = read("scripts/windows-authenticode.ps1");
for (const [needle, message] of [
  ["verify /pa /all /v", "Release verification must use signtool verify /pa /all /v"],
  ["1.3.6.1.4.1.311.3.3.1", "Verifier must require the Authenticode RFC3161 timestamp attribute"],
  ["2.16.840.1.101.3.4.2.1", "Verifier must require SHA-256 signer digest policy"],
  ["TimeStamperCertificate", "Verifier must require a trusted timestamp certificate"],
  ["WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT", "Verifier must pin the expected publisher subject"],
  ["SignatureStatus]::Valid", "Verifier must require valid Authenticode status"],
  ["Expected exact subject", "Verifier must enforce the owner-approved exact publisher subject"],
]) requireText(verifier, needle, message);

const build = read(".github/workflows/build-windows.yml");
for (const [needle, message] of [
  ["run-name: Build Windows [${{ inputs.release_intent }}]", "Windows run must expose build intent independently of artifact metadata"],
  ["release_intent:", "Windows build must distinguish internal from public intent"],
  ["- internal", "Windows build must preserve internal builds"],
  ["- public", "Windows build must expose an explicit public signing path"],
  ["PENDING_OWNER_PROVIDER", "Windows build must default to deferred provider state"],
  ["Prepare Authenticode config for public intent", "Public build must prepare signing before bundling"],
  ["Build Tauri app - public Authenticode", "Public build must run through Authenticode-aware Tauri bundling"],
  ["Verify Windows Authenticode public release gate", "Public build must verify Authenticode"],
  ["WINDOWS-AUTHENTICODE-STATUS.json", "Windows build must emit release eligibility evidence"],
  ["public_release_eligible = $publicEligible", "Windows evidence must encode public eligibility from explicit intent"],
  ["INTERNAL_NOT_FOR_PUBLIC_RELEASE", "Internal builds must be explicitly non-public"],
  ["tauri_updater_signature = \"separate-control\"", "Build metadata must distinguish Tauri updater signing from Authenticode"],
  ["Tauri updater signature is older than the final Authenticode-signed installer", "Public build must guard against stale updater signatures"],
  ["Expected exactly one installed application executable", "Public build must discover and verify the installed application executable"],
  ["windows-authenticode.ps1 -Path $appCandidates[0].FullName -RequireExpectedSubject", "Public build must verify the discovered installed application executable"],
]) requireText(build, needle, message);

const prepareIndex = build.indexOf("Prepare Authenticode config for public intent");
const publicBuildIndex = build.indexOf("Build Tauri app - public Authenticode");
const updaterVerifyIndex = build.indexOf("Verify updater artifacts");
const eligibilityIndex = build.indexOf("Record Windows release eligibility");
if (prepareIndex < 0 || publicBuildIndex < 0 || prepareIndex > publicBuildIndex) {
  throw new Error("Authenticode configuration must occur before the public Tauri bundle is built");
}
if (updaterVerifyIndex < publicBuildIndex || eligibilityIndex < updaterVerifyIndex) {
  throw new Error("Public eligibility must only be recorded after final updater signature verification");
}

const release = read(".github/workflows/release-desktop-updater.yml");
for (const [needle, message] of [
  ["verify-windows-authenticode:", "Public release workflow needs an independent Windows Authenticode verification job"],
  ["needs: verify-windows-authenticode", "Publication must depend on the Authenticode gate"],
  ["Selected Windows build is not marked as release_intent=public", "Release workflow must verify public build intent independently from artifact metadata"],
  ["INTERNAL_NOT_FOR_PUBLIC_RELEASE artifacts cannot enter publication", "Release workflow must reject internal artifacts"],
  ["Current Windows signing provider is still PENDING_OWNER_PROVIDER", "Release workflow must reject the deferred provider state"],
  ["Checkout verifier at exact Windows build source SHA", "Release verifier must be pinned to the selected build source"],
  ["windows-authenticode.ps1 -Path $installers[0].FullName -RequireExpectedSubject", "Release workflow must cryptographically re-verify the actual EXE"],
  ["Create immutable release draft", "Existing immutable draft-first governance must remain present"],
  ["provenance.json", "Existing source/release provenance must remain present"],
  ["Publish verified immutable release", "Existing publish-once boundary must remain present"],
  ["make_latest", "Stable/latest governance must remain present"],
]) requireText(release, needle, message);
forbidText(release, "--clobber", "Release workflow must not restore clobber/overwrite behavior");

const seamCi = read(".github/workflows/test-windows-authenticode.yml");
for (const [needle, message] of [
  ["Windows Authenticode seam test", "PR CI must expose a dedicated Authenticode seam test"],
  ["npm run test:windows-authenticode-guard", "PR CI must run the static Authenticode guard"],
  ["./scripts/test-windows-authenticode-seam.ps1", "PR CI must run the executable no-certificate fail-closed seam test"],
]) requireText(seamCi, needle, message);

const docs = read("docs/WINDOWS-AUTHENTICODE.md");
for (const [needle, message] of [
  ["Owner: `RO`", "Windows signing owner must be RO"],
  ["PENDING_OWNER_PROVIDER", "Deferred external provider must be documented"],
  ["Production signing state: `NO-GO`", "Production signing must remain NO-GO"],
  ["Tauri updater signature", "Docs must distinguish updater signature from Authenticode"],
  ["RFC3161", "RFC3161 requirement must be documented"],
  ["SHA-256", "SHA-256 requirement must be documented"],
  ["1. **Authenticode provider**", "RO input 1 must be documented"],
  ["12. **Controlled public-build authorization**", "All twelve pending RO inputs must be documented"],
]) requireText(docs, needle, message);

console.log("PASS Windows Authenticode guard: internal remains non-public; public and publication are fail-closed on real SHA-256 Authenticode + RFC3161 verification; Tauri updater signing remains a separate control");
