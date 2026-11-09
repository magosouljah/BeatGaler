'use strict';
// T14 — Unidad: RNG uniforme por rejection sampling (sin módulo sesgado), modelo puro del Fisher–Yates perezoso (cada ronda contiene cada
// miembro exactamente una vez; caminos RNG exhaustivos para N pequeño; inverso/consume sin doble descuento; prueba estadística con umbral
// prerregistrado), Range/token de medios y rutas HTTP de rondas y medios con módulos falsos (loopback). Sin DB ni Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const express = require(path.join(__dirname, '..', '..', 'node_modules', 'express'));
const pb = require('../../catalog/playback.js');
const media = require('../../catalog/media.js');
const { createCatalogRouter } = require('../../catalog/routes.js');
const { CatalogQueryError } = require('../../catalog/cursor.js');

// RNG determinista: devuelve los 48 bits indicados (para forzar caminos) o aleatorio real.
const bytesOf = (values) => { let i = 0; return () => { const v = BigInt(values[i++ % values.length]); const b = Buffer.alloc(6); b.writeUInt32BE(Number(v >> 16n), 0); b.writeUInt16BE(Number(v & 0xffffn), 4); return b; }; };

test('uniformInt: rango exacto, m=1 sin sorteo, rechazo de valores sesgados (x ≥ limit) y uniformidad estadística con umbral prerregistrado (χ², m=7, 70 000 muestras, p>0,001)', () => {
  assert.equal(pb.uniformInt(1, () => { throw new Error('no debe sortear'); }), 0);
  assert.throws(() => pb.uniformInt(0), (e) => e.code === 'INPUT_INVALID');
  for (let i = 0; i < 5000; i++) { const x = pb.uniformInt(13); assert.ok(Number.isInteger(x) && x >= 0 && x < 13); }
  // 2^48 mod 3 = 1 → limit = 2^48 − 1: el valor 2^48 − 1 se rechaza y se toma el siguiente
  const rng = bytesOf([(1n << 48n) - 1n, 5n]);
  assert.equal(pb.uniformInt(3, rng), 2);
  // χ² con 6 grados de libertad: umbral prerregistrado 22.46 (p = 0.001)
  const m = 7; const n = 70_000; const counts = new Array(m).fill(0);
  for (let i = 0; i < n; i++) counts[pb.uniformInt(m)]++;
  const expected = n / m; const chi = counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
  assert.ok(chi < 22.46, `χ²=${chi.toFixed(2)} supera el umbral prerregistrado 22.46`);
});

test('modelo puro: cada ronda contiene cada slot exactamente una vez para N=0/1/2/5/240; caminos RNG exhaustivos para N=4 producen las 24 permutaciones una vez cada una; mapping disperso acotado', () => {
  for (const n of [0, 1, 2, 5, 240]) {
    const r = pb.createMemoryRound(n); const seen = [];
    while (r.state.remaining > 0) { const j = pb.uniformInt(r.state.remaining); seen.push(r.next(j)); }
    assert.equal(r.next(0), null, 'con m = 0 no hay sorteo');
    assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
    assert.equal(r.mappingSize(), 0, 'al terminar no quedan filas de mapping');
  }
  // exhaustivo: todas las secuencias j∈[0,4)×[0,3)×[0,2)×[0,1) → 24 permutaciones distintas, cada una exactamente una vez (uniformidad condicional)
  const perms = new Map();
  for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 2; c++) { const r = pb.createMemoryRound(4); const p = [r.next(a), r.next(b), r.next(c), r.next(0)].join(','); perms.set(p, (perms.get(p) || 0) + 1); }
  assert.equal(perms.size, 24); assert.ok([...perms.values()].every((v) => v === 1));
  // mapping disperso: tras k sorteos hay ≤ k filas
  const big = pb.createMemoryRound(100_000);
  for (let i = 0; i < 300; i++) big.next(pb.uniformInt(big.state.remaining));
  assert.ok(big.mappingSize() <= 300); assert.equal(big.state.remaining, 99_700);
});

