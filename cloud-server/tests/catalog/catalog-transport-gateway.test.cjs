'use strict';
// T11 — Adaptador del contrato de envío (gateway §8.6): conversión Long, caption, peticiones TL exactas del SDK instalado,
// tabla de errores, reconciliación y gateway sobre el servidor fake. Sin red (la importación de `telegram` no abre conexiones).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Api } = require('telegram');
const bigInt = require('big-integer');
const { RPCError, FloodWaitError, RPCMessageToError } = require('telegram/errors');
const g = require('../../catalog/transport-gateway.js');
const { createFakeTelegramServer } = require('../helpers/catalog-fake-mtproto.cjs');

const sdk = { Api, bigInt };
const channel = () => new Api.InputPeerChannel({ channelId: bigInt('1001'), accessHash: bigInt('7') });
const inputFile = () => new Api.InputFile({ id: bigInt('1'), parts: 1, name: 'a.wav', md5Checksum: '' });
const gw = (server, selfId = '20') => g.createTelegramGateway({ client: server.session({ selfId }), sdk, senderId: selfId, resolvePeer: async () => ({ peer: channel(), channel: true }) });
const part = (over = {}) => ({ operationId: 'top-1', partKey: 'm0', randomId: g.newRandomId(), chatId: '1001', file: { name: 'a.wav', buffer: Buffer.alloc(1000, 1) }, mimeType: 'audio/wav', fileName: 'a.wav', ...over });

test('random_id: int64 con signo en texto ↔ BigInteger; extremos exactos; fuera de rango y formatos inválidos rechazados; generador uniforme en rango', () => {
  for (const s of ['-9223372036854775808', '9223372036854775807', '0', '-1', '42']) assert.equal(g.longToText(g.randomIdToLong(s, bigInt)), s);
  for (const bad of ['9223372036854775808', '-9223372036854775809', '01', '1.5', '', 'abc', 12]) assert.throws(() => g.randomIdToLong(bad, bigInt), (e) => e.code === 'RANDOM_ID_INVALID');
  const ids = new Set(Array.from({ length: 2000 }, () => g.newRandomId()));
  assert.equal(ids.size, 2000);
  for (const id of ids) { const v = BigInt(id); assert.ok(v >= -(2n ** 63n) && v <= 2n ** 63n - 1n); }
  assert.ok([...ids].some((id) => id.startsWith('-')), 'el generador cubre el rango negativo');
});

test('caption: marcador no ambiguo op/part, parse estricto, ids inválidos rechazados', () => {
  assert.equal(g.captionFor({ operationId: 'top-abc', partKey: 'm0' }), 'catalog:v1 op=top-abc part=m0');
  assert.deepEqual(g.parseCaption('  catalog:v1 op=top-abc part=m0 '), { operationId: 'top-abc', partKey: 'm0' });
  assert.equal(g.parseCaption('catalog:v1 op=top-abc part=m0 bot_token=x'), null);
  assert.equal(g.parseCaption('catalog:v0 op=a part=b'), null);
  assert.throws(() => g.captionFor({ operationId: 'top abc', partKey: 'm0' }), (e) => e.code === 'OPERATION_ID_INVALID');
  assert.throws(() => g.captionFor({ operationId: 'top-abc', partKey: 'm 0' }), (e) => e.code === 'PART_KEY_INVALID' && e.effectPossible === false && e.classification.kind === 'PERMANENT');
  // T16/V09: la gramática del cliente real ('MASTER:0', 'FILES:0:0', 'ARTWORK:0') es la de operations.js y hace roundtrip exacto
  for (const partKey of ['MASTER:0', 'FILES:0:0', 'ARTWORK:0', 'PROJECT:0', 'a.b-c_d']) assert.deepEqual(g.parseCaption(g.captionFor({ operationId: 'top-abc', partKey })), { operationId: 'top-abc', partKey });
});

