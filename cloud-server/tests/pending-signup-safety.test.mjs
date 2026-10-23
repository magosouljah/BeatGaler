import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPendingSignupService } = require('../pending-signup-service');
const { hashPassword } = require('../password-kdf');
const {
  createPendingSignupRuntime,
  digest,
  normalizeManualCode,
} = require('../pending-signup-runtime');
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
assert.equal(statusForError({ code: 'SIGNUP_CODE_FORMAT_INVALID' }), 400);
assert.match(publicError({ code: 'SIGNUP_CODE_FORMAT_INVALID' }).error, /six-digit code/);
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
  const salt = 'ab'.repeat(16);
  const future = new Date(Date.now() + 60_000);
  const hash = await hashPassword('original-password', salt);
  const row = { id: 'psu_reclaim', status: 'CODE_SENT', expires_at: future,
    challenge_expires_at: future, password_hash: hash, password_salt: salt, resend_count: 2 };
  let createCalls = 0;
  let updateCalls = 0;
  const { pool } = poolWithClient(async (sql, params) => {
    if (sql.includes('FROM users')) return { rows: [] };
    if (sql.includes('FROM pending_signups')) return { rows: [row] };
    if (sql.includes('SET continuation_hash=')) {
      updateCalls += 1;
      assert.equal(params[0], row.id);
      assert.notEqual(params[1], digest(pepper, 'continuation', 'old-secret'));
      assert.equal(sql.includes('resend_count='), false, 'reclaim must preserve resend limits');
      return { rows: [row] };
    }
    return { rows: [] };
  });
  const runtime = { async create() { createCalls += 1; throw new Error('must not create a duplicate'); } };
  const service = createPendingSignupService({ pool, runtime, env: { BEATGALER_SIGNUP_PEPPER: pepper } });
  const wrong = await service.begin({ email: 'same@example.com', password: 'wrong-password' });
  assert.equal(wrong.created, false);
  assert.equal(updateCalls, 0);
  const recovered = await service.begin({ email: 'same@example.com', password: 'original-password' });
  assert.equal(recovered.created, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.signup_id, row.id);
  assert.match(recovered.continuation_secret, /^sc_/);
  assert.equal(recovered.status, 'CODE_SENT');
  assert.equal(updateCalls, 1);
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
  const pepper = 'p'.repeat(32);
  const now = 1_000_000;
  for (const challenge of ['123-456', '123456', '123 456']) {
    const row = {
      id: `psu_verify_${challenge.replace(/\D/g, '_')}`,
      status: 'CODE_SENT',
      continuation_hash: digest(pepper, 'continuation', 'sc_good'),
      link_token_hash: digest(pepper, 'link', 'sv_unrelated'),
      manual_code_hash: digest(pepper, 'code', '123456'),
      challenge_failures: 0,
      challenge_expires_at: new Date(now + 60_000),
      expires_at: new Date(now + 120_000),
    };
    let failureUpdates = 0;
    const { pool } = poolWithClient(async sql => {
      if (sql.startsWith('SELECT * FROM pending_signups')) return { rows: [row] };
      if (sql.includes('SET challenge_failures=')) failureUpdates += 1;
      if (sql.includes("SET status='VERIFIED'")) {
        return { rows: [{ ...row, status: 'VERIFIED', verified_at: new Date(now) }] };
      }
      return { rows: [] };
    });
    const runtime = createPendingSignupRuntime({
      pool,
      keyring: { key: Buffer.alloc(32, 7), keyVersion: 1 },
      env: { BEATGALER_SIGNUP_PEPPER: pepper },
      now: () => now,
    });
    const verified = await runtime.verify({ signupId: row.id, continuationSecret: 'sc_good', challenge });
    assert.equal(verified.status, 'VERIFIED');
    assert.equal(failureUpdates, 0, `${challenge} must verify against the canonical six digits`);
  }
}