test('modelo puro: consume explícito usa el inverso y el mismo swap; un consumido no se descuenta dos veces; el slot consumido no vuelve a salir', () => {
  const r = pb.createMemoryRound(6);
  assert.equal(r.consume(4), true); assert.equal(r.state.remaining, 5);
  assert.equal(r.consume(4), false, 'segundo consume del mismo slot: sin efecto');
  assert.equal(r.next(0) !== 4, true);
  // slot movido: 5 (tail) ocupó la posición 4 al consumir el 4; consumirlo ahora debe localizarlo por el inverso
  const r2 = pb.createMemoryRound(6); r2.consume(0); // tail 5 → posición 0
  assert.equal(r2.positionOf(5), 0); assert.equal(r2.consume(5), true); assert.equal(r2.state.remaining, 4);
  const rest = []; while (r2.state.remaining > 0) rest.push(r2.next(0));
  assert.deepEqual(rest.sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('medios: Range RFC 9110 (completo, a-b, a-, -n, inválido/insatisfacible → 416) y token opaco con hash', () => {
  assert.deepEqual(media.parseRange(null, 10), { start: 0, end: 9, partial: false });
  assert.deepEqual(media.parseRange('bytes=2-5', 10), { start: 2, end: 5, partial: true });
  assert.deepEqual(media.parseRange('bytes=7-', 10), { start: 7, end: 9, partial: true });
  assert.deepEqual(media.parseRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
  assert.deepEqual(media.parseRange('bytes=0-999', 10), { start: 0, end: 9, partial: true });
  for (const bad of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=', 'chars=1-2', 'bytes=a-b']) assert.throws(() => media.parseRange(bad, 10), (e) => e.code === 'RANGE_NOT_SATISFIABLE' && e.status === 416, bad);
  const t = media.newToken(); assert.match(t, media.TOKEN_RE); assert.equal(media.tokenHash(t), crypto.createHash('sha256').update(t).digest('hex'));
  assert.throws(() => media.tokenHash('short'), (e) => e.code === 'MEDIA_GRANT_INVALID');
});

// ---------- rutas con módulos falsos ----------
function listen(router) { const app = express(); app.use(express.json()); app.use(router); return new Promise((resolve) => { const server = http.createServer(app); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); }); }
function raw(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = buf.length ? JSON.parse(buf.toString()) : null; } catch { /* binario */ } resolve({ status: res.statusCode, headers: res.headers, body: json, bytes: buf }); }); });
    req.on('error', reject); if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body)); req.end();
  });
}
const fakeCmd = () => new Proxy({}, { get: () => async () => ({}) });

