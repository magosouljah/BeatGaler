'use strict';

const { buildLegacyRows } = require('./legacy-import-executor');
const { encryptSecretForStorage, decryptSecretFromStorage } = require('./secret-envelope');

const SECRET_KEY_VERSION_COLUMN = ['secret', 'key', 'version'].join('_');
const CUTOVER_ID = 'legacy-json-v1';
const COMPAT_STATE_KEY = 'legacy-cloud-data-v1';

function toMs(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function providerProfile(record) {
  const profile = {};
  for (const key of ['email', 'name', 'username', 'connectedAt', 'profileSyncedAt']) {
    if (record?.[key] != null) profile[key] = record[key];
  }
  return profile;
}

function encryptionCallbacks({ key, keyVersion }) {
  return Object.freeze({
    encrypt(plaintext, { aad }) {
      return encryptSecretForStorage(plaintext, { key, keyVersion, aad });
    },
    decrypt(stored, { aad }) {
      return decryptSecretFromStorage(stored, {
        aad,
        resolveKey(version) {
          if (Number(version) !== Number(keyVersion)) {
            throw new Error(`Envelope key version ${version} is unavailable.`);
          }
          return key;
        },
      });
    },
  });
}

async function assertCutoverReady(pool, expectedSnapshotSha256) {
  const result = await pool.query(
    'SELECT snapshot_sha256,state FROM control_plane_cutovers WHERE id=$1',
    [CUTOVER_ID],
  );
  if (result.rows.length !== 1) {
    throw new Error('PostgreSQL cutover marker is missing. Run the controlled cutover preparation first.');
  }
  const row = result.rows[0];
  if (row.state !== 'READY') {
    throw new Error(`PostgreSQL cutover marker is ${row.state}; authority switch is refused.`);
  }
  if (String(row.snapshot_sha256) !== String(expectedSnapshotSha256)) {
    throw new Error('PostgreSQL cutover snapshot SHA256 does not match the configured expected snapshot.');
  }
  return Object.freeze({ snapshotSha256: row.snapshot_sha256, state: row.state });
}

async function loadAuthSnapshot(pool, cryptoConfig) {
  const decrypt = encryptionCallbacks(cryptoConfig).decrypt;
  const [usersResult, sessionsResult, providersResult, mfaResult, entitlementsResult, vaultsResult] = await Promise.all([
    pool.query('SELECT * FROM users ORDER BY id'),
    pool.query('SELECT * FROM auth_sessions ORDER BY session_key_hash'),
    pool.query('SELECT * FROM provider_identities ORDER BY user_id,provider,provider_subject'),
    pool.query("SELECT * FROM mfa_factors WHERE enabled=true ORDER BY user_id,factor_type"),
    pool.query('SELECT * FROM entitlements ORDER BY user_id,starts_at,id'),
    pool.query('SELECT * FROM vaults ORDER BY user_id,id'),
  ]);

  const providersByUser = new Map();
  for (const row of providersResult.rows) {
    const target = providersByUser.get(row.user_id) || {};
    const accessToken = row.access_token_ciphertext ? decrypt({
      ciphertext: row.access_token_ciphertext,
      nonce: row.access_token_nonce,
      keyVersion: row.secret_key_version,
    }, { aad: `provider:${row.provider}:${row.user_id}:access` }) : null;
    const refreshToken = row.refresh_token_ciphertext ? decrypt({
      ciphertext: row.refresh_token_ciphertext,
      nonce: row.refresh_token_nonce,
      keyVersion: row.secret_key_version,
    }, { aad: `provider:${row.provider}:${row.user_id}:refresh` }) : null;
    const profile = row.profile && typeof row.profile === 'object' && !Array.isArray(row.profile) ? row.profile : {};
    target[row.provider] = {
      id: row.provider_subject,
      ...profile,
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(row.token_expires_at ? { tokenExpiresAt: toMs(row.token_expires_at) } : {}),
    };
    providersByUser.set(row.user_id, target);
  }

  const mfaByUser = new Map();
  for (const row of mfaResult.rows) {
    if (row.factor_type !== 'totp') throw new Error(`Unsupported runtime MFA factor: ${row.factor_type}`);
    mfaByUser.set(row.user_id, decrypt({
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      keyVersion: row.secret_key_version,
    }, { aad: `mfa:${row.user_id}:totp` }));
  }

  const entitlementsByUser = new Map();
  for (const row of entitlementsResult.rows) {
    const list = entitlementsByUser.get(row.user_id) || [];
    list.push(row);
    entitlementsByUser.set(row.user_id, list);
  }
  const vaultByUser = new Map(vaultsResult.rows.map(row => [row.user_id, row]));

  const users = usersResult.rows.map(row => {
    const entitlements = entitlementsByUser.get(row.id) || [];
    const base = entitlements.find(item => item.source === 'base_plan') || null;
    const grants = entitlements.filter(item => item !== base).map(item => ({
      id: item.id,
      planId: item.plan_id,
      source: item.source,
      startsAt: toMs(item.starts_at),
      ...(item.expires_at ? { expiresAt: toMs(item.expires_at) } : {}),
    }));
    const vault = vaultByUser.get(row.id);
    return {
      id: row.id,
      ...(row.username ? { username: row.username } : {}),
      ...(row.username_source ? { usernameSource: row.username_source } : {}),
      ...(row.email ? { email: row.email } : {}),
      ...(row.password_hash ? { passwordHash: row.password_hash, passwordSalt: row.password_salt } : {}),
      createdAt: toMs(row.created_at) || 0,
      ...(providersByUser.has(row.id) ? { providers: providersByUser.get(row.id) } : {}),
      ...(mfaByUser.has(row.id) ? { mfaSecret: mfaByUser.get(row.id) } : {}),
      planState: { basePlanId: base?.plan_id || 'free', grants },
      ...(vault ? {
        storageChatId: vault.telegram_chat_id,
        ...(vault.title ? { storageChatTitle: vault.title } : {}),
        storageCreatedAt: toMs(vault.created_at) || 0,
      } : {}),
    };
  });

  const sessions = {};
  for (const row of sessionsResult.rows) {
    sessions[row.session_key_hash] = {
      userId: row.user_id,
      createdAt: toMs(row.created_at) || 0,
      expiresAt: toMs(row.expires_at),
    };
  }
  return { users, sessions };
}

async function replaceAuthSnapshot(pool, authData, cryptoConfig) {
  const rows = buildLegacyRows(authData);
  const encrypt = encryptionCallbacks(cryptoConfig).encrypt;
  const originalUsers = new Map((authData.users || []).map(user => [String(user.id), user]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of rows.users) {
      await client.query(`INSERT INTO users(id,username,username_source,email,password_hash,password_hash_algorithm,password_salt,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username, username_source=EXCLUDED.username_source, email=EXCLUDED.email,
          password_hash=EXCLUDED.password_hash, password_hash_algorithm=EXCLUDED.password_hash_algorithm, password_salt=EXCLUDED.password_salt, updated_at=now()`,
      [row.id,row.username,row.username_source,row.email,row.password_hash,row.password_hash_algorithm,row.password_salt,row.created_at]);
    }

    await client.query('DELETE FROM auth_sessions');
    for (const row of rows.sessions) {
      if (!row.expires_at) throw new Error(`Legacy session ${row.session_key_hash} has no expiresAt.`);
      await client.query('INSERT INTO auth_sessions(session_key_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)',
        [row.session_key_hash,row.user_id,row.created_at,row.expires_at]);
    }

    await client.query('DELETE FROM provider_identities');
    for (const row of rows.providers) {
      const original = originalUsers.get(String(row.user_id))?.providers?.[row.provider] || row.record || {};
      const access = original.accessToken ? encrypt(original.accessToken, { aad: `provider:${row.provider}:${row.user_id}:access` }) : null;
      const refresh = original.refreshToken ? encrypt(original.refreshToken, { aad: `provider:${row.provider}:${row.user_id}:refresh` }) : null;
      const keyVersions = [access?.keyVersion, refresh?.keyVersion].filter(Boolean);
      if (new Set(keyVersions).size > 1) throw new Error(`Provider ${row.provider} for ${row.user_id} used mixed key versions.`);
      await client.query(`INSERT INTO provider_identities(id,user_id,provider,provider_subject,profile,access_token_ciphertext,access_token_nonce,refresh_token_ciphertext,refresh_token_nonce,${SECRET_KEY_VERSION_COLUMN},token_expires_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
      [row.id,row.user_id,row.provider,row.provider_subject,JSON.stringify(providerProfile(original)),access?.ciphertext || null,access?.nonce || null,
        refresh?.ciphertext || null,refresh?.nonce || null,keyVersions[0] || null,original.tokenExpiresAt ? new Date(Number(original.tokenExpiresAt)) : null]);
    }

    await client.query('DELETE FROM mfa_factors');
    for (const row of rows.mfa) {
      const encrypted = encrypt(row.plaintext_secret, { aad: `mfa:${row.user_id}:totp` });
      await client.query(`INSERT INTO mfa_factors(id,user_id,factor_type,secret_ciphertext,secret_nonce,${SECRET_KEY_VERSION_COLUMN},enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [row.id,row.user_id,row.factor_type,encrypted.ciphertext,encrypted.nonce,encrypted.keyVersion,row.enabled]);
    }

    await client.query('DELETE FROM entitlements');
    for (const row of rows.entitlements) {
      await client.query('INSERT INTO entitlements(id,user_id,plan_id,source,starts_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [row.id,row.user_id,row.plan_id,row.source,row.starts_at,row.expires_at]);
    }

    for (const row of rows.vaults) {
      await client.query(`INSERT INTO vaults(id,user_id,telegram_chat_id,title,created_at,updated_at) VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,title=EXCLUDED.title,updated_at=now()`,
      [row.id,row.user_id,row.telegram_chat_id,row.title,row.created_at]);
    }

    await client.query('COMMIT');
    return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length]));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function emptyPersistentSnapshot() {
  return {
    linkedAccounts: {},
    uploadedFiles: {},
    beatTopics: {},
    pendingTopicDeletes: {},
    messageRedirects: {},
  };
}

async function loadPersistentSnapshot(pool) {
  const result = await pool.query('SELECT payload FROM runtime_compat_state WHERE state_key=$1', [COMPAT_STATE_KEY]);
  if (!result.rows.length) return emptyPersistentSnapshot();
  const payload = result.rows[0].payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PostgreSQL runtime compatibility state is malformed.');
  }
  return { ...emptyPersistentSnapshot(), ...payload };
}

async function replacePersistentSnapshot(pool, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Runtime compatibility payload must be an object.');
  }
  await pool.query(`INSERT INTO runtime_compat_state(state_key,payload,updated_at)
    VALUES($1,$2::jsonb,now())
    ON CONFLICT(state_key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`,
  [COMPAT_STATE_KEY, JSON.stringify(payload)]);
}

