'use strict';

const assert = require('node:assert/strict');
const {
  LEGACY_SAVE_USERS,
  STABLE_SAVE_USERS,
  LEGACY_LOGIN_LOOKUP,
  EMAIL_ONLY_LOGIN_LOOKUP,
  hardenCoreSource,
  installServerCoreAuthBridgeLoader,
} = require('../server-core-auth-bridge-loader');

function representativeCore(extra = '') {
  return [
    'function generateBeatGalerHandle(rawBase) {}',
    'function saveAuthData() {',
    `  const payload = { ${LEGACY_SAVE_USERS} sessions: Object.fromEntries(authSessions) };`,
    '}',
    'async function ensureUserStorage(user) {}',
    'function bindInstallationToBeatGalerUser(user, beatgalerUserId) {}',
    'function createAuthSession(userId) {}',
    'function accountPublicPayload(user, token) {}',
    'app.post("/auth/login", async (req, res) => {',
    LEGACY_LOGIN_LOOKUP,
    '});',
    extra,
  ].join('\n');
}

{
  const hardened = hardenCoreSource(representativeCore());
  assert.equal(hardened.includes(LEGACY_SAVE_USERS), false);
  assert.equal(hardened.includes(STABLE_SAVE_USERS), true);
  assert.equal((hardened.match(/beatGalerUsersById\.values\(\)/g) || []).length, 1);
  assert.equal(hardened.includes(LEGACY_LOGIN_LOOKUP), false);
  assert.equal(hardened.includes(EMAIL_ONLY_LOGIN_LOOKUP), true);
  assert.equal(hardened.includes('req.body?.username'), false);
}

{
  assert.throws(
    () => hardenCoreSource(representativeCore(`const duplicate = { ${LEGACY_SAVE_USERS} };`)),
    error => error?.code === 'SERVER_CORE_STABLE_ID_PATCH_AMBIGUOUS',
  );
}

{
  assert.throws(
    () => hardenCoreSource(representativeCore(LEGACY_LOGIN_LOOKUP)),
    error => error?.code === 'SERVER_CORE_EMAIL_LOGIN_PATCH_AMBIGUOUS',
  );
}

{
  const missingMarker = representativeCore().replace('async function ensureUserStorage(user) {}', '');
  assert.throws(
    () => hardenCoreSource(missingMarker),
    error => error?.code === 'SERVER_CORE_AUTH_BRIDGE_INCOMPATIBLE',
  );
}

{
  const restore = installServerCoreAuthBridgeLoader({ exposeBridge: true });
  assert.equal(typeof restore, 'function');
  restore();
}

console.log('server-core auth bridge loader tests: PASS');
