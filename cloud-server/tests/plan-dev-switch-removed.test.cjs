'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckoutHandlers } = require('../billing-web-checkout-route');


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

test('no module exposes a helper that can simulate plan changes', () => {
  // La ausencia del helper se mide en lo que los módulos exportan, no en su texto fuente.
  // El flag local de arranque (BEATGALER_DEV_PLAN_SWITCH) queda cubierto por el primer test: con el flag activo la ruta responde 404.
  for (const mod of [require('../session-security'), require('../plans')]) {
    for (const name of Object.keys(mod)) assert.doesNotMatch(name, /dev.?switch|setBasePlanForUser/i, `export ${name}`);
    assert.equal(typeof mod.setBasePlanForUser, 'undefined');
  }
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
