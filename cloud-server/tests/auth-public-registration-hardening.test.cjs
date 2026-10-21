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

console.log('auth-public-registration-hardening tests: PASS');
