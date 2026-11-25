'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCheckoutHandlers } = require('../billing-web-checkout-route');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('the running Cloud has no route, env switch or caller-selected plan to simulate plan changes', async () => {
  const { account, withCloud } = require('./helpers/composition-cloud.cjs');
  const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1', host: '127.0.0.1' };
  await withCloud(async (_app, send) => {
    const login = await send('POST', '/auth/login', {
      headers: browser,
      body: { email: account.email, password: account.password, beatgalerUserId: account.beatgalerUserId },
    });
    assert.equal(login.status, 200);
    const session = {
      ...browser,
      cookie: login.headers['set-cookie'].map(cookie => cookie.split(';', 1)[0]).join('; '),
      'x-beatgaler-csrf': JSON.parse(login.data).csrf_token,
      'x-beatgaler-installation-id': account.beatgalerUserId,
    };
    const plan = async () => JSON.parse((await send('GET', '/plans/me?plan_id=paid', { headers: session })).data).plan;
    const before = await plan();
    assert.equal(before.base_plan_id, 'free');

    for (const headers of [session, browser]) {
      const response = await send('POST', '/plans/dev-switch', { headers, body: { plan_id: 'paid' } });
      assert.equal(response.status, 404, 'no handler may exist for /plans/dev-switch, with or without a session');
    }
    assert.deepEqual(await plan(), before, 'neither the removed route nor a plan_id query may change the plan');

    const selected = await send('POST', '/billing/checkout', {
      headers: session,
      body: { offerId: 'annual_offer', requestId: 'request_test', plan_id: 'paid' },
    });
    assert.equal(selected.status, 400);
    assert.equal(JSON.parse(selected.data).code, 'BILLING_CHECKOUT_INVALID_REQUEST');
    const offer = await send('POST', '/billing/checkout', { headers: session, body: { offerId: 'annual_offer', requestId: 'request_test' } });
    assert.equal(offer.status, 503, 'the real checkout route stays mounted behind its provider');
    assert.equal(JSON.parse(offer.data).code, 'BILLING_CHECKOUT_UNAVAILABLE');
    assert.equal((await send('POST', '/billing/checkout', { headers: browser, body: {} })).status, 401);
    assert.deepEqual(await plan(), before);
  }, { prepare() { process.env.BEATGALER_DEV_PLAN_SWITCH = '1'; } });
});

test('no helper or local startup flag can simulate plan changes', () => {
  const session = read('cloud-server/session-security.js');
  const plans = read('cloud-server/plans.js');
  const startup = read('start-beatgaler-cloud.ps1');
  for (const source of [session, plans, startup]) {
    assert.doesNotMatch(source, /\/plans\/dev-switch|BEATGALER_DEV_PLAN_SWITCH|setBasePlanForUser/);
  }
});

test('client exposes only real checkout and no simulated commercial plan control', () => {
  const accountGate = read('src/components/AccountGate.tsx');
  const settings = read('src/components/SettingsPanel.tsx');
  for (const source of [accountGate, settings]) {
    assert.doesNotMatch(source, /devSwitchBeatGalerPlan|\/plans\/dev-switch|switchPlanForTesting|BEATGALER_DEV_PLAN_SWITCH/);
  }
  assert.doesNotMatch(settings, /Switch to Free|Buttons simulate plan changes|Simulate subscription/);
  assert.match(settings, /startBeatGalerCheckout\(plan\.price\.offer_id, requestId\)/);
  assert.match(settings, /currentPlan\?\.effective_plan_id === plan\.id/);
});

test('checkout rejects a caller-selected plan before starting a checkout session', async t => {
  const user = { id: 'usr_test', email: 'listener@example.test' };
  const checkout = { state: 'OPEN' };
  const createSession = t.mock.fn(async () => checkout);
  const currentCheckout = t.mock.fn(() => ({ service: { createSession } }));
  const { create } = createCheckoutHandlers({ getUser: () => user, currentCheckout });
  const response = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const offerRequest = { offerId: 'annual_offer', requestId: 'request_test' };

  const rejected = response();
  await create({ body: { ...offerRequest, plan_id: 'paid' } }, rejected);
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.code, 'BILLING_CHECKOUT_INVALID_REQUEST');
  assert.equal(currentCheckout.mock.callCount(), 0);
  assert.equal(createSession.mock.callCount(), 0);

  const accepted = response();
  await create({ body: offerRequest }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.body, { ok: true, checkout });
  assert.equal(createSession.mock.callCount(), 1);
  assert.deepEqual(createSession.mock.calls[0].arguments, [{ user, request: offerRequest }]);
});
