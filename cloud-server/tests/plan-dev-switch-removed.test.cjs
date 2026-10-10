'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
