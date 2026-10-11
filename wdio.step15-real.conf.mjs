import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStep15Env } from './scripts/step15-isolated-env-guard.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const identity = validateStep15Env(process.env);
const bindHost = '127.0.0.1';
const browserHost = 'localhost';
const port = identity.webPort;
const cloudUrl = String(process.env.STEP15_CLOUD_URL || `http://127.0.0.1:${identity.cloudPort}`).replace(/\/$/, '');
const headed = process.env.STEP15_HEADED === '1';
const preview = process.env.STEP15_WEB_PREVIEW === '1';
const browserProfileRoot = path.join(identity.runDir, 'browser-profiles', `run-${process.pid}-${Date.now()}`);
let viteProcess = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function preflightCloud() {
  const response = await fetch(`${cloudUrl}/auth/health`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.account_auth !== true) {
    throw new Error(`STEP15 Cloud preflight failed at ${cloudUrl}/auth/health.`);
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
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function waitForWeb() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (viteProcess?.exitCode != null) throw new Error(`STEP15 Vite exited early (${viteProcess.exitCode}).`);
    if (await canConnectToWeb()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for STEP15 Web on ${bindHost}:${port}.`);
}

function stopVite() {
  if (viteProcess && viteProcess.exitCode == null) viteProcess.kill('SIGTERM');
  viteProcess = null;
}

const chromeArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--window-size=1280,800',
  `--user-data-dir=${path.join(browserProfileRoot, 'account-a')}`,
];
if (!headed) chromeArgs.unshift('--headless=new');

export const config = {
  runner: 'local',
  specs: ['./tests/e2e-web/step15-real-auth-access.e2e.mjs'],
  maxInstances: 1,
  logLevel: 'warn',
  bail: 1,
  baseUrl: `http://${browserHost}:${port}`,
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 180_000 },
  services: [],
  capabilities: [{ browserName: 'chrome', 'goog:chromeOptions': { args: chromeArgs } }],

  onPrepare: async () => {
    await preflightCloud();
    await fs.mkdir(browserProfileRoot, { recursive: true });
    if (preview) {
      await fs.access(path.join(root, 'dist', 'index.html')).catch(() => {
        throw new Error('STEP15_WEB_PREVIEW=1 requires npm run build:web first.');
      });
    }
    const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    const viteArgs = preview
      ? [viteBin, 'preview', '--host', bindHost, '--port', String(port), '--strictPort']
      : [viteBin, '--mode', 'web', '--host', bindHost, '--port', String(port), '--strictPort'];
    viteProcess = spawn(process.execPath, viteArgs, {
      cwd: root,
      env: { ...process.env, STAGE1_CLOUD_URL: cloudUrl },
      stdio: 'inherit',
      shell: false,
    });
    try { await waitForWeb(); }
    catch (error) { stopVite(); throw error; }
  },

  onComplete: async () => {
    stopVite();
    await fs.rm(browserProfileRoot, { recursive: true, force: true }).catch(() => {});
  },
};
