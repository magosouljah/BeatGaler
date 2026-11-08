'use strict';
// T02 — Pruebas del transporte fake y del reloj controlable (suite unit y faults).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeTransport, createFakeClock, BOUNDARIES } = require('../helpers/catalog-fake-transport.cjs');

const tick = () => new Promise((r) => setImmediate(r));

test('fronteras declaradas y efecto normal con contadores', async () => {
  assert.deepEqual(BOUNDARIES, ['uploadPart', 'verifyMessage', 'publishIndex', 'pinMessage', 'getPinned', 'download', 'deleteMessages', 'deleteTopic', 'metadata']);
  const t = createFakeTransport();
  const up = await t.uploadPart({ chatId: 1, bytes: 10 });
  assert.equal(up.locator, `direct:${up.messageId}`);
  assert.deepEqual(await t.verifyMessage({ messageId: up.messageId }), { messageId: up.messageId, bytes: 10 });
  const c = t.counters();
  assert.equal(c.uploadPart.calls, 1); assert.equal(c.uploadPart.effects, 1); assert.equal(c.uploadPart.inflight, 0);
});

test('pause retiene la frontera hasta liberarla', async () => {
  const t = createFakeTransport();
  t.script('uploadPart', { type: 'pause' });
  let done = false;
  const p = t.uploadPart({ chatId: 1, bytes: 1 }).then((r) => { done = true; return r; });
  await tick();
  assert.equal(done, false); assert.equal(t.pausedCount(), 1); assert.equal(t.counters().uploadPart.inflight, 1);
  assert.equal(t.releaseNext('uploadPart'), true);
  await p; assert.equal(done, true); assert.equal(t.counters().uploadPart.inflight, 0);
});

test('loseResponse aplica el efecto y pierde la respuesta', async () => {
  const t = createFakeTransport();
  t.script('uploadPart', { type: 'loseResponse' });
  await assert.rejects(t.uploadPart({ chatId: 1, bytes: 5 }), { code: 'FAKE_RESPONSE_LOST' });
  assert.equal(t.messages().size, 1, 'el mensaje existe aunque el cliente no recibió respuesta');
  const c = t.counters().uploadPart; assert.equal(c.effects, 1); assert.equal(c.faults, 1);
});

test('permisos y ausencia devuelven 403/404 sin efecto', async () => {
  const t = createFakeTransport();
  t.script('pinMessage', { type: 'permission' });
  await assert.rejects(t.pinMessage({ messageId: 1 }), (e) => e.code === 'FAKE_PERMISSION_DENIED' && e.status === 403);
  t.script('download', { type: 'absent' });
  await assert.rejects(t.download({ messageId: 1 }), (e) => e.code === 'FAKE_NOT_FOUND' && e.status === 404);
  assert.equal(t.counters().pinMessage.effects, 0);
});

test('duplicateReceipt devuelve el recibo anterior sin nuevo efecto', async () => {
  const t = createFakeTransport();
  const a = await t.publishIndex({ chatId: 1, bytes: 3 });
  t.script('publishIndex', { type: 'duplicateReceipt' });
  const b = await t.publishIndex({ chatId: 1, bytes: 3 });
  assert.equal(b.messageId, a.messageId); assert.equal(b.duplicate, true);
  assert.equal(t.counters().publishIndex.effects, 1);
  assert.equal(t.receipts().length, 2);
});

test('kill detiene todas las fronteras hasta restart', async () => {
  const t = createFakeTransport();
  t.script('uploadPart', { type: 'kill' });
  await assert.rejects(t.uploadPart({ chatId: 1 }), { code: 'FAKE_WORKER_KILLED' });
  await assert.rejects(t.getPinned({ chatId: 1 }), { code: 'FAKE_WORKER_KILLED' });
  t.restart();
  assert.deepEqual(await t.getPinned({ chatId: 1 }), { messageId: null });
});

test('delay usa el reloj fake: no resuelve hasta avanzar', async () => {
  const clock = createFakeClock(0);
  const t = createFakeTransport({ clock });
  t.script('download', { type: 'delay', ms: 2000 });
  const up = await t.uploadPart({ chatId: 1, bytes: 2 });
  let done = false;
  const p = t.download({ messageId: up.messageId }).then(() => { done = true; });
  await tick(); assert.equal(done, false); assert.equal(clock.pending(), 1);
  await clock.advance(1999); await tick(); assert.equal(done, false);
  await clock.advance(1); await p; assert.equal(done, true); assert.equal(clock.now(), 2000);
});

test('metadata está prohibida por defecto (V01-B)', async () => {
  const t = createFakeTransport();
  await assert.rejects(t.metadata({ beatId: 'x' }), { code: 'FAKE_METADATA_FORBIDDEN' });
  assert.equal(t.counters().metadata.calls, 1); assert.equal(t.counters().metadata.effects, 0);
});

test('pin/getPinned/delete mantienen estado coherente', async () => {
  const t = createFakeTransport();
  const a = await t.publishIndex({ chatId: 7, bytes: 1 });
  const b = await t.publishIndex({ chatId: 7, bytes: 1 });
  await t.pinMessage({ messageId: a.messageId }); await t.pinMessage({ messageId: b.messageId });
  assert.deepEqual(await t.getPinned({ chatId: 7 }), { messageId: b.messageId });
  assert.deepEqual(await t.deleteMessages({ messageIds: [b.messageId, b.messageId] }), { deleted: 1 });
  assert.deepEqual(await t.getPinned({ chatId: 7 }), { messageId: null });
  await assert.rejects(t.verifyMessage({ messageId: b.messageId }), { code: 'FAKE_NOT_FOUND' });
});
