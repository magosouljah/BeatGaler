'use strict';

// Comportamiento (M7.5b-B7at) del endurecimiento de registro contra server.js real en un proceso hijo
// (entorno por allowlist, loopback, puerto efimero).
// 1) Wrap GET del callback OAuth: con un flujo iniciado (cliente Google ficticio, sin red), el callback con un
//    `error_description` de aspecto interno se reescribe a un HTML generico con request id; uno inocuo pasa tal cual.
//    Sin el wrap GET el handler devuelve el texto interno.
// 2) Getter del ciclo de vida: la escritura de `accounts-data.json.tmp` conserva al usuario previo que el estado del
//    ciclo de vida conoce aunque la nueva lista no lo traiga. Con el getter a null no hay previos y se pierde.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

async function childScenario() {
  const { withCloud, account } = require('./helpers/composition-cloud.cjs');
  const out = {};
  let stateDir = null;
  const prepare = dir => {
    stateDir = dir;
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.BEATGALER_OAUTH_PUBLIC_BASE = 'http://127.0.0.1';
  };
  await withCloud(async (_app, send) => {
    const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' };
    const callback = async description => {
      const start = await send('POST', '/auth/oauth/start', { headers: browser, body: { provider: 'google', beatgalerUserId: 'inst-oauth' } });
      const state = new URL(JSON.parse(start.data).authorization_url).searchParams.get('state');
      const query = new URLSearchParams({ state, error: 'access_denied', error_description: description });
      const response = await send('GET', `/auth/oauth/google/callback?${query}`, { headers: browser });
      return { startStatus: start.status, status: response.status, type: response.headers['content-type'], html: response.data };
    };
    out.internal = await callback('database connection failed');
    out.benign = await callback('user cancelled');
    const tmp = path.join(stateDir, 'accounts-data.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ users: [{ id: 'usr_other', username: 'other', email: 'other@example.test', providers: {} }], sessions: {} }));
    out.preservedIds = JSON.parse(fs.readFileSync(tmp, 'utf8')).users.map(user => user.id);
    out.seedId = account.id;
  }, { prepare });
  return out;
}

function absoluteExecArgv() {
  const argv = process.execArgv;
  return argv.map((arg, i) => (/^(--require|-r|--import)$/.test(argv[i - 1] || '') && /^\.{1,2}[\/]/.test(arg) ? path.resolve(arg) : arg));
}

function runChild() {
  assert.equal(findLocalSecretFiles(path.resolve(__dirname, '../..')).length, 0, 'requires a clean Cloud checkout');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-reg-hardening-'));
  try {
    const preloads = ['catalog-net-guard.cjs', 'no-dotenv.cjs', 'pg-port-guard.cjs'];
    const args = preloads.flatMap(file => ['--require', path.join(__dirname, 'helpers', file)]);
    const child = spawnSync(process.execPath, [...absoluteExecArgv(), ...args, __filename, '--child'], {
      cwd: scratch,
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: scratch,
        TMP: scratch,
        NODE_ENV: 'test',
        BEATGALER_STATE_DIR: scratch,
        DIRECT_DIAGNOSTICS_DIR: process.env.DIRECT_DIAGNOSTICS_DIR || scratch,
        CATALOG_NET_POLICY: 'loopback',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
      encoding: 'utf8',
      timeout: 90000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `Cloud child failed:\n${child.stdout}${child.stderr}`);
    return JSON.parse(child.stdout.split('@@')[1]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') {
  childScenario().then(
    result => { process.stdout.write(`@@${JSON.stringify(result)}`); process.exit(0); },
    error => { console.error(error); process.exit(1); },
  );
} else {
  const r = runChild.cached || (runChild.cached = runChild());

  test('callback OAuth: el wrap GET oculta el error interno y deja pasar el inocuo', () => {
    assert.equal(r.internal.startStatus, 200);
    assert.equal(r.internal.status, 400);
    assert.match(r.internal.type, /text\/html/);
    assert.match(r.internal.html, /BeatGaler sign-in failed/);
    assert.match(r.internal.html, /Authentication service is temporarily unavailable\. Please try again\. \([^)]+\)/);
    assert.doesNotMatch(r.internal.html, /database/i);
    assert.equal(r.benign.status, 400);
    assert.match(r.benign.html, /<p>user cancelled<\/p>/);
  });

  test('el hardening ve el runtime de ciclo de vida: conserva al usuario previo al reescribir cuentas', () => {
    assert.deepEqual(r.preservedIds, ['usr_other', r.seedId]);
  });
}
