'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

function withFakeTelegram(fn) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'telegram') return { TelegramClient: class {}, Api: {} };
    if (request === 'telegram/sessions') return { StringSession: class {} };
    if (request === 'telegram/client/uploads') return { CustomFile: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return fn(); }
  finally { Module._load = originalLoad; }
}

let passed = 0;

const plans = require('../plans.js');
passed += test('unknown plan id cannot become an entitlement escalation', () => {
  const user = { planState: { basePlanId: 'admin_ultra', grants: [] } };
  const state = plans.publicPlanState(user, 1_000_000);
  assert.equal(state.effective_plan_id, 'free');
  assert.equal(state.entitlements.upload_project, false);
}) ? 1 : 0;

passed += test('new account receives the configured welcome grant', () => {
  const user = {};
  plans.ensurePlanState(user, { newAccount: true, now: 1_000_000 });
  const state = plans.publicPlanState(user, 1_000_001);
  assert.equal(state.base_plan_id, 'free');
  assert.equal(state.effective_plan_id, 'paid_entry');
  assert.equal(state.access_source, 'welcome');
}) ? 1 : 0;

passed += test('expired temporary grant cannot override base plan', () => {
  const user = { planState: { basePlanId: 'free', grants: [{ planId: 'highest_paid', source: 'test', startsAt: 1, expiresAt: 100 }] } };
  assert.equal(plans.publicPlanState(user, 101).effective_plan_id, 'free');
}) ? 1 : 0;

passed += test('lower temporary grant cannot downgrade a higher base plan', () => {
  const user = { planState: { basePlanId: 'highest_paid', grants: [{ planId: 'paid_entry', source: 'test', startsAt: 1, expiresAt: 9999 }] } };
  assert.equal(plans.publicPlanState(user, 100).effective_plan_id, 'highest_paid');
}) ? 1 : 0;

passed += test('invalid base plan assignment is rejected', () => {
  assert.throws(() => plans.setBasePlanForUser({}, 'owner'), /Unknown BeatGaler plan/);
}) ? 1 : 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-direct-unit-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
fs.writeFileSync(poolFile, JSON.stringify({ bots: [
  { id: 'Bot01', token: 'fake-1' },
  { id: 'Bot02', token: 'fake-2' },
  { id: 'Bot03', token: 'fake-3' },
] }));
process.env.TRANSPORT_BOTS_FILE = poolFile;
process.env.TRANSPORT_POOL_STATE = stateFile;
process.env.DIRECT_DIAGNOSTICS_DIR = path.join(tmp, 'diag');
process.env.BEATGALER_DIRECT_TRANSPORT = 'false';
process.env.DIRECT_TOKEN_ROTATION_ENABLED = 'false';
process.env.DIRECT_HEARTBEAT_INTERVAL_MS = '60000';
process.env.DIRECT_HEARTBEAT_TIMEOUT_MS = '300000';

const direct = withFakeTelegram(() => require('../direct-transport-control.js'));
const pool = [
  { id: 'Bot01', token: 'fake-1' },
  { id: 'Bot02', token: 'fake-2' },
  { id: 'Bot03', token: 'fake-3' },
];

passed += test('Direct defaults keep token rotation disabled during normal sessions', () => {
  assert.equal(direct.TOKEN_ROTATION_ENABLED, false);
}) ? 1 : 0;

passed += test('Direct heartbeat contract remains 60 seconds / 5 minutes', () => {
  const status = direct.poolStatus();
  assert.equal(status.heartbeat_interval_ms, 60_000);
  assert.equal(status.heartbeat_timeout_ms, 300_000);
}) ? 1 : 0;

passed += test('fair pool gives every bot one vault before any bot gets a second', () => {
  fs.rmSync(stateFile, { force: true });
  const picks = [];
  for (let i = 0; i < 6; i += 1) {
    const result = direct.__test.leaseNextBot(pool, { installation_id: `install-${i}`, chat_id: `vault-${i}` });
    picks.push(result.bot.id);
  }
  assert.deepEqual(picks.slice(0, 3), ['Bot01', 'Bot02', 'Bot03']);
  assert.deepEqual(picks.slice(3, 6), ['Bot01', 'Bot02', 'Bot03']);
}) ? 1 : 0;

