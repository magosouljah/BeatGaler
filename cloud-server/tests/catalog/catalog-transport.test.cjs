'use strict';
// T12 — Unidad: capacidad opaca (token/hash), medición acotada en streaming, admisión de temporales, clasificación fail-closed del fallo
// de envío, adaptador MASTER y rutas HTTP /catalog/v1 de transferencia con transporte falso (loopback). Sin DB ni Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const express = require(path.join(__dirname, '..', '..', 'node_modules', 'express'));
const t = require('../../catalog/transport.js');
const { createCatalogRouter } = require('../../catalog/routes.js');
const { CatalogQueryError } = require('../../catalog/cursor.js');
const { GatewayError } = require('../../catalog/transport-gateway.js');
const { createMasterProjectAdapter } = require('../../catalog-project-master-adapter.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t12-unit-'));

test('capacidad: token base64url de 32 bytes, hash SHA-256 estable, formatos inválidos → 403 CAPABILITY_INVALID', () => {
  const tok = t.newCapabilityToken();
  assert.match(tok, t.TOKEN_RE);
  assert.equal(t.capabilityHash(tok), sha(tok));
  assert.equal(new Set(Array.from({ length: 200 }, () => t.newCapabilityToken())).size, 200);
  for (const bad of ['', 'abc', `${tok}x`, tok.replace(/./, '+'), 42, null]) assert.throws(() => t.capabilityHash(bad), (e) => e.code === 'CAPABILITY_INVALID' && e.status === 403);
});

