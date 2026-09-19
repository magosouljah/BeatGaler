import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const bindHost = "127.0.0.1";
const browserHost = "localhost";
const port = Number(process.env.STAGE1_WEB_PORT || 1421);
const webUrl = `http://${browserHost}:${port}`;
const cloudUrl = String(process.env.STAGE1_CLOUD_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const headed = process.env.STAGE1_HEADED === "1";
const accountCount = Math.max(1, Number(process.env.STAGE1_RUN_ACCOUNTS || 2));
const soakMinutes = Math.max(0, Number(process.env.STAGE1_SOAK_MINUTES || 0));
const soakTimeoutMs = soakMinutes > 0
  ? Math.ceil(soakMinutes * 60_000 + 15 * 60_000)
  : null;
const browserProfileRoot = path.join(
  root,
  "tmp",
  "stage1-browser-profiles",
  `run-${process.pid}-${Date.now()}`,
);
let viteProcess = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function preflightCloud() {
  const response = await fetch(`${cloudUrl}/auth/health`, { signal: AbortSignal.timeout(3_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.account_auth !== true) {
    throw new Error(`BeatGaler Cloud preflight failed at ${cloudUrl}/auth/health.`);
  }
}

function canConnectToWeb() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: bindHost, port });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForWeb() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (viteProcess?.exitCode != null) {
      throw new Error(`Vite Web E2E server exited before Stage 1 could start (exit ${viteProcess.exitCode}).`);
    }
    if (await canConnectToWeb()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for BeatGaler Web to accept connections on ${bindHost}:${port}.`);
}

function stopVite() {
  if (viteProcess && viteProcess.exitCode == null) viteProcess.kill("SIGTERM");
  viteProcess = null;
}

function chromeCapability(label) {
  const profileDir = path.join(browserProfileRoot, label);
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--window-size=1280,800",
    `--user-data-dir=${profileDir}`,
  ];
  if (!headed) args.unshift("--headless=new");
  return {
    browserName: "chrome",
    "goog:chromeOptions": { args },
  };
}

const capabilities = Object.fromEntries(
  Array.from({ length: accountCount }, (_, index) => {
    const label = String(index + 1).padStart(2, "0");
    return [`account${label}`, { capabilities: chromeCapability(`account${label}`) }];
  }),
);

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
    timeout: soakTimeoutMs ?? (accountCount >= 4 ? 600_000 : 240_000),
  },

  services: [],
  capabilities,

  onPrepare: async () => {
    await preflightCloud();
    await fs.mkdir(browserProfileRoot, { recursive: true });
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

  onComplete: async () => {
    stopVite();
    await fs.rm(browserProfileRoot, { recursive: true, force: true }).catch(() => {});
  },
};
