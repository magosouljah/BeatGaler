'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { POLAR_API_VERSION, POLAR_SDK_ENTRY, POLAR_SDK_VERSION } = require('../billing-polar-sandbox');

function signWebhook({ body, signingKey, webhookId, timestamp }) {
  const signedContent = `${webhookId}.${timestamp}.${body}`;
  const signature = crypto.createHmac('sha256', signingKey).update(signedContent).digest('base64');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  };
}

function webhookBody() {
  return JSON.stringify({ type: 'product.created', timestamp: new Date().toISOString(), data: {} });
}

test('pinned Polar SDK entry loads the 2026-04 contract through CommonJS', () => {
  assert.equal(POLAR_SDK_VERSION, '1.0.0-alpha.20');
  assert.equal(POLAR_API_VERSION, '2026-04');
  assert.equal(POLAR_SDK_ENTRY, '@polar-sh/sdk/2026-04');

  const sdk = require(POLAR_SDK_ENTRY);
  assert.equal(typeof sdk.createPolar, 'function');
  assert.equal(typeof sdk.webhooks?.validateEvent, 'function');
});

test('pinned Polar SDK entry exposes every real lifecycle primitive required by Task 11', () => {
  const sdk = require(POLAR_SDK_ENTRY);
  const client = sdk.createPolar({
    accessToken: 'polar_oat_sandbox_contract_only',
    environment: 'sandbox',
    version: POLAR_API_VERSION,
  });
  assert.equal(typeof client.checkouts?.get, 'function');
  assert.equal(typeof client.orders?.get, 'function');
  assert.equal(typeof client.orders?.list, 'function');
  assert.equal(typeof client.subscriptions?.get, 'function');
  assert.equal(typeof client.subscriptions?.list, 'function');
  assert.equal(typeof client.subscriptions?.update, 'function');
  assert.equal(typeof client.subscriptions?.revoke, 'function');
  assert.equal(typeof client.refunds?.create, 'function');
});

test('pinned Polar SDK entry loads the same 2026-04 contract through ESM import', async () => {
  const sdk = await import(POLAR_SDK_ENTRY);
  assert.equal(typeof sdk.createPolar, 'function');
  assert.equal(typeof sdk.webhooks?.validateEvent, 'function');
});

test('real Polar SDK validates the legacy literal-secret webhook scheme and rejects tampering', async () => {
  const sdk = require(POLAR_SDK_ENTRY);
  const secret = 'beatgaler-polar-legacy-webhook-secret';
  const webhookId = 'msg_beatgaler_legacy_contract';
  const timestamp = Math.floor(Date.now() / 1000);
  const body = webhookBody();
  const headers = signWebhook({ body, signingKey: secret, webhookId, timestamp });

  const event = await sdk.webhooks.validateEvent(body, headers, secret);
  assert.equal(event.type, 'product.created');

  await assert.rejects(
    () => sdk.webhooks.validateEvent(`${body} `, headers, secret),
    error => error && /signature|matching/i.test(String(error.message || error)),
  );
});

test('real Polar SDK validates the current whsec_ Standard Webhooks key scheme', async () => {
  const sdk = require(POLAR_SDK_ENTRY);
  const rawKey = Buffer.from('beatgaler-polar-standard-webhook-key');
  const secret = `whsec_${rawKey.toString('base64')}`;
  const webhookId = 'msg_beatgaler_standard_contract';
  const timestamp = Math.floor(Date.now() / 1000);
  const body = webhookBody();
  const headers = signWebhook({ body, signingKey: rawKey, webhookId, timestamp });

  const event = await sdk.webhooks.validateEvent(body, headers, secret);
  assert.equal(event.type, 'product.created');
});
