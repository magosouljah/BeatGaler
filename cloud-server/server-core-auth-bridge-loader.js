'use strict';

const fs = require('node:fs');

const TARGET = require.resolve('./server-core');
const REQUIRED_MARKERS = Object.freeze([
  'function generateBeatGalerHandle(rawBase)',
  'function saveAuthData()',
  'async function ensureUserStorage(user)',
  'function bindInstallationToBeatGalerUser(user, beatgalerUserId)',
  'function createAuthSession(userId)',
  'function accountPublicPayload(user, token)',
]);

function validateCoreSource(source) {
  const text = String(source || '');
  const missing = REQUIRED_MARKERS.filter(marker => !text.includes(marker));
  if (missing.length) {
    const error = new Error(`server-core auth bridge markers changed: ${missing.join(', ')}`);
    error.code = 'SERVER_CORE_AUTH_BRIDGE_INCOMPATIBLE';
    throw error;
  }
  return true;
}

function bridgeSuffix() {
  return `

;module.exports.__beatgalerAuthBridge = Object.freeze({
  adoptOrCreatePasswordUser(input = {}) {
    const userId = String(input.id || '').trim();
    const email = normalizeEmail(input.email);
    const passwordHash = String(input.passwordHash || '').trim();
    const passwordSalt = String(input.passwordSalt || '').trim();
    if (!userId || !email || !passwordHash || !passwordSalt) {
      const error = new Error('Stable id, email and password material are required for activation.');
      error.code = 'AUTH_BRIDGE_USER_INPUT_INVALID';
      throw error;
    }

    const existingById = beatGalerUsersById.get(userId) || null;
    if (existingById) {
      if (normalizeEmail(existingById.email) !== email) {
        const error = new Error('Stable user id already exists with a different email.');
        error.code = 'AUTH_BRIDGE_USER_ID_CONFLICT';
        throw error;
      }
      return {
        created: false,
        userId: existingById.id,
        username: existingById.username,
        storageReady: Boolean(existingById.storageChatId),
      };
    }

    const emailOwner = findUserByEmail(email);
    if (emailOwner && String(emailOwner.id) !== userId) {
      const error = new Error('Email already belongs to another BeatGaler user.');
      error.code = 'AUTH_BRIDGE_EMAIL_CONFLICT';
      throw error;
    }

    let username = normalizeBeatGalerUsername(input.username || '');
    if (!username) username = generateBeatGalerHandle(input.usernameBase);
    if (!validBeatGalerUsername(username)) {
      const error = new Error('Activation username is invalid.');
      error.code = 'AUTH_BRIDGE_USERNAME_INVALID';
      throw error;
    }
    const usernameOwner = beatGalerUsers.get(username);
    if (usernameOwner && String(usernameOwner.id) !== userId) {
      const error = new Error('Activation username is already owned by another user.');
      error.code = 'AUTH_BRIDGE_USERNAME_CONFLICT';
      throw error;
    }

    const user = {
      id: userId,
      username,
      usernameSource: String(input.usernameSource || 'beatgaler'),
      email,
      passwordSalt,
      passwordHash,
      createdAt: Number(input.createdAt || Date.now()),
      storageChatId: input.storageChatId == null ? null : String(input.storageChatId),
      storageChatTitle: input.storageChatTitle || null,
      storageCreatedAt: input.storageCreatedAt || null,
      providers: input.providers && typeof input.providers === 'object' ? input.providers : {},
    };
    ensurePlanState(user, { newAccount: false });
    beatGalerUsers.set(username, user);
    beatGalerUsersById.set(user.id, user);
    saveAuthData();
    return { created: true, userId: user.id, username: user.username, storageReady: Boolean(user.storageChatId) };
  },

  adoptAuthoritativeUser(input = {}) {
    const userId = String(input.id || '').trim();
    if (!userId) throw Object.assign(new Error('Stable user id is required.'), { code: 'AUTH_BRIDGE_USER_INPUT_INVALID' });
    const current = beatGalerUsersById.get(userId) || null;
    if (current) return { userId: current.id, username: current.username, storageReady: Boolean(current.storageChatId) };
    return this.adoptOrCreatePasswordUser(input);
  },

  userState(userId) {
    const user = beatGalerUsersById.get(String(userId || '')) || null;
    if (!user) return null;
    return {
      userId: user.id,
      username: user.username,
      email: user.email || null,
      storageReady: Boolean(user.storageChatId),
      storageChatId: user.storageChatId || null,
      storageChatTitle: user.storageChatTitle || null,
    };
  },

  async ensureStorage(userId) {
    const user = beatGalerUsersById.get(String(userId || '')) || null;
    if (!user) throw Object.assign(new Error('Activation user is not loaded in this process.'), { code: 'AUTH_BRIDGE_USER_NOT_LOADED' });
    await ensureUserStorage(user);
    return this.userState(user.id);
  },

  bindInstallation(userId, installationId) {
    const user = beatGalerUsersById.get(String(userId || '')) || null;
    if (!user) throw Object.assign(new Error('Activation user is not loaded in this process.'), { code: 'AUTH_BRIDGE_USER_NOT_LOADED' });
    bindInstallationToBeatGalerUser(user, String(installationId || ''));
    return true;
  },

  createSession(userId) {
    const user = beatGalerUsersById.get(String(userId || '')) || null;
    if (!user) throw Object.assign(new Error('Activation user is not loaded in this process.'), { code: 'AUTH_BRIDGE_USER_NOT_LOADED' });
    return createAuthSession(user.id);
  },

  async publicPayload(userId, token) {
    const user = beatGalerUsersById.get(String(userId || '')) || null;
    if (!user) throw Object.assign(new Error('Activation user is not loaded in this process.'), { code: 'AUTH_BRIDGE_USER_NOT_LOADED' });
    return accountPublicPayload(user, token);
  },
});
`;
}

function installServerCoreAuthBridgeLoader() {
  if (require.cache[TARGET]?.exports?.__beatgalerAuthBridge) {
    return () => {};
  }
  const previous = require.extensions['.js'];
  if (typeof previous !== 'function') throw new Error('Node CommonJS .js loader is unavailable.');
  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    if (require.extensions['.js'] === hooked) require.extensions['.js'] = previous;
  }
  function hooked(mod, filename) {
    if (filename !== TARGET) return previous(mod, filename);
    restore();
    const source = fs.readFileSync(filename, 'utf8');
    validateCoreSource(source);
    mod._compile(`${source}${bridgeSuffix()}`, filename);
  }
  require.extensions['.js'] = hooked;
  return restore;
}

function getServerCoreAuthBridge() {
  return require.cache[TARGET]?.exports?.__beatgalerAuthBridge || null;
}

module.exports = {
  TARGET,
  REQUIRED_MARKERS,
  validateCoreSource,
  bridgeSuffix,
  installServerCoreAuthBridgeLoader,
  getServerCoreAuthBridge,
};
