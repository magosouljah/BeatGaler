import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/run-desktop-e2e-isolated.mjs", "review"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
