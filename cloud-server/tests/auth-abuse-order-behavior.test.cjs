'use strict';

// Comportamiento (M7.5b-B5t) del orden durable -> memoria del antiabuso de /auth/login y /auth/register.
// server.js real en un proceso hijo (entorno por allowlist, loopback, puerto efimero) y una rafaga de intentos.
// Con pool durable falso (limite 4) la capa durable corta el login en el intento 6 con `code: AUTH_RATE_LIMITED`
// y Retry-After 60; el registro tambien. Sin pool solo actua la memoria: login corta en el 13 sin `code`.
// Invertir durable/memoria en ROUTE_GUARD_TABLE cambia en que intento llega el 429 y su `code`.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

const ATTEMPTS = 15;

async function childScenario(durableMode) {
  const { withCloud, account } = require('./helpers/composition-cloud.cjs');
  const out = { login: [], register: [] };
  const prepare = () => {
    Object.assign(process.env, {
      BEATGALER_AUTH_FAILURE_DELAY_MS: '0',
      BEATGALER_AUTH_LOGIN_TARGET_MAX: '5',
      BEATGALER_AUTH_DURABLE_TARGET_MAX: '4',
    });
    if (!durableMode) return;
    const durable = require('../auth-durable-abuse-controls');
    const original = durable.installDurableAuthAbuseControls;
    const buckets = new Map();
    const pool = {
      async query(_sql, params) {
        const key = `${params[0]}|${params[1]}`;
        const count = (buckets.get(key) || 0) + 1;
        buckets.set(key, count);
        return { rows: [{ request_count: count, window_started_at: new Date(), expires_at: new Date(Date.now() + 60000) }] };
      },
    };
    durable.installDurableAuthAbuseControls = (first, options = {}) => original(first, { ...options, pool });
  };
  await withCloud(async (_app, send) => {
    const headers = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' };
    const shot = async (url, body) => {
      const response = await send('POST', url, { headers, body });
      let code = null;
      try { code = JSON.parse(response.data).code ?? null; } catch { /* cuerpo no JSON */ }
      return { status: response.status, retryAfter: response.headers['retry-after'] ?? null, code };
    };
    for (let i = 1; i <= ATTEMPTS; i += 1) {
      out.login.push(await shot('/auth/login', { email: account.email, password: `wrong-pass-${i}`, beatgalerUserId: account.beatgalerUserId }));
    }
    for (let i = 1; i <= 8; i += 1) {
      out.register.push(await shot('/auth/register', { email: 'burst@example.test', password: `Sup3r-secret-pass!${i}`, beatgalerUserId: account.beatgalerUserId }));
    }
  }, { prepare });
  return out;
}

function absoluteExecArgv() {
  const argv = process.execArgv;
  return argv.map((arg, i) => (/^(--require|-r|--import)$/.test(argv[i - 1] || '') && /^\.{1,2}[\\/]/.test(arg) ? path.resolve(arg) : arg));
}

function runChild(mode) {
  assert.equal(findLocalSecretFiles(path.resolve(__dirname, '../..')).length, 0, 'requires a clean Cloud checkout');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-abuse-order-'));
  try {
    const preloads = ['catalog-net-guard.cjs', 'no-dotenv.cjs', 'pg-port-guard.cjs'];
    const args = preloads.flatMap(file => ['--require', path.join(__dirname, 'helpers', file)]);
    const child = spawnSync(process.execPath, [...absoluteExecArgv(), ...args, __filename, '--child', mode], {
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
    assert.equal(child.status, 0, `Cloud child ${mode} failed:\n${child.stdout}${child.stderr}`);
    return JSON.parse(child.stdout.split('@@')[1]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const firstBlocked = list => list.findIndex(r => r.status === 429) + 1;

if (process.argv[2] === '--child') {
  childScenario(process.argv[3] === 'durable').then(
    result => { process.stdout.write(`@@${JSON.stringify(result)}`); process.exit(0); },
    error => { console.error(error); process.exit(1); },
  );
} else {
  test('con pool durable el primer 429 llega en el intento 6 y lo emite la capa durable', () => {
    const r = runChild('durable');
    assert.equal(firstBlocked(r.login), 6, 'login: la capa durable corta en el intento 6');
    assert.ok(r.login.slice(0, 5).every(x => x.status === 401));
    assert.ok(r.login.slice(5).every(x => x.status === 429 && x.code === 'AUTH_RATE_LIMITED' && x.retryAfter === '60'));
    assert.deepEqual(r.register.slice(0, 5).map(x => [x.status, x.code]), Array(5).fill([503, 'AUTH_SERVICE_UNAVAILABLE']));
    assert.ok(r.register.slice(5).every(x => x.status === 429 && x.code === 'AUTH_RATE_LIMITED' && x.retryAfter === '60'), 'registro: 429 durable desde el intento 6');
  });

  test('sin pool solo actua la memoria: el primer 429 llega en el intento 13 y sin code', () => {
    const r = runChild('memory');
    assert.equal(firstBlocked(r.login), 13, 'login: la memoria corta en el intento 13');
    assert.ok(r.login.slice(0, 12).every(x => x.status === 401));
    assert.ok(r.login.slice(12).every(x => x.status === 429 && x.code === null && x.retryAfter === '60'));
    assert.equal(firstBlocked(r.register), 0, 'registro: sin durable no hay 429 en 8 intentos');
    assert.ok(r.register.every(x => x.status === 503 && x.code === 'AUTH_SERVICE_UNAVAILABLE'));
  });
}
