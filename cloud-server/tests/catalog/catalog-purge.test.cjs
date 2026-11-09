'use strict';
// T15 — Unidad: reglas puras de bloqueo (C9), clasificación de errores del proveedor (nada prueba ausencia), journal externo (memoria y
// disco: append + verify + list, fallos), gateway deleteMessage/probeAbsence sobre el fake (MessageEmpty = ausencia; sin entrada/403/timeout
// = no probado) y rutas HTTP de purge con módulo falso (loopback). Sin DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require(path.join(__dirname, '..', '..', 'node_modules', 'express'));
const { Api } = require(path.join(__dirname, '..', '..', 'node_modules', 'telegram'));
const bigInt = require(path.join(__dirname, '..', '..', 'node_modules', 'big-integer'));
const purge = require('../../catalog/purge.js');
const g = require('../../catalog/transport-gateway.js');
const journalMod = require('../../catalog-deletion-journal.js');
const { createCatalogRouter } = require('../../catalog/routes.js');
const { CatalogQueryError } = require('../../catalog/cursor.js');
const { createFakeTelegramServer } = require('../helpers/catalog-fake-mtproto.cjs');

test('evaluateObjectBlock: precedencia OPAQUE > SHARED > RETENTION > PENDING_OPERATION > RESTORE_HOLD > CLEANUP_DISABLED; sin motivos → null', () => {
  assert.equal(purge.evaluateObjectBlock({ opaque: true, otherLiveRefs: 2 }), 'OPAQUE_REFERENCE');
  assert.equal(purge.evaluateObjectBlock({ otherLiveRefs: 1, retainedUntilFuture: true }), 'SHARED_OBJECT');
  assert.equal(purge.evaluateObjectBlock({ retainedUntilFuture: true, pendingOperations: 1 }), 'RETENTION_WINDOW');
  assert.equal(purge.evaluateObjectBlock({ pendingOperations: 1, restoreHold: true }), 'PENDING_OPERATION');
  assert.equal(purge.evaluateObjectBlock({ restoreHold: true, cleanupEnabled: false }), 'RESTORE_HOLD');
  assert.equal(purge.evaluateObjectBlock({ cleanupEnabled: false }), 'CLEANUP_DISABLED');
  assert.equal(purge.evaluateObjectBlock({ cleanupEnabled: true, restoreHold: false }), null);
  for (const r of ['OPAQUE_REFERENCE', 'SHARED_OBJECT', 'RETENTION_WINDOW', 'RESTORE_HOLD', 'CLEANUP_DISABLED', 'PENDING_OPERATION']) assert.ok(purge.BLOCK_REASONS.includes(r));
});

test('classifyProviderError: 403/404/timeout/genérico → UNCERTAIN (nunca "ausente"); permanente/revocado no transitorio', () => {
  const ge = (code, kind, rpc) => new g.GatewayError(code, code, { classification: { kind, code: rpc }, transient: kind !== 'PERMANENT' });
  assert.deepEqual(purge.classifyProviderError(ge('DELETE_REJECTED_PERMANENT', 'PERMANENT', 'MESSAGE_DELETE_FORBIDDEN')), { outcome: 'UNCERTAIN', transient: false, reason: 'MESSAGE_DELETE_FORBIDDEN' });
  assert.deepEqual(purge.classifyProviderError(ge('CREDENTIAL_REVOKED', 'REVOKED', 'AUTH_KEY_UNREGISTERED')), { outcome: 'UNCERTAIN', transient: false, reason: 'REVOKED' });
  assert.deepEqual(purge.classifyProviderError(Object.assign(new Error('t'), { code: 'ETIMEDOUT' })), { outcome: 'UNCERTAIN', transient: true, reason: 'ETIMEDOUT' });
  assert.equal(purge.classifyProviderError(new g.GatewayError('PROBE_UNVERIFIED', 'x', { transient: true })).outcome, 'UNCERTAIN');
});

