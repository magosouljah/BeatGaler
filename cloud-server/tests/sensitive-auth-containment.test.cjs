'use strict';

const assert = require('node:assert/strict');
const {
  hasVerifiedUniqueEmail,
  hasUsablePassword,
  installSensitiveAuthContainment,
} = require('../sensitive-auth-containment');

function runtimeFor({
  userId = 'usr_1',
  email = 'one@example.com',
  verified = true,
  passwordHash = null,
  overrideHash = null,
  providers = {},
  duplicateEmail = false,
  reauthOk = false,
} = {}) {
  const user = { id: userId, email, passwordHash, providers };
  const users = [user, ...(duplicateEmail ? [{ id: 'usr_2', email }] : [])];
  return {
    passwordOverrideForUser() { return overrideHash ? { passwordHash: overrideHash } : null; },
    _test: {
      sessionInfoFromRequest() { return { userId, user, sessionHash: 'session_hash' }; },
      publicStatusForUser() { return { email_verified: verified }; },
      accountsSnapshot() { return { users, sessions: {} }; },
      consumeReauth(_req, raw) {
        return reauthOk && raw === 'reauth_good'
          ? { ok: true, info: { userId, user }, method: 'oauth:x' }
          : { ok: false, code: 'REAUTH_REQUIRED' };
      },
    },
  };
}

function fakeExpress() {
  const registered = new Map();
  const application = {
    post(routePath, ...handlers) {
      registered.set(String(routePath), handlers);
      return application;
    },
  };
  return { application, registered };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = Number(code); return this; },
    json(body) { this.body = body; return this; },
  };
}

async function runFirst(express, route, req = {}) {
  let nextCalled = false;
  const res = responseRecorder();
  const handlers = express.registered.get(route) || [];
  assert.ok(handlers.length >= 2, `expected guard + legacy handler for ${route}`);
  await Promise.resolve(handlers[0]({ body: {}, headers: {}, ...req }, res, () => { nextCalled = true; }));
  return { res, nextCalled };
}

(async () => {
  {
    const runtime = runtimeFor({ passwordHash: 'hash', verified: true });
    const info = runtime._test.sessionInfoFromRequest({});
    assert.equal(hasVerifiedUniqueEmail(runtime, info), true);
    assert.equal(hasUsablePassword(runtime, info), true);
  }

  {
    const runtime = runtimeFor({ passwordHash: 'hash', verified: false });
    const info = runtime._test.sessionInfoFromRequest({});
    assert.equal(hasVerifiedUniqueEmail(runtime, info), false);
    assert.equal(hasUsablePassword(runtime, info), false);
  }

  {
    const runtime = runtimeFor({ passwordHash: 'hash', verified: true, duplicateEmail: true });
    const info = runtime._test.sessionInfoFromRequest({});
    assert.equal(hasVerifiedUniqueEmail(runtime, info), false);
    assert.equal(hasUsablePassword(runtime, info), false);
  }

  {
    const express = fakeExpress();
    installSensitiveAuthContainment(express, runtimeFor({ verified: true, reauthOk: false }));
    express.application.post('/auth/password/change', () => {});
    const { res, nextCalled } = await runFirst(express, '/auth/password/change', {
      body: { reauthToken: 'bad' },
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'REAUTH_REQUIRED');
  }

  {
    const express = fakeExpress();
    installSensitiveAuthContainment(express, runtimeFor({ verified: true, reauthOk: true }));
    express.application.post('/auth/password/change', () => {});
    const { nextCalled } = await runFirst(express, '/auth/password/change', {
      body: { reauthToken: 'reauth_good' },
    });
    assert.equal(nextCalled, true);
  }

  {
    const express = fakeExpress();
    installSensitiveAuthContainment(express, runtimeFor({ verified: false, reauthOk: true }));
    express.application.post('/auth/password/change', () => {});
    const { res, nextCalled } = await runFirst(express, '/auth/password/change', {
      body: { reauthToken: 'reauth_good' },
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'PASSWORD_VERIFIED_EMAIL_REQUIRED');
  }

  {
    const express = fakeExpress();
    installSensitiveAuthContainment(express, runtimeFor({
      verified: true,
      passwordHash: 'hash',
      providers: { x: { id: 'x-1' } },
      reauthOk: true,
    }));
    express.application.post('/auth/oauth/disconnect', () => {});
    const { nextCalled } = await runFirst(express, '/auth/oauth/disconnect', {
      body: { provider: 'x', reauthToken: 'reauth_good' },
    });
    assert.equal(nextCalled, true);
  }

  {
    const express = fakeExpress();
    installSensitiveAuthContainment(express, runtimeFor({
      verified: false,
      providers: { x: { id: 'x-1' } },
      reauthOk: true,
    }));
    express.application.post('/auth/oauth/disconnect', () => {});
    const { res, nextCalled } = await runFirst(express, '/auth/oauth/disconnect', {
      body: { provider: 'x', reauthToken: 'reauth_good' },
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'LAST_SIGNIN_METHOD_REQUIRED');
  }

  {
    const express = fakeExpress();
    installSensitiveAuthContainment(express, runtimeFor({
      verified: true,
      providers: { google: { id: 'g-1' } },
      reauthOk: false,
    }));
    express.application.post('/auth/oauth/disconnect', () => {});
    const { res, nextCalled } = await runFirst(express, '/auth/oauth/disconnect', { body: { provider: 'x' } });
    assert.equal(nextCalled, false, 'a stale local snapshot cannot bypass provider unlink reauthentication');
    assert.equal(res.statusCode, 401);
  }

  {
    const express = fakeExpress();
    installSensitiveAuthContainment(express, runtimeFor({ verified: true, reauthOk: false }));
    express.application.post('/auth/oauth/start', () => {});
    const { res, nextCalled } = await runFirst(express, '/auth/oauth/start', {
      body: { provider: 'google' },
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'REAUTH_REQUIRED');
  }

  console.log('sensitive-auth-containment tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
