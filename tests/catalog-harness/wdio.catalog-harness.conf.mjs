// T02 / V01-B — wdio para el harness de navegador. Servicios simulados en 127.0.0.1; Chrome headless con
// resolución DNS bloqueada salvo 127.0.0.1 y chromedriver fijo en caché (sin descargas).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..", "..");
const OUT = process.env.CATALOG_HARNESS_OUT;
const host = "127.0.0.1", port = 4284, fakePort = 4299, url = `http://${host}:${port}`;
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childEnv = (extra) => {
  const keep = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "NODE_OPTIONS", "CATALOG_NET_POLICY", "CATALOG_NET_REPORT"];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...extra };
};

export const config = {
  runner: "local", specs: [path.join(here, "catalog-harness.e2e.mjs")], maxInstances: 1, logLevel: "warn", bail: 0,
  baseUrl: url, waitforTimeout: 20000, framework: "mocha", reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 90000 }, services: [],
  capabilities: [{
    browserName: "chrome",
    "wdio:chromedriverOptions": { binary: process.env.CATALOG_HARNESS_CHROMEDRIVER },
    "goog:chromeOptions": {
      binary: process.env.CATALOG_HARNESS_CHROME,
      args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900", "--force-device-scale-factor=1",
        `--user-data-dir=${path.join(OUT, "chrome-profile")}`, "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--disable-default-apps"],
    },
  }],
  onPrepare: async () => {
    procs.push(spawn(process.execPath, [path.join(REPO, "cloud-server", "tests", "helpers", "catalog-fake-server.cjs")], { cwd: REPO, stdio: ["ignore", fs.openSync(path.join(OUT, "fake-server.log"), "a"), "inherit"], env: childEnv({ CATALOG_FAKE_PORT: String(fakePort) }) }));
    procs.push(spawn(process.execPath, [path.join(REPO, "node_modules", "vite", "bin", "vite.js"), "preview", "--config", path.join(here, "vite.catalog-harness.config.ts"),
      "--mode", "web", "--host", host, "--port", String(port), "--strictPort"], { cwd: REPO, stdio: ["ignore", fs.openSync(path.join(OUT, "preview.log"), "a"), "inherit"], env: childEnv({ STAGE1_CLOUD_URL: `http://127.0.0.1:${fakePort}` }) }));
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      try { const [a, b] = await Promise.all([fetch(url), fetch(`http://127.0.0.1:${fakePort}/auth/health`)]); if (a.ok && b.ok) return; } catch { /* arrancando */ }
      await sleep(250);
    }
    throw new Error("preview o servidor fake no arrancaron");
  },
  onComplete: async () => {
    try { fs.writeFileSync(path.join(OUT, "fake-server-counters.json"), JSON.stringify(await (await fetch(`http://127.0.0.1:${fakePort}/__catalog/counters`)).json(), null, 2)); } catch { /* registrado como ausente */ }
    for (const p of procs) if (p.exitCode == null) p.kill();
  },
};