test('peticiones TL del SDK instalado: SendMedia con randomId explícito y forceFile, Search con filtro documento y límite ≤100, GetMessages por tipo de peer; serializan', () => {
  const caption = g.captionFor({ operationId: 'top-1', partKey: 'm0' });
  const send = g.buildSendMedia(sdk, { peer: channel(), inputFile: inputFile(), mimeType: 'audio/wav', fileName: 'a.wav', caption, randomId: '-5' });
  assert.equal(send.className, 'messages.SendMedia');
  assert.equal(send.randomId.toString(), '-5');
  assert.equal(send.media.className, 'InputMediaUploadedDocument');
  assert.deepEqual([send.media.forceFile, send.media.mimeType, send.media.attributes[0].fileName, send.message, send.silent], [true, 'audio/wav', 'a.wav', caption, true]);
  assert.ok(send.getBytes().length > 40);
  const search = g.buildSearch(sdk, { peer: channel(), caption, limit: 1000 });
  assert.deepEqual([search.className, search.q, search.filter.className, search.limit, search.hash.toString()], ['messages.Search', caption, 'InputMessagesFilterDocument', 100, '0']);
  assert.ok(search.getBytes().length > 0);
  assert.equal(g.buildGetMessages(sdk, { peer: channel(), messageId: 7, channel: true }).className, 'channels.GetMessages');
  assert.equal(g.buildGetMessages(sdk, { messageId: 7 }).className, 'messages.GetMessages');
  assert.throws(() => g.buildSendMedia(sdk, { peer: channel(), inputFile: inputFile(), fileName: 'a.wav', caption: 'hola', randomId: '1' }), (e) => e.code === 'CAPTION_INVALID');
  assert.throws(() => g.buildGetMessages(sdk, { messageId: 0 }), (e) => e.code === 'MESSAGE_ID_INVALID');
  assert.deepEqual(g.SDK_CONTRACT.requests, ['messages.SendMedia', 'messages.Search', 'messages.GetMessages', 'channels.GetMessages']);
});

test('tabla de errores: FLOOD_WAIT rechazo con espera; permisos permanentes; auth revocada; red/timeout/desconocido → UNCERTAIN fail-closed; RANDOM_ID_DUPLICATE → RECONCILE', () => {
  // instancias reales del SDK: errores conocidos llegan como subclases (errorMessage base 'FLOOD', `seconds`, `newDc`)
  const flood = g.classifyError(RPCMessageToError({ errorMessage: 'FLOOD_WAIT_37', errorCode: 420 }, { className: 'messages.SendMedia' }));
  assert.deepEqual([flood.kind, flood.action, flood.retryAfterMs, flood.transient, flood.effectPossible, flood.code], ['REJECTED', 'RETRY_SAME_IDENTITY_AFTER_WAIT', 37_000, true, false, 'FLOOD_WAIT_37']);
  assert.equal(g.classifyError(new FloodWaitError({ capture: 5, request: { className: 'x' } })).retryAfterMs, 5000);
  const migrate = g.classifyError(RPCMessageToError({ errorMessage: 'FILE_MIGRATE_2', errorCode: 303 }, { className: 'upload.SaveFilePart' }));
  assert.deepEqual([migrate.kind, migrate.action, migrate.code], ['REJECTED', 'RETRY_SAME_IDENTITY_AFTER_REUPLOAD', 'FILE_MIGRATE_2']);
  const fileRefReal = g.classifyError(RPCMessageToError({ errorMessage: 'FILE_REFERENCE_EXPIRED', errorCode: 400 }, { className: 'messages.SendMedia' }));
  assert.equal(fileRefReal.kind, 'REJECTED');
  const forbiddenReal = g.classifyError(RPCMessageToError({ errorMessage: 'CHAT_WRITE_FORBIDDEN', errorCode: 403 }, { className: 'messages.SendMedia' }));
  assert.deepEqual([forbiddenReal.kind, forbiddenReal.action], ['PERMANENT', 'BLOCK']);
  const revokedReal = g.classifyError(RPCMessageToError({ errorMessage: 'AUTH_KEY_UNREGISTERED', errorCode: 401 }, { className: 'messages.SendMedia' }));
  assert.equal(revokedReal.kind, 'REVOKED');
  const forbidden = g.classifyError(new RPCError('CHAT_WRITE_FORBIDDEN', { className: 'messages.SendMedia' }, 403));
  assert.deepEqual([forbidden.kind, forbidden.action, forbidden.transient], ['PERMANENT', 'BLOCK', false]);
  const revoked = g.classifyError(new RPCError('AUTH_KEY_UNREGISTERED', { className: 'messages.SendMedia' }, 401));
  assert.deepEqual([revoked.kind, revoked.action, revoked.transient], ['REVOKED', 'FENCE_REVOKED', false]);
  const fileRef = g.classifyError(new RPCError('FILE_REFERENCE_EXPIRED', { className: 'messages.SendMedia' }, 400));
  assert.deepEqual([fileRef.kind, fileRef.action], ['REJECTED', 'RETRY_SAME_IDENTITY_AFTER_REUPLOAD']);
  for (const e of [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), new Error('Timeout'), new Error('Not connected'), new Error('something odd'), {}]) {
    const c = g.classifyError(e);
    assert.deepEqual([c.kind, c.action, c.effectPossible, c.transient], ['UNCERTAIN', 'RECONCILE', true, true], JSON.stringify(e.message));
  }
  const dup = g.classifyError(new RPCError('RANDOM_ID_DUPLICATE', { className: 'messages.SendMedia' }, 400));
  assert.deepEqual([dup.kind, dup.action, dup.effectPossible], ['DUPLICATE_IDENTITY', 'RECONCILE', true]);
  assert.deepEqual([g.RESEND_POLICY.uncertain, g.RESEND_POLICY.evidence], ['BLOCKED', 'NONE_REAL']);
});

