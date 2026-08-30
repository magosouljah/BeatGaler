'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WebhookSignatureError,
  WebhookDeliveryError,
  createWebhookProcessor,
} = require('../billing-webhook');

function event(id = 'evt_1', created = 10, type = 'invoice.paid', subjectId = 'sub_1') {
  return { id, created, type, data: { object: { id: subjectId } } };
}

function verifierFor(expectedRaw = '{"ok":true}', expectedSignature = 'sig_ok', returnedEvent = event()) {
  return {
    async verify(raw, signature) {
      if (!Buffer.isBuffer(raw)) throw new Error('not raw');
      if (raw.toString('utf8') !== expectedRaw || signature !== expectedSignature) throw new Error('bad signature');
      return returnedEvent;
    },
  };
}

function memoryRepository() {
  const states = new Map();
  const watermarks = new Map();
  let attempts = 0;
  return {
    states,
    watermarks,
    get attempts() { return attempts; },
    async process(evt, handler) {
      const existing = states.get(evt.id);
      if (existing === 'PROCESSED' || existing === 'PROCESSING' || existing === 'IGNORED_OUT_OF_ORDER') {
        return { duplicate: true, state: existing };
      }
      states.set(evt.id, 'PROCESSING');
      attempts += 1;
      const last = watermarks.get(evt.subjectId) ?? -1;
      if (last > evt.created) {
        states.set(evt.id, 'IGNORED_OUT_OF_ORDER');
        return { duplicate: false, stale: true, state: 'IGNORED_OUT_OF_ORDER' };
      }
      try {
        await handler({}, evt);
        watermarks.set(evt.subjectId, Math.max(last, evt.created));
        states.set(evt.id, 'PROCESSED');
        return { duplicate: false, stale: false, state: 'PROCESSED' };
      } catch (_) {
        states.set(evt.id, 'FAILED');
        throw new WebhookDeliveryError();
      }
    },
  };
}

const raw = Buffer.from('{"ok":true}');

test('valid signature is verified from exact raw Buffer before handler', async () => {
  const repo = memoryRepository();
  let handled = 0;
  const processor = createWebhookProcessor({ verifier: verifierFor(), repository: repo, handlers: { 'invoice.paid': async () => { handled += 1; } } });
  const result = await processor.receive({ rawBody: raw, signature: 'sig_ok' });
  assert.equal(result.state, 'PROCESSED');
  assert.equal(result.entitlementGranted, false);
  assert.equal(handled, 1);
});

test('invalid signature and mutated body fail before persistence or handler', async () => {
  const repo = memoryRepository();
  let handled = 0;
  const processor = createWebhookProcessor({ verifier: verifierFor(), repository: repo, handlers: { 'invoice.paid': async () => { handled += 1; } } });
  await assert.rejects(() => processor.receive({ rawBody: raw, signature: 'sig_bad' }), WebhookSignatureError);
  await assert.rejects(() => processor.receive({ rawBody: Buffer.from('{"ok":false}'), signature: 'sig_ok' }), WebhookSignatureError);
  assert.equal(repo.attempts, 0);
  assert.equal(handled, 0);
});

test('parsed object/string instead of raw body fails closed', async () => {
  const processor = createWebhookProcessor({ verifier: verifierFor(), repository: memoryRepository(), handlers: {} });
  await assert.rejects(() => processor.receive({ rawBody: { ok: true }, signature: 'sig_ok' }), WebhookSignatureError);
});

