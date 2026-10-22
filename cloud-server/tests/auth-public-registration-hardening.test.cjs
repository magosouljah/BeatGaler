'use strict';

const assert = require('node:assert/strict');
const {
  normalizeEmail,
  validEmail,
  normalizeUsername,
  preserveUsersByStableId,
  publicRegistrationOpen,
  oauthDecision,
  authErrorLooksInternal,
  installAuthPublicRegistrationHardening,
} = require('../auth-public-registration-hardening');
const { hasUsablePassword } = require('../sensitive-auth-containment');
const {
  opaque,
  routePolicy,
  targetIdentity,
} = require('../auth-durable-abuse-controls');
const {
  normalizeEmail: normalizePendingEmail,
  normalizeBase,
  validEmail: validPendingEmail,
  validBase,
  digest,
  safeEqualHex,
  randomManualCode,
  normalizeManualCode,
  formatManualCode,
} = require('../pending-signup-runtime');

function user({ id, username, email = null, x = null, google = null }) {
  return {
    id,
    username,
    email,
    providers: {
      ...(x ? { x: { id: x } } : {}),
      ...(google ? { google: { id: google } } : {}),
    },
  };
}

function decision(overrides = {}) {
  return oauthDecision({
    provider: 'x',
    identity: { id: 'x-new', username: 'fresh' },
    users: [],
    link: false,
    registrationOpen: false,
    ...overrides,
  });
}

assert.equal(normalizeEmail('  TEST@Example.COM  '), 'test@example.com');
assert.equal(validEmail('person@example.com'), true);
assert.equal(validEmail('pepito#1234'), false);
assert.equal(normalizeUsername(' @PePiTo '), 'pepito');

assert.equal(publicRegistrationOpen({ NODE_ENV: 'development', BEATGALER_PUBLIC_REGISTRATION: '0' }), false);
assert.equal(publicRegistrationOpen({ NODE_ENV: 'production', BEATGALER_PUBLIC_REGISTRATION: '0' }), false);
assert.equal(publicRegistrationOpen({ NODE_ENV: 'production', BEATGALER_PUBLIC_REGISTRATION: '1' }), true);

{
  const result = decision();
  assert.equal(result.allow, false);
  assert.equal(result.code, 'PUBLIC_REGISTRATION_CLOSED');
}

{
  const result = decision({
    identity: { id: 'x-a', username: 'pepito' },
    users: [user({ id: 'usr-a', username: 'pepito', x: 'x-a' })],
  });
  assert.equal(result.allow, true, 'existing provider subject must still sign in while registration is closed');
  assert.equal(result.existing.id, 'usr-a');
}

{
  const result = decision({ link: true });
  assert.equal(result.allow, true, 'authenticated account may explicitly link a new provider while registration is closed');
}

{
  const users = [user({ id: 'usr-a', username: 'pepito', x: 'x-a' })];
  const result = decision({
    identity: { id: 'x-b', username: 'PEPITO' },
    users,
    registrationOpen: true,
  });
  assert.equal(result.allow, false);
  assert.equal(result.code, 'X_HANDLE_RECONCILIATION_REQUIRED');
  assert.equal(users[0].id, 'usr-a', 'decision must not mutate the existing owner');
  assert.equal(users[0].username, 'pepito', 'decision must not mutate the existing display name');
}

{
  const result = decision({
    identity: { id: 'x-a', username: 'juanito' },
    users: [user({ id: 'usr-a', username: 'pepito', x: 'x-a' })],
  });
  assert.equal(result.allow, true, 'same X subject may present a new free handle');
}

