'use strict';
// T02 / V01-B §5 — Servidor fake de catálogo + Cloud de auth simulada, solo 127.0.0.1.
// - Bloques bajo demanda del generador determinista (semilla 777, formato v01a-big-generator):
//   nunca materializa N IDs; un bloque son <= 240 items.
// - Digest incremental de la secuencia completa (para V10) calculado en streaming.
// - Fixtures T01 por id (solo los versionados).
// - Auth simulada (sin cuentas reales) para montar la Gallery LOCAL.
// - Contadores por ruta; toda ruta no simulada responde 404 y queda contada.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'catalog');
const BLOCK_MAX = 240;
const SEED = 777;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function* sequence(seed = SEED) { const r = rng(seed); for (let i = 0; ; i++) yield { ordinal: i, id: `g${i}`, bpm: Math.floor(r() * 200), nameKey: Math.floor(r() * 1e6) }; }

function block(n, start, limit, seed = SEED) {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1) throw Object.assign(new Error('parámetros inválidos'), { status: 400 });
  const lim = Math.min(limit, BLOCK_MAX);
  const end = Math.min(start + lim, n);
  const items = [];
  if (start < n) for (const it of sequence(seed)) { if (it.ordinal >= end) break; if (it.ordinal >= start) items.push(it); }
  return { n, start, end: Math.max(start, end), items, forward_boundary: end < n, backward_boundary: start > 0 };
}

function digest(n, seed = SEED) {
  const h = crypto.createHash('sha256');
  let k = 0;
  for (const it of sequence(seed)) { if (k++ >= n) break; h.update(`${it.id}|${it.bpm}|${it.nameKey}\n`); }
  return h.digest('hex');
}

function createFakeCatalogServer({ host = '127.0.0.1', port = 0, fixtureDir = FIXTURE_DIR, user = { id: 'v01b-fake-user', email: 'v01b@fake.invalid', display_name: 'V01B Fake' } } = {}) {
  if (host !== '127.0.0.1') throw new Error('el servidor fake solo escucha en 127.0.0.1');
  const counters = {};
  const count = (k) => { counters[k] = (counters[k] || 0) + 1; };
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
  let loggedIn = false;
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake.invalid');
    const p = url.pathname.replace(/^\/beatgaler-api(?=\/)/, '');
    req.resume();
    req.on('end', () => {
      count(`${req.method} ${p.startsWith('/__catalog/fixtures/') ? '/__catalog/fixtures/:id' : p}`);
      try {
        switch (p) {
          case '/auth/health': return json(res, 200, { account_auth: true });
          case '/auth/signup/status': return json(res, 200, { signup_pending: false, status: 'NONE' });
          case '/auth/login': loggedIn = true; res.setHeader('Set-Cookie', 'bg_v01b_fake=1; Path=/; HttpOnly; SameSite=Strict'); return json(res, 200, { user, csrf_token: 'v01b-fake-csrf' });
          case '/auth/session': return loggedIn ? json(res, 200, { user, csrf_token: 'v01b-fake-csrf' }) : json(res, 401, { error: 'No session', code: 'SESSION_INVALID' });
          case '/auth/logout': loggedIn = false; return json(res, 200, { ok: true });
          case '/__catalog/block': return json(res, 200, block(Number(url.searchParams.get('n')), Number(url.searchParams.get('start') || 0), Number(url.searchParams.get('limit') || BLOCK_MAX)));
          case '/__catalog/digest': return json(res, 200, { n: Number(url.searchParams.get('n')), seed: SEED, sha256: digest(Number(url.searchParams.get('n'))) });
          case '/__catalog/counters': return json(res, 200, { counters });
          default:
            if (p.startsWith('/__catalog/fixtures/')) {
              const id = decodeURIComponent(p.slice('/__catalog/fixtures/'.length));
              const f = manifest.fixtures.find((x) => x.id === id && !x.on_demand);
              if (!f) return json(res, 404, { code: 'FIXTURE_UNKNOWN' });
              const data = fs.readFileSync(path.join(fixtureDir, f.file));
              res.writeHead(200, { 'Content-Type': 'application/json', 'X-Fixture-Sha256': f.sha256 }); return res.end(data);
            }
            count('UNHANDLED');
            return json(res, 404, { error: 'fake catalog: not simulated', code: 'FAKE_NOT_SIMULATED' });
        }
      } catch (e) { return json(res, e.status || 500, { code: 'FAKE_ERROR', error: e.message }); }
    });
  });
  return {
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    counters: () => ({ ...counters }),
  };
}

module.exports = { createFakeCatalogServer, block, digest, sequence, BLOCK_MAX, SEED };

if (require.main === module) {
  const s = createFakeCatalogServer({ port: Number(process.env.CATALOG_FAKE_PORT || 0) });
  s.listen().then((p) => process.stdout.write(`CATALOG_FAKE_READY ${p}\n`));
  process.on('SIGTERM', () => s.close().then(() => process.exit(0)));
}
