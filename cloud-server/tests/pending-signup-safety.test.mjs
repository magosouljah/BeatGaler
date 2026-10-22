import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPendingSignupService } = require('../pending-signup-service');
const { digest } = require('../pending-signup-runtime');
const { retryDelay, createAuthDeliveryWorker } = require('../auth-delivery-worker');
const { statusForError, publicError, shouldOwnRegister, installPendingSignupBoundary } = require('../pending-signup-boundary');

function poolWithClient(queryImpl) {
  const client = {
    released: false,
    async query(sql, params) { return queryImpl(String(sql), params || []); },
    release() { this.released = true; },
  };
  return {
    client,
    pool: {
      async connect() { return client; },
      async query(sql, params) { return queryImpl(String(sql), params || []); },
    },
  };
}

assert.equal(shouldOwnRegister({ NODE_ENV: 'production' }), true);
assert.equal(shouldOwnRegister({ NODE_ENV: 'development' }), true);
assert.equal(shouldOwnRegister({ NODE_ENV: 'development', BEATGALER_PENDING_SIGNUP_ENABLED: '1' }), true);
assert.equal(shouldOwnRegister({ NODE_ENV: 'development', BEATGALER_PUBLIC_REGISTRATION: '1' }), true);
assert.equal(statusForError({ code: 'SIGNUP_RESEND_COOLDOWN' }), 429);
assert.equal(statusForError({ code: 'SIGNUP_CHALLENGE_INVALID' }), 400);
assert.equal(statusForError({ code: 'SIGNUP_EXPIRED' }), 410);
assert.equal(statusForError({ code: 'DATABASE_PASSWORD=secret' }), 503);
assert.equal(publicError({ code: 'DATABASE_PASSWORD=secret', message: 'postgres://secret' }).error, 'Account creation is temporarily unavailable.');

{
  let createCalls = 0;
  const queries = [];
  const { pool, client } = poolWithClient(async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM users')) return { rows: [] };
    if (sql.includes('FROM pending_signups')) return { rows: [] };
    return { rows: [] };
  });
  const runtime = {
    async create(input) { createCalls += 1; return { signup_id: 'psu_1', continuation_secret: 'sc_1', status: 'DELIVERY_PENDING', input }; },
    resend() {}, verify() {}, status() {}, claimActivation() {}, setActivationState() {}, claimDelivery() {}, completeDelivery() {},
  };
  const service = createPendingSignupService({ pool, runtime, env: { BEATGALER_SIGNUP_PEPPER: 'p'.repeat(32) } });
  const result = await service.begin({ email: ' Person@Example.com ', usernameBase: 'person', password: 'password-123' });
  assert.equal(result.created, true);
  assert.equal(result.signup_id, 'psu_1');
  assert.equal(createCalls, 1);
  assert.equal(queries.some(sql => sql.includes('pg_advisory_lock')), true);
  assert.equal(queries.some(sql => sql.includes('pg_advisory_unlock')), true);
  assert.equal(client.released, true);
}

{
  let createCalls = 0;
  const future = new Date(Date.now() + 60_000);
  const { pool } = poolWithClient(async (sql) => {
    if (sql.includes('FROM users')) return { rows: [] };
    if (sql.includes('FROM pending_signups')) return { rows: [{ id: 'psu_existing', status: 'CODE_SENT', expires_at: future }] };
    return { rows: [] };
  });
  const runtime = {
    async create() { createCalls += 1; throw new Error('must not overwrite pending signup'); },
    resend() {}, verify() {}, status() {}, claimActivation() {}, setActivationState() {}, claimDelivery() {}, completeDelivery() {},
  };
  const service = createPendingSignupService({ pool, runtime, env: { BEATGALER_SIGNUP_PEPPER: 'p'.repeat(32) } });
  const result = await service.begin({ email: 'same@example.com', usernameBase: 'same', password: 'password-123' });
  assert.equal(result.created, false);
  assert.equal(result.reason, 'pending_exists');
  assert.equal(createCalls, 0);
}

{
  const pepper = 'p'.repeat(32);
  const now = 1_000_000;
  let resendCalls = 0;
  const row = {
    id: 'psu_cooldown',
    status: 'CODE_SENT',
    continuation_hash: digest(pepper, 'continuation', 'sc_good'),
    last_requested_at: new Date(now - 5_000),
  };
  const { pool } = poolWithClient(async (sql) => {
    if (sql.startsWith('SELECT * FROM pending_signups')) return { rows: [row] };
    return { rows: [] };
  });
  const runtime = {
    async resend() { resendCalls += 1; },
    create() {}, verify() {}, status() {}, claimActivation() {}, setActivationState() {}, claimDelivery() {}, completeDelivery() {},
  };
  const service = createPendingSignupService({
    pool,
    runtime,
    env: { BEATGALER_SIGNUP_PEPPER: pepper, BEATGALER_SIGNUP_RESEND_COOLDOWN_MS: '60000' },
    now: () => now,
  });
  await assert.rejects(
    service.resend({ signupId: row.id, continuationSecret: 'sc_good' }),
    error => error?.code === 'SIGNUP_RESEND_COOLDOWN' && Number(error.retryAfterMs) === 55_000,
  );
  assert.equal(resendCalls, 0);
}

