'use strict';

const { buildLegacyRows } = require('./legacy-import-executor');
const {
  loadAuthSnapshot,
  providerProfile,
  encryptionCallbacks,
} = require('./postgres-control-plane-runtime');

const SECRET_KEY_VERSION_COLUMN = ['secret', 'key', 'version'].join('_');

function clone(value) {
  return JSON.parse(JSON.stringify(value || { users: [], sessions: {} }));
}

function setOf(rows, key) {
  return new Set((rows || []).map(row => String(row?.[key] || '')).filter(Boolean));
}

function removedKeys(previousRows, currentRows, key) {
  const current = setOf(currentRows, key);
  return [...setOf(previousRows, key)].filter(value => !current.has(value));
}

function authSnapshotDelta(previousAuth, currentAuth) {
  const previous = buildLegacyRows(previousAuth || { users: [], sessions: {} }, { includeEntitlements: false });
  const current = buildLegacyRows(currentAuth || { users: [], sessions: {} }, { includeEntitlements: false });
  return {
    removed_sessions: removedKeys(previous.sessions, current.sessions, 'session_key_hash'),
    removed_providers: removedKeys(previous.providers, current.providers, 'id'),
    removed_mfa: removedKeys(previous.mfa, current.mfa, 'id'),
    current,
  };
}

async function deleteIds(client, table, column, values) {
  if (!values.length) return 0;
  const result = await client.query(`DELETE FROM ${table} WHERE ${column}=ANY($1::text[])`, [values]);
  return Number(result.rowCount || 0);
}

