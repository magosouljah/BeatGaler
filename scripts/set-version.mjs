// Compatibility wrapper. All version logic lives in scripts/version.mjs.
import { spawnSync } from "node:child_process";
import path from "node:path";

const versionScript = path.join(process.cwd(), "scripts", "version.mjs");
const result = spawnSync(process.execPath, [versionScript, "set", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
