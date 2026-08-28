'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');
const { installLifecycleRequestGuard } = require('../account-lifecycle-request-guard');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-lifecycle-guard-'));
  const now = 1_800_000_000_000;
  const token = 'canonical-session';
  const hash = sha256(token);
  fs.writeFileSync(path.join(dir, 'accounts-data.json'), JSON.stringify({
    users: [{ id: 'usr_guard', username: 'guard#0001', email: 'guard@example.com' }],
    sessions: { [hash]: { userId: 'usr_guard', createdAt: now - 1, expiresAt: now + 100000 } },
  }));

  const runtime = createAccountLifecycleRuntime({ dataDir: dir, now: () => now });
  const application = {
    use(...handlers) { this.__stack.push(...handlers); return this; },
  };
  const express = { application };
  installLifecycleRequestGuard(express, runtime);
  const app = Object.create(application);
  app.__stack = [];
  app.use((_req, _res, next) => next());
  assert.equal(app.__stack.length, 2, 'guard must install before the first ordinary middleware');
  const guard = app.__stack[0];

  {
    let nextCalled = false;
    const res = response();
    guard({ headers: { authorization: `Bearer ${token}` } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  }

  runtime._test.revokedSessionHashes.add(hash);
  {
    let nextCalled = false;
    const res = response();
    guard({ path: '/transport/session/start', headers: { authorization: `Bearer ${token}` } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, 'revocation must cover non-/auth routes too');
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'SESSION_REQUIRED');
  }

  {
    let nextCalled = false;
    const res = response();
    guard({ path: '/auth/password/reset/request', headers: {} }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'public requests without a bearer remain reachable');
  }

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sessionInstall = serverSource.indexOf('installSessionSecurity(express');
  const lifecycleGuardInstall = serverSource.indexOf('installLifecycleRequestGuard(express');
  assert.ok(sessionInstall >= 0 && lifecycleGuardInstall > sessionInstall,
    'lifecycle guard must be installed after SessionSecurity so Web cookies/rotation aliases are normalized first');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('account-lifecycle-request-guard: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
