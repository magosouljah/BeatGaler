'use strict';
// T02 / V01-C — El guard bloquea red externa antes de abrir socket y cuenta cada intento.
// Cada caso corre en un proceso hijo con su propio CATALOG_NET_REPORT (no contamina el reporte del runner).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'helpers', 'catalog-net-guard.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-net-guard-'));

function runChild(policy, code) {
  const report = path.join(tmp, `r-${Math.random().toString(16).slice(2)}.jsonl`);
  const script = path.join(tmp, `c-${Math.random().toString(16).slice(2)}.cjs`);
  fs.writeFileSync(script, code);
  const r = spawnSync(process.execPath, ['--require', GUARD, script], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CATALOG_NET_POLICY: policy, CATALOG_NET_REPORT: report },
    encoding: 'utf8', timeout: 30000,
  });
  const lines = fs.existsSync(report) ? fs.readFileSync(report, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  let out = {}; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { out = { raw: r.stdout, err: r.stderr }; }
  return { status: r.status, out, report: lines[0] };
}

const ATTEMPTS = `
const net = require('net'), tls = require('tls'), dns = require('dns'), http = require('http'), https = require('https');
const res = {};
const settle = (k, p) => p.then(() => { res[k] = 'OPEN'; }, (e) => { res[k] = e.code || String(e.message); });
const sock = (host, port) => new Promise((ok, ko) => { const s = net.connect(port, host); s.on('connect', () => { s.destroy(); ok(); }); s.on('error', ko); });
const req = (mod, url) => new Promise((ok, ko) => { const r = mod.get(url, () => ok()); r.on('error', ko); });
(async () => {
  await Promise.all([
    settle('fetch', fetch('http://93.184.216.34/')),
    settle('net', sock('10.255.255.1', 5432)),
    settle('http', req(http, 'http://198.51.100.7/')),
    settle('https', req(https, 'https://198.51.100.8/')),
    settle('dns', new Promise((ok, ko) => dns.lookup('example.com', (e) => e ? ko(e) : ok()))),
    settle('dnsp', dns.promises.lookup('example.org')),
    settle('tls', new Promise((ok, ko) => { try { const s = tls.connect(443, '198.51.100.9'); s.on('secureConnect', ok); s.on('error', ko); } catch (e) { ko(e); } })),
  ]);
  console.log(JSON.stringify(res));
})();
`;

test('deny: todo intento externo falla con CATALOG_NET_BLOCKED y queda contado', () => {
  const r = runChild('deny', ATTEMPTS);
  assert.equal(r.status, 0, JSON.stringify(r.out));
  for (const k of ['fetch', 'net', 'http', 'https', 'dns', 'dnsp', 'tls']) assert.equal(r.out[k], 'CATALOG_NET_BLOCKED', k);
  assert.ok(r.report.attempts >= 7); assert.equal(r.report.allowed, 0); assert.equal(r.report.blocked, r.report.attempts);
});

test('política inválida se trata como deny y se marca', () => {
  const r = runChild('allow-all', ATTEMPTS);
  assert.equal(r.out.fetch, 'CATALOG_NET_BLOCKED');
  assert.equal(r.report.invalid_policy, 'allow-all');
});

test('loopback: 127.0.0.1 permitido, externo bloqueado', () => {
  const r = runChild('loopback', `
const http = require('http');
const srv = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', async () => {
  const port = srv.address().port; const res = {};
  res.local = await fetch('http://127.0.0.1:' + port + '/').then((x) => x.status, (e) => e.code);
  res.ext = await fetch('http://203.0.113.5/').then((x) => x.status, (e) => e.code);
  srv.close(); console.log(JSON.stringify(res));
});`);
  assert.deepEqual(r.out, { local: 200, ext: 'CATALOG_NET_BLOCKED' });
  assert.ok(r.report.allowed >= 1); assert.ok(r.report.blocked >= 1);
});

test('descriptor: solo host:puerto exacto', () => {
  const r = runChild('descriptor:127.0.0.1:1', `
const net = require('net'); const res = {};
const t = (k, h, p) => new Promise((ok) => { const s = net.connect(p, h); s.on('connect', () => { res[k] = 'OPEN'; s.destroy(); ok(); }); s.on('error', (e) => { res[k] = e.code; ok(); }); });
(async () => { await t('exact', '127.0.0.1', 1); await t('otherPort', '127.0.0.1', 2); await t('otherHost', '10.0.0.1', 1); console.log(JSON.stringify(res)); })();`);
  assert.notEqual(r.out.exact, 'CATALOG_NET_BLOCKED', 'el destino del descriptor no lo bloquea el guard');
  assert.equal(r.out.otherPort, 'CATALOG_NET_BLOCKED');
  assert.equal(r.out.otherHost, 'CATALOG_NET_BLOCKED');
});

test('proceso sin intentos reporta 0', () => {
  const r = runChild('deny', 'console.log(JSON.stringify({ ok: 1 }));');
  assert.deepEqual(r.out, { ok: 1 });
  assert.equal(r.report.attempts, 0);
});
