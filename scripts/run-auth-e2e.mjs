import fs from "node:fs";
import { spawnSync } from "node:child_process";
const runnerPath = "scripts/run-desktop-e2e-isolated.mjs";
const original = fs.readFileSync(runnerPath, "utf8");
const marker = ': ["wdio", "run", "wdio.e2e.conf.mjs"];';
const replacement = ': ["wdio", "run", "wdio.e2e.conf.mjs", "--spec", "tests/e2e/auth-flow.e2e.mjs"];';
if (!original.includes(marker)) throw new Error("[auth-e2e] isolated runner default WDIO marker missing");
try {
  fs.writeFileSync(runnerPath, original.replace(marker, replacement), "utf8");
  const result = spawnSync(process.execPath, [runnerPath], { cwd: process.cwd(), env: { ...process.env, TAURI_WEBDRIVER_PORT: "4445", WDIO_EMBEDDED_PORT: "4445" }, stdio: "inherit" });
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally { fs.writeFileSync(runnerPath, original, "utf8"); }
