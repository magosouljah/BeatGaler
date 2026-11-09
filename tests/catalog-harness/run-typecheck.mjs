// T08 — `npm run test:typecheck` (tsc --noEmit) invocable por el runner de catálogo sin npm ni shell.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..", "..");
const r = spawnSync(process.execPath, [path.join(REPO, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", path.join(REPO, "tsconfig.json")], { cwd: REPO, stdio: "inherit" });
if (r.status === 0) console.log("TYPECHECK_PASS");
process.exit(r.status ?? 1);