{
  const pepper = 'p'.repeat(32);
  const now = 2_000_000;
  let resendCalls = 0;
  const queries = [];
  const row = {
    id: 'psu_ready',
    status: 'CODE_SENT',
    continuation_hash: digest(pepper, 'continuation', 'sc_good'),
    last_requested_at: new Date(now - 120_000),
  };
  const { pool } = poolWithClient(async (sql) => {
    queries.push(sql);
    if (sql.startsWith('SELECT * FROM pending_signups')) return { rows: [row] };
    return { rows: [] };
  });
  const runtime = {
    async resend(input) { resendCalls += 1; return { status: 'DELIVERY_PENDING', signup_id: input.signupId }; },
    create() {}, verify() {}, status() {}, claimActivation() {}, setActivationState() {}, claimDelivery() {}, completeDelivery() {},
  };
  const service = createPendingSignupService({
    pool,
    runtime,
    env: { BEATGALER_SIGNUP_PEPPER: pepper, BEATGALER_SIGNUP_RESEND_COOLDOWN_MS: '60000' },
    now: () => now,
  });
  const result = await service.resend({ signupId: row.id, continuationSecret: 'sc_good' });
  assert.equal(result.status, 'DELIVERY_PENDING');
  assert.equal(resendCalls, 1);
  assert.equal(queries.some(sql => sql.includes('last_requested_at=now()')), true);
  assert.equal(queries.includes('COMMIT'), true);
}

assert.equal(retryDelay(1), 60_000);
assert.equal(retryDelay(2), 120_000);
assert.equal(retryDelay(7), 3_600_000);
assert.equal(retryDelay(100), 3_600_000);

{
  const calls = [];
  const service = {
    async requeueStaleDeliveries() { calls.push(['requeue']); return 0; },
    async claimDelivery() {
      calls.push(['claim']);
      return {
        row: { id: 'out_1', kind: 'signup_verification', attempt_count: 1 },
        secret: { email: 'person@example.com', manual_code: '12345678', expires_at: '2026-10-21T22:00:00.000Z' },
      };
    },
    async completeDelivery(id, result) { calls.push(['complete', id, result]); },
  };
  const worker = createAuthDeliveryWorker({
    service,
    emailNotifier: async message => calls.push(['email', message]),
    logger: { warn() {}, error() {} },
  });
  const worked = await worker.runOnce();
  assert.equal(worked, true);
  assert.equal(calls[0][0], 'requeue');
  assert.equal(calls[1][0], 'claim');
  assert.equal(calls[2][0], 'email');
  assert.equal(calls[2][1].token, '12345678');
  assert.deepEqual(calls[3], ['complete', 'out_1', { ok: true }]);
}

{
  const completions = [];
  const service = {
    async requeueStaleDeliveries() { return 0; },
    async claimDelivery() {
      return {
        row: { id: 'out_fail', kind: 'signup_verification', attempt_count: 2 },
        secret: { email: 'person@example.com', manual_code: '12345678', expires_at: '2026-10-21T22:00:00.000Z' },
      };
    },
    async completeDelivery(id, result) { completions.push([id, result]); },
  };
  const worker = createAuthDeliveryWorker({
    service,
    emailNotifier: async () => { throw Object.assign(new Error('provider down'), { code: 'SES_TIMEOUT' }); },
    logger: { warn() {}, error() {} },
  });
  await worker.runOnce();
  assert.equal(completions.length, 1);
  assert.equal(completions[0][0], 'out_fail');
  assert.equal(completions[0][1].ok, false);
  assert.equal(completions[0][1].errorCode, 'SES_TIMEOUT');
  assert.equal(completions[0][1].retryDelayMs, 120_000);
}

