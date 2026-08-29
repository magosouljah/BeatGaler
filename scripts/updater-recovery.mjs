import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemver } from "./updater-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPolicyPath = path.join(root, "release", "updater-recovery-policy.json");
const sha256Pattern = /^[a-f0-9]{64}$/i;
const gitShaPattern = /^[a-f0-9]{40}$/i;

export function validateRecoveryPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("Recovery policy must be an object.");
  if (policy.schemaVersion !== 1) throw new Error("Unsupported recovery policy schemaVersion.");
  if (policy.strategy !== "immutable-release-withdraw-and-recover") throw new Error("Recovery policy must preserve immutable releases.");
  const requiredFailures = ["network", "disk", "signature", "manifest"];
  for (const failure of requiredFailures) {
    if (!policy.failureClasses?.includes(failure)) throw new Error(`Recovery policy is missing ${failure} failure coverage.`);
  }
  if (policy.failureBehavior?.activatePartialUpdate !== false) throw new Error("Partial updates must never activate after failure.");
  if (policy.failureBehavior?.deleteInstalledVersion !== false) throw new Error("Updater failure must preserve the installed version.");
  if (policy.badArtifact?.mutateImmutableRelease !== false) throw new Error("Bad artifact handling must not mutate immutable releases.");
  if (policy.badArtifact?.withdrawFromUpdaterDiscovery !== true) throw new Error("Bad artifacts must be withdrawn from updater discovery.");
  if (policy.badArtifact?.requireIncidentNotice !== true) throw new Error("Bad artifact withdrawal requires communication.");
  if (policy.recovery?.stableLatestMayMoveOnlyWithReleaseAuthorization !== true) throw new Error("stable/latest must stay authorization-gated.");
  return true;
}

export function buildWithdrawalPlan({ badTag, sourceSha, artifactSha256, badVersion, lastKnownGoodVersion, reason, policy }) {
  validateRecoveryPolicy(policy);
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(badTag ?? ""))) throw new Error("badTag must be a version tag.");
  if (!gitShaPattern.test(String(sourceSha ?? ""))) throw new Error("sourceSha must be an exact 40-character Git SHA.");
  if (!sha256Pattern.test(String(artifactSha256 ?? ""))) throw new Error("artifactSha256 must be an exact SHA-256 digest.");
  if (compareSemver(lastKnownGoodVersion, badVersion) >= 0) throw new Error("lastKnownGoodVersion must be N-1 / older than badVersion.");
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedReason) throw new Error("Withdrawal reason is required.");
  return {
    action: "withdraw-from-updater-discovery",
    immutableReleaseMutation: false,
    badTag,
    sourceSha,
    artifactSha256: artifactSha256.toLowerCase(),
    badVersion,
    lastKnownGoodVersion,
    preserveInstalledVersion: true,
    recovery: "publish-new-fixed-version-or-reinstall-last-known-good",
    communicationRequired: true,
    reason: normalizedReason,
  };
}

function readPolicy(file = defaultPolicyPath) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requireArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    const policy = readPolicy();
    if (command === "validate-policy") {
      validateRecoveryPolicy(policy);
      console.log("PASS updater recovery policy");
    } else if (command === "plan-withdrawal") {
      const plan = buildWithdrawalPlan({
        badTag: requireArg(args, "--bad-tag"),
        sourceSha: requireArg(args, "--source-sha"),
        artifactSha256: requireArg(args, "--artifact-sha256"),
        badVersion: requireArg(args, "--bad-version"),
        lastKnownGoodVersion: requireArg(args, "--last-known-good-version"),
        reason: requireArg(args, "--reason"),
        policy,
      });
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      throw new Error("Usage: updater-recovery.mjs <validate-policy|plan-withdrawal> ...");
    }
  } catch (error) {
    console.error(`FAIL updater recovery: ${error.message}`);
    process.exit(1);
  }
}
