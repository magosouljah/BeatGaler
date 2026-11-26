'use strict';

const { sha256String: sha256, normalizeEmail, bearerTokenOptionalRequest: bearerToken, ACCOUNTS_FILE_NAME, accountsDataPath } = require('./auth-helpers');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const passwordKdf = require('./password-kdf');
const { statusForUser, markVerifiedEmail, clearVerifiedEmail } = require('./email-verification-authority');
const { IdentitySnapshot, virtualIdentity } = require('./identity-store');

const STATE_VERSION = 1;
const STATE_FILE_NAME = 'account-lifecycle-state.json';
const CLOUD_DATA_FILE_NAME = 'cloud-data.json';
const DEFAULT_EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REAUTH_TTL_MS = 5 * 60 * 1000;
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_PREFIX = 'rcv_';
const REAUTH_PREFIX = 'reauth_';
const EMAIL_VERIFY_PREFIX = 'verify_';
const PASSWORD_RESET_PREFIX = 'reset_';
const SAFE_PUBLIC_AUTH_ROUTES = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/email/verification/request',
  '/auth/email/verification/confirm',
  '/auth/password/reset/request',
  '/auth/password/reset/complete',
]);
const USER_DECORATION_ROUTES = new Set([
  '/auth/register',
  '/auth/login',
  '/auth/session',
  '/auth/account',
  '/auth/email/change',
]);
const NOTIFICATION_ROUTES = new Map([
  ['/auth/password/change', 'password_changed'],
  ['/auth/mfa/enable', 'mfa_enabled'],
  ['/auth/mfa/disable', 'mfa_disabled'],
  ['/auth/oauth/disconnect', 'provider_disconnected'],
]);

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function randomToken(prefix, randomBytes = size => crypto.randomBytes(size)) {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Envoltorio de fs de auth-public-registration-hardening.js (M7.4e: entrega del valor ya filtrado).
const REGISTRATION_FS_PATCH = Symbol.for('beatgaler.authPublicRegistration.fsPatch');

// Cierto si JSON.parse(JSON.stringify(root)) daría un árbol equivalente e independiente: solo null,
// cadenas, booleanos, números finitos (-0 pasa a 0, indistinguible para el filtro de registro),
// arrays y objetos con el prototipo estándar, cada objeto una sola vez (sin alias ni ciclos); un
// hueco, undefined o una función (p. ej. toJSON propio) lo descartan. Como JSON.parse, presupone
// propiedades de datos enumerables y prototipos sin alterar.
function isCanonicalJsonTree(root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      for (let index = 0; index < value.length; index += 1) stack.push(value[index]);
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      for (const key of Object.keys(value)) stack.push(value[key]);
    }
  }
  return true;
}

function clampTtl(value, fallback, min, max) {
  const parsed = Number(value);
  const picked = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, picked));
}