test('duplicate same event ID is handled at most once', async () => {
  const repo = memoryRepository();
  let handled = 0;
  const processor = createWebhookProcessor({ verifier: verifierFor(), repository: repo, handlers: { 'invoice.paid': async () => { handled += 1; } } });
  await processor.receive({ rawBody: raw, signature: 'sig_ok' });
  const duplicate = await processor.receive({ rawBody: raw, signature: 'sig_ok' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(handled, 1);
});

test('out-of-order event is ignored before handler mutation', async () => {
  const repo = memoryRepository();
  let handled = 0;
  const newer = createWebhookProcessor({ verifier: verifierFor('{"ok":true}', 'sig_ok', event('evt_new', 20)), repository: repo, handlers: { 'invoice.paid': async () => { handled += 1; } } });
  const older = createWebhookProcessor({ verifier: verifierFor('{"ok":true}', 'sig_ok', event('evt_old', 10)), repository: repo, handlers: { 'invoice.paid': async () => { handled += 1; } } });
  await newer.receive({ rawBody: raw, signature: 'sig_ok' });
  const result = await older.receive({ rawBody: raw, signature: 'sig_ok' });
  assert.equal(result.stale, true);
  assert.equal(result.state, 'IGNORED_OUT_OF_ORDER');
  assert.equal(handled, 1);
});

test('distinct events with the same provider timestamp both process', async () => {
  const repo = memoryRepository();
  let handled = 0;
  const first = createWebhookProcessor({ verifier: verifierFor('{"ok":true}', 'sig_ok', event('evt_a', 20)), repository: repo, handlers: { 'invoice.paid': async () => { handled += 1; } } });
  const second = createWebhookProcessor({ verifier: verifierFor('{"ok":true}', 'sig_ok', event('evt_b', 20)), repository: repo, handlers: { 'invoice.paid': async () => { handled += 1; } } });
  assert.equal((await first.receive({ rawBody: raw, signature: 'sig_ok' })).state, 'PROCESSED');
  assert.equal((await second.receive({ rawBody: raw, signature: 'sig_ok' })).state, 'PROCESSED');
  assert.equal(handled, 2);
});

test('handler failure records retryable failure and retry can succeed', async () => {
  const repo = memoryRepository();
  let calls = 0;
  const processor = createWebhookProcessor({ verifier: verifierFor(), repository: repo, handlers: { 'invoice.paid': async () => { calls += 1; if (calls === 1) throw new Error('temporary'); } } });
  await assert.rejects(() => processor.receive({ rawBody: raw, signature: 'sig_ok' }), WebhookDeliveryError);
  assert.equal(repo.states.get('evt_1'), 'FAILED');
  const result = await processor.receive({ rawBody: raw, signature: 'sig_ok' });
  assert.equal(result.state, 'PROCESSED');
  assert.equal(calls, 2);
  assert.equal(repo.attempts, 2);
});

test('timeout/error fails closed without entitlement grant', async () => {
  const repo = memoryRepository();
  const processor = createWebhookProcessor({ verifier: verifierFor(), repository: repo, handlers: { 'invoice.paid': async () => { throw new Error('timeout'); } } });
  await assert.rejects(() => processor.receive({ rawBody: raw, signature: 'sig_ok' }), WebhookDeliveryError);
  assert.equal(repo.states.get('evt_1'), 'FAILED');
});

test('unsupported event is safe no-op and does not touch durable processor', async () => {
  const repo = memoryRepository();
  const processor = createWebhookProcessor({ verifier: verifierFor('{"ok":true}', 'sig_ok', event('evt_unknown', 30, 'unknown.event')), repository: repo, handlers: {} });
  const result = await processor.receive({ rawBody: raw, signature: 'sig_ok' });
  assert.equal(result.unsupported, true);
  assert.equal(result.entitlementGranted, false);
  assert.equal(repo.attempts, 0);
});

test('concurrent duplicate delivery cannot run handler twice', async () => {
  const repo = memoryRepository();
  let handled = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const processor = createWebhookProcessor({ verifier: verifierFor(), repository: repo, handlers: { 'invoice.paid': async () => { handled += 1; await gate; } } });
  const first = processor.receive({ rawBody: raw, signature: 'sig_ok' });
  await Promise.resolve();
  const second = processor.receive({ rawBody: raw, signature: 'sig_ok' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(handled, 1);
  assert.ok(a.duplicate === true || b.duplicate === true);
});
