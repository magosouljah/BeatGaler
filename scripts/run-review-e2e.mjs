import fs from "node:fs";
import { spawnSync } from "node:child_process";

const harnessSlot = "tests/e2e-harness/E2EFlowHarness.tsx";
const specSlot = "tests/e2e/edit-metadata-flow.e2e.mjs";
const harnessBackup = fs.readFileSync(harnessSlot, "utf8");
const specBackup = fs.readFileSync(specSlot, "utf8");

let status = 1;
try {
  fs.copyFileSync("tests/e2e-harness/E2EReviewHarness.tsx", harnessSlot);
  fs.copyFileSync("tests/e2e/review-flow.e2e.mjs", specSlot);
  const result = spawnSync(process.execPath, ["scripts/run-desktop-e2e-isolated.mjs"], {
    stdio: "inherit",
    env: { ...process.env, BEATGALER_E2E_FLOW: "1" },
  });
  status = result.status ?? 1;
} finally {
  fs.writeFileSync(harnessSlot, harnessBackup, "utf8");
  fs.writeFileSync(specSlot, specBackup, "utf8");
}
process.exit(status);