test('journal externo: memoria (append/verify/list, fallo de persistencia) y disco (JSON Lines + fsync + relectura; hash incorrecto → false; nunca sobrescribe)', async () => {
  let fail = false;
  const mem = journalMod.createMemoryDeletionJournal({ failAppend: () => fail });
  const e = { userId: 'u1', purgeId: 'op-purge-1', objectId: 'tg:-1001:5', beatId: 'b1', chatId: '-1001', messageId: 5, kind: 'DELETE_INTENT' };
  const a = await mem.append(e);
  assert.equal(await mem.verify(a.ref, a.sha256), true); assert.equal(await mem.verify(a.ref, 'f'.repeat(64)), false);
  assert.equal((await mem.list('u1')).length, 1); assert.equal((await mem.list('u2')).length, 0);
  fail = true; await assert.rejects(mem.append(e), (x) => x.code === 'JOURNAL_UNAVAILABLE');
  await assert.rejects(mem.append({ userId: 'u1' }), (x) => x.code === 'JOURNAL_ENTRY_INVALID');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-journal-'));
  try {
    const disk = journalMod.createFileDeletionJournal({ dir });
    const r1 = await disk.append(e); const r2 = await disk.append({ ...e, objectId: 'tg:-1001:6', messageId: 6 });
    assert.notEqual(r1.ref, r2.ref);
    assert.equal(await disk.verify(r1.ref, r1.sha256), true); assert.equal(await disk.verify(r2.ref, r2.sha256), true);
    assert.equal(await disk.verify(r1.ref, r2.sha256), false); assert.equal(await disk.verify('file:nope.jsonl:' + 'a'.repeat(64), 'a'.repeat(64)), false);
    const lines = fs.readFileSync(path.join(dir, 'u1.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'solo append: dos líneas inmutables');
    const list = await disk.list('u1'); assert.deepEqual(list.map((x) => x.objectId), ['tg:-1001:5', 'tg:-1001:6']);
    assert.equal(disk.counters.appends, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gateway deleteMessage/probeAbsence sobre el fake: borrado + MessageEmpty en el peer correcto = ausencia; otro peer (sin entrada) → PROBE_UNVERIFIED; 403/timeout → GatewayError (no prueban nada)', async () => {
  const server = createFakeTelegramServer();
  const sdk = { Api, bigInt };
  const client = server.session({ selfId: '20' });
  const channel = () => new Api.InputPeerChannel({ channelId: bigInt('1001'), accessHash: bigInt('7') });
  const gw = g.createTelegramGateway({ client, sdk, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: chatId === 'other' ? new Api.InputPeerChannel({ channelId: bigInt('2002'), accessHash: bigInt('7') }) : channel(), channel: true }) });
  const sent = await gw.sendPart({ operationId: 'top-1', partKey: 'm0', randomId: g.newRandomId(), chatId: '1001', file: { name: 'a.mp3', buffer: Buffer.alloc(10, 1) }, mimeType: 'audio/mpeg', fileName: 'a.mp3' });
  assert.deepEqual(await gw.probeAbsence({ chatId: '1001', messageId: sent.messageId }), { absent: false, evidence: 'DOCUMENT_PRESENT', size: 10 });
  client.script({ type: 'wrongChat' });
  await assert.rejects(gw.probeAbsence({ chatId: '1001', messageId: sent.messageId }), (e) => e.code === 'PROBE_UNVERIFIED' && e.transient === true);
  client.script({ type: 'forbidden' });
  await assert.rejects(gw.probeAbsence({ chatId: '1001', messageId: sent.messageId }), (e) => e.code === 'PROBE_REJECTED_PERMANENT' || /PROBE/.test(e.code));
  client.script({ type: 'timeout' });
  await assert.rejects(gw.probeAbsence({ chatId: '1001', messageId: sent.messageId }), (e) => /PROBE/.test(e.code) && e.classification.kind === 'UNCERTAIN');
  client.script({ type: 'forbidden' });
  await assert.rejects(gw.deleteMessage({ chatId: '1001', messageId: sent.messageId }), (e) => e.code === 'DELETE_REJECTED_PERMANENT');
  assert.equal(server.messages().length, 1, 'el 403 no borró nada');
  const r = await gw.deleteMessage({ chatId: '1001', messageId: sent.messageId });
  assert.equal(r.requested, true); assert.equal(server.messages().length, 0);
  assert.deepEqual(await gw.probeAbsence({ chatId: '1001', messageId: sent.messageId }), { absent: true, evidence: 'MESSAGE_EMPTY' });
  assert.deepEqual(await gw.probeAbsence({ chatId: '1001', messageId: 999_999 }), { absent: true, evidence: 'MESSAGE_EMPTY' }, 'id inexistente en el peer autorizado también es MessageEmpty');
  assert.ok(gw.metrics.deletes === 1 && gw.metrics.probes >= 3);
});

// ---------- rutas ----------
function listen(router) { const app = express(); app.use(express.json()); app.use(router); return new Promise((resolve) => { const server = http.createServer(app); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); }); }
function raw(port, method, p, { headers = {}, body = null } = {}) { return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null })); }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); }); }
const fakeCmd = () => new Proxy({}, { get: () => async () => ({}) });

