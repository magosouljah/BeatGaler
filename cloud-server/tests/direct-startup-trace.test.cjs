'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDirectStartupTrace, noDirectStartupTrace } = require('../direct-startup-trace');

test('diagnostics preserve results, errors and the no-trace caller path', async () => {
  const trace = createDirectStartupTrace();
  const result = {};
  assert.equal(await trace.step('STEP', async () => result), result);
  assert.equal(noDirectStartupTrace.step('STEP', () => result), result);
  const error = new Error('private-error-payload');
  await assert.rejects(trace.step('STEP', async () => { throw error; }), value => value === error);
  let header;
  trace.publish({ setHeader(_key, value) { header = value; } }, 'error');
  assert.ok(JSON.parse(header).events.some(event => event.stage === 'STEP_ERROR'));
  assert.doesNotMatch(header, /private-error-payload/);
});

test('headers are bounded, omit credentials and expose lost diagnostic events', () => {
  const trace = createDirectStartupTrace();
  for (let i = 0; i < 80; i++) trace.mark('LEASE_SELECTED', {
    server_lease: 'reused', lease_state: 'ACTIVE', session_id: 'secret', token: 'secret',
  });
  let header;
  trace.publish({ setHeader(_key, value) { header = value; } }, 'done');
  const data = JSON.parse(header);
  assert.ok(data.events.length <= 32);
  assert.equal(data.events.length + data.dropped_events, 80);
  assert.ok(header.length <= 3_000);
  assert.doesNotMatch(header, /secret|session_id|token/);
  assert.doesNotThrow(() => trace.publish({ setHeader() { throw new Error('closed response'); } }, 'done'));
});

test('bounded headers retain the first correlation event and final readiness proof', () => {
  const trace = createDirectStartupTrace();
  trace.mark('SESSION_USER_VAULT', { user_id: 'usr_safe', vault_chat_id: '-10042', channel_id: '42' });
  for (let i = 0; i < 80; i++) trace.mark('STEP', { elapsed_ms: i });
  trace.mark('BOT_MEMBERSHIP_VISIBLE', {
    membership_state: 'bot_visible', membership_source: 'bot_api_getChat',
    transport_id: 'Bot01', expected_bot_id: '8618989421',
  });
  let header;
  trace.publish({ setHeader(_key, value) { header = value; } }, 'done');
  const data = JSON.parse(header);
  assert.equal(data.events[0].stage, 'SESSION_USER_VAULT');
  assert.equal(data.events.at(-1).stage, 'BOT_MEMBERSHIP_VISIBLE');
  assert.equal(data.events.at(-1).membership_state, 'bot_visible');
  assert.ok(header.length <= 3_000);
});
