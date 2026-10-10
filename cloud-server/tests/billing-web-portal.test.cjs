'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingPortalService, BillingPortalError } = require('../billing-web-portal-runtime');
const { createPortalHandler } = require('../billing-web-portal-route');

function fixture({ row = { provider_customer_id: 'cus_1', external_id: 'user_1' },
  remote = { id: 'cus_1', external_id: 'user_1' },
  portalUrl = 'https://sandbox.polar.sh/portal/session' } = {}) {
  const calls = [];
  const pool = { async query(sql, params) { calls.push(['query', params]); return { rows: row ? [row] : [] }; } };
  const adapter = {
    provider: 'polar', environment: 'sandbox',
    async getCustomerByExternalId(id) { calls.push(['get', id]); return remote; },
    async createCustomerPortal(input) { calls.push(['portal', input]); return { url: portalUrl }; },
  };
  return { calls, pool, adapter };
}

test('portal binds local and remote customer identity and owns return URL', async () => {
  const f = fixture();
  const service = createBillingPortalService({ ...f, env: { NODE_ENV: 'production' } });
  assert.deepEqual(await service.createSession('user_1'), { url: 'https://sandbox.polar.sh/portal/session' });
  assert.deepEqual(f.calls, [
    ['query', ['user_1', 'sandbox']], ['get', 'user_1'],
    ['portal', { userId: 'user_1', returnUrl: 'https://beatgaler.com/?billing=return' }],
  ]);
});

test('missing or mismatched customer never creates a portal session', async () => {
  for (const options of [{ row: null }, { row: { provider_customer_id: 'cus_1', external_id: 'user_2' } },
    { remote: { id: 'cus_2', external_id: 'user_1' } }, { remote: { id: 'cus_1', external_id: 'user_2' } }]) {
    const f = fixture(options);
    const service = createBillingPortalService({ ...f, env: { NODE_ENV: 'production' } });
    await assert.rejects(service.createSession('user_1'), BillingPortalError);
    assert.equal(f.calls.some(call => call[0] === 'portal'), false);
  }
});

test('portal rejects invalid provider URL and callback origin', async () => {
  for (const portalUrl of ['http://sandbox.polar.sh/portal', 'https://evil.example/portal',
    'https://sandbox.polar.sh.evil.example/portal', 'javascript:alert(1)']) {
    const f = fixture({ portalUrl });
    const service = createBillingPortalService({ ...f, env: { NODE_ENV: 'production' } });
    await assert.rejects(service.createSession('user_1'), { code: 'BILLING_PORTAL_UNAVAILABLE' });
  }
  const f = fixture();
  assert.throws(() => createBillingPortalService({ ...f, env: {
    NODE_ENV: 'production', BILLING_WEB_ORIGIN: 'https://evil.example',
  } }));
});

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.body = value; return this; } };
}

test('portal route enforces auth, empty body, and sanitized failures', async () => {
  let calls = 0;
  const handler = createPortalHandler({ getUser: req => req.user,
    currentPortal: () => ({ async createSession() { calls++; throw new Error('private token'); } }) });
  const unauth = response();
  await handler({ body: {}, user: null }, unauth);
  assert.equal(unauth.statusCode, 401);
  const extra = response();
  await handler({ body: { returnUrl: 'https://evil.example' }, user: { id: 'user_1' } }, extra);
  assert.equal(extra.statusCode, 400);
  assert.equal(calls, 0);
  const failed = response();
  await handler({ body: {}, user: { id: 'user_1' } }, failed);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.error.includes('private'), false);
  assert.equal(failed.headers['Cache-Control'], 'no-store');
});
