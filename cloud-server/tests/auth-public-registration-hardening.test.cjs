'use strict';

const assert = require('node:assert/strict');
const {
  normalizeEmail,
  validEmail,
  normalizeUsername,
  publicRegistrationOpen,
  oauthDecision,
  authErrorLooksInternal,
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

assert.equal(publicRegistrationOpen({ NODE_ENV: 'development', BEATGALER_PUBLIC_REGISTRATION: '0' }), true);
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

{
  const runtime = { passwordOverrideForUser: () => null };
  assert.equal(hasUsablePassword(runtime, { userId: 'u1', user: { passwordHash: 'abc' } }), true);
  assert.equal(hasUsablePassword(runtime, { userId: 'u1', user: {} }), false);
  assert.equal(hasUsablePassword({ passwordOverrideForUser: () => ({ passwordHash: 'override' }) }, { userId: 'u1', user: {} }), true);
}

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

  const pepper = '01234567890123456789012345678901';
  const linkHash = digest(pepper, 'link', 'same-value');
  const codeHash = digest(pepper, 'code', 'same-value');
  assert.notEqual(linkHash, codeHash, 'challenge kinds must be domain-separated');
  assert.equal(safeEqualHex(linkHash, digest(pepper, 'link', 'same-value')), true);
  assert.equal(safeEqualHex(linkHash, codeHash), false);

  const zeroRandom = size => Buffer.alloc(size);
  assert.equal(randomManualCode(zeroRandom), '00000000');
}

console.log('auth-public-registration-hardening tests: PASS');
