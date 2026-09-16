import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const bindHost = "127.0.0.1";
const browserHost = "localhost";
const port = Number(process.env.STAGE1_WEB_PORT || 1421);
const webUrl = `http://${browserHost}:${port}`;
const probeUrl = `http://${bindHost}:${port}`;
const cloudUrl = String(process.env.STAGE1_CLOUD_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const headed = process.env.STAGE1_HEADED === "1";
let viteProcess = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function preflightCloud() {
  const response = await fetch(`${cloudUrl}/auth/health`, { signal: AbortSignal.timeout(3_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.account_auth !== true) {
    throw new Error(`BeatGaler Cloud preflight failed at ${cloudUrl}/auth/health.`);
  }
}

async function waitForWeb() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (viteProcess?.exitCode != null) {
      throw new Error(`Vite Web E2E server exited before Stage 1 could start (exit ${viteProcess.exitCode}).`);
    }
    try {
      const response = await fetch(probeUrl, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // Vite can take a moment to bind on a clean checkout.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for BeatGaler Web at ${probeUrl}.`);
}

function stopVite() {
  if (viteProcess && viteProcess.exitCode == null) viteProcess.kill("SIGTERM");
  viteProcess = null;
}

function chromeCapability() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800", "--incognito"];
  if (!headed) args.unshift("--headless=new");
  return {
    browserName: "chrome",
    "goog:chromeOptions": { args },
  };
}

export const config = {
  runner: "local",
  specs: ["./tests/e2e-web/stage1-real-multi-account.e2e.mjs"],
  maxInstances: 1,
  logLevel: "warn",
  bail: 0,
  baseUrl: webUrl,
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000,
  },

  services: [],
  capabilities: {
    accountA: { capabilities: chromeCapability() },
    accountB: { capabilities: chromeCapability() },
  },

  onPrepare: async () => {
    await preflightCloud();
    const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
    viteProcess = spawn(
      process.execPath,
      [viteBin, "--mode", "web", "--host", bindHost, "--port", String(port), "--strictPort"],
      {
        cwd: root,
        env: { ...process.env },
        stdio: "inherit",
        shell: false,
      },
    );
    try {
      await waitForWeb();
    } catch (error) {
      stopVite();
      throw error;
    }
  },

  onComplete: () => {
    stopVite();
  },
};
