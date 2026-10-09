'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../billing-web-checkout-runtime');

const pool = { connect() {}, query() {} };
const adapter = { provider: 'polar', environment: 'sandbox', createCheckout() {}, getCheckoutOffer() {} };

test('Web checkout uses one server-owned canonical callback origin', () => {
  assert.equal(runtime.callbackOrigin({ NODE_ENV: 'production' }), 'https://beatgaler.com');
  assert.deepEqual(runtime.configure({ pool, adapter, env: { NODE_ENV: 'production' } }), {
    ready: true, failureCode: null,
  });
  assert.deepEqual(runtime.current().callbackUrls, {
    successUrl: 'https://beatgaler.com/?billing=success',
    returnUrl: 'https://beatgaler.com/?billing=return',
  });
});

test('invalid callback origins and provider configuration fail closed', () => {
  for (const origin of ['javascript:alert(1)', 'https://user:pass@evil.example',
    'https://beatgaler.com.evil.example/path', 'https://other.example',
    'http://beatgaler.com', 'https://beatgaler.com/?next=evil']) {
    assert.equal(runtime.configure({ pool, adapter, env: { NODE_ENV: 'production', BILLING_WEB_ORIGIN: origin } }).ready, false);
    assert.equal(runtime.current(), null);
  }
  assert.equal(runtime.configure({ pool, adapter: null, env: { NODE_ENV: 'production' } }).ready, false);
});

test('development callback origin permits only explicit loopback', () => {
  assert.equal(runtime.callbackOrigin({ NODE_ENV: 'development', BILLING_WEB_ORIGIN: 'http://localhost:5173' }), 'http://localhost:5173');
  assert.equal(runtime.callbackOrigin({ NODE_ENV: 'development', BILLING_WEB_ORIGIN: 'https://127.0.0.1:5173' }), 'https://127.0.0.1:5173');
  assert.throws(() => runtime.callbackOrigin({ NODE_ENV: 'development', BILLING_WEB_ORIGIN: 'https://other.example' }));
});