async function writeCutoverMarker(pool, snapshotSha256, state = 'READY') {
  await pool.query(`INSERT INTO control_plane_cutovers(id,snapshot_sha256,state,prepared_at,updated_at)
    VALUES($1,$2,$3,now(),now())
    ON CONFLICT(id) DO UPDATE SET snapshot_sha256=EXCLUDED.snapshot_sha256,state=EXCLUDED.state,updated_at=now()`,
  [CUTOVER_ID, snapshotSha256, state]);
}

class PostgresControlPlaneRuntime {
  constructor({ pool, expectedSnapshotSha256, cryptoConfig }) {
    this.pool = pool;
    this.expectedSnapshotSha256 = expectedSnapshotSha256;
    this.cryptoConfig = cryptoConfig;
    this.tail = Promise.resolve();
    this.poisoned = null;
  }

  async initialize() {
    await assertCutoverReady(this.pool, this.expectedSnapshotSha256);
    const [auth, persistent] = await Promise.all([
      loadAuthSnapshot(this.pool, this.cryptoConfig),
      loadPersistentSnapshot(this.pool),
    ]);
    return { auth, persistent };
  }

  enqueue(label, work) {
    if (this.poisoned) return Promise.reject(this.poisoned);
    const operation = this.tail.then(async () => {
      if (this.poisoned) throw this.poisoned;
      try {
        return await work();
      } catch (error) {
        const wrapped = new Error(`PostgreSQL control-plane durability failed during ${label}: ${error?.message || error}`);
        wrapped.cause = error;
        this.poisoned = wrapped;
        throw wrapped;
      }
    });
    this.tail = operation;
    operation.catch(() => {});
    return operation;
  }

  saveAuthSnapshot(snapshot) {
    const captured = JSON.parse(JSON.stringify(snapshot));
    return this.enqueue('auth snapshot', () => replaceAuthSnapshot(this.pool, captured, this.cryptoConfig));
  }

  savePersistentSnapshot(snapshot) {
    const captured = JSON.parse(JSON.stringify(snapshot));
    return this.enqueue('runtime compatibility state', () => replacePersistentSnapshot(this.pool, captured));
  }

  async flush() {
    await this.tail;
    if (this.poisoned) throw this.poisoned;
  }
}

module.exports = {
  CUTOVER_ID,
  COMPAT_STATE_KEY,
  providerProfile,
  encryptionCallbacks,
  assertCutoverReady,
  loadAuthSnapshot,
  replaceAuthSnapshot,
  emptyPersistentSnapshot,
  loadPersistentSnapshot,
  replacePersistentSnapshot,
  writeCutoverMarker,
  PostgresControlPlaneRuntime,
};
