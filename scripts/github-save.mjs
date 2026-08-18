import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();

function fail(message, code = 1) {
  console.error(`\nGitHub save failed: ${message}`);
  process.exit(code);
}

function readVersion() {
  const raw = readFileSync(path.join(root, "VERSION"), "utf8").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!match) fail(`VERSION contains an invalid semantic version: ${raw}`);
  return {
    raw,
    stable: `${match[1]}.${match[2]}.${match[3]}`,
    prerelease: match[4] || "",
  };
}

function branchFor(version) {
  if (/^beta(?:\.|$)/i.test(version.prerelease)) {
    return `galer-cloud-beta-v${version.stable}`;
  }
  if (version.prerelease) {
    const channel = version.prerelease.split(".")[0].replace(/[^0-9A-Za-z-]+/g, "-").toLowerCase();
    return `galer-cloud-${channel}-v${version.stable}`;
  }
  return `galer-cloud-v${version.stable}`;
}

function runGit(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) fail(`Could not run git: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? String(result.stderr || result.stdout || "").trim() : "";
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}.`, result.status || 1);
  }
  return result;
}

function gitText(args) {
  return String(runGit(args, { capture: true }).stdout || "").trim();
}

function gitSucceeds(args) {
  return runGit(args, { capture: true, allowFailure: true }).status === 0;
}

const version = readVersion();
const branch = branchFor(version);
const args = process.argv.slice(2);

if (args[0] === "--print-branch") {
  console.log(branch);
  process.exit(0);
}

console.log(`\nBeatGaler ${version.raw}`);
console.log(`GitHub branch: ${branch}\n`);

// Never publish a half-synced release. VERSION remains the source of truth.
const versionCheck = spawnSync(process.execPath, [path.join(root, "scripts", "version.mjs"), "check"], {
  cwd: root,
  stdio: "inherit",
});
if (versionCheck.error) fail(`Could not run version check: ${versionCheck.error.message}`);
if (versionCheck.status !== 0) fail("Version files are not synchronized. Run npm run version:sync first.");

if (gitText(["rev-parse", "--is-inside-work-tree"]) !== "true") {
  fail("This folder is not a Git repository.");
}
if (!gitSucceeds(["remote", "get-url", "origin"])) {
  fail('Git remote "origin" is not configured.');
}

let currentBranch = gitText(["branch", "--show-current"]);
if (!currentBranch) fail("Git is currently in detached HEAD state.");

if (currentBranch !== branch) {
  const localExists = gitSucceeds(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  const remoteExists = gitSucceeds(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);

  if (localExists) {
    console.log(`Switching to existing local branch ${branch}...`);
    runGit(["switch", branch]);
  } else if (remoteExists) {
    console.log(`Restoring existing remote branch ${branch}...`);
    runGit(["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    runGit(["switch", "-c", branch, "--track", `origin/${branch}`]);
  } else {
    console.log(`Creating new branch ${branch}...`);
    runGit(["switch", "-c", branch]);
  }
  currentBranch = branch;
}

runGit(["add", "-A"]);

const hasStagedChanges = !gitSucceeds(["diff", "--cached", "--quiet"]);
if (hasStagedChanges) {
  const customMessage = args.filter((arg) => arg !== "--print-branch").join(" ").trim();
  const message = customMessage || `BeatGaler ${version.raw}`;
  console.log(`Committing: ${message}`);
  runGit(["commit", "-m", message]);
} else {
  console.log("No new changes to commit; pushing the current branch state.");
}

// Explicit refs/heads refspec prevents the old "refspec matches more than one" branch/tag collision.
runGit(["push", "-u", "origin", `HEAD:refs/heads/${branch}`]);

console.log(`\nDONE: ${branch}`);
console.log(`Version: ${version.raw}`);
console.log("GitHub is up to date.\n");
