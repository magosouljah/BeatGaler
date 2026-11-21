'use strict';
// Guardas de aislamiento de los runners de pruebas (scripts/run-cloud-tests.mjs y scripts/catalog-check.cjs):
// pg-port-guard, detección de credenciales locales y negativa del modo --integration sin centinela de instancia efímera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const PG_GUARD = path.join(__dirname, 'helpers', 'pg-port-guard.cjs');

function connectProbe(port, env = {}) {
  const script = `const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',e=>console.log('ERR '+e.code));`;
  const r = spawnSync(process.execPath, ['--require', PG_GUARD, '-e', script], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  return r.stdout.trim();
}

test('pg-port-guard: bloquea los puertos PostgreSQL por defecto y solo deja pasar la instancia verificada', async () => {
  assert.equal(connectProbe(5432), 'ERR TEST_PG_BLOCKED');
  assert.equal(connectProbe(6432), 'ERR TEST_PG_BLOCKED');
  assert.equal(connectProbe(5432, { BEATGALER_TEST_PG_ALLOW: '127.0.0.1:54329' }), 'ERR TEST_PG_BLOCKED');
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(connectProbe(port), 'CONNECTED'); // puerto no PostgreSQL: lo regula solo el guard de red
    assert.equal(connectProbe(port, { BEATGALER_TEST_PG_ALLOW: `localhost:${port}` }), 'CONNECTED');
    assert.equal(connectProbe(port, { BEATGALER_TEST_PG_ALLOW: `10.0.0.5:${port}` }), 'ERR TEST_PG_BLOCKED');
  } finally { server.close(); }
});

test('local-secret-files: detecta por nombre credenciales/estado locales sin leerlos (.env.example no cuenta)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-secret-files-'));
  fs.mkdirSync(path.join(dir, 'cloud-server'));
  assert.deepEqual(findLocalSecretFiles(dir), []);
  fs.writeFileSync(path.join(dir, 'cloud-server', '.env.example'), 'X=1\n');
  assert.deepEqual(findLocalSecretFiles(dir), []);
  for (const f of ['master-session.txt', '.env.telegram-test']) fs.writeFileSync(path.join(dir, 'cloud-server', f), 'fake');
  assert.deepEqual(findLocalSecretFiles(dir).sort(), ['.env.telegram-test', 'master-session.txt']);
  fs.writeFileSync(path.join(dir, '.env'), 'fake');
  assert.ok(findLocalSecretFiles(dir).includes('../.env'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run-cloud-tests --integration: sin centinela de instancia efímera no se ejecuta nada (también con CI=true)', () => {
  const run = (env) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'run-cloud-tests.mjs'), '--integration'], { cwd: REPO, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  const noId = run({ CI: 'true', BEATGALER_CLOUD_TEST_ADMIN_URL: 'postgres://u:p@127.0.0.1:5432/postgres' });
  assert.equal(noId.status, 2);
  assert.match(noId.stderr, /BEATGALER_CLOUD_TEST_INSTANCE_ID/);
  const remote = run({ CI: 'true', BEATGALER_CLOUD_TEST_ADMIN_URL: 'postgres://u:p@db.example.com:5432/postgres', BEATGALER_CLOUD_TEST_INSTANCE_ID: 'bgct-0123456789abcdef' });
  assert.equal(remote.status, 2);
  assert.match(remote.stderr, /loopback/);
  const devPort = run({ BEATGALER_CLOUD_TEST_ADMIN_URL: 'postgres://u:p@127.0.0.1:5432/postgres', BEATGALER_CLOUD_TEST_INSTANCE_ID: 'bgct-0123456789abcdef' });
  assert.equal(devPort.status, 2);
  assert.match(devPort.stderr, /5432/);
});
