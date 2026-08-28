'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const passwordKdf = require('../password-kdf');
const { createAccountLifecycleRuntime, RECOVERY_PREFIX } = require('../account-lifecycle');
const { installLifecyclePasswordAuthority } = require('../account-lifecycle-password-authority');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: new Map(),
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); return this; },
    getHeader(name) { return this.headers.get(String(name).toLowerCase()); },
    json(value) { this.body = value; return this; },
  };
}

function req({ token = '', body = {}, pathName = '/auth/account' } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: 'POST', path: pathName, url: pathName, headers, body };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-account-lifecycle-'));
  let clock = 1_800_000_000_000;
  const userId = 'usr_lifecycle';
  const salt = '00112233445566778899aabbccddeeff';
  const passwordHash = await passwordKdf.hashPassword('old-password', salt);
  const sessionOne = 'session-one';
  const sessionTwo = 'session-two';
  const sessionHashOne = sha256(sessionOne);
  const sessionHashTwo = sha256(sessionTwo);
  const user = {
    id: userId,
    username: 'life#0001',
    email: 'life@example.com',
    passwordSalt: salt,
    passwordHash,
    createdAt: clock - 50000,
    mfaSecret: 'JBSWY3DPEHPK3PXP',
    providers: {
      google: {
        id: 'google-subject',
        email: 'life@example.com',
        name: 'Life',
        accessToken: 'must-not-export',
        refreshToken: 'must-not-export-either',
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'accounts-data.json'), JSON.stringify({
    users: [user],
    sessions: {
      [sessionHashOne]: { userId, createdAt: clock - 1000, expiresAt: clock + 1000000 },
      [sessionHashTwo]: { userId, createdAt: clock - 500, expiresAt: clock + 1000000 },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'cloud-data.json'), JSON.stringify({
    linkedAccounts: { install_a: { beatgalerAccountId: userId, storageChatId: '-100123', storageChatTitle: 'Private' } },
    uploadedFiles: { f1: { beatgalerUserId: 'install_a', beatId: 'beat-a' } },
    beatTopics: { 'install_a:beat-a': { messageThreadId: 7 } },
    pendingTopicDeletes: { 'install_a:beat-b': { beatId: 'beat-b' } },
    messageRedirects: { 'install_a:1': 2 },
  }, null, 2));

  const deliveries = [];
  const capabilityRevokes = [];
  let randomCounter = 1;
  const deterministicRandom = size => {
    const buffer = Buffer.alloc(size);
    buffer.fill(randomCounter++ % 251 || 1);
    return buffer;
  };
  const runtime = createAccountLifecycleRuntime({
    dataDir: dir,
    now: () => clock,
    randomBytes: deterministicRandom,
    env: {
      BEATGALER_ACCOUNT_TOMBSTONE_RETENTION_DAYS: '30',
      BEATGALER_EMAIL_VERIFY_TTL_MS: String(10 * 60 * 1000),
      BEATGALER_PASSWORD_RESET_TTL_MS: String(10 * 60 * 1000),
      BEATGALER_REAUTH_TTL_MS: String(5 * 60 * 1000),
    },
    emailNotifier: async message => { deliveries.push(message); },
    getCapabilityStore: () => ({
      async revokeAuthSession(input) { capabilityRevokes.push(input); return 1; },
    }),
  });

  {
    const unknownRes = makeRes();
    await runtime._test.requestPasswordReset(req({ body: { email: 'nobody@example.com' }, pathName: '/auth/password/reset/request' }), unknownRes);
    const existingRes = makeRes();
    await runtime._test.requestPasswordReset(req({ body: { email: 'life@example.com' }, pathName: '/auth/password/reset/request' }), existingRes);
    assert.equal(unknownRes.statusCode, 202);
    assert.equal(existingRes.statusCode, 202);
    assert.equal(unknownRes.body.message, existingRes.body.message);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, 'password_reset');
    assert.equal(JSON.stringify(runtime._test.stateSnapshot()).includes(deliveries[0].token), false);
  }

  {
    const resetToken = deliveries[0].token;
    const resetRes = makeRes();
    await runtime._test.completePasswordReset(req({
      body: { token: resetToken, newPassword: 'new-password-123' },
      pathName: '/auth/password/reset/complete',
    }), resetRes);
    assert.equal(resetRes.statusCode, 200);
    assert.equal(resetRes.body.sessions_revoked, true);
    assert.equal(capabilityRevokes.length, 2);
    assert.deepEqual(new Set(capabilityRevokes.map(row => row.authSessionHash)), new Set([sessionHashOne, sessionHashTwo]));
    const override = runtime.passwordOverrideForUser(userId);
    assert.ok(override?.passwordHash);
    assert.equal(await passwordKdf.verifyPassword('new-password-123', { ...user, ...override }), true);
    assert.equal(await passwordKdf.verifyPassword('old-password', { ...user, ...override }), false);
    passwordKdf.setPasswordAuthorityResolver(userKey => userKey === userId ? runtime.passwordOverrideForUser(userKey) : null);
    assert.equal(await passwordKdf.verifyPassword('new-password-123', user), true);
    assert.equal(await passwordKdf.verifyPassword('old-password', user), false);
    passwordKdf.setPasswordAuthorityResolver(null);
    const reused = makeRes();
    await runtime._test.completePasswordReset(req({
      body: { token: resetToken, newPassword: 'another-password' },
      pathName: '/auth/password/reset/complete',
    }), reused);
    assert.equal(reused.statusCode, 400);
    assert.equal(reused.body.code, 'PASSWORD_RESET_INVALID');
    assert.equal(Object.keys(runtime._test.accountsSnapshot().sessions).length, 0);
  }

  {
    const emailToken = runtime._test.issueTestToken({ kind: 'email_verification', user, email: user.email });
    assert.equal(JSON.stringify(runtime._test.stateSnapshot()).includes(emailToken), false);
    const verifiedRes = makeRes();
    runtime._test.confirmEmailVerification(req({ body: { token: emailToken }, pathName: '/auth/email/verification/confirm' }), verifiedRes);
    assert.equal(verifiedRes.statusCode, 200);
    assert.equal(verifiedRes.body.verified, true);
    const again = makeRes();
    runtime._test.confirmEmailVerification(req({ body: { token: emailToken }, pathName: '/auth/email/verification/confirm' }), again);
    assert.equal(again.statusCode, 400);
    assert.equal(runtime._test.publicStatusForUser(user).email_verified, true);

    const expired = runtime._test.issueTestToken({ kind: 'email_verification', user, email: user.email });
    clock += 11 * 60 * 1000;
    const expiredRes = makeRes();
    runtime._test.confirmEmailVerification(req({ body: { token: expired }, pathName: '/auth/email/verification/confirm' }), expiredRes);
    assert.equal(expiredRes.statusCode, 400);
    clock -= 11 * 60 * 1000;
  }

  let recoveryCode;
  {
    const codes = runtime._test.generateRecoveryCodes(userId);
    assert.equal(codes.length, 8);
    recoveryCode = codes[0];
    assert.ok(recoveryCode.startsWith(RECOVERY_PREFIX));
    assert.equal(JSON.stringify(runtime._test.stateSnapshot()).includes(recoveryCode), false);
    assert.equal(runtime._test.validateRecoveryCode(userId, recoveryCode), true);
    assert.equal(runtime._test.validateRecoveryCode(userId, recoveryCode, { consume: true }), true);
    assert.equal(runtime._test.validateRecoveryCode(userId, recoveryCode), false);
    recoveryCode = codes[1];
  }

  fs.writeFileSync(path.join(dir, 'accounts-data.json'), JSON.stringify({
    users: [user],
    sessions: { [sessionHashOne]: { userId, createdAt: clock - 1000, expiresAt: clock + 1000000 } },
  }, null, 2));
  runtime._test.revokedSessionHashes.delete(sessionHashOne);

  let reauthToken;
  {
    const reauthRes = makeRes();
    await runtime._test.reauthenticate(req({
      token: sessionOne,
      body: { password: 'new-password-123', recoveryCode },
      pathName: '/auth/reauth',
    }), reauthRes);
    assert.equal(reauthRes.statusCode, 200);
    assert.match(reauthRes.body.reauth_token, /^reauth_/);
    reauthToken = reauthRes.body.reauth_token;
    assert.equal(runtime._test.validateRecoveryCode(userId, recoveryCode), false);
  }

  {
    const exportRes = makeRes();
    runtime._test.exportAccount(req({ token: sessionOne, body: { reauthToken }, pathName: '/auth/account/export' }), exportRes);
    assert.equal(exportRes.statusCode, 200);
    const serialized = JSON.stringify(exportRes.body);
    assert.equal(serialized.includes(passwordHash), false);
    assert.equal(serialized.includes('must-not-export'), false);
    assert.equal(serialized.includes(user.mfaSecret), false);
    assert.equal(exportRes.body.export.providers[0].provider, 'google');
  }

  {
    const replayRes = makeRes();
    runtime._test.exportAccount(req({ token: sessionOne, body: { reauthToken } }), replayRes);
    assert.equal(replayRes.statusCode, 401);
    assert.equal(replayRes.body.code, 'REAUTH_REQUIRED');
  }

  {
    const codes = runtime._test.generateRecoveryCodes(userId);
    const reauthRes = makeRes();
    await runtime._test.reauthenticate(req({
      token: sessionOne,
      body: { password: 'new-password-123', recoveryCode: codes[0] },
      pathName: '/auth/reauth',
    }), reauthRes);
    reauthToken = reauthRes.body.reauth_token;
  }

  {
    const beforeRevokes = capabilityRevokes.length;
    const deleteRes = makeRes();
    await runtime._test.deleteAccount(req({ token: sessionOne, body: { reauthToken }, pathName: '/auth/account/delete' }), deleteRes);
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deleteRes.body.deleted, true);
    assert.equal(deleteRes.body.receipt.retention_days, 30);
    assert.match(deleteRes.body.receipt.id, /^delete_/);
    assert.ok(capabilityRevokes.length > beforeRevokes);
    const accounts = readJson(path.join(dir, 'accounts-data.json'));
    assert.equal(accounts.users.some(row => row.id === userId), false);
    assert.equal(Object.values(accounts.sessions || {}).some(row => row.userId === userId), false);
    const cloud = readJson(path.join(dir, 'cloud-data.json'));
    assert.equal(Object.keys(cloud.linkedAccounts || {}).includes('install_a'), false);
    assert.equal(Object.keys(cloud.uploadedFiles || {}).includes('f1'), false);
    const lifecycle = runtime._test.stateSnapshot();
    assert.ok(lifecycle.tombstones[userId]);
    assert.equal(JSON.stringify(lifecycle.tombstones[userId]).includes(user.email), false);
  }

  {
    const blockedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-retention-required-'));
    const blockedToken = 'blocked-session';
    const blockedHash = sha256(blockedToken);
    const blockedSalt = 'ffeeddccbbaa99887766554433221100';
    const blockedPasswordHash = await passwordKdf.hashPassword('blocked-password', blockedSalt);
    fs.writeFileSync(path.join(blockedDir, 'accounts-data.json'), JSON.stringify({
      users: [{ id: 'usr_blocked', username: 'blocked#0001', email: 'blocked@example.com', passwordSalt: blockedSalt, passwordHash: blockedPasswordHash }],
      sessions: { [blockedHash]: { userId: 'usr_blocked', createdAt: clock - 1, expiresAt: clock + 100000 } },
    }));
    const blockedRuntime = createAccountLifecycleRuntime({
      dataDir: blockedDir,
      now: () => clock,
      env: {},
      getCapabilityStore: () => ({ revokeAuthSession: async () => 1 }),
    });
    assert.equal(blockedRuntime.deliveryConfigured, false);
    assert.equal(blockedRuntime.retentionConfigured, false);
    const grant = blockedRuntime._test.issueReauth('usr_blocked', blockedHash, 'password');
    const blockedRes = makeRes();
    await blockedRuntime._test.deleteAccount(req({ token: blockedToken, body: { reauthToken: grant } }), blockedRes);
    assert.equal(blockedRes.statusCode, 503);
    assert.equal(blockedRes.body.code, 'ACCOUNT_RETENTION_POLICY_REQUIRED');
    assert.equal(blockedRuntime._test.accountsSnapshot().users.length, 1);
    fs.rmSync(blockedDir, { recursive: true, force: true });
  }

  {
    const providerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-provider-reauth-'));
    const providerToken = 'provider-session';
    const providerHash = sha256(providerToken);
    fs.writeFileSync(path.join(providerDir, 'accounts-data.json'), JSON.stringify({
      users: [{ id: 'usr_provider', username: 'provider#0001', email: 'provider@example.com', providers: { google: { id: 'g' } } }],
      sessions: { [providerHash]: { userId: 'usr_provider', createdAt: clock - 1, expiresAt: clock + 100000 } },
    }));
    const providerRuntime = createAccountLifecycleRuntime({ dataDir: providerDir, now: () => clock, env: {} });
    const providerRes = makeRes();
    await providerRuntime._test.reauthenticate(req({ token: providerToken, body: {} }), providerRes);
    assert.equal(providerRes.statusCode, 409);
    assert.equal(providerRes.body.code, 'PROVIDER_REAUTH_REQUIRED');
    fs.rmSync(providerDir, { recursive: true, force: true });
  }

  {
    const authorityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-password-authority-'));
    const authorityUserId = 'usr_authority';
    const authorityOldSalt = '11112222333344445555666677778888';
    const authorityOldHash = await passwordKdf.hashPassword('authority-old', authorityOldSalt);
    const authoritySession = 'authority-session';
    const authoritySessionHash = sha256(authoritySession);
    const authorityUser = {
      id: authorityUserId,
      username: 'authority#0001',
      email: 'authority@example.com',
      passwordSalt: authorityOldSalt,
      passwordHash: authorityOldHash,
    };
    fs.writeFileSync(path.join(authorityDir, 'accounts-data.json'), JSON.stringify({
      users: [authorityUser],
      sessions: { [authoritySessionHash]: { userId: authorityUserId, createdAt: clock - 1, expiresAt: clock + 100000 } },
    }));
    const authorityRuntime = createAccountLifecycleRuntime({
      dataDir: authorityDir,
      now: () => clock,
      env: {},
      getCapabilityStore: () => ({ revokeAuthSession: async () => 1 }),
    });
    installLifecyclePasswordAuthority(authorityRuntime);
    const resetToken = authorityRuntime._test.issueTestToken({ kind: 'password_reset', user: authorityUser, email: authorityUser.email });
    const resetRes = makeRes();
    await authorityRuntime._test.completePasswordReset(req({ body: { token: resetToken, newPassword: 'authority-reset' } }), resetRes);
    assert.equal(resetRes.statusCode, 200);
    const resetOverride = authorityRuntime.passwordOverrideForUser(authorityUserId);
    assert.ok(resetOverride?.passwordHash);
    assert.equal(resetOverride.previousPasswordHash, authorityOldHash);

    const staleWrite = authorityRuntime._test.filterAccountsValue({ users: [{ ...authorityUser }], sessions: {} });
    assert.equal(staleWrite.users[0].passwordHash, resetOverride.passwordHash, 'stale in-memory password cannot revert a completed reset');
    assert.ok(authorityRuntime.passwordOverrideForUser(authorityUserId));

    const laterSalt = '99990000aaaabbbbccccddddeeeeffff';
    const laterHash = await passwordKdf.hashPassword('authority-later', laterSalt);
    const newerWrite = authorityRuntime._test.filterAccountsValue({
      users: [{ ...authorityUser, passwordSalt: laterSalt, passwordHash: laterHash }],
      sessions: {},
    });
    assert.equal(newerWrite.users[0].passwordHash, laterHash, 'a later authenticated password change must supersede reset authority');
    assert.equal(authorityRuntime.passwordOverrideForUser(authorityUserId), null);
    fs.rmSync(authorityDir, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('account-lifecycle: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
