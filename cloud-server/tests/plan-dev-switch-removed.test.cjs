'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCheckoutHandlers } = require('../billing-web-checkout-route');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('no production route, security exception, helper or local startup flag can simulate plan changes', () => {
  const server = read('cloud-server/server-core.js');
  const session = read('cloud-server/session-security.js');
  const plans = read('cloud-server/plans.js');
  const startup = read('start-beatgaler-cloud.ps1');
  for (const source of [server, session, plans, startup]) {
    assert.doesNotMatch(source, /\/plans\/dev-switch|BEATGALER_DEV_PLAN_SWITCH|setBasePlanForUser/);
  }
  assert.match(server, /app\.post\("\/billing\/checkout", webCheckoutHandlers\.create\)/);
  assert.match(server, /app\.get\("\/plans\/me", createPlanMeHandler/);
  assert.doesNotMatch(server, /req\.body\?\.plan_id|req\.body\.plan_id/);
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
