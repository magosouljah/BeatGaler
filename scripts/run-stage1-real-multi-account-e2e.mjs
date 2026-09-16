import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, ".env.stage1");
const reportFile = path.join(root, "tmp", "stage1-real-multi-account-report.json");

if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const required = [
  "STAGE1_ACCOUNT_A_IDENTIFIER",
  "STAGE1_ACCOUNT_A_PASSWORD",
  "STAGE1_ACCOUNT_B_IDENTIFIER",
  "STAGE1_ACCOUNT_B_PASSWORD",
];
const missing = required.filter(name => !String(process.env[name] || "").trim());

if (missing.length) {
  console.error("BLOCKED Stage 1 real multi-account E2E: dedicated local account credentials are not configured.");
  console.error(`Missing variables: ${missing.join(", ")}`);
  console.error("Create an ignored .env.stage1 file locally. Do not commit or paste its values.");
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
console.log("[stage1-real] accounts=2 browser_sessions=2 mode=real");
console.log("[stage1-real] secrets are loaded locally and are never printed.");

const result = spawnSync(wdioBin, ["run", "wdio.stage1-real.conf.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    STAGE1_GIT_HEAD: gitHead,
  },
  shell: process.platform === "win32",
});

if (fs.existsSync(reportFile)) {
  console.log(`[stage1-real] report=${reportFile}`);
}

if (result.error) {
  console.error(`[stage1-real] runner error: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
