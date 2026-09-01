import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertMatchingBuildShas,
  assertReleaseIntent,
  buildProvenance,
  parseReleaseTag,
} from "./release-governance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "release-desktop-updater.yml"),
  "utf8",
);
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "release", "release-controls.json"), "utf8"),
);

const cases = [
  ["v0.8.0-alpha.6", "alpha", true],
  ["v0.8.0-beta.1", "beta", true],
  ["v1.0.0-rc.1", "candidate", true],
  ["v1.0.0", "stable", false],
];
for (const [tag, channel, prerelease] of cases) {
  assert.deepEqual(parseReleaseTag(tag), {
    tag,
    version: tag.slice(1),
    channel,
    prerelease,
  });
  assert.equal(assertReleaseIntent(tag, channel).prerelease, prerelease);
}
assert.throws(
  () => assertReleaseIntent("v0.8.0-alpha.6", "stable"),
  /requires channel alpha/,
);
assert.throws(
  () => parseReleaseTag("v1.0.0-preview.1"),
  /unsupported prerelease suffix/,
);

const sha = "a".repeat(40);
assert.equal(assertMatchingBuildShas(sha, sha), sha);
assert.throws(
  () => assertMatchingBuildShas("a".repeat(40), "b".repeat(40)),
  /different commits/,
);

const provenance = buildProvenance({
  sourceRepository: "magosouljah/BeatGaler",
  windowsSourceSha: sha,
  macosSourceSha: sha,
  releaseRepository: "magosouljah/galer",
  releaseTag: "v0.8.0-alpha.6",
  releaseChannel: "alpha",
  windowsRunId: "111",
  macosRunId: "222",
  publicationRepository: "magosouljah/BeatGaler",
  publicationWorkflow: "Release - Desktop Updater",
  publicationRunId: "333",
  publicationRunAttempt: "1",
  publicationRef: "refs/heads/release-governance-f0-0.4",
  publicationSha: "c".repeat(40),
});
assert.equal(provenance.source_sha, sha);
assert.equal(provenance.windows_run_id, "111");
assert.equal(provenance.macos_run_id, "222");
assert.equal(provenance.release_tag, "v0.8.0-alpha.6");
assert.equal(provenance.version, "0.8.0-alpha.6");
assert.equal(provenance.prerelease, true);

assert.ok(policy.channels.candidate, "candidate release-control channel must exist");
assert.equal(policy.channels.candidate.publicationEnabled, false);

assert.ok(workflow.includes("release-governance.mjs github-env"));
assert.ok(workflow.includes("RELEASE_SOURCE_SHA=$WIN_SHA"));
assert.ok(workflow.includes('test "$WIN_PROVENANCE_SHA" = "$RELEASE_SOURCE_SHA"'));
assert.ok(workflow.includes('test "$MAC_PROVENANCE_SHA" = "$RELEASE_SOURCE_SHA"'));
assert.ok(workflow.includes("release-assets/provenance.json"));
assert.ok(workflow.includes('--arg source_sha "$RELEASE_SOURCE_SHA"'));
assert.ok(workflow.includes('--arg windows_run_id "$WINDOWS_RUN_ID"'));
assert.ok(workflow.includes('--arg macos_run_id "$MACOS_RUN_ID"'));
assert.ok(workflow.includes('gh release view "$TAG"'));
assert.ok(workflow.includes("git/ref/tags/$TAG"));
assert.ok(workflow.includes("already exists"));
assert.ok(workflow.includes('"draft": true'));
assert.ok(workflow.includes('"make_latest": "false"'));
assert.ok(workflow.includes('MAKE_LATEST="false"'));
assert.ok(workflow.includes('MAKE_LATEST="true"'));
assert.ok(workflow.includes("RELEASE_IS_PRERELEASE"));
assert.ok(!workflow.includes("--clobber"));
assert.ok(!workflow.includes('--target "$RELEASE_SOURCE_SHA"'));

const createDraftIndex = workflow.indexOf("Create immutable release draft");
const uploadIndex = workflow.indexOf('gh release upload "$TAG"');
const verifyDraftIndex = workflow.indexOf("Verify draft release and assets");
const publishIndex = workflow.indexOf("Publish verified immutable release");
assert.ok(createDraftIndex >= 0, "draft creation step missing");
assert.ok(uploadIndex > createDraftIndex, "assets must upload after draft creation");
assert.ok(verifyDraftIndex > uploadIndex, "draft assets must be verified after upload");
assert.ok(publishIndex > verifyDraftIndex, "publication must happen after draft verification");
assert.equal(
  workflow.indexOf('gh release upload "$TAG"', publishIndex),
  -1,
  "no asset upload may occur after publication",
);
assert.equal(
  workflow.indexOf("--method PATCH", publishIndex + "Publish verified immutable release".length),
  workflow.lastIndexOf("--method PATCH"),
  "publication must be the final release mutation",
);

console.log("PASS release governance policy, provenance and immutable publication ordering");