test('rutas T14: rondas (start/next/consume/rebuild/release/get) con era/época, vecino de orden, acceso a medios 201 y stream GET/HEAD con Range (206/200/416); 401 sin sesión; 501 sin módulos', async () => {
  const calls = [];
  const playback = {
    async startRound(a) { calls.push(['start', a]); return { roundId: 'rnd-1', status: 'ACTIVE', remaining: 9, sequence: '0', created: true }; },
    async nextInRound(a) { calls.push(['next', a]); if (a.sequence !== '0') throw new CatalogQueryError('SEQUENCE_MISMATCH', 409, 'seq', { current_sequence: '0' }); return { roundId: a.roundId, beatId: 'g7', remaining: 8, sequence: '1', roundComplete: false }; },
    async consumeInRound(a) { calls.push(['consume', a]); return { roundId: a.roundId, beatId: a.beatId, consumed: true, remaining: 7, sequence: '2' }; },
    async rebuildRound(a) { calls.push(['rebuild', a]); return { roundId: a.roundId, status: 'ACTIVE', processed: 3 }; },
    async releaseRound(a) { calls.push(['release', a]); return { roundId: a.roundId, status: 'RELEASED' }; },
    async getRound(a) { calls.push(['get', a]); return { roundId: a.roundId, status: 'ACTIVE', remaining: 8 }; },
    async neighbor(a) { calls.push(['neighbor', a]); return { setId: a.setId, beatId: a.direction === 'next' ? 'g2' : 'g0', slot: 2 }; },
  };
  const bytes = Buffer.from('0123456789abcdef');
  const mediaMod = {
    async issueAccess(a) { calls.push(['access', a]); return { fileId: a.fileId, parts: [{ partIndex: 0, size: 16, token: 'T'.repeat(43), url: `/catalog/v1/media/${'T'.repeat(43)}` }] }; },
    async stream({ token, rangeHeader, res, method }) {
      if (token !== 'T'.repeat(43)) throw new CatalogQueryError('MEDIA_GRANT_INVALID', 403, 'bad', {});
      const r = media.parseRange(rangeHeader, bytes.length);
      res.setHeader('Content-Length', String(r.end - r.start + 1)); res.setHeader('Accept-Ranges', 'bytes'); if (r.partial) res.setHeader('Content-Range', `bytes ${r.start}-${r.end}/${bytes.length}`);
      res.status(r.partial ? 206 : 200); if (method === 'HEAD') return res.end();
      await new Promise((resolve) => Readable.from([bytes.subarray(r.start, r.end + 1)]).pipe(res).on('finish', resolve));
    },
  };
  const router = createCatalogRouter({ authority: {}, queries: {}, commands: fakeCmd(), playback, media: mediaMod, authenticate: (req, res) => { if (req.headers.authorization !== 'Bearer ok') { res.status(401).json({ code: 'UNAUTHENTICATED' }); return null; } return { id: 'u1' }; } });
  const { server, port } = await listen(router);
  try {
    const H = { authorization: 'Bearer ok', 'x-catalog-era': 'e1', 'x-catalog-epoch': '1', 'content-type': 'application/json' };
    let r = await raw(port, 'POST', '/catalog/v1/playback/rounds', { headers: H, body: { setId: 'set-1', currentBeatId: 'g3', consumerId: 'c1' } });
    assert.equal(r.status, 201); assert.deepEqual(calls.at(-1)[1], { userId: 'u1', era: 'e1', epoch: '1', setId: 'set-1', currentBeatId: 'g3', consumerId: 'c1', fromRoundId: null });
    r = await raw(port, 'POST', '/catalog/v1/playback/rounds/rnd-1/next', { headers: { ...H, 'idempotency-key': 'k1' }, body: { sequence: '0' } });
    assert.deepEqual([r.status, r.body.beatId, calls.at(-1)[1].idempotencyKey], [200, 'g7', 'k1']);
    r = await raw(port, 'POST', '/catalog/v1/playback/rounds/rnd-1/next', { headers: H, body: { sequence: '5', idempotencyKey: 'k2' } });
    assert.deepEqual([r.status, r.body.code], [409, 'SEQUENCE_MISMATCH']);
    r = await raw(port, 'POST', '/catalog/v1/playback/rounds/rnd-1/consume', { headers: H, body: { beatId: 'g9', sequence: '1', idempotencyKey: 'k3' } });
    assert.deepEqual([r.status, r.body.consumed], [200, true]);
    assert.equal((await raw(port, 'POST', '/catalog/v1/playback/rounds/rnd-1/rebuild', { headers: H })).body.processed, 3);
    assert.equal((await raw(port, 'POST', '/catalog/v1/playback/rounds/rnd-1/release', { headers: H })).body.status, 'RELEASED');
    assert.equal((await raw(port, 'GET', '/catalog/v1/playback/rounds/rnd-1', { headers: { authorization: 'Bearer ok' } })).body.remaining, 8);
    r = await raw(port, 'POST', '/catalog/v1/playback/rounds', { headers: { authorization: 'Bearer ok', 'content-type': 'application/json' }, body: { setId: 'set-1' } });
    assert.equal(r.status, 428, 'escrituras musicales exigen era/época');
    r = await raw(port, 'GET', '/catalog/v1/query-sets/set-1/neighbor?beatId=g1&direction=next', { headers: { authorization: 'Bearer ok' } });
    assert.deepEqual([r.status, r.body.beatId, calls.at(-1)[1]], [200, 'g2', { userId: 'u1', setId: 'set-1', beatId: 'g1', direction: 'next', sort: 'manual' }]);
    r = await raw(port, 'POST', '/catalog/v1/files/f-1/access', { headers: { authorization: 'Bearer ok', 'x-catalog-epoch': '1' } });
    assert.deepEqual([r.status, r.body.parts[0].size, calls.at(-1)[1]], [201, 16, { userId: 'u1', fileId: 'f-1', epoch: '1' }]);
    const url = `/catalog/v1/media/${'T'.repeat(43)}`;
    r = await raw(port, 'GET', url, { headers: { authorization: 'Bearer ok' } });
    assert.deepEqual([r.status, r.bytes.toString(), r.headers['accept-ranges']], [200, '0123456789abcdef', 'bytes']);
    r = await raw(port, 'GET', url, { headers: { authorization: 'Bearer ok', range: 'bytes=4-7' } });
    assert.deepEqual([r.status, r.bytes.toString(), r.headers['content-range'], r.headers['content-length']], [206, '4567', 'bytes 4-7/16', '4']);
    r = await raw(port, 'HEAD', url, { headers: { authorization: 'Bearer ok', range: 'bytes=-2' } });
    assert.deepEqual([r.status, r.headers['content-range'], r.bytes.length], [206, 'bytes 14-15/16', 0]);
    r = await raw(port, 'GET', url, { headers: { authorization: 'Bearer ok', range: 'bytes=99-' } });
    assert.deepEqual([r.status, r.body.code, r.headers['content-range']], [416, 'RANGE_NOT_SATISFIABLE', 'bytes */16']);
    r = await raw(port, 'GET', `/catalog/v1/media/${'X'.repeat(43)}`, { headers: { authorization: 'Bearer ok' } });
    assert.deepEqual([r.status, r.body.code], [403, 'MEDIA_GRANT_INVALID']);
    assert.equal((await raw(port, 'GET', url, {})).status, 401);
  } finally { server.close(); }
  const bare = createCatalogRouter({ authority: {}, queries: {}, commands: fakeCmd(), authenticate: () => ({ id: 'u1' }) });
  const s2 = await listen(bare);
  try {
    assert.equal((await raw(s2.port, 'POST', '/catalog/v1/playback/rounds', { headers: { 'x-catalog-era': 'e', 'x-catalog-epoch': '1', 'content-type': 'application/json' }, body: {} })).status, 501);
    assert.equal((await raw(s2.port, 'GET', `/catalog/v1/media/${'T'.repeat(43)}`)).status, 501);
  } finally { s2.server.close(); }
});
