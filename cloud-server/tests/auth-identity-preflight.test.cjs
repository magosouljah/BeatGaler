'use strict';

const assert = require('node:assert/strict');
const {
  sha256,
  usablePassword,
  verifiedEmail,
  analyzeIdentityPreflight,
} = require('../auth-identity-preflight');

function verifiedState(userId, email, extra = {}) {
  return {
    email_verified: {
      [userId]: { email_hash: sha256(String(email).trim().toLowerCase()), verified_at: '2026-10-21T00:00:00.000Z' },
    },
    password_overrides: {},
    ...extra,
  };
}

{
  const state = verifiedState('u1', 'person@example.com');
  assert.equal(verifiedEmail({ id: 'u1', email: ' Person@Example.com ' }, state), true);
  assert.equal(verifiedEmail({ id: 'u1', email: 'other@example.com' }, state), false);
  assert.equal(usablePassword({ id: 'u1', password_hash: 'present' }, state), true);
  assert.equal(usablePassword({ id: 'u2' }, { password_overrides: { u2: { passwordHash: 'present' } } }), true);
}

{
  const users = [
    { id: 'u1', username: 'Pepito', email: 'One@example.com', password_hash: 'present' },
    { id: 'u2', username: 'pepito', email: 'one@EXAMPLE.com', password_hash: null },
    { id: 'u3', username: 'safe#1234', email: null, password_hash: 'present' },
    { id: 'u4', username: 'other#4321', email: 'unverified@example.com', password_hash: null },
  ];
  const lifecycleState = {
    email_verified: {
      u1: { email_hash: sha256('one@example.com'), verified_at: '2026-10-21T00:00:00.000Z' },
    },
    password_overrides: {
      u4: { passwordHash: 'present' },
    },
  };
  const providers = [
    { id: 'p1', user_id: 'u1', provider: 'x', provider_subject: 'x-1', access_token_ciphertext: true },
    { id: 'p2', user_id: 'u1', provider: 'x', provider_subject: 'x-2' },
    { id: 'p3', user_id: 'u2', provider: 'google', provider_subject: 'g-1' },
  ];
  const report = analyzeIdentityPreflight({ users, providers, lifecycleState });
  assert.equal(report.ready, false);
  assert.equal(report.counts.username_casefold_collision_groups, 1);
  assert.equal(report.counts.email_casefold_collision_groups, 1);
  assert.equal(report.counts.password_without_email, 1);
  assert.equal(report.counts.password_email_unverified, 1);
  assert.equal(report.counts.user_provider_multiple_groups, 1);
  assert.equal(report.counts.legacy_x_token_identities, 1);
  assert.equal(report.blockers.some(row => row.code === 'USERNAME_CASEFOLD_COLLISION'), true);
  assert.equal(report.blockers.some(row => row.code === 'EMAIL_CASEFOLD_COLLISION'), true);
  assert.equal(report.blockers.some(row => row.code === 'PASSWORD_WITHOUT_EMAIL' && row.user_ids[0] === 'u3'), true);
  assert.equal(report.blockers.some(row => row.code === 'PASSWORD_EMAIL_UNVERIFIED' && row.user_ids[0] === 'u4'), true);
  assert.equal(report.warnings.some(row => row.code === 'MULTIPLE_PROVIDER_IDENTITIES_FOR_USER'), true);
  assert.equal(report.warnings.some(row => row.code === 'LEGACY_X_TOKENS_PRESENT'), true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('One@example.com'), false);
  assert.equal(serialized.includes('Pepito'), false);
}

{
  const email = 'ready@example.com';
  const report = analyzeIdentityPreflight({
    users: [{ id: 'ready', username: 'ready#1234', email, password_hash: 'present' }],
    providers: [{ id: 'g', user_id: 'ready', provider: 'google', provider_subject: 'sub-ready' }],
    lifecycleState: verifiedState('ready', email),
  });
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.counts.password_email_ready, 1);
}

console.log('auth-identity-preflight tests: PASS');
