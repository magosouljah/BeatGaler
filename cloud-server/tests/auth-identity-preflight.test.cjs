'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  sha256,
  usablePassword,
  verifiedEmail,
  analyzeIdentityPreflight,
} = require('../auth-identity-preflight');

function verifiedState(userId, email, extra = {}) {
  return {
    password_overrides: {},
    ...extra,
  };
}

{
  const state = verifiedState('u1', 'person@example.com');
  assert.equal(verifiedEmail({ id: 'u1', email: ' Person@Example.com ', verified_email_hash: sha256('person@example.com') }), true);
  assert.equal(verifiedEmail({ id: 'u1', email: 'other@example.com', verified_email_hash: sha256('person@example.com') }), false);
  assert.equal(verifiedEmail({ id: 'u1', email: 'person@example.com' }, verifiedState('u1', 'person@example.com', {
    email_verified: { u1: { email_hash: sha256('person@example.com') } },
  })), false);
  assert.equal(usablePassword({ id: 'u1', password_hash: 'present' }, state), true);
  assert.equal(usablePassword({ id: 'u2' }, { password_overrides: { u2: { passwordHash: 'present' } } }), true);
}

{
  const users = [
    { id: 'u1', username: 'Pepito', email: 'One@example.com', password_hash: 'present', verified_email_hash: sha256('one@example.com') },
    { id: 'u2', username: 'pepito', email: 'one@EXAMPLE.com', password_hash: null },
    { id: 'u3', username: 'safe#1234', email: null, password_hash: 'present' },
    { id: 'u4', username: 'other#4321', email: 'unverified@example.com', password_hash: null },
  ];
  const lifecycleState = {
    email_verified: { u4: { email_hash: sha256('unverified@example.com') } },
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
    users: [{ id: 'ready', username: 'ready#1234', email, password_hash: 'present', verified_email_hash: sha256(email) }],
    providers: [{ id: 'g', user_id: 'ready', provider: 'google', provider_subject: 'sub-ready' }],
    lifecycleState: verifiedState('ready', email),
  });
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.counts.password_email_ready, 1);
}

const casefoldMigration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0022_auth_casefold_identity.sql'), 'utf8');
assert.match(casefoldMigration, /UNIQUE INDEX[^;]+lower\(username\)/s);
assert.match(casefoldMigration, /UNIQUE INDEX[^;]+lower\(email\)/s);

// The CLI loads dotenv on import. Keep the SQL contract as a source check.
const preflightCli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'auth-identity-preflight.cjs'), 'utf8');
const [, usersQuery] = preflightCli.match(/async function loadIdentityRows\(pool\)[\s\S]*?pool\.query\(`([^`]+)`\)/) ?? [];
assert.ok(usersQuery, 'identity preflight must load users through the PostgreSQL query');
assert.match(usersQuery, /LEFT JOIN user_email_verifications/);
assert.match(usersQuery, /verified_email_hash/);
assert.doesNotMatch(usersQuery, /account-lifecycle-state/);

{
  const user = {
    id: 'changed', username: 'changed#4321', email: 'New@Example.com', password_hash: 'present',
    verified_email_hash: sha256('old@example.com'),
  };
  const currentHash = sha256('new@example.com');
  const lifecycleState = { email_verified: { changed: { email_hash: currentHash } } };
  const stale = analyzeIdentityPreflight({ users: [user], lifecycleState });
  assert.equal(stale.ready, false, 'an old authoritative hash and a matching local mirror cannot verify the new address');
  assert.deepEqual(stale.blockers, [{ code: 'PASSWORD_EMAIL_UNVERIFIED', user_ids: ['changed'] }]);
  assert.equal(stale.counts.password_email_ready, 0);

  const verified = analyzeIdentityPreflight({ users: [{ ...user, verified_email_hash: currentHash }], lifecycleState });
  assert.equal(verified.ready, true);
  assert.deepEqual(verified.blockers, []);
  assert.equal(verified.counts.password_email_ready, 1);
}

console.log('auth-identity-preflight tests: PASS');