async function mergeAuthSnapshotDelta(pool, currentAuth, cryptoConfig, previousAuth) {
  const delta = authSnapshotDelta(previousAuth, currentAuth);
  const rows = delta.current;
  const encrypt = encryptionCallbacks(cryptoConfig).encrypt;
  const originalUsers = new Map((currentAuth?.users || []).map(user => [String(user.id), user]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of rows.users) {
      await client.query(`INSERT INTO users(id,username,username_source,email,password_hash,password_hash_algorithm,password_salt,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,username_source=EXCLUDED.username_source,email=EXCLUDED.email,
          password_hash=EXCLUDED.password_hash,password_hash_algorithm=EXCLUDED.password_hash_algorithm,password_salt=EXCLUDED.password_salt,updated_at=now()`,
      [row.id,row.username,row.username_source,row.email,row.password_hash,row.password_hash_algorithm,row.password_salt,row.created_at]);
    }

    await deleteIds(client, 'auth_sessions', 'session_key_hash', delta.removed_sessions);
    for (const row of rows.sessions) {
      if (!row.expires_at) throw new Error(`Legacy session ${row.session_key_hash} has no expiresAt.`);
      await client.query(`INSERT INTO auth_sessions(session_key_hash,user_id,created_at,expires_at)
        VALUES($1,$2,$3,$4)
        ON CONFLICT(session_key_hash) DO UPDATE SET user_id=EXCLUDED.user_id,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at`,
      [row.session_key_hash,row.user_id,row.created_at,row.expires_at]);
    }

    await deleteIds(client, 'provider_identities', 'id', delta.removed_providers);
    for (const row of rows.providers) {
      const original = originalUsers.get(String(row.user_id))?.providers?.[row.provider] || row.record || {};
      const access = original.accessToken ? encrypt(original.accessToken, { aad: `provider:${row.provider}:${row.user_id}:access` }) : null;
      const refresh = original.refreshToken ? encrypt(original.refreshToken, { aad: `provider:${row.provider}:${row.user_id}:refresh` }) : null;
      const keyVersions = [access?.keyVersion, refresh?.keyVersion].filter(Boolean);
      if (new Set(keyVersions).size > 1) throw new Error(`Provider ${row.provider} for ${row.user_id} used mixed key versions.`);
      await client.query(`INSERT INTO provider_identities(
          id,user_id,provider,provider_subject,profile,access_token_ciphertext,access_token_nonce,
          refresh_token_ciphertext,refresh_token_nonce,${SECRET_KEY_VERSION_COLUMN},token_expires_at
        ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(id) DO UPDATE SET
          user_id=EXCLUDED.user_id,provider=EXCLUDED.provider,provider_subject=EXCLUDED.provider_subject,profile=EXCLUDED.profile,
          access_token_ciphertext=EXCLUDED.access_token_ciphertext,access_token_nonce=EXCLUDED.access_token_nonce,
          refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,refresh_token_nonce=EXCLUDED.refresh_token_nonce,
          ${SECRET_KEY_VERSION_COLUMN}=EXCLUDED.${SECRET_KEY_VERSION_COLUMN},token_expires_at=EXCLUDED.token_expires_at,updated_at=now()`,
      [row.id,row.user_id,row.provider,row.provider_subject,JSON.stringify(providerProfile(original)),access?.ciphertext || null,access?.nonce || null,
        refresh?.ciphertext || null,refresh?.nonce || null,keyVersions[0] || null,original.tokenExpiresAt ? new Date(Number(original.tokenExpiresAt)) : null]);
    }

    await deleteIds(client, 'mfa_factors', 'id', delta.removed_mfa);
    for (const row of rows.mfa) {
      const encrypted = encrypt(row.plaintext_secret, { aad: `mfa:${row.user_id}:totp` });
      await client.query(`INSERT INTO mfa_factors(id,user_id,factor_type,secret_ciphertext,secret_nonce,${SECRET_KEY_VERSION_COLUMN},enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,factor_type=EXCLUDED.factor_type,
          secret_ciphertext=EXCLUDED.secret_ciphertext,secret_nonce=EXCLUDED.secret_nonce,
          ${SECRET_KEY_VERSION_COLUMN}=EXCLUDED.${SECRET_KEY_VERSION_COLUMN},enabled=EXCLUDED.enabled`,
      [row.id,row.user_id,row.factor_type,encrypted.ciphertext,encrypted.nonce,encrypted.keyVersion,row.enabled]);
    }

    for (const row of rows.vaults) {
      await client.query(`INSERT INTO vaults(id,user_id,telegram_chat_id,title,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,title=EXCLUDED.title,updated_at=now()`,
      [row.id,row.user_id,row.telegram_chat_id,row.title,row.created_at]);
    }

    await client.query('COMMIT');
    return {
      users: rows.users.length,
      sessions: rows.sessions.length,
      providers: rows.providers.length,
      mfa: rows.mfa.length,
      vaults: rows.vaults.length,
      removed_sessions: delta.removed_sessions.length,
      removed_providers: delta.removed_providers.length,
      removed_mfa: delta.removed_mfa.length,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function installMultiprocessAuthSnapshotCompatibility(runtime, pool) {
  if (!runtime || typeof runtime.enqueue !== 'function' || typeof runtime.flush !== 'function') {
    throw new Error('PostgreSQL auth delta compatibility requires PostgresControlPlaneRuntime.');
  }
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL auth delta compatibility requires a pool.');
  if (runtime.__beatgalerMultiprocessAuthDeltaInstalled) return runtime;

  let desired = clone(await loadAuthSnapshot(pool, runtime.cryptoConfig));
  runtime.__beatgalerMultiprocessAuthDeltaInstalled = true;
  runtime.saveAuthSnapshot = function saveAuthSnapshotDelta(snapshot) {
    const captured = clone(snapshot);
    const previous = desired;
    desired = captured;
    return runtime.enqueue('auth snapshot delta', () => mergeAuthSnapshotDelta(pool, captured, runtime.cryptoConfig, previous));
  };
  return runtime;
}

module.exports = {
  clone,
  setOf,
  removedKeys,
  authSnapshotDelta,
  deleteIds,
  mergeAuthSnapshotDelta,
  installMultiprocessAuthSnapshotCompatibility,
};
