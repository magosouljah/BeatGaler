import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function requireValue(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function parseReleaseTag(tag) {
  const rawTag = requireValue(tag, "release tag");
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(rawTag);
  if (!match) throw new Error(`release tag must be v-prefixed semver: ${rawTag}`);

  const version = rawTag.slice(1);
  const prereleaseText = match[4] || "";
  if (!prereleaseText) {
    return { tag: rawTag, version, channel: "stable", prerelease: false };
  }

  const prereleaseId = prereleaseText.split(".")[0].toLowerCase();
  const channelByPrerelease = {
    alpha: "alpha",
    beta: "beta",
    rc: "candidate",
  };
  const channel = channelByPrerelease[prereleaseId];
  if (!channel) {
    throw new Error(
      `unsupported prerelease suffix "${prereleaseId}" in ${rawTag}; expected alpha, beta or rc`,
    );
  }
  return { tag: rawTag, version, channel, prerelease: true };
}

export function assertReleaseIntent(tag, requestedChannel) {
  const classification = parseReleaseTag(tag);
  const requested = requireValue(requestedChannel, "release channel").toLowerCase();
  if (classification.channel !== requested) {
    throw new Error(
      `release tag ${classification.tag} requires channel ${classification.channel}, not ${requested}`,
    );
  }
  return classification;
}

export function assertMatchingBuildShas(windowsSha, macosSha) {
  const windows = requireValue(windowsSha, "Windows source SHA");
  const macos = requireValue(macosSha, "macOS source SHA");
  if (windows !== macos) {
    throw new Error(`Windows and macOS builds came from different commits: ${windows} != ${macos}`);
  }
  return windows;
}

export function buildProvenance(input) {
  const sourceSha = assertMatchingBuildShas(input.windowsSourceSha, input.macosSourceSha);
  const release = assertReleaseIntent(input.releaseTag, input.releaseChannel);
  return {
    schema_version: 1,
    source_repository: requireValue(input.sourceRepository, "source repository"),
    source_sha: sourceSha,
    release_repository: requireValue(input.releaseRepository, "release repository"),
    release_tag: release.tag,
    version: release.version,
    release_channel: release.channel,
    prerelease: release.prerelease,
    windows_run_id: requireValue(input.windowsRunId, "Windows run ID"),
    macos_run_id: requireValue(input.macosRunId, "macOS run ID"),
    publication_repository: requireValue(input.publicationRepository, "publication repository"),
    publication_workflow: requireValue(input.publicationWorkflow, "publication workflow"),
    publication_run_id: requireValue(input.publicationRunId, "publication run ID"),
    publication_run_attempt: requireValue(input.publicationRunAttempt, "publication run attempt"),
    publication_ref: requireValue(input.publicationRef, "publication ref"),
    publication_sha: requireValue(input.publicationSha, "publication SHA"),
  };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function exportGithubEnv(classification) {
  const output = process.env.GITHUB_ENV;
  if (!output) throw new Error("GITHUB_ENV is unavailable");
  fs.appendFileSync(
    output,
    [
      `RELEASE_POLICY_CHANNEL=${classification.channel}`,
      `RELEASE_IS_PRERELEASE=${classification.prerelease}`,
    ].join("\n") + "\n",
    "utf8",
  );
}

const [command, ...args] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (command === "assert-intent" || command === "github-env") {
      const result = assertReleaseIntent(argValue(args, "--tag"), argValue(args, "--channel"));
      if (command === "github-env") exportGithubEnv(result);
      console.log(JSON.stringify(result));
    } else if (command === "assert-build-shas") {
      const sha = assertMatchingBuildShas(
        argValue(args, "--windows-sha"),
        argValue(args, "--macos-sha"),
      );
      console.log(`PASS build source SHA: ${sha}`);
    } else {
      throw new Error(
        "usage: release-governance.mjs <assert-intent|github-env|assert-build-shas> [options]",
      );
    }
  } catch (error) {
    console.error(`FAIL release governance: ${error.message}`);
    process.exit(1);
  }
}