{
  const routes = new Map();
  const app = { post(path, ...handlers) { routes.set(path, handlers); return this; } };
  let activations = 0;
  installPendingSignupBoundary({ application: app }, {
    service: { async status() { return { status: 'VERIFIED' }; } },
    activation: async () => { activations += 1; return { status: 'ACTIVE', account: { token: 'session', user: { id: 'usr_1' } } }; },
    env: { BEATGALER_PUBLIC_REGISTRATION: '0' },
  });
  app.post('/auth/register', () => {});
  const result = await new Promise(resolve => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve(body); } };
    routes.get('/auth/signup/status')[0]({ body: { signup_id: 'psu_1', continuation_secret: 'secret' } }, res);
  });
  assert.equal(activations, 1);
  assert.equal(result.signup_pending, false);
  assert.equal(result.user.id, 'usr_1');
  assert.equal(result.token, 'session');
}

{
  const routes = new Map();
  const app = { post(route, ...handlers) { routes.set(route, handlers); return this; } };
  let current = 'PROVISIONING';
  const calls = [];
  installPendingSignupBoundary({ application: app }, {
    service: { async status() { return { status: current }; } },
    activation: async () => { calls.push(current); return current === 'PROVISIONING'
      ? { status: 'PROVISIONING', signup_pending: true }
      : { status: 'ACTIVE', session_required: true }; },
    env: { BEATGALER_PUBLIC_REGISTRATION: '0' },
  });
  app.post('/auth/register', () => {});
  async function poll() {
    return new Promise(resolve => {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve(body); } };
      routes.get('/auth/signup/status')[0]({ body: { signup_id: 'psu_1', continuation_secret: 'secret' } }, res);
    });
  }
  assert.equal((await poll()).signup_pending, true);
  current = 'RETRYABLE';
  assert.equal((await poll()).status, 'ACTIVE');
  assert.deepEqual(calls, ['PROVISIONING', 'RETRYABLE'], 'polling must reach activation after a stale crash');
}

{
  const routes = new Map();
  const app = { post(path, ...handlers) { routes.set(path, handlers); return this; } };
  let statusInput = null;
  installPendingSignupBoundary({ application: app }, {
    service: {
      async begin() { return { created: true, signup_id: 'psu_web', continuation_secret: 'private-secret', status: 'CODE_SENT', expires_at: new Date(Date.now() + 60_000).toISOString() }; },
      async status(input) { statusInput = input; return { status: 'CODE_SENT' }; },
    },
    env: { BEATGALER_PUBLIC_REGISTRATION: '1' },
  });
  app.post('/auth/register', () => {});
  const headers = new Map();
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    json(body) { this.body = body; return this; } });
  const registered = response();
  await routes.get('/auth/register')[0]({ headers: { 'x-beatgaler-client': 'web' }, body: {} }, registered);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registered.body.continuation_secret, undefined);
  const cookie = headers.get('set-cookie')[0];
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  const checked = response();
  await routes.get('/auth/signup/status')[0]({ headers: { 'x-beatgaler-client': 'web', cookie: cookie.split(';')[0] }, body: {} }, checked);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statusInput, { signupId: 'psu_web', continuationSecret: 'private-secret' });
}

{
  const routes = new Map();
  const app = { post(path, ...handlers) { routes.set(path, handlers); return this; } };
  let verifiedInput;
  installPendingSignupBoundary({ application: app }, {
    service: {
      async begin() { return { created: true, signup_id: 'psu_web', continuation_secret: 'private-secret',
        status: 'CODE_SENT', expires_at: new Date(Date.now() + 60_000).toISOString() }; },
      async verify(input) { verifiedInput = input; return { status: 'VERIFIED', verified: true }; },
    },
    activation: async () => ({ status: 'ACTIVE', account: { token: 'session', user: { id: 'usr_1' } } }),
    env: { BEATGALER_PUBLIC_REGISTRATION: '1' },
  });
  app.post('/auth/register', () => {});
  const response = () => {
    const headers = new Map();
    return { statusCode: 200, status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
      getHeader(name) { return headers.get(String(name).toLowerCase()); },
      json(body) { this.body = body; return this; } };
  };
  const registered = response();
  await routes.get('/auth/register')[0]({ headers: { 'x-beatgaler-client': 'web' }, body: {} }, registered);
  await new Promise(resolve => setImmediate(resolve));
  const cookie = registered.getHeader('Set-Cookie')[0].split(';')[0];
  const activated = response();
  await routes.get('/auth/signup/verify')[0]({ headers: { 'x-beatgaler-client': 'web', cookie }, body: { code: '12345678' } }, activated);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(verifiedInput, { signupId: 'psu_web', continuationSecret: 'private-secret', challenge: '12345678' });
  assert.equal(activated.body.user.id, 'usr_1');
  assert.equal(activated.body.continuation_secret, undefined);
  assert.match(activated.getHeader('Set-Cookie')[0], /Max-Age=0/);
}

console.log('pending-signup-safety tests: PASS');
