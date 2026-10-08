'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('verified email activates Access once and a failed durable issue can retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-welcome-activation-'));
  try {
    const user = { id: 'usr_verified', username: 'verified#0001', email: 'verified@example.com' };
    fs.writeFileSync(path.join(dir, 'accounts-data.json'), JSON.stringify({ users: [user], sessions: {} }));
    let calls = 0;
    const runtime = createAccountLifecycleRuntime({
      dataDir: dir,
      now: () => Date.parse('2026-10-08T12:00:00Z'),
      onEmailVerified: async userId => {
        assert.equal(userId, user.id);
        calls += 1;
        if (calls === 1) throw new Error('temporary Access outage');
      },
    });
    const token = runtime._test.issueTestToken({ kind: 'email_verification', user, email: user.email });
    const first = response();
    await runtime._test.confirmEmailVerification({ body: { token } }, first);
    assert.equal(first.statusCode, 503);
    assert.equal(first.body.code, 'EMAIL_VERIFICATION_RETRY');
    assert.equal(runtime._test.publicStatusForUser(user).email_verified, true);

    const retry = response();
    await runtime._test.confirmEmailVerification({ body: { token } }, retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.verified, true);
    assert.equal(calls, 2);

    const replay = response();
    await runtime._test.confirmEmailVerification({ body: { token } }, replay);
    assert.equal(replay.statusCode, 400);
    assert.equal(calls, 2);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^beatgaler-welcome-activation-/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
