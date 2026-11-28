'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAccessRuntime } = require('../access-runtime');
const { createPlanMeHandler, createAccountHandler, accountPublicPayload } = require('../access-consumer-handlers');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86400_000;
const user = { id: 'u1', username: 'producer#0001', email: 'p@example.com', providers: {}, planState: { basePlanId: 'highest_paid', grants: [] } };

async function observe({ subscription = null, grants = [], now = NOW } = {}) {
  const pool = {
    async query(sql, values) {
      assert.deepEqual(values, ['u1']);
      if (sql.includes('billing_subscription_state')) return { rows: subscription ? [subscription] : [] };
      if (sql.includes('entitlements')) return { rows: grants };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const access = createAccessRuntime({ pool, now: () => now });
  const app = express();
  const getUser = () => user;
  const bearerToken = () => 'session';
  app.get('/plans/me', createPlanMeHandler({ getUser, bearerToken, resolveUserPlan: access.resolveUserPlan }));
  app.post('/auth/account', createAccountHandler({ getUser, bearerToken, resolveUserPlan: access.resolveUserPlan, userProvider: () => null, syncIdentity: async () => {} }));
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const [planResponse, accountResponse, direct] = await Promise.all([
      fetch(`${base}/plans/me`),
      fetch(`${base}/auth/account`, { method: 'POST' }),
      access.resolveUserPlan(user),
    ]);
    assert.equal(planResponse.status, 200);
    assert.equal(accountResponse.status, 200);
    const plan = (await planResponse.json()).plan;
    const account = (await accountResponse.json()).user.plan;
    assert.deepEqual(plan, account);
    assert.deepEqual(plan, direct);
    return plan;
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

// The composition helper audits every network attempt in its process.
test('the mounted Cloud serves the same paid access in /plans/me and /auth/account', observeMountedCloud);

test('A/G: resolver, /plans/me and Account share one answer despite stale basePlanId', async () => {
  const plan = await observe();
  assert.equal(plan.effective_plan_id, 'free');
  assert.equal(plan.quotas.max_beats, 20);
  assert.equal(plan.entitlements.upload_project, false);
  assert.equal(plan.access.effectivePlanId, 'free');
  assert.equal(plan.initial_checkout_allowed, true);
});

test('B: Free plus welcome grant is Paid Entry everywhere', async () => {
  const plan = await observe({ grants: [{ id: 'welcome', source: 'welcome', source_key: 'internal-secret', plan_id: 'paid_entry', starts_at: NOW - DAY, expires_at: NOW + 6 * DAY }] });
  assert.equal(plan.effective_plan_id, 'paid_entry');
  assert.equal(plan.quotas.max_beats, 100);
  assert.equal(plan.entitlements.upload_project, true);
  assert.equal(plan.access.accessSources[1].source, 'welcome');
  assert.equal(JSON.stringify(plan).includes('internal-secret'), false);
});

test('a legitimate server-side support grant remains effective independently of client and old flag', async () => {
  const previous = process.env.BEATGALER_DEV_PLAN_SWITCH;
  process.env.BEATGALER_DEV_PLAN_SWITCH = '1';
  try {
    const free = await observe();
    assert.equal(free.effective_plan_id, 'free');
    const granted = await observe({ grants: [{ id: 'support', source: 'support', plan_id: 'highest_paid', starts_at: NOW - DAY, expires_at: NOW + DAY }] });
    assert.equal(granted.effective_plan_id, 'highest_paid');
  } finally {
    if (previous === undefined) delete process.env.BEATGALER_DEV_PLAN_SWITCH;
    else process.env.BEATGALER_DEV_PLAN_SWITCH = previous;
  }
});

test('C/D: paid and cancel-at-period-end remain Paid until paid_through', async () => {
  const subscription = { plan_id: 'highest_paid', status: 'canceled', paid_through: NOW + DAY, cancel_at_period_end: true };
  const current = await observe({ subscription });
  assert.equal(current.effective_plan_id, 'highest_paid');
  assert.equal(current.access.billing.cancelAtPeriodEnd, true);
  const ended = await observe({ subscription, now: NOW + DAY });
  assert.equal(ended.effective_plan_id, 'free');
});

test('a confirmed paid period outlasting welcome is the displayed access window', async () => {
  const plan = await observe({
    subscription: { plan_id: 'paid_entry', status: 'active', paid_through: NOW + 30 * DAY },
    grants: [{ id: 'welcome', source: 'welcome', plan_id: 'paid_entry', starts_at: NOW - DAY, expires_at: NOW + 6 * DAY }],
  });
  assert.equal(plan.effective_plan_id, 'paid_entry');
  assert.equal(plan.effective_until, NOW + 30 * DAY);
  assert.equal(plan.access_source, 'paid');
});

test('E: grace has one temporal access state and quota', async () => {
  const subscription = { plan_id: 'paid_entry', status: 'past_due', paid_through: NOW - DAY, past_due_at: NOW - DAY, grace_until: NOW + 6 * DAY, next_plan_id: 'highest_paid', next_plan_effective_at: NOW + DAY };
  const plan = await observe({ subscription });
  assert.equal(plan.effective_plan_id, 'paid_entry');
  assert.equal(plan.access.commercialAccessState, 'grace');
  assert.equal(plan.access.billing.nextPlanId, 'highest_paid');
  assert.equal(plan.quotas.max_beats, 100);
});

test('initial checkout availability follows the live subscription row without exposing provider IDs', async () => {
  const subscription = { plan_id: 'paid_entry', status: 'active', provider_subscription_id: 'private_sub', paid_through: NOW + DAY };
  const active = await observe({ subscription });
  assert.equal(active.initial_checkout_allowed, false);
  assert.equal(JSON.stringify(active).includes('private_sub'), false);
  const ended = await observe({ subscription: { ...subscription, ended_at: NOW - DAY }, now: NOW + DAY });
  assert.equal(ended.initial_checkout_allowed, true);
});

test('F: revoked and expired grants cannot grant access', async () => {
  const grants = [
    { id: 'revoked', source: 'support', plan_id: 'highest_paid', starts_at: NOW - DAY, expires_at: NOW + DAY, revoked_at: NOW - 1 },
    { id: 'expired', source: 'welcome', plan_id: 'paid_entry', starts_at: NOW - 8 * DAY, expires_at: NOW - DAY },
  ];
  const plan = await observe({ grants });
  assert.equal(plan.effective_plan_id, 'free');
  assert.equal(plan.access.accessSources.length, 1);
});

test('a PostgreSQL read failure never falls back to stale Auth planState', async () => {
  const access = createAccessRuntime({ pool: { async query() { throw new Error('database unavailable'); } }, now: () => NOW });
  await assert.rejects(access.resolveUserPlan(user), /database unavailable/);
});

test('Account serializer and catalog use resolved Access', async () => {
  const access = createAccessRuntime({ pool: { query: async () => ({ rows: [] }) }, now: () => NOW });
  const payload = await accountPublicPayload(user, 'session', { resolveUserPlan: access.resolveUserPlan, userProvider: () => null });
  assert.equal(payload.user.plan.effective_plan_id, 'free');
  assert.equal(payload.user.plan.base_plan_id, 'free');
  const catalog = access.planCatalog();
  assert.equal(catalog.find(plan => plan.id === 'paid_entry').quotas.max_project_zip_bytes, 1_000_000_000);
  assert.equal(Object.hasOwn(catalog[0].quotas, 'max_active_devices'), false);
});

async function observeMountedCloud(t) {
  const access = require('../access-runtime');
  const configureAccess = t.mock.method(access, 'configure');
  await withCloud(async (_app, send) => {
    const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' };
    async function json(method, url, options = {}) {
      const response = await send(method, url, options);
      assert.equal(response.status, 200, `${method} ${url}`);
      return JSON.parse(response.data);
    }

    const login = await send('POST', '/auth/login', {
      headers: browser,
      body: { email: account.email, password: account.password, beatgalerUserId: account.beatgalerUserId },
    });
    assert.equal(login.status, 200);
    const headers = {
      ...browser,
      cookie: login.headers['set-cookie'].map(cookie => cookie.split(';', 1)[0]).join('; '),
      'x-beatgaler-csrf': JSON.parse(login.data).csrf_token,
      'x-beatgaler-installation-id': account.beatgalerUserId,
    };

    const legacy = await json('GET', '/plans/catalog', { headers });
    assert.ok(legacy.plans.some(plan => plan.id === 'free'));
    assert.equal(Object.hasOwn(legacy.plans[0], 'price'), false);
    const defaultAccess = await json('GET', '/plans/me', { headers });
    assert.equal(defaultAccess.plan.effective_plan_id, 'free');
    assert.deepEqual(configureAccess.mock.calls.map(call => call.arguments), [[{ pool: null }]]);

    // The composition helper boots JSON mode. Feed the mounted consumers a
    // projected subscription without opening PostgreSQL or configuring Polar.
    const grants = require('../access-grant-runtime');
    const paidThrough = Date.now() + DAY;
    const pool = {
      async query(sql, values) {
        assert.deepEqual(values, [account.id]);
        if (sql.includes('billing_subscription_state')) {
          return { rows: [{ plan_id: 'paid_entry', status: 'active', paid_through: paidThrough }] };
        }
        assert.match(sql, /FROM entitlements/);
        return { rows: [] };
      },
    };
    access.configure({ pool });
    grants.configure({ pool, authRuntime: {} });
    try {
      const { plan } = await json('GET', '/plans/me', { headers });
      const { user: accountUser } = await json('POST', '/auth/account', { headers, body: {} });
      assert.equal(plan.effective_plan_id, 'paid_entry');
      assert.equal(plan.access_source, 'paid');
      assert.deepEqual(accountUser.plan, plan);

      const webCatalog = await json('GET', '/plans/catalog', { headers });
      const entry = webCatalog.plans.find(plan => plan.id === 'paid_entry');
      assert.equal(entry.price.amount_minor, 699);
      assert.equal(entry.checkout_available, false);
    } finally {
      grants.configure();
      access.configure();
    }
  });
}