function validPassword(value) {
  const text = String(value || '');
  return text.length >= 8 && text.length <= 200;
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value || '').replace(/=+$/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) return Buffer.alloc(0);
    bits += index.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function totpCode(secret, atMs = Date.now()) {
  const key = base32Decode(secret);
  if (!key.length) return '';
  const counter = Math.floor(Number(atMs) / 30000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code, now = Date.now()) {
  const normalized = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  return [-1, 0, 1].some(step => {
    const expected = Buffer.from(totpCode(secret, now + step * 30000));
    const actual = Buffer.from(normalized);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  });
}

function normalizeState(input) {
  const state = input && typeof input === 'object' ? input : {};
  return {
    version: STATE_VERSION,
    tokens: state.tokens && typeof state.tokens === 'object' && !Array.isArray(state.tokens) ? state.tokens : {},
    recovery: state.recovery && typeof state.recovery === 'object' && !Array.isArray(state.recovery) ? state.recovery : {},
    reauth: state.reauth && typeof state.reauth === 'object' && !Array.isArray(state.reauth) ? state.reauth : {},
    password_overrides: state.password_overrides && typeof state.password_overrides === 'object' && !Array.isArray(state.password_overrides) ? state.password_overrides : {},
    revoked_session_hashes: Array.isArray(state.revoked_session_hashes)
      ? state.revoked_session_hashes.filter(value => /^[0-9a-f]{64}$/.test(String(value)))
      : [],
    notifications: state.notifications && typeof state.notifications === 'object' && !Array.isArray(state.notifications) ? state.notifications : {},
    tombstones: state.tombstones && typeof state.tombstones === 'object' && !Array.isArray(state.tombstones) ? state.tombstones : {},
  };
}

function createAccountLifecycleRuntime({
  dataDir = require('./state-dir').STATE_DIR,
  env = process.env,
  now = () => Date.now(),
  randomBytes = size => crypto.randomBytes(size),
  emailNotifier = null,
  pool = null,
  getCapabilityStore = () => null,
} = {}) {
  const stateFile = path.join(dataDir, STATE_FILE_NAME);
  const accountsFile = accountsDataPath(dataDir);
  const cloudDataFile = path.join(dataDir, CLOUD_DATA_FILE_NAME);
  const persisted = normalizeState(readJson(stateFile, {}));
  const deletedUserIds = new Set(Object.keys(persisted.tombstones || {}));
  const revokedSessionHashes = new Set(persisted.revoked_session_hashes);
  const emailVerifyTtlMs = clampTtl(env.BEATGALER_EMAIL_VERIFY_TTL_MS, DEFAULT_EMAIL_VERIFY_TTL_MS, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
  const resetTtlMs = clampTtl(env.BEATGALER_PASSWORD_RESET_TTL_MS, DEFAULT_PASSWORD_RESET_TTL_MS, 5 * 60 * 1000, 60 * 60 * 1000);
  const reauthTtlMs = clampTtl(env.BEATGALER_REAUTH_TTL_MS, DEFAULT_REAUTH_TTL_MS, 60 * 1000, 15 * 60 * 1000);
  const retentionValue = String(env.BEATGALER_ACCOUNT_TOMBSTONE_RETENTION_DAYS ?? '').trim();
  const retentionDays = retentionValue === '' ? null : Number(retentionValue);
  const retentionConfigured = Number.isInteger(retentionDays) && retentionDays >= 0 && retentionDays <= 3650;
  const deliveryConfigured = typeof emailNotifier === 'function';

  function stateSnapshot() { return persisted; }

  function saveState() {
    persisted.revoked_session_hashes = [...revokedSessionHashes].sort();
    atomicWriteJson(stateFile, persisted);
  }

  function accountsSnapshot() {
    const identity = virtualIdentity(fs, accountsFile);
    return identity ? identity.copy() : readAccountsFile();
  }

  function readAccountsFile() {
    const value = readJson(accountsFile, {});
    return {
      users: Array.isArray(value?.users) ? value.users : [],
      sessions: value?.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions) ? value.sessions : {},
    };
  }

  function accountsRead() {
    return virtualIdentity(fs, accountsFile) || readAccountsFile();
  }

  function cloudSnapshot() {
    const value = readJson(cloudDataFile, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function userById(userId, snapshot = accountsRead()) {
    if (snapshot instanceof IdentitySnapshot) return snapshot.userById(userId);
    return snapshot.users.find(user => String(user?.id || '') === String(userId)) || null;
  }

  function userByEmail(email, snapshot = accountsRead()) {
    if (snapshot instanceof IdentitySnapshot) return snapshot.userByEmail(email);
    const normalized = normalizeEmail(email);
    return snapshot.users.find(user => normalizeEmail(user?.email) === normalized) || null;
  }

  function userByIdentifier(identifier, snapshot = accountsSnapshot()) {
    const normalized = normalizeIdentifier(identifier);
    return snapshot.users.find(user =>
      normalizeIdentifier(user?.username) === normalized || normalizeEmail(user?.email) === normalizeEmail(identifier)
    ) || null;
  }

  function sessionInfoFromRequest(req, snapshot = accountsRead()) {
    const token = bearerToken(req);
    if (!token) return null;
    const sessionHash = sha256(token);
    if (revokedSessionHashes.has(sessionHash)) return null;
    const session = snapshot instanceof IdentitySnapshot ? snapshot.session(sessionHash) : snapshot.sessions?.[sessionHash];
    if (!session || Number(session?.expiresAt || session?.expires_at || 0) <= now()) return null;
    const userId = String(session?.userId || session?.user_id || '');
    if (!userId || deletedUserIds.has(userId)) return null;
    const user = userById(userId, snapshot);
    if (!user) return null;
    return { token, sessionHash, session, user, userId };
  }

  async function publicStatusForUser(user) {
    const userId = String(user?.id || '');
    const verification = pool
      ? await statusForUser(pool, userId)
      : { email_verified: false, email_verified_at: null };
    return {
      ...verification,
      email_delivery_configured: deliveryConfigured,
      mfa_recovery_remaining: Array.isArray(persisted.recovery[userId]?.code_hashes) ? persisted.recovery[userId].code_hashes.length : 0,
      retention_policy_configured: retentionConfigured,
    };
  }

  function addNotification(userId, type, details = {}) {
    const id = `notice_${randomBytes(10).toString('hex')}`;
    const rows = Array.isArray(persisted.notifications[userId]) ? persisted.notifications[userId] : [];
    rows.push({
      id,
      type: String(type),
      created_at: new Date(now()).toISOString(),
      details: details && typeof details === 'object' ? details : {},
    });
    persisted.notifications[userId] = rows.slice(-100);
    saveState();
    return id;
  }

  function cleanupExpiredTokens() {
    const current = now();
    for (const [tokenHash, record] of Object.entries(persisted.tokens)) {
      if (Number(record?.expires_at_ms || 0) <= current || record?.consumed_at) delete persisted.tokens[tokenHash];
    }
    for (const [grantHash, record] of Object.entries(persisted.reauth)) {
      if (Number(record?.expires_at_ms || 0) <= current || record?.consumed_at) delete persisted.reauth[grantHash];
    }
  }

  async function issueEmailToken({ kind, user, email }) {
    cleanupExpiredTokens();
    const prefix = kind === 'password_reset' ? PASSWORD_RESET_PREFIX : EMAIL_VERIFY_PREFIX;
    const ttl = kind === 'password_reset' ? resetTtlMs : emailVerifyTtlMs;
    const token = randomToken(prefix, randomBytes);
    const tokenHash = sha256(token);
    const targetEmail = normalizeEmail(email || user?.email);
    persisted.tokens[tokenHash] = {
      kind,
      user_id: String(user?.id || ''),
      email_hash: sha256(targetEmail),
      issued_at_ms: now(),
      expires_at_ms: now() + ttl,
    };
    saveState();
    if (!deliveryConfigured) return { issued: true, delivered: false, token: null, expires_at_ms: now() + ttl };
    try {
      await emailNotifier({ kind, to: targetEmail, token, expires_at: new Date(now() + ttl).toISOString() });
      return { issued: true, delivered: true, token: null, expires_at_ms: now() + ttl };
    } catch {
      delete persisted.tokens[tokenHash];
      saveState();
      return { issued: false, delivered: false, token: null, expires_at_ms: null };
    }
  }

  function issueTestToken({ kind, user, email }) {
    cleanupExpiredTokens();
    const prefix = kind === 'password_reset' ? PASSWORD_RESET_PREFIX : EMAIL_VERIFY_PREFIX;
    const ttl = kind === 'password_reset' ? resetTtlMs : emailVerifyTtlMs;
    const token = randomToken(prefix, randomBytes);
    persisted.tokens[sha256(token)] = {
      kind,
      user_id: String(user?.id || ''),
      email_hash: sha256(normalizeEmail(email || user?.email)),
      issued_at_ms: now(),
      expires_at_ms: now() + ttl,
    };
    saveState();
    return token;
  }

  function consumeToken(rawToken, expectedKind) {
    cleanupExpiredTokens();
    const tokenHash = sha256(rawToken);
    const record = persisted.tokens[tokenHash];
    if (!record || record.kind !== expectedKind || record.consumed_at || Number(record.expires_at_ms || 0) <= now()) return null;
    record.consumed_at = new Date(now()).toISOString();
    delete persisted.tokens[tokenHash];
    saveState();
    return { ...record };
  }

  function generateRecoveryCodes(userId) {
    const rawCodes = [];
    const hashes = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
      const code = `${RECOVERY_PREFIX}${randomBytes(10).toString('hex')}`;
      rawCodes.push(code);
      hashes.push(sha256(code));
    }
    persisted.recovery[userId] = { code_hashes: hashes, issued_at: new Date(now()).toISOString() };
    saveState();
    return rawCodes;
  }

  function validateRecoveryCode(userId, rawCode, { consume = false } = {}) {
    const record = persisted.recovery[userId];
    const codeHash = sha256(rawCode);
    const index = Array.isArray(record?.code_hashes) ? record.code_hashes.indexOf(codeHash) : -1;
    if (index < 0) return false;
    if (consume) {
      record.code_hashes.splice(index, 1);
      saveState();
    }
    return true;
  }

  async function verifyUserPassword(user, password) {
    const override = persisted.password_overrides[String(user?.id || '')] || null;
    return passwordKdf.verifyPassword(password, override ? { ...user, ...override } : user);
  }

  function verifySecondFactor(user, code, { consumeRecovery = false } = {}) {
    const raw = String(code || '').trim();
    if (!user?.mfaSecret) return { ok: true, method: 'none' };
    if (verifyTotp(user.mfaSecret, raw, now())) return { ok: true, method: 'totp' };
    if (raw.startsWith(RECOVERY_PREFIX) && validateRecoveryCode(String(user.id), raw, { consume: consumeRecovery })) return { ok: true, method: 'recovery' };
    return { ok: false, method: null };
  }

  function issueReauth(userId, sessionHash, method) {
    const token = randomToken(REAUTH_PREFIX, randomBytes);
    persisted.reauth[sha256(token)] = {
      user_id: String(userId),
      session_hash: String(sessionHash),
      method,
      issued_at_ms: now(),
      expires_at_ms: now() + reauthTtlMs,
    };
    saveState();
    return token;
  }

  function consumeReauth(req, rawGrant) {
    cleanupExpiredTokens();
    const info = sessionInfoFromRequest(req);
    if (!info) return { ok: false, code: 'SESSION_REQUIRED' };
    const hash = sha256(rawGrant);
    const grant = persisted.reauth[hash];
    if (!grant || grant.consumed_at || Number(grant.expires_at_ms || 0) <= now()) return { ok: false, code: 'REAUTH_REQUIRED' };
    if (grant.user_id !== info.userId || grant.session_hash !== info.sessionHash) return { ok: false, code: 'REAUTH_SCOPE_DENIED' };
    grant.consumed_at = new Date(now()).toISOString();
    delete persisted.reauth[hash];
    saveState();
    return { ok: true, info, method: grant.method };
  }

  async function revokeUserSessions(userId, reason) {
    const snapshot = accountsSnapshot();
    const localHashes = Object.entries(snapshot.sessions)
      .filter(([, session]) => String(session?.userId || session?.user_id || '') === String(userId))
      .map(([sessionHash]) => sessionHash);
    const durable = pool
      ? await pool.query('SELECT session_key_hash FROM auth_sessions WHERE user_id=$1', [String(userId)])
      : { rows: [] };
    const hashes = [...new Set([...localHashes, ...durable.rows.map(row => String(row.session_key_hash))])];
    const store = getCapabilityStore?.();
    if (hashes.length && (!store || typeof store.revokeAuthSession !== 'function')) {
      const error = new Error('Capability revocation store is unavailable.');
      error.code = 'DIRECT_CAPABILITY_REVOKE_FAILED';
      throw error;
    }
    for (const sessionHash of hashes) await store.revokeAuthSession({ authSessionHash: sessionHash, reason });
    if (pool) {
      await pool.query("UPDATE direct_capabilities SET status='REVOKED',revoked_at=now(),revoke_reason=$2 WHERE user_id=$1 AND status IN ('ACTIVE','AUTHORIZED')", [String(userId), String(reason)]);
      await pool.query('DELETE FROM auth_sessions WHERE user_id=$1', [String(userId)]);
    }
    for (const sessionHash of hashes) revokedSessionHashes.add(sessionHash);
    saveState();
    scrubAccountsFile();
    return hashes.length;
  }

  function filterAccountsValue(value) {
    const parsed = value && typeof value === 'object' ? value : {};
    const users = (Array.isArray(parsed.users) ? parsed.users : []).filter(user => !deletedUserIds.has(String(user?.id || '')));
    const byId = new Map(users.map(user => [String(user?.id || ''), user]));
    for (const [userId, override] of Object.entries(persisted.password_overrides)) {
      const user = byId.get(userId);
      if (user && override?.passwordHash && override?.passwordSalt) {
        user.passwordHash = override.passwordHash;
        user.passwordSalt = override.passwordSalt;
      }
    }
    const sessions = {};
    for (const [sessionHash, session] of Object.entries(parsed.sessions || {})) {
      const userId = String(session?.userId || session?.user_id || '');
      if (deletedUserIds.has(userId) || revokedSessionHashes.has(sessionHash)) continue;
      sessions[sessionHash] = session;
    }
    return { ...parsed, users, sessions };
  }

  function scrubAccountsFile() {
    if (!fs.existsSync(accountsFile)) return;
    atomicWriteJson(accountsFile, filterAccountsValue(readJson(accountsFile, {})));
  }

  function filterCloudValue(value) {
    const parsed = value && typeof value === 'object' ? value : {};
    const linkedAccounts = { ...(parsed.linkedAccounts || {}) };
    const deletedInstallations = new Set();
    for (const [installationId, record] of Object.entries(linkedAccounts)) {
      if (deletedUserIds.has(String(record?.beatgalerAccountId || ''))) {
        deletedInstallations.add(String(installationId));
        delete linkedAccounts[installationId];
      }
    }
    const uploadedFiles = {};
    for (const [key, record] of Object.entries(parsed.uploadedFiles || {})) {
      if (!deletedInstallations.has(String(record?.beatgalerUserId || ''))) uploadedFiles[key] = record;
    }
    const keepPrefixed = source => {
      const output = {};
      for (const [key, record] of Object.entries(source || {})) {
        if (![...deletedInstallations].some(id => String(key).startsWith(`${id}:`))) output[key] = record;
      }
      return output;
    };
    return {
      ...parsed,
      linkedAccounts,
      uploadedFiles,
      beatTopics: keepPrefixed(parsed.beatTopics),
      pendingTopicDeletes: keepPrefixed(parsed.pendingTopicDeletes),
      messageRedirects: keepPrefixed(parsed.messageRedirects),
    };
  }

  function scrubCloudFile() {
    if (!fs.existsSync(cloudDataFile)) return;
    atomicWriteJson(cloudDataFile, filterCloudValue(readJson(cloudDataFile, {})));
  }

  function installPersistenceFilter() {
    const marker = Symbol.for('beatgaler.accountLifecyclePersistenceFilter');
    const state = fs[marker] || { installed: false, runtimes: new Set(), original: fs.writeFileSync };
    state.runtimes.add(runtimeApi);
    fs[marker] = state;
    if (state.installed) return;
    state.installed = true;
    fs.writeFileSync = function lifecycleFilteredWrite(file, data, ...rest) {
      let nextData = data;
      const fileText = String(file || '').replace(/\\/g, '/');
      const isAccounts = fileText.endsWith(`/${ACCOUNTS_FILE_NAME}.tmp`);
      if (typeof data === 'string' && (isAccounts || fileText.endsWith('/cloud-data.json.tmp'))) {
        // Fail closed: if parsing or any filter fails, nothing is written.
        let handoff = null;
        let parsed;
        try {
          parsed = JSON.parse(data);
          for (const runtime of state.runtimes) {
            parsed = isAccounts ? runtime.api.state.filterAccountsValue(parsed) : runtime.api.state.filterCloudValue(parsed);
          }
          // M7.4e: si el siguiente envoltorio es el filtro de registro, recibe el valor filtrado sin
          // serializar y volver a parsear. Solo con un árbol JSON canónico y sin alias, para el que
          // JSON.parse(JSON.stringify(parsed)) es un objeto igual: mismos bytes. Si no, se serializa.
          const registration = isAccounts ? fs[REGISTRATION_FS_PATCH] : null;
          if (registration && state.original === registration.wrapper && isCanonicalJsonTree(parsed)) handoff = registration;
          else nextData = JSON.stringify(parsed, null, 2);
        } catch (cause) {
          const error = new Error('Account lifecycle persistence filter failed; write aborted.');
          error.code = 'ACCOUNT_LIFECYCLE_FILTER_FAILED';
          error.cause = cause;
          throw error;
        }
        // Fuera del try, como la llamada a state.original: los fallos del registro conservan su código.
        if (handoff) return handoff.writeCanonicalAccounts(file, parsed, ...rest);
      }
      return state.original.call(fs, file, nextData, ...rest);
    };
  }

  async function decorateUserPayload(payload) {
    if (!payload?.user?.id) return payload;
    return { ...payload, user: { ...payload.user, ...await publicStatusForUser(payload.user) } };
  }

  async function requestEmailVerification(req, res) {
    const snapshot = accountsRead();
    const email = normalizeEmail(req?.body?.email);
    const session = sessionInfoFromRequest(req, snapshot);
    const user = session?.user || userByEmail(email, snapshot);
    if (user && !deletedUserIds.has(String(user.id))) {
      await issueEmailToken({ kind: 'email_verification', user, email: user.email });
      addNotification(String(user.id), 'email_verification_requested', { delivery_configured: deliveryConfigured });
    }
    return res.status(202).json({
      ok: true,
      message: 'If the address can be verified, verification instructions will be sent.',
      delivery_configured: deliveryConfigured,
    });
  }

  async function confirmEmailVerification(req, res) {
    const rawToken = String(req?.body?.token || '');
    const record = consumeToken(rawToken, 'email_verification');
    if (!record) return res.status(400).json({ error: 'Verification link is invalid or expired.', code: 'EMAIL_VERIFICATION_INVALID' });
    const user = userById(record.user_id);
    if (!user || sha256(normalizeEmail(user.email)) !== record.email_hash || deletedUserIds.has(String(user.id))) {
      return res.status(400).json({ error: 'Verification link is invalid or expired.', code: 'EMAIL_VERIFICATION_INVALID' });
    }
    try {
      await markVerifiedEmail(pool, String(user.id), user.email, { verifiedAt: new Date(now()) });
    } catch {
      // A failed durable verification must not consume the token; retry is safe.
      const retry = { ...record };
      delete retry.consumed_at;
      persisted.tokens[sha256(rawToken)] = retry;
      saveState();
      return res.status(503).json({ error: 'Account verification could not be completed. Retry.', code: 'EMAIL_VERIFICATION_RETRY' });
    }
    addNotification(String(user.id), 'email_verified');
    saveState();
    return res.json({ ok: true, verified: true });
  }

  async function requestPasswordReset(req, res) {
    const email = normalizeEmail(req?.body?.email || req?.body?.identifier);
    const user = userByEmail(email);
    if (user && !deletedUserIds.has(String(user.id))) {
      await issueEmailToken({ kind: 'password_reset', user, email: user.email });
      addNotification(String(user.id), 'password_reset_requested', { delivery_configured: deliveryConfigured });
    }
    return res.status(202).json({
      ok: true,
      message: 'If an account matches, password reset instructions will be sent.',
      delivery_configured: deliveryConfigured,
    });
  }

  async function completePasswordReset(req, res) {
    const rawToken = String(req?.body?.token || '');
    const newPassword = String(req?.body?.newPassword || '');
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'New password must be 8-200 characters.', code: 'PASSWORD_RESET_INVALID_PASSWORD' });
    const record = consumeToken(rawToken, 'password_reset');
    if (!record) return res.status(400).json({ error: 'Reset link is invalid or expired.', code: 'PASSWORD_RESET_INVALID' });
    const user = userById(record.user_id);
    if (!user || sha256(normalizeEmail(user.email)) !== record.email_hash || deletedUserIds.has(String(user.id))) {
      return res.status(400).json({ error: 'Reset link is invalid or expired.', code: 'PASSWORD_RESET_INVALID' });
    }
    const salt = randomBytes(16).toString('hex');
    const passwordHash = await passwordKdf.hashPassword(newPassword, salt);
    persisted.password_overrides[String(user.id)] = { passwordSalt: salt, passwordHash, updated_at: new Date(now()).toISOString() };
    try {
      await revokeUserSessions(String(user.id), 'password_reset');
    } catch {
      delete persisted.password_overrides[String(user.id)];
      saveState();
      return res.status(503).json({ error: 'Password reset could not safely revoke active sessions.', code: 'DIRECT_CAPABILITY_REVOKE_FAILED' });
    }
    addNotification(String(user.id), 'password_reset_completed');
    saveState();
    scrubAccountsFile();
    return res.json({ ok: true, sessions_revoked: true });
  }

  async function reauthenticate(req, res) {
    const info = sessionInfoFromRequest(req);
    if (!info) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'SESSION_REQUIRED' });
    const password = String(req?.body?.password || '');
    const mfaCode = String(req?.body?.mfaCode || req?.body?.recoveryCode || '');
    const hasPassword = Boolean(info.user?.passwordHash || persisted.password_overrides[info.userId]);
    if (!hasPassword) return res.status(409).json({ error: 'This account needs provider reauthentication before sensitive actions.', code: 'PROVIDER_REAUTH_REQUIRED' });
    if (!(await verifyUserPassword(info.user, password))) return res.status(401).json({ error: 'Reauthentication failed.', code: 'REAUTH_FAILED' });
    const second = verifySecondFactor(info.user, mfaCode, { consumeRecovery: true });
    if (!second.ok) return res.status(401).json({ error: 'Reauthentication failed.', code: 'REAUTH_FAILED' });
    const grant = issueReauth(info.userId, info.sessionHash, info.user.mfaSecret ? `password+${second.method}` : 'password');
    return res.json({ ok: true, reauth_token: grant, expires_in_ms: reauthTtlMs });
  }

  function regenerateRecovery(req, res) {
    const result = consumeReauth(req, String(req?.body?.reauthToken || req?.headers?.['x-beatgaler-reauth'] || ''));
    if (!result.ok) return res.status(401).json({ error: 'Recent reauthentication is required.', code: result.code });
    const codes = generateRecoveryCodes(result.info.userId);
    addNotification(result.info.userId, 'mfa_recovery_regenerated');
    return res.json({ ok: true, recovery_codes: codes });
  }

  function listNotifications(req, res) {
    const info = sessionInfoFromRequest(req);
    if (!info) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'SESSION_REQUIRED' });
    const rows = Array.isArray(persisted.notifications[info.userId]) ? persisted.notifications[info.userId] : [];
    return res.json({ ok: true, notifications: rows.slice(-50).reverse() });
  }

  async function lifecycleStatus(req, res) {
    const info = sessionInfoFromRequest(req);
    if (!info) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'SESSION_REQUIRED' });
    return res.json({ ok: true, ...await publicStatusForUser(info.user) });
  }

  function sanitizedProvider(provider, value) {
    if (!value || typeof value !== 'object') return null;
    const out = { provider, connected: true };
    for (const key of ['id', 'email', 'name', 'username', 'profileSyncedAt', 'tokenExpiresAt']) if (value[key] != null) out[key] = value[key];
    return out;
  }

  async function exportAccount(req, res) {
    const result = consumeReauth(req, String(req?.body?.reauthToken || req?.headers?.['x-beatgaler-reauth'] || ''));
    if (!result.ok) return res.status(401).json({ error: 'Recent reauthentication is required.', code: result.code });
    const user = result.info.user;
    const providers = Object.entries(user.providers || {}).map(([provider, value]) => sanitizedProvider(provider, value)).filter(Boolean);
    const cloud = cloudSnapshot();
    const linkedInstallations = Object.entries(cloud.linkedAccounts || {})
      .filter(([, record]) => String(record?.beatgalerAccountId || '') === result.info.userId)
      .map(([installationId, record]) => ({
        installation_id: installationId,
        storage_chat_id: record?.storageChatId ?? null,
        storage_chat_title: record?.storageChatTitle ?? null,
      }));
    const receiptId = `export_${randomBytes(12).toString('hex')}`;
    addNotification(result.info.userId, 'account_exported', { receipt_id: receiptId });
    return res.json({
      ok: true,
      receipt_id: receiptId,
      exported_at: new Date(now()).toISOString(),
      export: {
        account: {
          id: user.id,
          username: user.username,
          email: user.email ?? null,
          created_at: user.createdAt ?? null,
          email_verified: (await publicStatusForUser(user)).email_verified,
          mfa_enabled: Boolean(user.mfaSecret),
        },
        providers,
        linked_installations: linkedInstallations,
      },
    });
  }

  async function deleteAccount(req, res) {
    if (!retentionConfigured) return res.status(503).json({ error: 'Account deletion retention policy requires an explicit owner/legal decision.', code: 'ACCOUNT_RETENTION_POLICY_REQUIRED' });
    const result = consumeReauth(req, String(req?.body?.reauthToken || req?.headers?.['x-beatgaler-reauth'] || ''));
    if (!result.ok) return res.status(401).json({ error: 'Recent reauthentication is required.', code: result.code });
    const userId = result.info.userId;
    try {
      await revokeUserSessions(userId, 'account_delete');
    } catch {
      return res.status(503).json({ error: 'Account deletion could not safely revoke active sessions.', code: 'DIRECT_CAPABILITY_REVOKE_FAILED' });
    }
    const receiptId = `delete_${randomBytes(12).toString('hex')}`;
    const deletedAt = now();
    const purgeAt = deletedAt + retentionDays * 24 * 60 * 60 * 1000;
    await clearVerifiedEmail(pool, userId);
    deletedUserIds.add(userId);
    persisted.tombstones[userId] = {
      receipt_id: receiptId,
      subject_hash: sha256(`${userId}:${deletedAt}:${receiptId}`),
      deleted_at: new Date(deletedAt).toISOString(),
      purge_at: new Date(purgeAt).toISOString(),
      retention_days: retentionDays,
    };
    delete persisted.recovery[userId];
    delete persisted.password_overrides[userId];
    delete persisted.notifications[userId];
    for (const [hash, grant] of Object.entries(persisted.reauth)) if (grant?.user_id === userId) delete persisted.reauth[hash];
    for (const [hash, token] of Object.entries(persisted.tokens)) if (token?.user_id === userId) delete persisted.tokens[hash];
    saveState();
    scrubAccountsFile();
    scrubCloudFile();
    return res.json({
      ok: true,
      deleted: true,
      receipt: {
        id: receiptId,
        deleted_at: new Date(deletedAt).toISOString(),
        purge_at: new Date(purgeAt).toISOString(),
        retention_days: retentionDays,
        provider_cleanup: 'local_credentials_removed',
      },
    });
  }

  function loginRecoveryMiddleware(req, res, next) {
    const code = String(req?.body?.mfaCode || '');
    const identifier = String(req?.body?.email || req?.body?.identifier || '');
    const user = userByEmail(identifier);
    if (!user) return next();
    if (deletedUserIds.has(String(user.id))) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!code.startsWith(RECOVERY_PREFIX) || !validateRecoveryCode(String(user.id), code)) return next();
    if (!user.mfaSecret) return next();
    req.body.mfaCode = totpCode(user.mfaSecret, now());
    req.beatgalerLifecycleRecoveryCode = code;
    next();
  }

  function mfaDisableRecoveryMiddleware(req, _res, next) {
    const info = sessionInfoFromRequest(req);
    const code = String(req?.body?.code || '');
    if (info?.user?.mfaSecret && code.startsWith(RECOVERY_PREFIX) && validateRecoveryCode(info.userId, code)) {
      req.body.code = totpCode(info.user.mfaSecret, now());
      req.beatgalerLifecycleRecoveryCode = code;
    }
    next();
  }

  function responseDecorator(routePath, req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = payload => {
      void (async () => {
        const success = Number(res.statusCode || 200) >= 200 && Number(res.statusCode || 200) < 300;
        let nextPayload = payload;
        if (success && req.beatgalerLifecycleRecoveryCode) {
          const info = routePath === '/auth/login'
            ? userByEmail(String(req?.body?.email || req?.body?.identifier || ''))
            : sessionInfoFromRequest(req)?.user;
          if (info?.id) validateRecoveryCode(String(info.id), req.beatgalerLifecycleRecoveryCode, { consume: true });
        }
        if (success && USER_DECORATION_ROUTES.has(routePath)) nextPayload = await decorateUserPayload(nextPayload);
        if (success && routePath === '/auth/mfa/enable') {
          const info = sessionInfoFromRequest(req);
          if (info) nextPayload = { ...(nextPayload || {}), recovery_codes: generateRecoveryCodes(info.userId) };
        }
        if (success && routePath === '/auth/password/change') {
          const info = sessionInfoFromRequest(req);
          if (info) {
            delete persisted.password_overrides[info.userId];
            saveState();
          }
        }
        if (success && routePath === '/auth/email/change') {
          const info = sessionInfoFromRequest(req);
          if (info) {
            void issueEmailToken({ kind: 'email_verification', user: { ...info.user, email: req.body?.email }, email: req.body?.email })
              .then(() => addNotification(info.userId, 'email_verification_requested', { delivery_configured: deliveryConfigured }));
          }
        }
        const notice = NOTIFICATION_ROUTES.get(routePath);
        if (success && notice) {
          const info = sessionInfoFromRequest(req);
          if (info) addNotification(info.userId, notice);
        }
        if (success && routePath === '/auth/register' && nextPayload?.user?.id) {
          const snapshotUser = userById(nextPayload.user.id);
          if (snapshotUser?.email) {
            void issueEmailToken({ kind: 'email_verification', user: snapshotUser, email: snapshotUser.email })
              .then(() => addNotification(String(snapshotUser.id), 'email_verification_requested', { delivery_configured: deliveryConfigured }));
          }
        }
        originalJson(nextPayload);
      })().catch(next);
      return res;
    };
    next();
  }

  const implementations = { completePasswordReset, filterAccountsValue, deleteAccount };
  const api = Object.freeze({
    session: Object.freeze({
      sessionInfoFromRequest,
      issueReauth,
      consumeReauth,
      revokeUserSessions,
      reauthenticate,
      regenerateRecovery,
      loginRecoveryMiddleware,
      mfaDisableRecoveryMiddleware,
    }),
    password: Object.freeze({
      requestPasswordReset,
      get completePasswordReset() { return implementations.completePasswordReset; },
    }),
    email: Object.freeze({
      clearEmailVerificationForUser: userId => clearVerifiedEmail(pool, userId),
      requestEmailVerification,
      confirmEmailVerification,
    }),
    state: Object.freeze({
      stateSnapshot,
      accountsSnapshot,
      userById,
      get filterAccountsValue() { return implementations.filterAccountsValue; },
      filterCloudValue,
      scrubAccountsFile,
      scrubCloudFile,
      lifecycleStatus,
      responseDecorator,
      deletedUserIds,
      stateFile,
    }),
    data: Object.freeze({
      exportAccount,
      get deleteAccount() { return implementations.deleteAccount; },
    }),
  });

  const runtimeApi = {
    installPersistenceFilter,
    passwordOverrideForUser(userId) { return persisted.password_overrides[String(userId)] || null; },
    deliveryConfigured,
    retentionConfigured,
    api,
    provide({ completePasswordReset, filterAccountsValue, deleteAccount }) {
      if (completePasswordReset !== undefined) implementations.completePasswordReset = completePasswordReset;
      if (filterAccountsValue !== undefined) implementations.filterAccountsValue = filterAccountsValue;
      if (deleteAccount !== undefined) implementations.deleteAccount = deleteAccount;
    },
    _test: {
      cloudSnapshot,
      userByEmail,
      userByIdentifier,
      publicStatusForUser,
      issueTestToken,
      consumeToken,
      generateRecoveryCodes,
      validateRecoveryCode,
      verifySecondFactor,
      revokedSessionHashes,
    },
  };

  return runtimeApi;
}

