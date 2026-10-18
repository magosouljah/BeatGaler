import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePublicBrowserEnv } from './scripts/v1-public-browser-guard.mjs';
import { runPublicCanary } from './scripts/v1-public-canary.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const run = validatePublicBrowserEnv(process.env, root);
const profile = path.join(run.runDir, 'browser-profile');

export const config = {
  runner: 'local',
  specs: ['./tests/e2e-web/v1-public-auth-access.e2e.mjs'],
  maxInstances: 1, logLevel: 'warn', bail: 1, baseUrl: run.webOrigin,
  waitforTimeout: 30_000, connectionRetryTimeout: 120_000, connectionRetryCount: 1,
  framework: 'mocha', reporters: ['spec'], mochaOpts: { ui: 'bdd', timeout: 180_000 }, services: [],
  capabilities: [{ browserName: 'chrome', 'goog:chromeOptions': { args: [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800',
    `--user-data-dir=${profile}`,
  ] } }],
  onPrepare: async () => {
    const proof = await runPublicCanary(run);
    await fs.mkdir(run.runDir, { recursive: true });
    await fs.writeFile(path.join(run.runDir, 'public-read-only-canary.json'), `${JSON.stringify(proof, null, 2)}\n`);
  },
  onComplete: async () => {
    await fs.rm(profile, { recursive: true, force: true });
  },
};