{
  const previous = [
    user({ id: 'usr-a', username: 'pepito', x: 'x-a' }),
    user({ id: 'usr-b', username: 'other', x: 'x-b' }),
  ];
  const serializedFromUsernameMap = [
    user({ id: 'usr-b', username: 'pepito', x: 'x-b' }),
  ];
  const repaired = preserveUsersByStableId(serializedFromUsernameMap, previous, new Set());
  assert.equal(repaired.length, 2, 'a username collision must not drop the previous stable user id');
  assert.deepEqual(new Set(repaired.map(row => row.id)), new Set(['usr-a', 'usr-b']));
  assert.equal(repaired.find(row => row.id === 'usr-b').username, 'pepito');
  const preservedA = repaired.find(row => row.id === 'usr-a');
  assert.match(preservedA.username, /^pepito#[0-9]{4}$/);
  assert.equal(preservedA.usernameSource, 'beatgaler');
  assert.equal(preservedA.usernameReconciliation, 'snapshot_preserved');
  assert.notEqual(normalizeUsername(preservedA.username), normalizeUsername(repaired.find(row => row.id === 'usr-b').username));
}

{
  const previous = [user({ id: 'usr-deleted', username: 'gone', x: 'x-gone' })];
  const repaired = preserveUsersByStableId([], previous, new Set(['usr-deleted']));
  assert.equal(repaired.length, 0, 'lifecycle tombstones must prevent legitimate deletions from being resurrected');
}

{
  const previous = [user({ id: 'usr-a', username: 'alpha#1234' })];
  const next = [user({ id: 'usr-a', username: 'renamed#1234' })];
  const repaired = preserveUsersByStableId(next, previous, new Set());
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].username, 'renamed#1234', 'new record for the same user.id remains authoritative');
}

{
  const result = oauthDecision({
    provider: 'google',
    identity: { id: 'g-a', email: 'a@example.com', email_verified: false },
    users: [],
    link: false,
    registrationOpen: true,
  });
  assert.equal(result.allow, false);
  assert.equal(result.code, 'GOOGLE_EMAIL_NOT_VERIFIED');
}

{
  const result = oauthDecision({
    provider: 'google',
    identity: { id: 'g-new', email: 'same@example.com', email_verified: true },
    users: [user({ id: 'usr-password', username: 'same#1234', email: 'SAME@example.com' })],
    link: false,
    registrationOpen: true,
  });
  assert.equal(result.allow, false);
  assert.equal(result.code, 'GOOGLE_EMAIL_CONFLICT');
}

{
  const result = oauthDecision({
    provider: 'google',
    identity: { id: 'g-a', email: 'a@example.com', email_verified: true },
    users: [user({ id: 'usr-a', username: 'alpha#0001', email: 'a@example.com', google: 'g-a' })],
    link: false,
    registrationOpen: false,
  });
  assert.equal(result.allow, true, 'existing Google subject must still sign in while registration is closed');
}

assert.equal(authErrorLooksInternal('Master Galer Cloud storage account is not configured'), true);
assert.equal(authErrorLooksInternal('ECONNREFUSED 127.0.0.1:5432'), true);
assert.equal(authErrorLooksInternal('Invalid email or password.'), false);
assert.equal(authErrorLooksInternal('That Google account is already connected to another BeatGaler account.'), false);

const passwordChecks = (async () => {
  // A password by itself is no longer a usable sign-in method. It only becomes
  // usable once the account also has one unique verified email address.
  const runtime = { passwordOverrideForUser: () => null };
  const pool = { async query() { return { rows: [] }; } };
  assert.equal(await hasUsablePassword(runtime, { userId: 'u1', user: { passwordHash: 'abc' } }, pool), false);
  assert.equal(await hasUsablePassword(runtime, { userId: 'u1', user: {} }, pool), false);
  assert.equal(await hasUsablePassword({ passwordOverrideForUser: () => ({ passwordHash: 'override' }) }, { userId: 'u1', user: {} }, pool), false);
})();

{
  const login = routePolicy('/auth/login', {});
  assert.equal(login.windowMs, 60_000);
  assert.equal(login.ipMax, 30);
  assert.equal(login.targetMax, 12);

  const send = routePolicy('/auth/password/reset/request', {});
  assert.equal(send.windowMs, 10 * 60_000);
  assert.equal(send.targetMax, 5);
  assert.equal(send.globalMax, 1000);

  const oauth = routePolicy('/auth/oauth/start', {});
  assert.equal(oauth.ipMax, 40);
  assert.equal(oauth.targetMax, 20);

  const custom = routePolicy('/auth/login', { BEATGALER_AUTH_LOGIN_TARGET_MAX: '7' });
  assert.equal(custom.targetMax, 7);
}

{
  const runtime = { _test: { sessionInfoFromRequest: () => ({ userId: 'usr-stable' }) } };
  assert.equal(targetIdentity({ body: { email: 'attacker@example.com' } }, runtime), 'user:usr-stable');
  assert.equal(targetIdentity({ body: { email: ' Test@Example.COM ' } }, null), 'input:test@example.com');
  const hashed = opaque('test@example.com');
  assert.notEqual(hashed, 'test@example.com');
  assert.equal(hashed.length, 64);
}

