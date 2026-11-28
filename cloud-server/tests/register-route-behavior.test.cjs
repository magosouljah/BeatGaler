'use strict';

// Comportamiento (M7.6a-a0) de POST /auth/register. Tres escenarios, cada uno en un proceso hijo (entorno por allowlist,
// loopback, puerto efimero, guards de red/dotenv/PG):
//  (1) server.js real con BEATGALER_PENDING_SIGNUP_ENABLED apagado: 503 con codigo estable y ningun usuario nuevo en el almacen.
//  (2) server.js real con un servicio de alta pendiente FALSO inyectado en installPendingSignupBoundary (server.js con el flag=1
//      exige PostgreSQL, que aqui no existe): 202 sin token, sin csrf y sin Set-Cookie de sesion. Fija la sustitucion X65 del
//      ultimo handler de la ruta por el alta pendiente (el handler clasico daria 201 con token).
//  (3) server-core cargado sin server.js fuera de produccion (contexto vacio): tras M7.6a-a2 el handler clasico ya no existe;
//      la ruta responde 503 SIGNUP_BOUNDARY_REQUIRED sin crear usuario, boveda ni sesion (y sin delegar en next()).
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

const NEW_EMAIL = 'newbie@example.test';
const registerBody = { email: NEW_EMAIL, username: 'newbie', password: 'Sup3r-secret-pass!1', beatgalerUserId: 'register-route-installation' };

async function shot(send, headers) {
  const response = await send('POST', '/auth/register', { headers, body: registerBody });
  let body = null;
  try { body = JSON.parse(response.data); } catch { /* cuerpo no JSON */ }
  return { status: response.status, body, setCookie: response.headers['set-cookie'] || null };
}

function readUsers(dir) {
  const file = path.join(dir, 'accounts-data.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).users || []) : [];
}

async function childServerJs(mode) {
  const { withCloud } = require('./helpers/composition-cloud.cjs');
  const out = {};
  let stateDir = null;
  const prepare = dir => {
    stateDir = dir;
    process.env.BEATGALER_AUTH_FAILURE_DELAY_MS = '0';
    if (mode !== 'fake') return;
    const boundary = require('../pending-signup-boundary');
    const original = boundary.installPendingSignupBoundary;
    const service = {
      async begin(input) {
        out.beginInput = { email: input.email, usernameBase: input.usernameBase, hasPassword: Boolean(input.password) };
        return { created: true, signup_id: 'sgn_fake', continuation_secret: 'fake-continuation', status: 'PENDING', expires_at: 1, challenge_expires_at: 1 };
      },
    };
    boundary.installPendingSignupBoundary = (ctx, options = {}) => original(ctx, { ...options, service });
  };
  await withCloud(async (_app, send) => {
    const web = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' };
    out.desktop = await shot(send, {});
    if (mode === 'fake') out.web = await shot(send, web);
    out.emails = readUsers(stateDir).map(user => user.email);
  }, { prepare });
  return out;
}

async function childServerCore() {
  const express = require('express');
  const originalListen = express.application.listen;
  const server = await new Promise((resolve, reject) => {
    express.application.listen = function listen(_port, _host, callback) {
      const s = originalListen.call(this, 0, '127.0.0.1', callback);
      s.once('listening', () => resolve(s));
      s.once('error', reject);
      return s;
    };
    require('../server-core').listenCloudServer();
  });
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registerBody),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* cuerpo no JSON */ }
  server.close();
  server.closeAllConnections?.();
  return {
    status: response.status,
    body,
    setCookie: response.headers.get('set-cookie'),
    emails: readUsers(process.env.BEATGALER_STATE_DIR).map(user => user.email),
  };
}

function absoluteExecArgv() {
  const argv = process.execArgv;
  return argv.map((arg, i) => (/^(--require|-r|--import)$/.test(argv[i - 1] || '') && /^\.{1,2}[\\/]/.test(arg) ? path.resolve(arg) : arg));
}

function runChild(mode) {
  assert.equal(findLocalSecretFiles(path.resolve(__dirname, '../..')).length, 0, 'requires a clean Cloud checkout');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-register-route-'));
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
        ...(mode === 'direct' ? {
          BEATGALER_PUBLIC_REGISTRATION: '1',
          BEATGALER_POSTGRES_ENABLED: 'false',
          TRANSPORT_BOTS_FILE: path.join(scratch, 'no-pool.json'),
          TRANSPORT_POOL_STATE: path.join(scratch, 'pool-state.json'),
          MASTERS_FILE: path.join(scratch, 'no-masters.json'),
          VAULT_REGISTRY_FILE: path.join(scratch, 'vaults.json'),
        } : {}),
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

if (process.argv[2] === '--child') {
  const mode = process.argv[3];
  (mode === 'direct' ? childServerCore() : childServerJs(mode)).then(
    result => { process.stdout.write(`@@${JSON.stringify(result)}`); process.exit(0); },
    error => { console.error(error); process.exit(1); },
  );
} else {
  test('(1) server.js con alta pendiente apagada: 503 estable y ninguna cuenta nueva', () => {
    const r = runChild('flag0');
    assert.equal(r.desktop.status, 503);
    assert.equal(r.desktop.body.code, 'AUTH_SERVICE_UNAVAILABLE');
    assert.equal(r.desktop.body.token, undefined);
    assert.equal(r.desktop.setCookie, null);
    assert.deepEqual(r.emails, ['smoke@example.test'], 'solo el usuario sembrado: el registro no escribe cuentas');
  });

  test('(2) server.js con servicio de alta pendiente falso: 202 sin token ni cookie de sesion', () => {
    const r = runChild('fake');
    assert.deepEqual(r.beginInput, { email: NEW_EMAIL, usernameBase: 'newbie', hasPassword: true }, 'el alta pendiente sustituye al handler clasico');
    assert.equal(r.desktop.status, 202);
    assert.equal(r.desktop.body.signup_pending, true);
    for (const key of ['token', 'csrf_token', 'user', 'account_created']) assert.equal(r.desktop.body[key], undefined, key);
    assert.equal(r.desktop.setCookie, null, 'escritorio: ninguna cookie');
    assert.equal(r.web.status, 202);
    for (const key of ['token', 'csrf_token', 'user']) assert.equal(r.web.body[key], undefined, key);
    const cookies = (r.web.setCookie || []).map(value => value.split('=', 1)[0]);
    assert.deepEqual(cookies, ['__Host-beatgaler_signup'], 'web: solo la cookie de continuacion del alta, ninguna de sesion');
    assert.deepEqual(r.emails, ['smoke@example.test'], 'sin cuenta permanente');
  });

  test('(3) server-core sin server.js fuera de produccion: 503 SIGNUP_BOUNDARY_REQUIRED sin escritura', () => {
    const r = runChild('direct');
    assert.equal(r.status, 503, `estado ${r.status} (404 = la llamada se delego en next() o se retiro la ruta)`);
    assert.equal(r.body?.code, 'SIGNUP_BOUNDARY_REQUIRED');
    for (const key of ['token', 'csrf_token', 'user', 'account_created', 'username']) assert.equal(r.body[key], undefined, key);
    assert.equal(r.setCookie, null, 'sin cookie de sesion');
    assert.deepEqual(r.emails, [], 'ningun usuario persistido');
  });
}
