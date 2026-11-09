'use strict';
// T02 / V01-C — Pruebas negativas y de contrato de scripts/catalog-check.cjs.
// Manifiestos sintéticos en un directorio temporal; el runner real se ejecuta como proceso hijo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RUNNER = path.join(REPO, 'scripts', 'catalog-check.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-runner-'));
let n = 0;

function write(name, body) { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; }
function manifest(suites, extra = {}) {
  return write(`m-${++n}.json`, JSON.stringify({ schema: 'beatgaler.catalog-suites', version: 1, allowed_case_roots: [tmp], forbidden_case_files: [], suites, ...extra }));
}
function run(suite, man, envExtra = {}) {
  const out = path.join(tmp, `out-${++n}`);
  const r = spawnSync(process.execPath, [RUNNER, suite, '--manifest', man, '--out', out], {
    cwd: REPO, encoding: 'utf8', timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ...envExtra },
  });
  const sumFile = path.join(out, 'summary.json');
  const summary = fs.existsSync(sumFile) ? JSON.parse(fs.readFileSync(sumFile, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary, out };
}
const nodeTest = (id, file, extra = {}) => ({ id, cmd: ['node', '--test', '--test-reporter=tap', file], kind: 'node-test', ...extra });

const passFile = write('pass.test.cjs', "require('node:test')('ok', () => {});\n");
const skipFile = write('skip.test.cjs', "const t = require('node:test'); t('ok', () => {}); t('later', { skip: true }, () => {});\n");
const todoFile = write('todo.test.cjs', "require('node:test')('x', { todo: true }, () => {});\n");
const emptyFile = write('empty.test.cjs', "// sin tests\n");
const failFile = write('fail.test.cjs', "require('node:test')('boom', () => { throw new Error('x'); });\n");
const plainFail = write('plain-fail.cjs', 'process.exit(3);\n');
const netFile = write('net.test.cjs', "require('node:test')('red', async () => { await fetch('http://192.0.2.1/').catch(() => {}); });\n");
const envFile = write('env.test.cjs', `
const test = require('node:test'); const assert = require('node:assert/strict');
test('entorno limpio', () => {
  for (const k of ['DATABASE_URL', 'RESTORE_DATABASE_URL', 'PGPASSWORD', 'PGHOST', 'AWS_SECRET_ACCESS_KEY', 'TELEGRAM_BOT_TOKEN', 'POLAR_ACCESS_TOKEN', 'SMTP_PASSWORD', 'CATALOG_TEST_ADMIN_URL']) assert.equal(process.env[k], undefined, k);
  assert.match(process.env.NODE_OPTIONS, /catalog-net-guard\\.cjs/);
  assert.equal(process.env.CATALOG_NET_POLICY, 'deny');
});
`);

test('suite inexistente => exit 2', () => {
  const r = run('T99', manifest({ unit: { status: 'active', network: 'deny', requires: [], cases: [nodeTest('a', passFile)] } }));
  assert.equal(r.status, 2); assert.match(r.summary.error, /suite inexistente/);
});

test('suite pending, vacía o aggregate con pending => exit 4 (no se finge)', () => {
  const m = manifest({ T03: { status: 'pending', owner: 'T03' }, vacia: { status: 'active', cases: [] }, all: { status: 'aggregate', includes: ['ok', 'T03'] }, ok: { status: 'active', network: 'deny', requires: [], cases: [nodeTest('a', passFile)] } });
  for (const s of ['T03', 'vacia', 'all']) { const r = run(s, m); assert.equal(r.status, 4, s); assert.equal(r.summary.cases.length, 0, s); }
});

test('casos no permitidos => exit 5 antes de ejecutar nada', () => {
  const outside = path.join(REPO, 'cloud-server', 'tests', 'unit.test.cjs');
  const bad = {
    fuera: nodeTest('a', outside),
    'postgres-live': nodeTest('a', path.join(REPO, 'cloud-server', 'tests', 'postgres-live.integration.cjs')),
    'env-file': { id: 'a', cmd: ['node', '--env-file=.env', passFile], kind: 'plain' },
    'no-node': { id: 'a', cmd: ['npm', 'test'], kind: 'plain' },
    'require extra': { id: 'a', cmd: ['node', '-r', passFile, passFile], kind: 'plain' },
    inexistente: nodeTest('a', path.join(tmp, 'nope.test.cjs')),
  };
  for (const [label, c] of Object.entries(bad)) {
    const r = run('s', manifest({ s: { status: 'active', network: 'deny', requires: [], cases: [nodeTest('ok', passFile), c] } }));
    assert.equal(r.status, 5, label); assert.equal(r.summary.cases.length, 0, label);
  }
});