passed += test('minimum-load tier wins even when queue head has more vaults', () => {
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 4,
    queue: ['Bot01', 'Bot02', 'Bot03'],
    bots: {},
    leases: {
      existing1: { session_id:'existing1', bot_id:'Bot01', installation_id:'a', chat_id:'a', generation:1, credential_version:1, status:'ACTIVE', started_at:new Date().toISOString(), last_heartbeat_at:new Date().toISOString() },
      existing2: { session_id:'existing2', bot_id:'Bot01', installation_id:'b', chat_id:'b', generation:2, credential_version:1, status:'ACTIVE', started_at:new Date().toISOString(), last_heartbeat_at:new Date().toISOString() },
      existing3: { session_id:'existing3', bot_id:'Bot02', installation_id:'c', chat_id:'c', generation:1, credential_version:1, status:'ACTIVE', started_at:new Date().toISOString(), last_heartbeat_at:new Date().toISOString() },
    }, operations:{}, metrics:{}, rotation:{}
  }));
  const result = direct.__test.leaseNextBot(pool, { installation_id:'new', chat_id:'new' });
  assert.equal(result.bot.id, 'Bot03');
  assert.equal(result.loadBefore, 0);
}) ? 1 : 0;

passed += test('quarantined and rotation-pending bots are not assignable', () => {
  fs.writeFileSync(stateFile, JSON.stringify({
    version:4, queue:['Bot01','Bot02','Bot03'],
    bots:{ Bot01:{quarantined:true}, Bot02:{rotation_pending:true}, Bot03:{} },
    leases:{}, operations:{}, metrics:{}, rotation:{}
  }));
  const result = direct.__test.leaseNextBot(pool, { installation_id:'new2', chat_id:'new2' });
  assert.equal(result.bot.id, 'Bot03');
}) ? 1 : 0;

passed += test('pool state normalization deduplicates queue and preserves all configured bots', () => {
  fs.writeFileSync(stateFile, JSON.stringify({ version:4, queue:['Bot01','Bot01','unknown'], bots:{}, leases:{}, operations:{}, metrics:{}, rotation:{} }));
  const state = direct.__test.stateSnapshot(pool);
  assert.deepEqual(state.queue, ['Bot01','Bot02','Bot03']);
}) ? 1 : 0;

const { stripPermanentSecrets } = require('../productive-temp-auth-boundary.js');
const { wrapWebTransportSession } = require('../web-transport-envelope.js');

passed += test('productive transport boundary strips permanent credentials before client response', () => {
  const safe = stripPermanentSecrets({
    ok: true,
    mode: 'telegram-direct-botapi-local',
    session_id: 'session-1',
    transport_id: 'Bot01',
    chat_id: '-100123',
    generation: 7,
    credential_version: 3,
    bot_token: '123456:must-never-reach-client',
    telegram_api_id: 12345,
    telegram_api_hash: 'REDACTED_TELEGRAM_API_HASH',
    credential_envelope: { ciphertext: 'legacy-secret-wrapper' },
  });

  assert.equal(safe.bot_token, undefined);
  assert.equal(safe.telegram_api_id, undefined);
  assert.equal(safe.telegram_api_hash, undefined);
  assert.equal(safe.credential_envelope, undefined);
  assert.equal(safe.session_id, 'session-1');
  assert.equal(safe.transport_id, 'Bot01');
  assert.equal(safe.chat_id, '-100123');
  assert.equal(safe.generation, 7);
  assert.equal(safe.credential_version, 3);
}) ? 1 : 0;

passed += test('legacy Web envelope is inert and cannot create a client credential envelope', () => {
  const session = {
    session_id: 'session-1',
    bot_token: 'server-only',
    telegram_api_id: 12345,
    telegram_api_hash: 'server-only-hash',
  };
  const wrapped = wrapWebTransportSession(session, { kty: 'RSA', n: 'ignored', e: 'AQAB' });
  assert.strictEqual(wrapped, session);
  assert.equal(wrapped.credential_envelope, undefined);
  const source = fs.readFileSync(path.join(__dirname, '..', 'web-transport-envelope.js'), 'utf8');
  assert(!source.includes('publicEncrypt'));
  assert(!source.includes('RSA-OAEP'));
}) ? 1 : 0;

passed += test('canonical Cloud entrypoint installs temporary-auth boundary before route registration', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const installAt = entrySource.indexOf('installProductiveTempAuthBoundary(express)');
  const coreAt = entrySource.indexOf('require("./server-core")');
  assert(installAt >= 0 && coreAt > installAt);

  const boundarySource = fs.readFileSync(path.join(__dirname, '..', 'productive-temp-auth-boundary.js'), 'utf8');
  for (const route of ['/transport/session/start', '/transport/session/heartbeat', '/transport/operation/begin']) {
    assert(boundarySource.includes(route));
  }
  assert(boundarySource.includes('mode: "galer-direct-temp-mtproto"'));
  assert(boundarySource.includes('temp_auth_required'));
}) ? 1 : 0;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`PASS cloud/direct unit tests: ${passed}/14`);
