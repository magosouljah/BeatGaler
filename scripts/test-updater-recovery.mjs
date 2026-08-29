import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaticUpdaterManifest, validateStaticUpdaterManifest } from "./updater-manifest.mjs";
import { buildWithdrawalPlan, validateRecoveryPolicy } from "./updater-recovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(fs.readFileSync(path.join(root, "release", "updater-recovery-policy.json"), "utf8"));
validateRecoveryPolicy(policy);

const signature = "dGVzdC1zaWduYXR1cmUtZml4dHVyZQ==";
const nMinusOne = "0.8.0-alpha.1";
const target = "0.8.0-alpha.2";
const valid = buildStaticUpdaterManifest({
  version: target,
  platform: "windows-x86_64",
  artifactUrl: "https://example.invalid/Beat.Galer_0.8.0-alpha.2_x64-setup.exe",
  signature,
  pubDate: "2026-08-29T12:00:00Z",
});
assert.equal(validateStaticUpdaterManifest(valid, { currentVersion: nMinusOne }).version, target, "N-1 must accept a strictly newer target");

assert.throws(
  () => validateStaticUpdaterManifest({ ...valid, version: nMinusOne }, { currentVersion: nMinusOne }),
  /must be newer/,
  "same/older manifest must fail closed",
);
assert.throws(
  () => validateStaticUpdaterManifest({ ...valid, platforms: { "windows-x86_64": { ...valid.platforms["windows-x86_64"], url: "http://example.invalid/update.exe" } } }),
  /HTTPS/,
  "insecure/network endpoint fixture must fail closed",
);
assert.throws(
  () => validateStaticUpdaterManifest({ ...valid, platforms: { "windows-x86_64": { ...valid.platforms["windows-x86_64"], signature: "" } } }),
  /signature is required/,
  "missing signature fixture must fail closed",
);
assert.throws(
  () => validateStaticUpdaterManifest({ ...valid, platforms: {} }),
  /at least one platform artifact/,
  "malformed/empty manifest fixture must fail closed",
);

for (const failureClass of ["network", "disk", "signature", "manifest"]) {
  assert.ok(policy.failureClasses.includes(failureClass));
}
assert.equal(policy.failureBehavior.activatePartialUpdate, false, "failed update must never activate partially");
assert.equal(policy.failureBehavior.deleteInstalledVersion, false, "failed update must preserve installed version");

const plan = buildWithdrawalPlan({
  badTag: "v0.8.0-alpha.2",
  sourceSha: "0123456789abcdef0123456789abcdef01234567",
  artifactSha256: "a".repeat(64),
  badVersion: target,
  lastKnownGoodVersion: nMinusOne,
  reason: "fixture: updater artifact failed post-publication validation",
  policy,
});
assert.equal(plan.immutableReleaseMutation, false);
assert.equal(plan.communicationRequired, true);
assert.equal(plan.preserveInstalledVersion, true);
assert.equal(plan.action, "withdraw-from-updater-discovery");

assert.throws(
  () => buildWithdrawalPlan({ ...plan, policy, badVersion: nMinusOne, lastKnownGoodVersion: target }),
  /must be N-1/,
  "rollback target must be older than the bad version",
);

console.log("PASS updater recovery/rollback acceptance fixtures");
