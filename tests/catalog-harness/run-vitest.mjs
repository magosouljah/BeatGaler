// T08 — Envoltorio del runner de catálogo para vitest (jsdom). Recibe las rutas de los tests como argumentos (validadas por
// scripts/catalog-check.cjs contra allowed_case_roots) y sale con el código de vitest. Sin red: los tests usan dobles.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..", "..");
const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!files.length) { console.error("run-vitest: sin archivos"); process.exit(2); }
const r = spawnSync(process.execPath, [path.join(REPO, "node_modules", "vitest", "vitest.mjs"), "run", ...files, "--environment", "jsdom", "--reporter", "verbose"], { cwd: REPO, stdio: "inherit", env: { ...process.env, CI: "true" } });
process.exit(r.status ?? 1);