test('medición en streaming: tamaño + SHA-256 exactos sin cargar el archivo; el primer byte que excede el tope corta con TRANSFER_TOO_LARGE y no deja temporal', async () => {
  const dir = tmp();
  const f1 = path.join(dir, 'a.part');
  const r1 = await t.spoolToFile(Readable.from([Buffer.from('ab'), Buffer.from('c')]), { filePath: f1, maxBytes: 3 });
  assert.deepEqual(r1, { size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
  assert.equal(fs.readFileSync(f1, 'utf8'), 'abc');
  const f2 = path.join(dir, 'b.part');
  await assert.rejects(t.spoolToFile(Readable.from([Buffer.alloc(2), Buffer.alloc(2)]), { filePath: f2, maxBytes: 3 }), (e) => e.code === 'TRANSFER_TOO_LARGE' && e.bytes === 4);
  await assert.rejects(t.spoolToFile(Readable.from([Buffer.alloc(1)]), { filePath: f1, maxBytes: 3 }), (e) => e.code === 'EEXIST', 'wx: nunca sobrescribe un temporal existente');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('admisión de temporales: concurrencia y presupuesto → 503 TRANSFER_BUSY con Retry-After 5 s; release idempotente', () => {
  const a = t.createTempAdmission({ maxConcurrent: 1, tempBudgetBytes: 1000 });
  const s1 = a.acquire({ maxBytes: 600, contentLength: '600' });
  assert.throws(() => a.acquire({ maxBytes: 10 }), (e) => e.code === 'TRANSFER_BUSY' && e.status === 503 && e.detail.retry_after_ms === 5000 && e.detail.reason === 'CONCURRENCY');
  s1.release(); s1.release();
  assert.deepEqual(a.snapshot(), { active: 0, reservedBytes: 0, maxConcurrent: 1, tempBudgetBytes: 1000 });
  assert.throws(() => a.acquire({ maxBytes: 2000 }), (e) => e.detail.reason === 'TEMP_BUDGET');
  const s2 = a.acquire({ maxBytes: 999, contentLength: 'garbage' });
  assert.equal(s2.bytes, 999, 'sin Content-Length válido reserva el tope declarado');
  s2.release();
});

test('clasificación del fallo de envío: sin efecto (REJECTED/UPLOAD_FAILED/PERMANENT/REVOKED) vs incierto (UNCERTAIN y errores desconocidos → RECONCILE, nunca reenvío)', () => {
  const ge = (code, classification, extra = {}) => new GatewayError(code, code, { classification, ...extra });
  assert.deepEqual(t.classifySendFailure(ge('SEND_REJECTED', { kind: 'REJECTED', retryAfterMs: 7000 })), { outcome: 'REJECTED', status: 'FAILED', http: 503, code: 'SEND_REJECTED', retryAfterMs: 7000, effect: false });
  assert.equal(t.classifySendFailure(ge('UPLOAD_FAILED', { kind: 'UNCERTAIN', effectPossible: false })).outcome, 'UPLOAD_FAILED');
  assert.deepEqual([t.classifySendFailure(ge('SEND_REJECTED_PERMANENT', { kind: 'PERMANENT' })).outcome, t.classifySendFailure(ge('SEND_REJECTED_PERMANENT', { kind: 'PERMANENT' })).http], ['PERMANENT', 403]);
  assert.deepEqual([t.classifySendFailure(ge('CREDENTIAL_REVOKED', { kind: 'REVOKED' })).outcome, t.classifySendFailure(ge('CREDENTIAL_REVOKED', { kind: 'REVOKED' })).http], ['REVOKED', 503]);
  const u = t.classifySendFailure(ge('SEND_UNCERTAIN', { kind: 'UNCERTAIN', retryAfterMs: 60_000 }));
  assert.deepEqual([u.outcome, u.status, u.http, u.effect], ['UNCERTAIN', 'CONSUMED', 202, true]);
  assert.equal(t.classifySendFailure(new TypeError('boom')).outcome, 'UNCERTAIN', 'un error desconocido nunca se interpreta como "no enviado"');
  assert.equal(t.classifySendFailure(Object.assign(new Error('master down'), { effectPossible: false })).outcome, 'UPLOAD_FAILED');
});

test('createCatalogTransport exige pool, autoridad, operaciones y tempDir; límites expuestos', () => {
  const pool = { connect() {}, query() {} }; const authority = { requireLibraryForMutation() {}, availability() {} }; const operations = { markDispatched() {}, putReceipt() {} };
  assert.throws(() => t.createCatalogTransport({ authority, operations, tempDir: 'x' }), /pool/);
  assert.throws(() => t.createCatalogTransport({ pool, operations, tempDir: 'x' }), /authority/);
  assert.throws(() => t.createCatalogTransport({ pool, authority, tempDir: 'x' }), /operations/);
  assert.throws(() => t.createCatalogTransport({ pool, authority, operations }), /tempDir/);
  const tr = t.createCatalogTransport({ pool, authority, operations, tempDir: 'x', capabilityTtlMs: 1234 });
  assert.deepEqual(tr.limits, { CAPABILITY_TTL_MS: 1234, TOKEN_BYTES: 32 });
  assert.equal(t.CAPABILITY_TTL_MS, 600_000);
});

test('adaptador MASTER: delega con el caption catalog:v1, normaliza remitente/tamaño y marca la identidad fallida como sin efecto', async () => {
  const calls = [];
  const control = { async masterSenderId(chatId) { calls.push(['me', chatId]); if (chatId === 'down') throw Object.assign(new Error('no master'), { code: 'PROJECT_ACCESS_UNAVAILABLE' }); return '777'; }, async publishProjectFile(a) { calls.push(['publish', a]); return { messageId: 55, documentId: 9001, senderId: 777, sizeBytes: 3 }; } };
  const m = createMasterProjectAdapter({ control });
  assert.equal(await m.resolveSenderId({ chatId: '-1001' }), '777');
  await assert.rejects(m.resolveSenderId({ chatId: 'down' }), (e) => e.effectPossible === false && e.code === 'PROJECT_ACCESS_UNAVAILABLE');
  const r = await m.publishProjectFile({ chatId: '-1001', filePath: '/tmp/x', filename: 'p.zip', caption: 'catalog:v1 op=top-1 part=PROJECT:0', sizeBytes: 3, sha256: 'a'.repeat(64), beatId: 'b1' });
  assert.deepEqual(r, { messageId: 55, documentId: '9001', senderId: '777', sizeBytes: 3 });
  assert.equal(calls[2][1].caption, 'catalog:v1 op=top-1 part=PROJECT:0');
  assert.throws(() => createMasterProjectAdapter({ control: {} }), /masterSenderId/);
});

// ---------- rutas HTTP con transporte falso ----------
function fakeTransport(calls) {
  const readAll = async (s) => { const chunks = []; for await (const c of s) chunks.push(c); return Buffer.concat(chunks); };
  return {
    async issueUploadCapability(a) { calls.push(['cap', a]); if (a.partKey === 'busy') throw new CatalogQueryError('PART_UNCERTAIN', 409, 'u', { reconcile: true }); return { operationId: a.operationId, partKey: a.partKey, token: 'T'.repeat(43), uploadPath: `/catalog/v1/transfer/upload/${'T'.repeat(43)}`, attempt: 1 }; },
    async uploadPart(a) {
      calls.push(['upload', { token: a.token, era: a.era, epoch: a.epoch, contentLength: a.contentLength }]);
      if (a.token === 'B'.repeat(43)) { a.stream.resume(); throw new CatalogQueryError('TRANSFER_BUSY', 503, 'busy', { retry_after_ms: 5000 }); }
      const body = await readAll(a.stream);
      if (a.token === 'U'.repeat(43)) return { status: 202, body: { operationId: 'top-1', upload: { state: 'UNCERTAIN', reconcile: true, bytes: body.length } } };
      return { status: 200, body: { operationId: 'top-1', upload: { state: 'RECEIPT', bytes: body.length, sha256: sha(body) } } };
    },
    async uploadProjectPart(a) { const body = await readAll(a.stream); calls.push(['project', { operationId: a.operationId, partKey: a.partKey, filename: a.filename, bytes: body.length }]); return { status: 200, body: { operationId: a.operationId, upload: { state: 'RECEIPT', bytes: body.length } } }; },
    async listAttempts(a) { calls.push(['attempts', a]); return { operationId: a.operationId, attempts: [] }; },
  };
}
function fakeOps() { return { async createOperation() { return {}; }, async getOperation() { return {}; }, async putReceipt() { return {}; }, async commitOperation() { return { status: 200, operation: {} }; }, async cancelOperation() { return {}; }, async renewReservation() { return {}; }, async readmitReservation() { return {}; }, async markDispatched() { return {}; } }; }
function fakeCommands() { return new Proxy({}, { get: () => async () => ({}) }); }
function listen(router) {
  const app = express(); app.use(express.json()); app.use(router);
  return new Promise((resolve) => { const server = http.createServer(app); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); });
}
function raw(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null })); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('rutas T12: capability 201, upload PUT con stream crudo (200/202/503+Retry-After), PROJECT PUT con nombre, attempts; 428 sin era/época; 401 sin sesión', async () => {
  const calls = [];
  const router = createCatalogRouter({ authority: {}, queries: {}, commands: fakeCommands(), operations: fakeOps(), transport: fakeTransport(calls), authenticate: (req, res) => { if (req.headers.authorization !== 'Bearer ok') { res.status(401).json({ code: 'UNAUTHENTICATED' }); return null; } return { id: 'u1' }; } });
  const { server, port } = await listen(router);
  try {
    const H = { authorization: 'Bearer ok', 'x-catalog-era': 'e1', 'x-catalog-epoch': '1' };
    let r = await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/capability', { headers: H });
    assert.equal(r.status, 201); assert.equal(r.body.uploadPath, `/catalog/v1/transfer/upload/${'T'.repeat(43)}`);
    assert.deepEqual(calls.at(-1)[1], { userId: 'u1', era: 'e1', epoch: '1', operationId: 'top-1', partKey: 'm0' });
    r = await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/busy/capability', { headers: H });
    assert.deepEqual([r.status, r.body.code, r.body.detail.reconcile], [409, 'PART_UNCERTAIN', true]);
    r = await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/capability', { headers: { authorization: 'Bearer ok' } });
    assert.equal(r.status, 428);
    const bytes = Buffer.from('hello-bytes');
    r = await raw(port, 'PUT', `/catalog/v1/transfer/upload/${'T'.repeat(43)}`, { headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, body: bytes });
    assert.deepEqual([r.status, r.body.upload.state, r.body.upload.bytes, r.body.upload.sha256], [200, 'RECEIPT', bytes.length, sha(bytes)], 'el cuerpo llega como stream crudo intacto');
    assert.deepEqual(calls.at(-1)[1], { token: 'T'.repeat(43), era: 'e1', epoch: '1', contentLength: String(bytes.length) });
    r = await raw(port, 'PUT', `/catalog/v1/transfer/upload/${'U'.repeat(43)}`, { headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': '3' }, body: Buffer.from('abc') });
    assert.deepEqual([r.status, r.body.upload.state, r.body.upload.reconcile], [202, 'UNCERTAIN', true]);
    r = await raw(port, 'PUT', `/catalog/v1/transfer/upload/${'B'.repeat(43)}`, { headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': '3' }, body: Buffer.from('abc') });
    assert.deepEqual([r.status, r.body.code, r.headers['retry-after']], [503, 'TRANSFER_BUSY', '5']);
    r = await raw(port, 'PUT', `/catalog/v1/transfer/upload/${'T'.repeat(43)}`, { headers: { authorization: 'Bearer ok', 'content-length': '3' }, body: Buffer.from('abc') });
    assert.equal(r.status, 428, 'las escrituras exigen era/época');
    r = await raw(port, 'PUT', '/catalog/v1/operations/top-1/parts/PROJECT:0/project', { headers: { ...H, 'content-type': 'application/zip', 'content-length': '4', 'x-catalog-filename': 'song.flp' }, body: Buffer.from('zip!') });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1)[1], { operationId: 'top-1', partKey: 'PROJECT:0', filename: 'song.flp', bytes: 4 });
    r = await raw(port, 'GET', '/catalog/v1/operations/top-1/attempts', { headers: { authorization: 'Bearer ok' } });
    assert.deepEqual(r.body, { operationId: 'top-1', attempts: [] });
    r = await raw(port, 'GET', '/catalog/v1/operations/top-1/attempts', { headers: {} });
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

test('sin transporte montado, las rutas T12 responden 501 explícito (nunca éxito ficticio)', async () => {
  const router = createCatalogRouter({ authority: {}, queries: {}, commands: fakeCommands(), operations: fakeOps(), authenticate: () => ({ id: 'u1' }) });
  const { server, port } = await listen(router);
  try {
    const H = { 'x-catalog-era': 'e1', 'x-catalog-epoch': '1' };
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations/top-1/parts/m0/capability', { headers: H })).status, 501);
    assert.equal((await raw(port, 'PUT', `/catalog/v1/transfer/upload/${'T'.repeat(43)}`, { headers: { ...H, 'content-length': '1' }, body: Buffer.from('a') })).status, 501);
  } finally { server.close(); }
});
