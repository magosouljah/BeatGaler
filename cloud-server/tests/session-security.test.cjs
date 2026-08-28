'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createSessionSecurityRuntime,
  SESSION_COOKIE,
  CSRF_COOKIE,
  ROTATED_TOKEN_PREFIX,
} = require('../session-security');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function makeRes() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); return this; },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    headers,
  };
}

function cookieHeader(name, value) {
  return `${name}=${encodeURIComponent(value)}`;
}

function baseReq({ token = '', cookie = '', csrf = '', pathName = '/auth/account', method = 'POST', web = false, body = {} } = {}) {
  const headers = { host: 'cloud.example.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-beatgaler-csrf'] = csrf;
  if (web) {
    headers['x-beatgaler-client'] = 'web';
    headers.origin = 'https://app.example.test';
  }
  return { method, path: pathName, url: pathName, headers, body };
}

function writeAccounts(dir, sessions) {
  fs.writeFileSync(path.join(dir, 'accounts-data.json'), JSON.stringify({ users: [{ id: 'usr_1', username: 'one#0001' }], sessions }, null, 2));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-session-security-'));
  const now = 1_800_000_000_000;
  const tokenOne = 'core-session-one';
  const tokenTwo = 'core-session-two';
  const hashOne = sha256(tokenOne);
  const hashTwo = sha256(tokenTwo);
  writeAccounts(dir, {
    [hashOne]: { userId: 'usr_1', createdAt: now - 10_000, expiresAt: now + 100_000 },
    [hashTwo]: { userId: 'usr_1', createdAt: now - 5_000, expiresAt: now + 100_000 },
  });

  const revokedCapabilities = [];
  const runtime = createSessionSecurityRuntime({
    dataDir: dir,
    now: () => now,
    randomBytes: size => Buffer.alloc(size, 7),
    getCapabilityStore: () => ({
      async revokeAuthSession(input) { revokedCapabilities.push(input); return 1; },
    }),
  });

  {
    const csrf = 'csrf-token';
    const req = baseReq({
      cookie: `${cookieHeader(SESSION_COOKIE, tokenOne)}; ${cookieHeader(CSRF_COOKIE, csrf)}`,
      pathName: '/auth/account',
      web: true,
    });
    const res = makeRes();
    let nextCalled = false;
    runtime.requestMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'CSRF_REQUIRED');

    req.headers['x-beatgaler-csrf'] = csrf;
    const res2 = makeRes();
    runtime.requestMiddleware(req, res2, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.headers.authorization, `Bearer ${tokenOne}`);
  }

  {
    const req = baseReq({ pathName: '/auth/login', web: true, body: { beatgalerUserId: 'web-installation' } });
    const res = makeRes();
    runtime.decorateResponse('/auth/login', req, res, () => {});
    res.json({ ok: true, token: tokenOne, user: { id: 'usr_1' } });
    assert.equal(res.body.token, undefined);
    assert.equal(res.body.session_transport, 'cookie');
    assert.ok(res.body.csrf_token);
    const cookies = res.getHeader('Set-Cookie');
    assert.ok(Array.isArray(cookies));
    const session = cookies.find(value => value.startsWith(`${SESSION_COOKIE}=`));
    const csrf = cookies.find(value => value.startsWith(`${CSRF_COOKIE}=`));
    assert.match(session, /HttpOnly/);
    assert.match(session, /Secure/);
    assert.match(session, /SameSite=None/);
    assert.match(csrf, /Secure/);
  }

  {
    const req = baseReq({ token: tokenOne, pathName: '/auth/sessions', body: { beatgalerUserId: 'desktop-a' } });
    const res = makeRes();
    runtime.requestMiddleware(req, res, () => {});
    runtime.listSessions(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.sessions.length, 2);
    assert.equal(res.body.sessions.filter(item => item.current).length, 1);
    assert.ok(res.body.sessions.every(item => /^ses_[0-9a-f]{24}$/.test(item.id)));
    assert.equal(JSON.stringify(res.body).includes(tokenOne), false);
    assert.equal(JSON.stringify(res.body).includes(hashOne), false);
  }

  {
    const req = baseReq({ token: tokenTwo, pathName: '/auth/sessions/revoke', body: { session_id: runtime.publicSessionId(hashTwo) } });
    const res = makeRes();
    runtime.requestMiddleware(req, res, () => {});
    await runtime.revokeOne(req, res);
    assert.equal(res.body.current_revoked, true);
    assert.deepEqual(revokedCapabilities.at(-1), { authSessionHash: hashTwo, reason: 'session_revoke_one' });

    const blocked = baseReq({ token: tokenTwo, pathName: '/auth/account' });
    const blockedRes = makeRes();
    let nextCalled = false;
    runtime.requestMiddleware(blocked, blockedRes, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(blockedRes.statusCode, 401);
    assert.equal(blockedRes.body.code, 'SESSION_REVOKED');
  }

  {
    const req = baseReq({ token: tokenOne, pathName: '/auth/password/change', body: { beatgalerUserId: 'desktop-a' } });
    const res = makeRes();
    runtime.requestMiddleware(req, res, () => {});
    runtime.decorateResponse('/auth/password/change', req, res, () => {});
    res.json({ ok: true });
    assert.equal(res.body.session_rotated, true);
    assert.ok(res.body.token.startsWith(ROTATED_TOKEN_PREFIX));
    const rotated = res.body.token;

    const oldReq = baseReq({ token: tokenOne, pathName: '/auth/account' });
    const oldRes = makeRes();
    let oldNext = false;
    runtime.requestMiddleware(oldReq, oldRes, () => { oldNext = true; });
    assert.equal(oldNext, false);
    assert.equal(oldRes.body.code, 'SESSION_ROTATED');

    const newReq = baseReq({ token: rotated, pathName: '/auth/account' });
    const newRes = makeRes();
    let newNext = false;
    runtime.requestMiddleware(newReq, newRes, () => { newNext = true; });
    assert.equal(newNext, true);
    assert.equal(newReq.headers.authorization, `Bearer ${tokenOne}`);

    const restarted = createSessionSecurityRuntime({ dataDir: dir, now: () => now, getCapabilityStore: () => ({ revokeAuthSession: async () => 0 }) });
    const restartAliasReq = baseReq({ token: rotated, pathName: '/auth/account' });
    const restartAliasRes = makeRes();
    let restartNext = false;
    restarted.requestMiddleware(restartAliasReq, restartAliasRes, () => { restartNext = true; });
    assert.equal(restartNext, false);
    assert.equal(restartAliasRes.body.code, 'SESSION_ROTATION_EXPIRED');

    const restartOldReq = baseReq({ token: tokenOne, pathName: '/auth/account' });
    const restartOldRes = makeRes();
    restarted.requestMiddleware(restartOldReq, restartOldRes, () => { restartNext = true; });
    assert.equal(restartOldRes.body.code, 'SESSION_ROTATED');
  }

  {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-session-security-all-'));
    writeAccounts(freshDir, {
      [hashOne]: { userId: 'usr_1', createdAt: now - 10_000, expiresAt: now + 100_000 },
      [hashTwo]: { userId: 'usr_1', createdAt: now - 5_000, expiresAt: now + 100_000 },
    });
    const revoked = [];
    const allRuntime = createSessionSecurityRuntime({
      dataDir: freshDir,
      now: () => now,
      getCapabilityStore: () => ({ async revokeAuthSession(input) { revoked.push(input); } }),
    });
    const req = baseReq({ token: tokenOne, pathName: '/auth/sessions/revoke-all' });
    const res = makeRes();
    allRuntime.requestMiddleware(req, res, () => {});
    await allRuntime.revokeAll(req, res);
    assert.equal(res.body.revoked_count, 2);
    assert.deepEqual(new Set(revoked.map(item => item.authSessionHash)), new Set([hashOne, hashTwo]));
    fs.rmSync(freshDir, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('session-security: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