test('rutas T15: POST /operations {kind: PURGE} → 202 ENUMERATING (ALL_TRASH | beatIds), GET/cancel por prefijo op-purge-, restore-hold/release; sin módulo → 501; cabeceras obligatorias', async () => {
  const calls = [];
  const purgeMod = {
    async requestPurge(a) { calls.push(['request', a]); return { operationId: 'op-purge-1', purgeId: 'op-purge-1', kind: 'PURGE', status: 'ENUMERATING', created: true, durable: true }; },
    async getPurge(a) { calls.push(['get', a]); return { operationId: a.purgeId, status: 'DELETING', progress: { total: 2, purged: 1, blocked: 0, pending: 1 } }; },
    async cancelPurge(a) { calls.push(['cancel', a]); if (a.purgeId === 'op-purge-busy') throw new CatalogQueryError('PURGE_IN_FLIGHT', 409, 'x', { in_flight: 1 }); return { operationId: a.purgeId, status: 'CANCELLED' }; },
    async releaseRestoreHold(a) { calls.push(['hold', a]); return { restoreHold: false, journalEntries: 0 }; },
  };
  const router = createCatalogRouter({ authority: {}, queries: {}, commands: fakeCmd(), operations: { async createOperation() { throw new Error('no debe llamarse para PURGE'); } }, purge: purgeMod, authenticate: () => ({ id: 'u1' }) });
  const { server, port } = await listen(router);
  try {
    const W = { 'idempotency-key': 'k1', 'x-catalog-era': 'e1', 'x-catalog-epoch': '1', 'content-type': 'application/json' };
    let r = await raw(port, 'POST', '/catalog/v1/operations', { headers: W, body: { kind: 'PURGE' } });
    assert.deepEqual([r.status, r.body.status, calls.at(-1)[1].scope, calls.at(-1)[1].idempotencyKey], [202, 'ENUMERATING', 'ALL_TRASH', 'k1']);
    r = await raw(port, 'POST', '/catalog/v1/operations', { headers: W, body: { kind: 'PURGE', beatIds: ['b1', 'b2'] } });
    assert.deepEqual([r.status, calls.at(-1)[1].scope, calls.at(-1)[1].beatIds], [202, 'ITEMS', ['b1', 'b2']]);
    assert.equal((await raw(port, 'POST', '/catalog/v1/operations', { headers: { 'content-type': 'application/json' }, body: { kind: 'PURGE' } })).status, 428);
    r = await raw(port, 'GET', '/catalog/v1/operations/op-purge-1'); assert.deepEqual([r.status, r.body.progress.pending], [200, 1]);
    r = await raw(port, 'POST', '/catalog/v1/operations/op-purge-1/cancel', { headers: W }); assert.equal(r.body.status, 'CANCELLED');
    r = await raw(port, 'POST', '/catalog/v1/operations/op-purge-busy/cancel', { headers: W }); assert.deepEqual([r.status, r.body.code], [409, 'PURGE_IN_FLIGHT']);
    r = await raw(port, 'POST', '/catalog/v1/library/restore-hold/release', { headers: W }); assert.deepEqual([r.status, r.body.restoreHold], [200, false]);
  } finally { server.close(); }
  const bare = createCatalogRouter({ authority: {}, queries: {}, commands: fakeCmd(), operations: { async createOperation() { return {}; } }, authenticate: () => ({ id: 'u1' }) });
  const s2 = await listen(bare);
  try { assert.equal((await raw(s2.port, 'POST', '/catalog/v1/operations', { headers: { 'idempotency-key': 'k', 'x-catalog-era': 'e', 'x-catalog-epoch': '1', 'content-type': 'application/json' }, body: { kind: 'PURGE' } })).status, 501); } finally { s2.server.close(); }
});
