'use strict';
// E70 — Direct B: cableado HTTP del plano directo con módulos FALSOS (sin red externa, sin PostgreSQL) + validaciones puras de direct.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { createCatalogRouter } = require('../../catalog/routes.js');
const { CatalogQueryError } = require('../../catalog/cursor.js');
const { createCatalogDirect, SESSION_PROTOCOL } = require('../../catalog/direct.js');

function listen(router) { const app = express(); app.use(express.json()); app.use(router); return new Promise((resolve) => { const server = http.createServer(app); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); }); }
function raw(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* sin cuerpo */ } resolve({ status: res.statusCode, body: json }); }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const fakeCmd = () => new Proxy({}, { get: () => async () => ({}) });
const auth = (req, res) => { if (req.headers.authorization !== 'Bearer ok') { res.status(401).json({ code: 'UNAUTHENTICATED' }); return null; } return { id: 'u1' }; };

test('rutas Direct B: sesión sin cabeceras X-Catalog; ticket/informe/recibo con era/época; intentos; acceso solo con referencias (sin concesiones de bytes); 501 sin el módulo', async () => {
  const calls = [];
  const direct = {
    async startSession(a) { calls.push(['session', a]); return { protocol: SESSION_PROTOCOL, temp_auth_required: !a.tempAuthMetadata }; },
    async issueSendTicket(a) { calls.push(['ticket', a]); return { operationId: a.operationId, partKey: a.partKey, attempt: 1, randomId: '-1', caption: 'c', chatId: '-1001' }; },
    async reportSend(a) { calls.push(['report', a]); if (a.outcome === 'BAD') throw new CatalogQueryError('INPUT_INVALID', 400, 'bad', {}); return { state: a.outcome }; },
    async submitReceipt(a) { calls.push(['receipt', a]); return { operationId: a.operationId, upload: { state: 'RECEIPT' } }; },
    async listAttempts(a) { calls.push(['attempts', a]); return { operationId: a.operationId, attempts: [] }; },
  };
  const mediaMod = { async issueAccess(a) { calls.push(['access', a]); return { fileId: a.fileId, parts: [] }; }, async confirmBytes(a) { calls.push(['bytes', a]); return { level: 'BYTES', bytesVerified: true }; } };
  const ops = new Proxy({}, { get: () => async () => ({}) });
  const router = createCatalogRouter({ authority: {}, queries: {}, commands: fakeCmd(), operations: ops, direct, media: mediaMod, authenticate: auth });
  const { server, port } = await listen(router);
  try {
    const J = { authorization: 'Bearer ok', 'content-type': 'application/json' }; const H = { ...J, 'x-catalog-era': 'e1', 'x-catalog-epoch': '1' };
    let r = await raw(port, 'POST', '/catalog/v1/direct/session', { headers: J, body: {} });
    assert.deepEqual([r.status, r.body.temp_auth_required, calls.at(-1)[1]], [200, true, { userId: 'u1', tempAuthMetadata: null }]);
    r = await raw(port, 'POST', '/catalog/v1/direct/session', { headers: J, body: { tempAuthMetadata: { expiresAt: 1 } } });
    assert.deepEqual([r.body.temp_auth_required, calls.at(-1)[1].tempAuthMetadata], [false, { expiresAt: 1 }]);
    assert.equal((await raw(port, 'POST', '/catalog/v1/direct/session/stop', { headers: J, body: {} })).body.ok, true);
    assert.equal((await raw(port, 'POST', '/catalog/v1/direct/session', { headers: { 'content-type': 'application/json' }, body: {} })).status, 401);
    r = await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/send-ticket', { headers: H });
    assert.deepEqual([r.status, r.body.randomId, calls.at(-1)[1]], [201, '-1', { userId: 'u1', era: 'e1', epoch: '1', operationId: 'top-1', partKey: 'm0' }]);
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/send-ticket', { headers: J })).status, 428, 'exige era/época');
    r = await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/send-report', { headers: H, body: { attempt: 1, outcome: 'REJECTED', code: 'FLOOD_WAIT_3', retryAfterMs: 3000 } });
    assert.deepEqual([r.status, calls.at(-1)[1].attempt, calls.at(-1)[1].outcome, calls.at(-1)[1].retryAfterMs], [200, 1, 'REJECTED', 3000]);
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/send-report', { headers: H, body: { attempt: 1, outcome: 'BAD' } })).body.code, 'INPUT_INVALID');
    r = await raw(port, 'PUT', '/catalog/v1/operations/top-1/parts/m0/direct-receipt', { headers: H, body: { attempt: 2, receipt: { messageId: 9, size: 3 } } });
    assert.deepEqual([r.status, calls.at(-1)[1].attempt, calls.at(-1)[1].receipt], [200, 2, { messageId: 9, size: 3 }]);
    r = await raw(port, 'GET', '/catalog/v1/operations/top-1/attempts', { headers: J });
    assert.deepEqual([r.status, calls.at(-1)], [200, ['attempts', { userId: 'u1', operationId: 'top-1' }]]);
    // E77: no existen rutas de bytes (capacidad, subida, PROJECT por Cloud ni medios por token): 501 explícito
    for (const [m, p] of [['POST', '/catalog/v1/operations/top-1/parts/m0/capability'], ['PUT', `/catalog/v1/transfer/upload/${'T'.repeat(43)}`], ['PUT', '/catalog/v1/operations/top-1/parts/PROJECT:0/project'], ['GET', `/catalog/v1/media/${'T'.repeat(43)}`]]) assert.equal((await raw(port, m, p, { headers: H })).status, 501, `${m} ${p}`);
    // lectura: el acceso solo autoriza y devuelve referencias; el parámetro ?direct ya no existe
    await raw(port, 'POST', '/catalog/v1/files/f-1/access?direct=1', { headers: H });
    assert.deepEqual(calls.at(-1)[1], { userId: 'u1', fileId: 'f-1', epoch: '1' });
    r = await raw(port, 'POST', '/catalog/v1/files/f-1/parts/0/bytes', { headers: J, body: { sha256: 'a'.repeat(64), size: 5 } });
    assert.deepEqual([r.status, calls.at(-1)[1].partIndex, calls.at(-1)[1].size], [200, 0, 5]);
    await raw(port, 'POST', '/catalog/v1/files/f-1/parts/x/bytes', { headers: J, body: { sha256: 'a'.repeat(64), size: 5 } });
    assert.equal(calls.at(-1)[1].partIndex, -1, 'índice no numérico se rechaza en el módulo');
  } finally { server.close(); }
  // sin el módulo direct: las rutas no existen (501 explícito) y /context no anuncia la capacidad
  const bare = createCatalogRouter({ authority: { async resolveContext() { return { authority_era: 'e1' }; } }, queries: {}, commands: fakeCmd(), operations: new Proxy({}, { get: () => async () => ({}) }), authenticate: auth });
  const b = await listen(bare);
  try {
    const J = { authorization: 'Bearer ok', 'content-type': 'application/json' };
    assert.equal((await raw(b.port, 'POST', '/catalog/v1/direct/session', { headers: J, body: {} })).status, 501);
    assert.equal((await raw(b.port, 'POST', '/catalog/v1/operations/top-1/parts/m0/send-ticket', { headers: { ...J, 'x-catalog-era': 'e', 'x-catalog-epoch': '1' } })).status, 501);
    assert.equal((await raw(b.port, 'GET', '/catalog/v1/context', { headers: J })).body.capabilities.direct, false);
  } finally { b.server.close(); }
});