{
  assert.equal(normalizePendingEmail(' Person@Example.COM '), 'person@example.com');
  assert.equal(normalizeBase(' My.Name '), 'my.name');
  assert.equal(validPendingEmail('person@example.com'), true);
  assert.equal(validPendingEmail('not-an-email'), false);
  assert.equal(validBase('abc'), true);
  assert.equal(validBase('ab'), false);
  assert.equal(validBase('name#1234'), false);
  assert.equal(validBase('UpperCase'), false);

  const pepper = 'p'.repeat(32);
  const linkHash = digest(pepper, 'link', 'same-value');
  const codeHash = digest(pepper, 'code', 'same-value');
  assert.notEqual(linkHash, codeHash, 'challenge kinds must be domain-separated');
  assert.equal(safeEqualHex(linkHash, digest(pepper, 'link', 'same-value')), true);
  assert.equal(safeEqualHex(linkHash, codeHash), false);

  const zeroRandom = size => Buffer.alloc(size);
  assert.equal(randomManualCode(zeroRandom), '000000');
  assert.match(randomManualCode(() => Buffer.from([0, 0, 0, 42])), /^[0-9]{6}$/);

  let randomCalls = 0;
  const rejectionSample = () => (++randomCalls === 1
    ? Buffer.from([0xff, 0xff, 0xff, 0xff])
    : Buffer.from([0, 0, 0, 123]));
  assert.equal(randomManualCode(rejectionSample), '000123', 'out-of-range samples must be rejected to avoid modulo bias');
  assert.equal(randomCalls, 2);

  assert.equal(normalizeManualCode('123-456'), '123456');
  assert.equal(normalizeManualCode('123456'), '123456');
  assert.equal(normalizeManualCode('123 456'), '123456');
  assert.equal(formatManualCode('000123'), '000-123');
  for (const invalid of ['', '12345', '1234567', '12-3456', '123_456', '123  456', '123-45a']) {
    assert.equal(normalizeManualCode(invalid), null, `${JSON.stringify(invalid)} must not normalize as a manual code`);
  }
}

(async () => {
  await passwordChecks;
  const routes = new Map();
  const app = {
    post(path, ...handlers) { routes.set(path, handlers); },
    get() {},
  };
  const calls = [];
  const info = { userId: 'usr_stable', user: { providers: { google: { id: 'g1' }, x: { id: 'x1' } } } };
  installAuthPublicRegistrationHardening({ application: app }, {
    env: { NODE_ENV: 'production', BEATGALER_PUBLIC_REGISTRATION: '0' },
    getAccountLifecycle: () => ({ _test: { sessionInfoFromRequest: () => info } }),
    getProviderIdentityAuthority: () => ({
      async prepareDisconnect(input) { calls.push(input); return { ok: true }; },
    }),
  });
  app.post('/auth/oauth/disconnect', () => {});
  const middleware = routes.get('/auth/oauth/disconnect')[1];
  await new Promise((resolve, reject) => {
    const req = { body: { provider: 'x' } };
    const res = { status() { reject(new Error('unlink unexpectedly rejected')); return this; }, json() {} };
    middleware(req, res, resolve);
  });
  assert.deepEqual(calls, [{ provider: 'x', userId: 'usr_stable', usablePassword: false }]);

  const loginRoutes = new Map();
  const loginApp = { post(path, ...handlers) { loginRoutes.set(path, handlers); }, get() {} };
  let queries = 0;
  installAuthPublicRegistrationHardening({ application: loginApp }, {
    getAccountLifecycle: () => ({ _test: { accountsSnapshot: () => ({ users: [{ id: 'usr_stable', email: 'old@example.com' }] }) } }),
    getAuthPool: () => ({ async query() { queries += 1; return { rows: [] }; } }),
  });
  loginApp.post('/auth/login', () => {});
  const loginGuard = loginRoutes.get('/auth/login')[1];
  const loginResult = await new Promise(resolve => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { resolve({ status: this.statusCode, payload }); } };
    loginGuard({ body: { email: 'old@example.com' } }, res, () => resolve({ status: 200 }));
  });
  assert.equal(loginResult.status, 401);
  assert.equal(queries, 1);
  console.log('auth-public-registration-hardening tests: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
