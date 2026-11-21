// T02 / V01-B — Orquestador del harness de navegador (caso `web/v01b-browser-harness`).
// 1) build del harness (config productiva + doble + instrumentación), 2) wdio con servicios fake en 127.0.0.1,
// 3) valida el reporte. Sale != 0 si falta Chrome/chromedriver en caché, si el build falla o si algún check falla.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..", "..");
const OUT = process.env.CATALOG_CHECK_CASE_DIR || path.join(REPO, "tmp", "catalog-harness", `run-${Date.now()}`);
fs.mkdirSync(OUT, { recursive: true });
const chrome = process.env.CHROME_BIN || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const fail = (msg) => { console.error(`V01B_HARNESS_FAIL ${msg}`); process.exit(1); };
if (!fs.existsSync(chrome)) fail(`Chrome ausente (${chrome})`);

function chromeVersion() {
  if (process.platform === "win32") {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Item '${chrome}').VersionInfo.ProductVersion`], { encoding: "utf8" });
    return r.stdout.trim();
  }
  return spawnSync(chrome, ["--version"], { encoding: "utf8" }).stdout.replace(/[^0-9.]/g, "");
}
const version = chromeVersion();
const tmpRoot = process.env.TEMP || process.env.TMP || "/tmp";
const driver = path.join(tmpRoot, "chromedriver", `win64-${version}`, "chromedriver-win64", process.platform === "win32" ? "chromedriver.exe" : "chromedriver");
if (!fs.existsSync(driver)) fail(`chromedriver ${version} no está en caché (${driver}); el harness no descarga nada`);

const env = { ...process.env, CATALOG_HARNESS_OUT: OUT, CATALOG_HARNESS_CHROME: chrome, CATALOG_HARNESS_CHROMEDRIVER: driver };
const t0 = Date.now();
const build = spawnSync(process.execPath, [path.join(REPO, "node_modules", "vite", "bin", "vite.js"), "build", "--config", path.join(here, "vite.catalog-harness.config.ts"), "--mode", "web", "--logLevel", "warn"], { cwd: REPO, env, encoding: "utf8", maxBuffer: 64 << 20 });
fs.writeFileSync(path.join(OUT, "build.log"), build.stdout + build.stderr);
if (build.status !== 0) fail(`build exit ${build.status}`);
const buildMs = Date.now() - t0;

const wdio = spawnSync(process.execPath, [path.join(REPO, "node_modules", "@wdio", "cli", "bin", "wdio.js"), "run", path.join(here, "wdio.catalog-harness.conf.mjs")], { cwd: REPO, env, encoding: "utf8", maxBuffer: 64 << 20 });
fs.writeFileSync(path.join(OUT, "wdio.log"), wdio.stdout + wdio.stderr);
const reportFile = path.join(OUT, "browser-harness-report.json");
if (!fs.existsSync(reportFile)) fail(`sin reporte (wdio exit ${wdio.status})`);
const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
const ids = report.results.map((r) => `${r.id}:${r.result}`);
console.log(JSON.stringify({ chrome: version, build_ms: buildMs, wdio_exit: wdio.status, results: ids, out: OUT }));
const expected = ["H1-login-gallery", "H2-cards", "H3-environment", "H4-isolation-counters"];
if (wdio.status !== 0 || expected.some((id) => !report.results.find((r) => r.id === id && r.result === "PASS"))) fail(`checks: ${ids.join(", ")}`);
console.log("V01B_HARNESS_PASS");