test('direct.js: argumentos inválidos se rechazan antes de tocar PostgreSQL; sin transporte configurado la sesión no existe', async () => {
  const never = () => { throw new Error('no debe tocar SQL'); };
  const d = createCatalogDirect({ pool: { connect: never, query: never }, authority: { requireLibraryForMutation: never, availability: never }, operations: { markDispatched: never, putReceipt: never } });
  for (const bad of [{ operationId: '', partKey: 'm0' }, { operationId: 'top-1', partKey: 'a b' }, { operationId: 'x'.repeat(65), partKey: 'm0' }]) {
    await assert.rejects(d.issueSendTicket({ userId: 'u1', era: 'e', epoch: '1', ...bad }), (e) => e.code === 'INPUT_INVALID');
  }
  await assert.rejects(d.reportSend({ userId: 'u1', era: 'e', epoch: '1', operationId: 'top-1', partKey: 'm0', attempt: 0, outcome: 'REJECTED' }), (e) => e.code === 'INPUT_INVALID');
  for (const outcome of ['SENT', 'ok', '', undefined, null]) await assert.rejects(d.reportSend({ userId: 'u1', era: 'e', epoch: '1', operationId: 'top-1', partKey: 'm0', attempt: 1, outcome }), (e) => e.code === 'INPUT_INVALID', String(outcome));
  await assert.rejects(d.submitReceipt({ userId: 'u1', era: 'e', epoch: '1', operationId: 'top-1', partKey: 'm0', attempt: 1.5, receipt: {} }), (e) => e.code === 'INPUT_INVALID');
  await assert.rejects(d.startSession({ userId: 'u1' }), (e) => e.code === 'TRANSFER_UNAVAILABLE');
  assert.throws(() => createCatalogDirect({}), /requires a pool/);
});

