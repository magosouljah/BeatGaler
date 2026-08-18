import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/run-desktop-e2e-isolated.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, BEATGALER_E2E_DOWNLOADS: "1" },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