{
  const pepper = 'p'.repeat(32);
  const now = 2_000_000;
  const oldLinkHash = digest(pepper, 'link', 'sv_old');
  const oldCodeHash = digest(pepper, 'code', '654321');
  let row = {
    id: 'psu_resend',
    email_normalized: 'person@example.com',
    status: 'CODE_SENT',
    continuation_hash: digest(pepper, 'continuation', 'sc_good'),
    link_token_hash: oldLinkHash,
    manual_code_hash: oldCodeHash,
    challenge_failures: 0,
    challenge_expires_at: new Date(now + 60_000),
    resend_count: 0,
    last_sent_at: null,
    expires_at: new Date(now + 24 * 60 * 60_000),
  };
  let outboxParams;
  let randomCalls = 0;
  const { pool } = poolWithClient(async (sql, params) => {
    if (sql.startsWith('SELECT * FROM pending_signups')) return { rows: [row] };
    if (sql.includes('FROM auth_delivery_outbox WHERE signup_id=')) return { rows: [{
      id: outboxParams[0], secret_ciphertext: outboxParams[5], secret_nonce: outboxParams[6],
      secret_key_version: outboxParams[7],
    }] };
    if (sql.includes('link_token_hash=$2,manual_code_hash=$3')) {
      row = {
        ...row,
        link_token_hash: params[1],
        manual_code_hash: params[2],
        challenge_expires_at: params[3],
        challenge_failures: 0,
        resend_count: row.resend_count + 1,
        status: 'DELIVERY_PENDING',
      };
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO auth_delivery_outbox')) outboxParams = params;
    if (sql.startsWith('UPDATE pending_signups SET challenge_failures=')) {
      row = { ...row, challenge_failures: params[1] };
    }
    if (sql.includes("SET status='VERIFIED'")) {
      row = { ...row, status: 'VERIFIED', verified_at: new Date(now) };
      return { rows: [row] };
    }
    return { rows: [] };
  });
  const runtime = createPendingSignupRuntime({
    pool,
    keyring: { key: Buffer.alloc(32, 8), keyVersion: 1 },
    env: { BEATGALER_SIGNUP_PEPPER: pepper, BEATGALER_SIGNUP_DIAGNOSTICS: '1' },
    now: () => now,
    randomBytes: size => Buffer.alloc(size, ++randomCalls),
  });
  assert.equal(runtime.constants.challengeTtlMs, 10 * 60_000);
  assert.equal(runtime.constants.maxFailures, 5);

  await runtime.resend({ signupId: row.id, continuationSecret: 'sc_good' });
  assert.notEqual(row.link_token_hash, oldLinkHash, 'resend must replace the link-token challenge hash');
  assert.notEqual(row.manual_code_hash, oldCodeHash, 'resend must replace the manual-code challenge hash');
  assert.equal(row.challenge_expires_at.toISOString(), new Date(now + 10 * 60_000).toISOString());

  assert.ok(outboxParams, 'resend must enqueue a replacement delivery');
  const secret = runtime.decryptDelivery({
    id: outboxParams[0],
    secret_ciphertext: outboxParams[5],
    secret_nonce: outboxParams[6],
    secret_key_version: outboxParams[7],
  });
  assert.match(secret.manual_code, /^[0-9]{3}-[0-9]{3}$/);
  const canonical = normalizeManualCode(secret.manual_code);
  assert.equal(row.manual_code_hash, digest(pepper, 'code', canonical), 'only canonical digits are hashed');
  assert.equal(JSON.parse(outboxParams[4]).manual_code, undefined, 'the public outbox payload must not contain the code');

  const audit = [];
  const previousWarn = console.warn;
  console.warn = (...args) => audit.push(args);
  try {
    await assert.rejects(
      runtime.verify({ signupId: row.id, continuationSecret: 'sc_good', challenge: '' }),
      error => error?.code === 'SIGNUP_CODE_FORMAT_INVALID',
      'an empty browser submission must be identified without consuming an OTP attempt',
    );
    assert.equal(row.challenge_failures, 0);
    assert.equal(audit[0]?.[1]?.input_length, 0);
    assert.equal(audit[0]?.[1]?.digit_count, 0);
    await assert.rejects(
      runtime.verify({ signupId: row.id, continuationSecret: 'sc_good', challenge: '654-321' }),
      error => error?.code === 'SIGNUP_CHALLENGE_INVALID',
      'the challenge replaced by resend must no longer verify',
    );
  } finally { console.warn = previousWarn; }
  assert.equal(audit[0]?.[0], '[signup-verify-audit]');
  assert.deepEqual(audit[1]?.[1]?.delivery_matches_newest_first, [false]);
  assert.equal(JSON.stringify(audit).includes('654-321'), false, 'the audit must never log a code');
  const verified = await runtime.verify({
    signupId: row.id,
    continuationSecret: 'sc_good',
    challenge: `${canonical.slice(0, 3)} ${canonical.slice(3)}`,
  });
  assert.equal(verified.status, 'VERIFIED');
}

{
  const calls = [];
  const service = {
    async requeueStaleDeliveries() { calls.push(['requeue']); return 0; },
    async claimDelivery() {
      calls.push(['claim']);
      return {
        row: { id: 'out_1', kind: 'signup_verification', attempt_count: 1 },
        secret: { email: 'person@example.com', manual_code: '123-456', expires_at: '2026-10-21T22:00:00.000Z' },
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
  assert.equal(calls[2][1].token, '123-456');
  assert.deepEqual(calls[3], ['complete', 'out_1', { ok: true }]);
}

{
  const completions = [];
  const service = {
    async requeueStaleDeliveries() { return 0; },
    async claimDelivery() {
      return {
        row: { id: 'out_fail', kind: 'signup_verification', attempt_count: 2 },
        secret: { email: 'person@example.com', manual_code: '123-456', expires_at: '2026-10-21T22:00:00.000Z' },
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
  installPendingSignupBoundary({ application: app, json: () => (_req, _res, next) => next() }, {
    service: { async status() { return { status: 'VERIFIED' }; } },
    activation: async () => { activations += 1; return { status: 'ACTIVE', account: { token: 'session', user: { id: 'usr_1' } } }; },
    env: { BEATGALER_PUBLIC_REGISTRATION: '0' },
  });
  app.post('/auth/register', () => {});
  const result = await new Promise(resolve => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve(body); } };
    routes.get('/auth/signup/status')[1]({ body: { signup_id: 'psu_1', continuation_secret: 'secret' } }, res);
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
  installPendingSignupBoundary({ application: app, json: () => (_req, _res, next) => next() }, {
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
      routes.get('/auth/signup/status')[1]({ body: { signup_id: 'psu_1', continuation_secret: 'secret' } }, res);
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
  installPendingSignupBoundary({ application: app, json: () => (_req, _res, next) => next() }, {
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
  await routes.get('/auth/signup/status')[1]({ headers: { 'x-beatgaler-client': 'web', cookie: cookie.split(';')[0] }, body: {} }, checked);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statusInput, { signupId: 'psu_web', continuationSecret: 'private-secret' });
}

{
  const routes = new Map();
  const app = { post(path, ...handlers) { routes.set(path, handlers); return this; } };
  installPendingSignupBoundary({ application: app, json: () => (_req, _res, next) => next() }, {
    service: { async begin() { return { created: true, recovered: true, signup_id: 'psu_existing',
      continuation_secret: 'replacement-secret', status: 'CODE_SENT',
      expires_at: new Date(Date.now() + 60_000).toISOString() }; } },
    env: { BEATGALER_PUBLIC_REGISTRATION: '1' },
  });
  app.post('/auth/register', () => {});
  const headers = new Map();
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    json(body) { this.body = body; return this; } };
  await routes.get('/auth/register')[0]({ headers: { 'x-beatgaler-client': 'web' }, body: {} }, res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.body.signup_id, 'psu_existing');
  assert.equal(res.body.recovered, true);
  assert.equal(res.body.continuation_secret, undefined);
  assert.match(res.getHeader('Set-Cookie')[0], /HttpOnly; Secure; SameSite=Lax/);
}

{
  const routes = new Map();
  const app = { post(path, ...handlers) { routes.set(path, handlers); return this; } };
  let verifiedInput;
  installPendingSignupBoundary({ application: app, json: () => (_req, _res, next) => next() }, {
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
  await routes.get('/auth/signup/verify')[1]({ headers: { 'x-beatgaler-client': 'web', cookie }, body: { code: '123-456' } }, activated);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(verifiedInput, { signupId: 'psu_web', continuationSecret: 'private-secret', challenge: '123-456' });
  assert.equal(activated.body.user.id, 'usr_1');
  assert.equal(activated.body.continuation_secret, undefined);
  assert.match(activated.getHeader('Set-Cookie')[0], /Max-Age=0/);
}

{
  // Reproduce production's registration order: a webhook app.post() installs
  // signup routes before the app-wide JSON parser is added.
  const express = require('../node_modules/express');
  let received = null;
  installPendingSignupBoundary(express, {
    service: { async verify(input) { received = input; return { status: 'VERIFIED', verified: false }; } },
    env: { BEATGALER_PUBLIC_REGISTRATION: '1' },
  });
  const app = express();
  app.post('/webhooks/polar', (_req, res) => res.sendStatus(204));
  app.use(express.json({ limit: '256kb' }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/auth/signup/verify`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signup_id: 'psu_1', continuation_secret: 'sc_1', code: '123-456' }) });
    assert.equal(response.status, 202);
    assert.deepEqual(received, { signupId: 'psu_1', continuationSecret: 'sc_1', challenge: '123-456' });
    const malformed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'SIGNUP_BODY_INVALID');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

console.log('pending-signup-safety tests: PASS');