test('reconciliación: candidatos por marcador + remitente + tamaño; 0 → UNCERTAIN, 1 → ADOPT, >1 → AMBIGUOUS; mensajes sin documento o de otro remitente se ignoran', () => {
  const doc = (id, size, name = 'a.wav') => ({ className: 'MessageMediaDocument', document: { className: 'Document', id: bigInt(String(id)), size: bigInt(String(size)), attributes: [{ className: 'DocumentAttributeFilename', fileName: name }] } });
  const msg = (id, caption, size, from = '20', extra = {}) => ({ className: 'Message', id, out: true, fromId: { className: 'PeerUser', userId: bigInt(from) }, message: caption, date: 1, media: doc(id * 10, size), ...extra });
  const cap = g.captionFor({ operationId: 'top-1', partKey: 'm0' });
  const list = [msg(1, cap, 1000), msg(2, cap, 999), msg(3, cap, 1000, '21'), msg(4, 'otro', 1000), { className: 'MessageService', id: 5 }, { className: 'Message', id: 6, out: true, message: cap, media: { className: 'MessageMediaPhoto' } }];
  const one = g.matchCandidates(list, { operationId: 'top-1', partKey: 'm0', senderId: '20', declaredSize: 1000 });
  assert.deepEqual(one.map((c) => [c.messageId, c.documentId, c.size, c.senderId, c.fileName]), [[1, '10', 1000, '20', 'a.wav']]);
  assert.equal(g.reconcileDecision(one), 'ADOPT');
  assert.equal(g.reconcileDecision(g.matchCandidates(list, { operationId: 'top-1', partKey: 'm0', senderId: '20', declaredSize: 5 })), 'UNCERTAIN');
  assert.equal(g.reconcileDecision(g.matchCandidates([...list, msg(7, cap, 1000)], { operationId: 'top-1', partKey: 'm0', senderId: '20', declaredSize: 1000 })), 'AMBIGUOUS');
  const r = g.receiptFromUpdates({ className: 'Updates', updates: [{ className: 'UpdateMessageID', id: 9, randomId: bigInt('-77') }, { className: 'UpdateNewChannelMessage', message: msg(9, cap, 1000) }] }, { randomId: '-77' });
  assert.deepEqual(r, { messageId: 9, documentId: '90', size: 1000, randomId: '-77', complete: true });
  assert.equal(g.receiptFromUpdates({ className: 'Updates', updates: [{ className: 'UpdateMessageID', id: 9, randomId: bigInt('1') }] }, { randomId: '-77' }), null, 'random_id ajeno no se adopta');
});

