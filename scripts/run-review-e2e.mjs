import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/run-desktop-e2e-isolated.mjs"], {
  stdio: "inherit",
  env: { ...process.env, BEATGALER_E2E_REVIEW: "1" },
});
process.exit(result.status ?? 1);
