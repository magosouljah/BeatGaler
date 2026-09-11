'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { POLAR_API_VERSION, POLAR_SDK_ENTRY, POLAR_SDK_VERSION } = require('../billing-polar-sandbox');

function signWebhook({ body, secret, webhookId, timestamp }) {
  const signedContent = `${webhookId}.${timestamp}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(signedContent).digest('base64');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  };
}

test('pinned Polar SDK entry loads the 2026-04 contract', () => {
  assert.equal(POLAR_SDK_VERSION, '1.0.0-alpha.20');
  assert.equal(POLAR_API_VERSION, '2026-04');
  assert.equal(POLAR_SDK_ENTRY, '@polar-sh/sdk/2026-04');

  const sdk = require(POLAR_SDK_ENTRY);
  assert.equal(typeof sdk.createPolar, 'function');
  assert.equal(typeof sdk.webhooks?.validateEvent, 'function');
});

test('real Polar SDK validates a correctly signed raw webhook body and rejects tampering', async () => {
  const sdk = require(POLAR_SDK_ENTRY);
  const secret = 'beatgaler-polar-sdk-contract-secret';
  const webhookId = 'msg_beatgaler_contract';
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type: 'product.created', timestamp: new Date().toISOString(), data: {} });
  const headers = signWebhook({ body, secret, webhookId, timestamp });

  const event = await sdk.webhooks.validateEvent(body, headers, secret);
  assert.equal(event.type, 'product.created');

  await assert.rejects(
    () => sdk.webhooks.validateEvent(`${body} `, headers, secret),
    error => error && /signature|matching/i.test(String(error.message || error)),
  );
});
