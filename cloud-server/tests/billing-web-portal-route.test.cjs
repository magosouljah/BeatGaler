'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortalService, createPortalHandlers, portalUrl } = require('../billing-web-portal-route');
const runtime = require('../billing-web-portal-runtime');

function fixture(overrides = {}) {
  const calls = { queries: [], customers: [], sessions: [] };
  const row = {
    provider_subscription_id: 'sub_owned', provider_customer_id: 'cus_owned', ended_at: null,
    owned_customer_id: 'cus_owned', owned_external_id: 'user_owned',
    ...overrides.row,
  };
  const pool = { async query(sql, params) { calls.queries.push({ sql, params }); return { rows: overrides.rows ?? [row] }; } };
  const adapter = {
    provider: 'polar', environment: 'sandbox',
    async getCustomerByExternalId(userId) { calls.customers.push(userId); return Object.hasOwn(overrides, 'customer') ? overrides.customer : { id: 'cus_owned' }; },
    async createCustomerPortal(input) { calls.sessions.push(input); return overrides.session ?? { url: 'https://sandbox.polar.sh/customer-portal/session_token' }; },
  };
  return { service: createPortalService({ pool, adapter, env: { NODE_ENV: 'production' } }), calls };
}

async function invoke(handler, { user = { id: 'user_owned' }, body = {} } = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ body }, res, user);
  return res;
}

test('opens only the authenticated subscriber customer with a canonical return and no access grant', async () => {
  const { service, calls } = fixture();
  const handlers = createPortalHandlers({ getUser: (_req) => ({ id: 'user_owned' }), currentPortal: () => service });
  assert.deepEqual((await invoke(handlers.availability)).body, { ok: true, available: true });
  const response = await invoke(handlers.create);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.portal.url, 'https://sandbox.polar.sh/customer-portal/session_token');
  assert.equal(response.body.portal.entitlementGranted, false);
  assert.deepEqual(calls.queries.map(item => item.params), [
    ['user_owned', 'polar', 'sandbox'], ['user_owned', 'polar', 'sandbox'],
  ]);
  assert.deepEqual(calls.customers, ['user_owned']);
  assert.deepEqual(calls.sessions, [{ userId: 'user_owned', returnUrl: 'https://beatgaler.com/?billing=portal-return' }]);
});

test('no subscription and other tenant subscription cannot open a portal', async () => {
  for (const rows of [[], [{ provider_subscription_id: null, provider_customer_id: null }]]) {
    const { service, calls } = fixture({ rows });
    const handlers = createPortalHandlers({ getUser: () => ({ id: 'user_other' }), currentPortal: () => service });
    assert.deepEqual((await invoke(handlers.availability)).body, { ok: true, available: false });
    const response = await invoke(handlers.create);
    assert.equal(response.statusCode, 404);
    assert.equal(calls.queries[0].params[0], 'user_other');
    assert.equal(calls.sessions.length, 0);
  }
});

test('rejects stale customer ownership, provider identity mismatch and ended subscription', async () => {
  for (const overrides of [
    { row: { owned_external_id: 'user_other' } },
    { row: { owned_customer_id: 'cus_other' } },
    { customer: { id: 'cus_other' } },
    { customer: { id: 'cus_owned', external_id: 'user_other' } },
    { row: { ended_at: new Date(0) } },
    { row: { ended_at: 'invalid-date' } },
  ]) {
    const { service, calls } = fixture(overrides);
    const handlers = createPortalHandlers({ getUser: () => ({ id: 'user_owned' }), currentPortal: () => service });
    const response = await invoke(handlers.create);
    assert.ok([404, 409].includes(response.statusCode));
    assert.equal(calls.sessions.length, 0);
  }
});

test('provider errors, arbitrary request fields and unsafe URLs fail closed', async () => {
  const { service: failed } = fixture({ customer: null });
  const handlers = createPortalHandlers({ getUser: () => ({ id: 'user_owned' }), currentPortal: () => failed });
  assert.equal((await invoke(handlers.create)).statusCode, 409);
  assert.equal((await invoke(handlers.create, { body: { returnUrl: 'https://evil.example' } })).statusCode, 400);
  assert.equal((await invoke(createPortalHandlers({ getUser: () => null, currentPortal: () => failed }).create)).statusCode, 401);
  for (const url of [
    'javascript:alert(1)', 'http://sandbox.polar.sh/customer-portal/x',
    'https://sandbox.polar.sh.evil.example/x', 'https://user:pass@sandbox.polar.sh/x',
    'https://polar.sh/customer-portal/x', 'https://sandbox.polar.sh:8443/x',
  ]) assert.throws(() => portalUrl(url, 'sandbox'));
  assert.equal(portalUrl('https://polar.sh/customer-portal/session_token', 'production'),
    'https://polar.sh/customer-portal/session_token');
  assert.throws(() => portalUrl('https://sandbox.polar.sh/customer-portal/session_token', 'production'));
  const { service: unsafe } = fixture({ session: { url: 'https://evil.example/steal' } });
  assert.equal((await invoke(createPortalHandlers({ getUser: () => ({ id: 'user_owned' }), currentPortal: () => unsafe }).create)).statusCode, 503);
});

test('provider exception and missing runtime expose no provider detail', async () => {
  const handlers = createPortalHandlers({ getUser: () => ({ id: 'user_owned' }), currentPortal: () => ({ create: async () => { throw new Error('private token'); } }) });
  const response = await invoke(handlers.create);
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(response.body), /private token/);
  assert.equal((await invoke(createPortalHandlers({ getUser: () => ({ id: 'user_owned' }), currentPortal: () => null }).create)).statusCode, 503);
});

test('runtime configuration fails closed on invalid origin or missing provider', () => {
  const pool = { query: async () => ({ rows: [] }) };
  const adapter = { provider: 'polar', environment: 'sandbox', getCustomerByExternalId() {}, createCustomerPortal() {} };
  assert.equal(runtime.configure({ pool, adapter, env: { NODE_ENV: 'production', BILLING_WEB_ORIGIN: 'https://evil.example' } }).ready, false);
  assert.equal(runtime.current(), null);
  assert.equal(runtime.configure({ pool, adapter: null, env: { NODE_ENV: 'production' } }).ready, false);
  assert.equal(runtime.configure({ pool, adapter, env: { NODE_ENV: 'production' } }).ready, true);
});
