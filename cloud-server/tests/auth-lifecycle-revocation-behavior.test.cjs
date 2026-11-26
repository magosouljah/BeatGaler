'use strict';

// Comportamiento (M7.5b-B6t) de la revocacion por ciclo de vida de cuenta contra server.js real en un proceso hijo
// (entorno por allowlist, loopback, puerto efimero). Login web y de escritorio -> peticion autenticada (200) ->
// revokeUserSessions del runtime de ciclo de vida -> reutilizar la credencial en una ruta sin handler propio ->
// 401 SESSION_REQUIRED de `account-lifecycle-request-guard` (sin borrar cookies). La revocacion purga el archivo de
// sesiones y session-security responderia antes (SESSION_EXPIRED); se restituye el archivo para aislar la guarda.
// Instalar la guarda en un ctx ajeno hace que la credencial revocada llegue al router (404).
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

async function childScenario(foreignCtx) {
  const { withCloud, account } = require('./helpers/composition-cloud.cjs');
  const out = {};
  let runtime = null;
  let stateDir = null;
  const prepare = dir => {
    stateDir = dir;
    process.env.BEATGALER_AUTH_FAILURE_DELAY_MS = '0';
    const guard = require('../account-lifecycle-request-guard');
    const original = guard.installLifecycleRequestGuard;
    guard.installLifecycleRequestGuard = (ctx, rt) => {
      runtime = rt;
      return original(foreignCtx ? { entries: {}, state: new WeakMap() } : ctx, rt);
    };
  };
  await withCloud(async (_app, send) => {
    const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' };
    const body = { email: account.email, password: account.password, beatgalerUserId: account.beatgalerUserId };
    const shot = async (url, headers) => {
      const response = await send('POST', url, { headers, body: {} });
      let code = null;
      try { code = JSON.parse(response.data).code ?? null; } catch { /* cuerpo no JSON */ }
      return { status: response.status, code, cleared: Boolean(response.headers['set-cookie']) };
    };
    const web = await send('POST', '/auth/login', { headers: browser, body });
    const cookie = web.headers['set-cookie'].map(value => value.split(';', 1)[0]).join('; ');
    const webHeaders = { ...browser, cookie, 'x-beatgaler-csrf': JSON.parse(web.data).csrf_token };
    const desktop = await send('POST', '/auth/login', { headers: {}, body });
    const bearer = { authorization: `Bearer ${JSON.parse(desktop.data).token}` };
    out.before = { web: await shot('/auth/sessions', webHeaders), desktop: await shot('/auth/sessions', bearer) };
    out.passThrough = { web: await shot('/probe/lifecycle-guard', webHeaders), desktop: await shot('/probe/lifecycle-guard', bearer) };
    const accountsFile = path.join(stateDir, 'accounts-data.json');
    const snapshot = fs.readFileSync(accountsFile);
    out.revoked = await runtime.api.session.revokeUserSessions(account.id, 'behavior-test');
    // La revocacion de ciclo de vida purga las sesiones del archivo y session-security responde antes. Se restituye el
    // registro para aislar la guarda: session-security acepta la credencial y solo el estado de revocacion la rechaza.
    fs.writeFileSync(accountsFile, snapshot);
    out.after = { web: await shot('/probe/lifecycle-guard', webHeaders), desktop: await shot('/probe/lifecycle-guard', bearer) };
  }, { prepare });
  return out;
}

function absoluteExecArgv() {
  const argv = process.execArgv;
  return argv.map((arg, i) => (/^(--require|-r|--import)$/.test(argv[i - 1] || '') && /^\.{1,2}[\/]/.test(arg) ? path.resolve(arg) : arg));
}

function runChild(mode) {
  assert.equal(findLocalSecretFiles(path.resolve(__dirname, '../..')).length, 0, 'requires a clean Cloud checkout');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-lifecycle-revoke-'));
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

if (process.argv[2] === '--child') {
  childScenario(process.argv[3] === 'foreign').then(
    result => { process.stdout.write(`@@${JSON.stringify(result)}`); process.exit(0); },
    error => { console.error(error); process.exit(1); },
  );
} else {
  test('tras revocar por ciclo de vida, la cookie web y el bearer de escritorio reciben 401', () => {
    const r = runChild('own');
    assert.equal(r.before.web.status, 200);
    assert.equal(r.before.desktop.status, 200);
    assert.equal(r.passThrough.web.status, 404, 'credencial vigente: la guarda deja pasar');
    assert.equal(r.passThrough.desktop.status, 404);
    assert.ok(r.revoked >= 2, 'revoca la sesion web y la de escritorio');
    assert.equal(r.after.web.status, 401);
    assert.equal(r.after.web.code, 'SESSION_REQUIRED');
    assert.equal(r.after.web.cleared, false);
    assert.deepEqual(r.after.desktop, { status: 401, code: 'SESSION_REQUIRED', cleared: false });
  });

  test('la guarda instalada en un ctx ajeno deja pasar al bearer revocado (sin SESSION_REQUIRED)', () => {
    const r = runChild('foreign');
    assert.equal(r.after.desktop.status, 404);
    assert.equal(r.after.web.status, 404);
  });
}
