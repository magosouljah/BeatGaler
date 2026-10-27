'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');
const { createEmailVerificationFakePool } = require('./email-verification-fake-pool.cjs');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('email verification retries a database failure without issuing welcome access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-email-verification-'));
  try {
    const user = { id: 'usr_verified', username: 'verified#0001', email: 'verified@example.com' };
    const pool = createEmailVerificationFakePool([user]);
    const originalConnect = pool.connect.bind(pool);
    let failOnce = true;
    pool.connect = async () => {
      const client = await originalConnect();
      return {
        ...client,
        async query(sql, params) {
          if (failOnce && String(sql).includes('INSERT INTO user_email_verifications')) {
            failOnce = false;
            throw new Error('temporary verification database outage');
          }
          return client.query(sql, params);
        },
      };
    };
    fs.writeFileSync(path.join(dir, 'accounts-data.json'), JSON.stringify({ users: [user], sessions: {} }));
    const runtime = createAccountLifecycleRuntime({
      dataDir: dir,
      pool,
      now: () => Date.parse('2026-10-08T12:00:00Z'),
    });
    const token = runtime._test.issueTestToken({ kind: 'email_verification', user, email: user.email });
    const first = response();
    await runtime._test.confirmEmailVerification({ body: { token } }, first);
    assert.equal(first.statusCode, 503);
    assert.equal(first.body.code, 'EMAIL_VERIFICATION_RETRY');
    assert.equal((await runtime._test.publicStatusForUser(user)).email_verified, false);

    const retry = response();
    await runtime._test.confirmEmailVerification({ body: { token } }, retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.verified, true);
    assert.equal((await runtime._test.publicStatusForUser(user)).email_verified, true);
    assert.equal(pool.statements.some(({ text }) => /\bentitlements\b|\bwelcome:v1\b/i.test(text)), false);

    const replay = response();
    await runtime._test.confirmEmailVerification({ body: { token } }, replay);
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.body.code, 'EMAIL_VERIFICATION_INVALID');
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^beatgaler-email-verification-/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
