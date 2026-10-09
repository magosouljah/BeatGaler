'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../billing-webhook-runtime');
const { createPolarWebhookRoute } = require('../billing-webhook-route');

const pool = { connect() {}, query() {} };
const adapter = { provider: 'polar', environment: 'sandbox', verifyWebhook() {} };

test('webhook secret is required independently of checkout catalog readiness', () => {
  assert.deepEqual(runtime.configure({ pool, adapter, env: {} }), {
    ready: false, failureCode: 'WEBHOOK_SECRET_MISSING',
  });
  assert.equal(runtime.current(), null);
  assert.deepEqual(runtime.configure({ pool, adapter, env: { POLAR_SANDBOX_WEBHOOK_SECRET: 'fixture-only' } }), {
    ready: true, failureCode: null,
  });
  assert.equal(runtime.current().provider, 'polar');
  assert.equal(runtime.current().environment, 'sandbox');
});

test('webhook endpoint refuses a delivery while the secret is absent', async () => {
  runtime.configure({ pool, adapter, env: {} });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await createPolarWebhookRoute({ currentInbox: runtime.current })({ body: Buffer.from('{}'), headers: {} }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'WEBHOOK_RUNTIME_UNAVAILABLE');
});

test('webhook runtime rejects an unvalidated or absent adapter', () => {
  for (const bad of [null, { ...adapter, environment: 'production' }, { ...adapter, verifyWebhook: null }]) {
    assert.equal(runtime.configure({ pool, adapter: bad, env: { POLAR_SANDBOX_WEBHOOK_SECRET: 'fixture-only' } }).ready, false);
    assert.equal(runtime.current(), null);
  }
});