test('skip, todo, vacío, fallo y exit != 0 => exit 1 con motivo', () => {
  const cases = [[skipFile, 'SKIPPED'], [todoFile, 'SKIPPED'], [emptyFile, 'EMPTY'], [failFile, 'TEST_FAIL']];
  for (const [file, reason] of cases) {
    const r = run('s', manifest({ s: { status: 'active', network: 'deny', requires: [], cases: [nodeTest('c', file)] } }));
    assert.equal(r.status, 1, reason); assert.ok(r.summary.cases[0].reasons.includes(reason), `${reason}: ${r.summary.cases[0].reasons}`);
  }
  const r = run('s', manifest({ s: { status: 'active', network: 'deny', requires: [], cases: [{ id: 'p', cmd: ['node', plainFail], kind: 'plain' }] } }));
  assert.equal(r.status, 1); assert.ok(r.summary.cases[0].reasons.includes('EXIT_3'));
});

test('intento de red en suite deny => exit 1 aunque el test pase', () => {
  const r = run('s', manifest({ s: { status: 'active', network: 'deny', requires: [], cases: [nodeTest('n', netFile)] } }));
  assert.equal(r.status, 1);
  const c = r.summary.cases[0];
  assert.equal(c.tap.pass, 1); assert.ok(c.reasons.includes('NETWORK_ATTEMPT_IN_DENY')); assert.equal(c.net.allowed, 0);
});

test('entorno contaminado no llega al hijo; solo se registran nombres', () => {
  const secret = 'postgres://prod-user:SuperSecret123@prod.example:5432/beatgaler';
  const r = run('s', manifest({ s: { status: 'active', network: 'deny', requires: [], cases: [nodeTest('e', envFile)] } }), {
    DATABASE_URL: secret, RESTORE_DATABASE_URL: secret, PGPASSWORD: 'SuperSecret123', PGHOST: 'prod.example', AWS_SECRET_ACCESS_KEY: 'SuperSecret123', TELEGRAM_BOT_TOKEN: 'SuperSecret123', POLAR_ACCESS_TOKEN: 'SuperSecret123', SMTP_PASSWORD: 'SuperSecret123', CATALOG_TEST_ADMIN_URL: secret,
  });
  assert.equal(r.status, 0, r.stdout);
  for (const k of ['DATABASE_URL', 'PGPASSWORD', 'AWS_SECRET_ACCESS_KEY', 'TELEGRAM_BOT_TOKEN']) assert.ok(r.summary.env.sensitive_dropped.includes(k), k);
  const all = r.stdout + fs.readFileSync(path.join(r.out, 'summary.json'), 'utf8') + fs.readFileSync(path.join(r.out, 'summary.txt'), 'utf8');
  assert.ok(!all.includes('SuperSecret123'), 'ningún valor se imprime');
});

test('prerequisito catalog-test-db ausente o ajeno => exit 3 sin ejecutar casos', () => {
  const m = manifest({ db: { status: 'active', network: 'descriptor', requires: ['catalog-test-db'], cases: [nodeTest('d', passFile)] } });
  let r = run('db', m);
  assert.equal(r.status, 3); assert.match(r.summary.error, /CATALOG_TEST_URL_MISSING/);
  r = run('db', m, { CATALOG_TEST_ADMIN_URL: 'postgres://catalog_lab_admin:x@localhost:5432/catalog_lab_sentinel', CATALOG_TEST_INSTANCE_ID: `gha-1-1-${'a'.repeat(32)}` });
  assert.equal(r.status, 3); assert.match(r.summary.error, /NOT_ALLOWLISTED/); assert.equal(r.summary.cases.length, 0);
});

test('PASS produce summary.json, summary.txt y log por comando con totales', () => {
  const r = run('s', manifest({ s: { status: 'active', network: 'deny', requires: [], cases: [nodeTest('a', passFile), nodeTest('b', passFile)] } }));
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.summary.totals, { executed: 2, failed: 0, skipped: 0 });
  assert.equal(r.summary.result, 'PASS');
  assert.ok(fs.existsSync(path.join(r.out, 'summary.txt')));
  for (const c of r.summary.cases) { assert.ok(fs.existsSync(path.join(r.out, c.log))); assert.equal(c.net.attempts, 0); assert.ok(c.net.processes >= 1); }
});

test('suite real del repo: manifiesto válido, T03/T04/T05 activas y T06..T21/perf pendientes', () => {
  const real = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'catalog-suites.json'), 'utf8'));
  for (const k of ['unit', 'integration', 'faults', 'web', 'all-local', 'perf']) assert.ok(real.suites[k], k);
  for (const t of ['T03', 'T04', 'T05']) assert.equal(real.suites[t].status, 'active');
  for (let i = 6; i <= 21; i++) assert.equal(real.suites[`T${String(i).padStart(2, '0')}`].status, 'pending');
  const r = spawnSync(process.execPath, [RUNNER, 'T06', '--out', path.join(tmp, 'real-t06')], { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(r.status, 4);
});
