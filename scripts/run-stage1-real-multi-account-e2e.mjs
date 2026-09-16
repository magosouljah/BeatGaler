import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, ".env.stage1");
const reportFile = path.join(root, "tmp", "stage1-real-multi-account-report.json");

if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function cliAccountCount() {
  const index = process.argv.indexOf("--accounts");
  if (index < 0) return null;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) ? value : NaN;
}

const cohortId = String(process.env.STAGE1_COHORT_ID || "").trim();
const cohortPassword = String(process.env.STAGE1_COHORT_PASSWORD || "").trim();
const cohortSize = Number(process.env.STAGE1_COHORT_SIZE || 10);
const requestedCount = cliAccountCount() ?? Number(process.env.STAGE1_RUN_ACCOUNTS || 2);

if (!cohortId || !cohortPassword) {
  console.error("BLOCKED Stage 1 real multi-account E2E: the reusable account cohort does not exist yet.");
  console.error("Run first: node scripts/seed-stage1-real-accounts.mjs");
  process.exit(2);
}
if (!Number.isInteger(cohortSize) || cohortSize < 2 || cohortSize > 50) {
  console.error(`BLOCKED Stage 1: invalid STAGE1_COHORT_SIZE=${process.env.STAGE1_COHORT_SIZE || ""}.`);
  process.exit(2);
}
if (!Number.isInteger(requestedCount) || requestedCount < 2 || requestedCount > cohortSize) {
  console.error(`BLOCKED Stage 1: --accounts must be between 2 and ${cohortSize}.`);
  process.exit(2);
}

const wdioBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wdio.cmd" : "wdio");
if (!fs.existsSync(wdioBin)) {
  console.error("BLOCKED Stage 1 real multi-account E2E: local WebdriverIO dependency is missing.");
  console.error("Install the repository dependencies first, then rerun this command.");
  process.exit(2);
}

let gitHead = "unknown";
try {
  gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  // The E2E can still run from an exported checkout; the report will say unknown.
}

console.log(`[stage1-real] baseline=${gitHead}`);
console.log(`[stage1-real] cohort=${cohortId} accounts=${requestedCount}/${cohortSize} browser_sessions=${requestedCount} mode=real`);
console.log("[stage1-real] cohort password stays local and is never printed.");

const result = spawnSync(wdioBin, ["run", "wdio.stage1-real.conf.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    STAGE1_GIT_HEAD: gitHead,
    STAGE1_RUN_ACCOUNTS: String(requestedCount),
  },
  shell: process.platform === "win32",
});

if (fs.existsSync(reportFile)) console.log(`[stage1-real] report=${reportFile}`);

if (result.error) {
  console.error(`[stage1-real] runner error: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
