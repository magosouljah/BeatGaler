import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const vitePort = 4174;
const binderPort = 4180;
const baseUrl = `http://${host}:${vitePort}`;
const binderHealth = `http://${host}:${binderPort}/health`;
const SECRET_NAMES = [
  "BEATGALER_M0_B2_API_ID",
  "BEATGALER_M0_B2_API_HASH",
  "BEATGALER_M0_B2_BOT_TOKEN",
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
];

let binderProcess = null;
let viteProcess = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(url, label, processRef, timeoutMs = 70_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processRef()?.exitCode != null) {
      throw new Error(`${label} exited before becoming ready (exit ${processRef()?.exitCode}).`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // Cold CI runners can take a moment to initialize MTProto/WASM/Vite.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}.`);
}

function stopProcess(proc) {
  if (proc && proc.exitCode == null) proc.kill("SIGTERM");
}

async function startBinderWithRetry(maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    binderProcess = spawn(process.execPath, ["scripts/telegram-temp-auth-web-binder.mjs"], {
      cwd: root,
      env: { ...process.env },
      stdio: "inherit",
    });
    try {
      await waitFor(binderHealth, `M0-E2 binder attempt ${attempt}`, () => binderProcess);
      return;
    } catch (error) {
      lastError = error;
      stopProcess(binderProcess);
      binderProcess = null;
      if (attempt < maxAttempts) await sleep(750 * attempt);
    }
  }
  throw lastError || new Error("M0-E2 binder could not start after bounded retries.");
}

function sanitizedBrowserServerEnv() {
  const env = { ...process.env };
  for (const name of SECRET_NAMES) delete env[name];
  return env;
}

export const config = {
  runner: "local",
  specs: ["./tests/probes/m0-e2-web.e2e.mjs"],
  maxInstances: 1,
  logLevel: "warn",
  bail: 1,
  baseUrl,
  waitforTimeout: 95_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 100_000,
  },

  services: [],
  capabilities: [
    {
      browserName: "chrome",
      "goog:chromeOptions": {
        args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
      },
    },
  ],

  onPrepare: async () => {
    await startBinderWithRetry();

    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    viteProcess = spawn(npx, ["--no-install", "vite", "--config", "vite.m0-e2.config.mjs"], {
      cwd: root,
      env: sanitizedBrowserServerEnv(),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    try {
      await waitFor(`${baseUrl}/m0-e2.html`, "M0-E2 Vite browser server", () => viteProcess, 30_000);
    } catch (error) {
      stopProcess(viteProcess);
      stopProcess(binderProcess);
      throw error;
    }
  },

  onComplete: () => {
    stopProcess(viteProcess);
    stopProcess(binderProcess);
    viteProcess = null;
    binderProcess = null;
  },
};
