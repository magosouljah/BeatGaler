import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = 4173;
const previewUrl = `http://${host}:${port}`;
let previewProcess = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPreview() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (previewProcess?.exitCode != null) {
      throw new Error(`Vite preview exited before Web smoke could start (exit ${previewProcess.exitCode}).`);
    }
    try {
      const response = await fetch(previewUrl, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // The preview server can take a moment to bind on a clean CI runner.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for BeatGaler Web preview at ${previewUrl}.`);
}

function stopPreview() {
  if (previewProcess && previewProcess.exitCode == null) previewProcess.kill("SIGTERM");
  previewProcess = null;
}

export const config = {
  runner: "local",
  specs: ["./tests/e2e-web/**/*.e2e.mjs"],
  exclude: ["./tests/e2e-web/temp-auth-live.e2e.mjs"],
  maxInstances: 1,
  logLevel: "warn",
  bail: 1,
  baseUrl: previewUrl,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 30_000,
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
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    previewProcess = spawn(
      command,
      ["run", "preview", "--", "--host", host, "--port", String(port), "--strictPort"],
      {
        cwd: root,
        env: { ...process.env },
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );
    try {
      await waitForPreview();
    } catch (error) {
      stopPreview();
      throw error;
    }
  },

  onComplete: () => {
    stopPreview();
  },
};