// E73 (C): precalentamiento acotado, secuencial y fail-soft de la autorización permanente de los bots con bibliotecas nativas.
test('direct.js prewarm: solo los bots devueltos por SQL (límite), sin vinculación, secuencial con pausa, se detiene en el primer fallo y nunca lanza', async () => {
  const never = () => { throw new Error('no debe usarse'); };
  const base = { authority: { requireLibraryForMutation: never, availability: never }, operations: { markDispatched: never, putReceipt: never } };
  const rows = [{ bot_id: 'Bot20', chat_id: '-1001' }, { bot_id: 'Bot21', chat_id: '-1002' }, { bot_id: 'Bot22', chat_id: '-1003' }];
  const sql = []; const sourced = []; const bound = []; const sleeps = []; let active = 0; let maxActive = 0;
  const pool = { connect: never, query: async (text, params) => { sql.push({ text, params }); return { rows: rows.slice(0, params[0]) }; } };
  const mk = (over = {}) => createCatalogDirect({ ...base, pool, sessionSource: async (a) => { sourced.push(a); return { ok: true, transport_id: a.botId }; },
    bindBuilder: async (session, metadata) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active--; bound.push({ bot: session.transport_id, metadata }); return {}; }, ...over });
  let d = mk();
  let out = await d.prewarm({ maxBots: 2, gapMs: 7, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(out.map((x) => [x.botId, x.ok]), [['Bot20', true], ['Bot21', true]]);
  assert.deepEqual(sql[0].params, [2]); assert.match(sql[0].text, /authority = 'POSTGRES'/); assert.match(sql[0].text, /quarantined/);
  assert.deepEqual(bound, [{ bot: 'Bot20', metadata: null }, { bot: 'Bot21', metadata: null }]); // metadata null: sin clave temporal ni vinculación
  assert.deepEqual(sourced.map((s) => [s.botId, s.chatId]), [['Bot20', '-1001'], ['Bot21', '-1002']]);
  assert.deepEqual(sleeps, [7]); assert.equal(maxActive, 1); assert.equal(d.metrics.prewarmed, 2);
  // límite duro (8), 0 lo apaga, y un fallo detiene la tanda sin lanzar
  assert.deepEqual(await d.prewarm({ maxBots: 0 }), []);
  await d.prewarm({ maxBots: 99, gapMs: 0, sleep: async () => {} }); assert.deepEqual(sql.at(-1).params, [8]);
  bound.length = 0;
  d = mk({ bindBuilder: async (session) => { bound.push(session.transport_id); if (session.transport_id === 'Bot21') throw Object.assign(new Error('FLOOD_WAIT_30'), { code: 'FLOOD_WAIT' }); return {}; } });
  out = await d.prewarm({ maxBots: 3, gapMs: 0, sleep: async () => {} });
  assert.deepEqual(out.map((x) => [x.botId, x.ok, x.code || null]), [['Bot20', true, null], ['Bot21', false, 'FLOOD_WAIT']]); assert.deepEqual(bound, ['Bot20', 'Bot21']);
  // SQL caído o transporte sin configurar: lista vacía, sin excepción
  assert.deepEqual(await createCatalogDirect({ ...base, pool: { connect: never, query: async () => { throw Object.assign(new Error('down'), { code: '57P01' }); } }, sessionSource: never, bindBuilder: never }).prewarm(), []);
  assert.deepEqual(await createCatalogDirect({ ...base, pool: { connect: never, query: never } }).prewarm(), []);
});