test('gateway sobre el fake: envío con identidad persistida → recibo con message/document/size; respuesta perdida → SEND_UNCERTAIN sin reenviar; verificación por proveedor; búsqueda por marcador', async () => {
  const server = createFakeTelegramServer(); const t = gw(server);
  const p = part();
  const receipt = await t.sendPart(p);
  assert.deepEqual([receipt.messageId > 0, typeof receipt.documentId, receipt.size, receipt.senderId, receipt.chatId, receipt.randomId, receipt.complete], [true, 'string', 1000, '20', '1001', p.randomId, true]);
  assert.deepEqual(server.messages().map((m) => [m.randomId, m.caption, m.size, m.sender]), [[p.randomId, 'catalog:v1 op=top-1 part=m0', 1000, '20']]);
  const v = await t.verifyMessage({ chatId: '1001', messageId: receipt.messageId });
  assert.deepEqual([v.size, v.sha256, v.provider, v.documentId], [1000, null, 'telegram', receipt.documentId]);
  const lost = part({ partKey: 'm1' }); server.session().script; // (sin efecto) documenta que los scripts son por sesión
  const client2 = server.session({ selfId: '20' }); client2.script({ type: 'loseResponse' });
  const t2 = g.createTelegramGateway({ client: client2, sdk, senderId: '20', resolvePeer: async () => ({ peer: channel(), channel: true }) });
  await assert.rejects(t2.sendPart(lost), (e) => e.code === 'SEND_UNCERTAIN' && e.transient === true && e.resend === false && e.classification.action === 'RECONCILE');
  assert.equal(server.counters().sends, 2, 'no hubo reenvío automático');
  const found = await t2.searchByRandomId({ chatId: '1001', declaredSize: 1000, operationId: 'top-1', partKey: 'm1' });
  assert.equal(g.reconcileDecision(found), 'ADOPT');
  await assert.rejects(t2.searchByRandomId({ chatId: '1001', declaredSize: 1000 }), (e) => e.code === 'RECONCILE_IDENTITY_INCOMPLETE' && e.transient === false);
  assert.deepEqual([t.metrics.sends, t2.metrics.uncertain, t2.metrics.searches], [1, 1, 1]);
});

test('gateway: FLOOD_WAIT → SEND_REJECTED con retryAfterMs y sin mensaje; permiso → permanente (status 403); revocación → CREDENTIAL_REVOKED; fallo de subida nunca es incierto; verificación de mensaje ausente → 404 no transitorio', async () => {
  const server = createFakeTelegramServer(); const client = server.session({ selfId: '20' });
  const t = g.createTelegramGateway({ client, sdk, senderId: '20', resolvePeer: async () => ({ peer: channel(), channel: true }) });
  client.script({ type: 'flood', seconds: 5 });
  await assert.rejects(t.sendPart(part()), (e) => e.code === 'SEND_REJECTED' && e.retryAfterMs === 5000 && e.transient === true);
  assert.equal(server.messages().length, 0);
  client.script({ type: 'forbidden' });
  await assert.rejects(t.sendPart(part()), (e) => e.code === 'SEND_REJECTED_PERMANENT' && e.status === 403 && e.transient === false);
  const failingUpload = { ...client, uploadFile: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } };
  const tu = g.createTelegramGateway({ client: failingUpload, sdk, senderId: '20', resolvePeer: async () => ({ peer: channel(), channel: true }) });
  await assert.rejects(tu.sendPart(part()), (e) => e.code === 'UPLOAD_FAILED' && e.transient === true && e.classification.effectPossible === false);
  await assert.rejects(t.verifyMessage({ chatId: '1001', messageId: 424242 }), (e) => e.code === 'PROVIDER_MESSAGE_NOT_FOUND' && e.status === 404 && e.transient === false);
  server.revokeBot('20');
  await assert.rejects(t.sendPart(part()), (e) => e.code === 'CREDENTIAL_REVOKED' && e.transient === false && e.classification.kind === 'REVOKED');
  await assert.rejects(t.verifyMessage({ chatId: '1001', messageId: 1 }), (e) => e.code === 'CREDENTIAL_REVOKED');
  assert.throws(() => g.createTelegramGateway({ client, sdk, senderId: 'Bot20', resolvePeer: async () => ({}) }), (e) => e.code === 'SENDER_INVALID');
});
