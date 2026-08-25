import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = 4174;
const binderPort = 43151;
const previewUrl = `http://${host}:${port}`;
const binderUrl = `http://${host}:${binderPort}`;
let previewProcess = null;
let binderProcess = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(url, proc, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (proc?.exitCode != null) throw new Error(`${label} exited early (${proc.exitCode}).`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}.`);
}

function stop(proc) {
  if (proc && proc.exitCode == null) proc.kill("SIGTERM");
}

export const config = {
  runner: "local",
  specs: ["./tests/e2e-web/temp-auth-live.e2e.mjs"],
  maxInstances: 1,
  logLevel: "warn",
  bail: 1,
  baseUrl: previewUrl,
  waitforTimeout: 120_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180_000 },
  services: [],
  capabilities: [{
    browserName: "chrome",
    "goog:chromeOptions": {
      args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
    },
  }],
  onPrepare: async () => {
    binderProcess = spawn(process.execPath, ["scripts/telegram-temp-auth-web-binder.mjs"], {
      cwd: root,
      env: { ...process.env, BEATGALER_M0_E_BINDER_PORT: String(binderPort) },
      stdio: "inherit",
    });
    await waitFor(`${binderUrl}/health`, binderProcess, "M0-E binder");

    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    previewProcess = spawn(command, ["vite", "preview", "--config", "vite.temp-auth-probe.config.mjs", "--host", host, "--port", String(port), "--strictPort"], {
      cwd: root,
      env: { ...process.env },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    await waitFor(previewUrl, previewProcess, "M0-E Web probe preview");
  },
  onComplete: () => {
    stop(previewProcess);
    stop(binderProcess);
  },
};