function installAccountLifecycle(express, options = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerAccountLifecycleInstalled) return application?.__beatgalerAccountLifecycleRuntime || null;
  application.__beatgalerAccountLifecycleInstalled = true;
  const runtime = createAccountLifecycleRuntime(options);
  application.__beatgalerAccountLifecycleRuntime = runtime;
  runtime.installPersistenceFilter();
  passwordKdf.setPasswordAuthorityResolver?.(userId => runtime.passwordOverrideForUser(userId));

  function ensureManagementRoutes(app) {
    if (app.__beatgalerAccountLifecycleRoutesInstalled || app.__beatgalerAccountLifecycleRoutesInstalling) return;
    app.__beatgalerAccountLifecycleRoutesInstalling = true;
    try {
      // Estas rutas se registran con el primer app.post(), que puede ocurrir antes del express.json() global:
      // sin su propio parser reciben el cuerpo vacío (reauth, reset de contraseña, export, borrado...).
      const bodyJson = express.json({ limit: '256kb' });
      app.post('/auth/email/verification/request', bodyJson, (req, res) => { void runtime.api.email.requestEmailVerification(req, res); });
      app.post('/auth/email/verification/confirm', bodyJson, (req, res, next) => { void runtime.api.email.confirmEmailVerification(req, res).catch(next); });
      app.post('/auth/password/reset/request', bodyJson, (req, res) => { void runtime.api.password.requestPasswordReset(req, res); });
      app.post('/auth/password/reset/complete', bodyJson, (req, res) => { void runtime.api.password.completePasswordReset(req, res); });
      app.post('/auth/reauth', bodyJson, (req, res) => { void runtime.api.session.reauthenticate(req, res); });
      app.post('/auth/mfa/recovery/regenerate', bodyJson, runtime.api.session.regenerateRecovery);
      app.post('/auth/security/notifications', bodyJson, (req, res) => {
        const info = runtime.api.session.sessionInfoFromRequest(req);
        if (!info) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'SESSION_REQUIRED' });
        const state = runtime.api.state.stateSnapshot();
        const rows = Array.isArray(state.notifications[info.userId]) ? state.notifications[info.userId] : [];
        return res.json({ ok: true, notifications: rows.slice(-50).reverse() });
      });
      app.post('/auth/lifecycle/status', bodyJson, (req, res, next) => {
        const info = runtime.api.session.sessionInfoFromRequest(req);
        if (!info) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'SESSION_REQUIRED' });
        void runtime.api.state.lifecycleStatus(req, res).catch(next);
      });
      app.post('/auth/account/export', bodyJson, (req, res, next) => { void runtime.api.data.exportAccount(req, res).catch(next); });
      app.post('/auth/account/delete', bodyJson, (req, res, next) => { void runtime.api.data.deleteAccount(req, res).catch(next); });
      app.__beatgalerAccountLifecycleRoutesInstalled = true;
    } finally {
      app.__beatgalerAccountLifecycleRoutesInstalling = false;
    }
  }

  application.__beatgalerAccountLifecyclePost = function patchedAccountLifecyclePost(routePath, handlers) {
    const { app, next } = this;
    if (!app.__beatgalerAccountLifecycleRoutesInstalling) ensureManagementRoutes(app);
    const pathName = String(routePath || '');
    const extras = [];
    if (pathName.startsWith('/auth/')) {
      extras.push((req, res, next) => {
        const route = String(req?.path || req?.url || pathName).split('?')[0];
        if (SAFE_PUBLIC_AUTH_ROUTES.has(route)) return next();
        const info = runtime.api.session.sessionInfoFromRequest(req);
        if (!bearerToken(req) || info) return next();
        return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'SESSION_REQUIRED' });
      });
    }
    if (pathName === '/auth/login') extras.push(runtime.api.session.loginRecoveryMiddleware);
    if (pathName === '/auth/mfa/disable') extras.push(runtime.api.session.mfaDisableRecoveryMiddleware);
    if (USER_DECORATION_ROUTES.has(pathName) || NOTIFICATION_ROUTES.has(pathName) || pathName === '/auth/mfa/enable') {
      extras.push((req, res, next) => runtime.api.state.responseDecorator(pathName, req, res, next));
    }
    return next(routePath, ...extras, ...handlers);
  };
  return runtime;
}

function wrapAccountLifecyclePost(routePath, handlers) {
  const register = this.app.__beatgalerAccountLifecyclePost;
  return register ? register.call(this, routePath, handlers) : this.next(routePath, ...handlers);
}

module.exports = {
  wrapAccountLifecyclePost,
  installAccountLifecycle,
  createAccountLifecycleRuntime,
  RECOVERY_PREFIX,
  REAUTH_PREFIX,
  EMAIL_VERIFY_PREFIX,
  PASSWORD_RESET_PREFIX,
  DEFAULT_EMAIL_VERIFY_TTL_MS,
  DEFAULT_PASSWORD_RESET_TTL_MS,
  DEFAULT_REAUTH_TTL_MS,
};
