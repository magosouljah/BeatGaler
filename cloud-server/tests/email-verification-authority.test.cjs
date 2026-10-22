'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emailHash, statusForUser, markVerifiedEmail, clearVerifiedEmail } = require('../email-verification-authority');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');
const { importLegacyEmailVerifications } = require('../scripts/import-legacy-email-verifications.cjs');
const { createEmailVerificationFakePool } = require('./email-verification-fake-pool.cjs');

(async () => {
  const pool = createEmailVerificationFakePool([
    { id: 'u1', email: ' Person@Example.com ' },
    { id: 'u2', email: 'other@example.com' },
  ]);
  assert.deepEqual(await statusForUser(pool, 'u1'), { email_verified: false, email_verified_at: null });
  await markVerifiedEmail(pool, 'u1', 'person@example.com', { verifiedAt: '2026-10-21T12:00:00Z' });
  assert.deepEqual(await statusForUser(pool, 'u1'), {
    email_verified: true,
    email_verified_at: '2026-10-21T12:00:00.000Z',
  });
  await markVerifiedEmail(pool, 'u1', 'person@example.com', { verifiedAt: '2026-10-22T12:00:00Z' });
  assert.equal((await statusForUser(pool, 'u1')).email_verified_at, '2026-10-21T12:00:00.000Z');
  pool.users.get('u1').email = 'changed@example.com';
  assert.equal((await statusForUser(pool, 'u1')).email_verified, false);
  await assert.rejects(markVerifiedEmail(pool, 'u1', 'person@example.com'), { code: 'EMAIL_VERIFICATION_CURRENT_EMAIL_MISMATCH' });
  await markVerifiedEmail(pool, 'u1', 'changed@example.com');
  assert.equal((await statusForUser(pool, 'u1')).email_verified, true);
  await clearVerifiedEmail(pool, 'u1');
  assert.equal((await statusForUser(pool, 'u1')).email_verified, false);

  const legacy = {
    email_verified: {
      u1: { email_hash: emailHash('changed@example.com'), verified_at: '2026-10-20T00:00:00Z' },
      u2: { email_hash: emailHash('wrong@example.com'), verified_at: '2026-10-20T00:00:00Z' },
      missing: { email_hash: emailHash('missing@example.com'), verified_at: '2026-10-20T00:00:00Z' },
      tombstoned: { email_hash: emailHash('old@example.com'), verified_at: '2026-10-20T00:00:00Z' },
    },
    tombstones: { tombstoned: { deleted_at: '2026-10-20T00:00:00Z' } },
  };
  const dry = await importLegacyEmailVerifications(pool, legacy, { dryRun: true });
  assert.deepEqual(dry, { LEGACY_ROWS_FOUND: 4, MATCHED: 1, IMPORTED: 0, SKIPPED_MISMATCH: 1, SKIPPED_MISSING_USER: 2 });
  assert.equal(pool.verifications.size, 0);
  const first = await importLegacyEmailVerifications(pool, legacy);
  assert.deepEqual(first, { LEGACY_ROWS_FOUND: 4, MATCHED: 1, IMPORTED: 1, SKIPPED_MISMATCH: 1, SKIPPED_MISSING_USER: 2 });
  const second = await importLegacyEmailVerifications(pool, legacy);
  assert.equal(second.IMPORTED, 0);
  assert.equal(pool.verifications.size, 1);
  assert.equal((await statusForUser(pool, 'u1')).email_verified, true);
  pool.users.get('u1').email = 'another@example.com';
  const stale = await importLegacyEmailVerifications(pool, legacy);
  assert.equal(stale.SKIPPED_MISMATCH, 2);
  assert.equal((await statusForUser(pool, 'u1')).email_verified, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-pg-email-authority-'));
  try {
    fs.writeFileSync(path.join(dir, 'account-lifecycle-state.json'), JSON.stringify({
      email_verified: { u1: { email_hash: emailHash('another@example.com'), verified_at: '2026-10-20T00:00:00Z' } },
    }));
    const runtime = createAccountLifecycleRuntime({ dataDir: dir, pool });
    assert.equal((await runtime._test.publicStatusForUser({ id: 'u1', email: 'another@example.com' })).email_verified, false,
      'legacy JSON must not grant verification without a PostgreSQL row');
    let decorated;
    const response = { statusCode: 200, json(payload) { decorated = payload; return this; } };
    runtime._test.responseDecorator('/auth/account', { body: {}, headers: {} }, response, () => {});
    response.json({ user: { id: 'u1', email: 'another@example.com' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(decorated.user.email_verified, false);
    runtime._test.issueTestToken({ kind: 'email_verification', user: { id: 'u1', email: 'another@example.com' }, email: 'another@example.com' });
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, 'account-lifecycle-state.json'), 'utf8')), 'email_verified'), false,
      'runtime state writes must not persist legacy verification');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('email verification authority tests: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
