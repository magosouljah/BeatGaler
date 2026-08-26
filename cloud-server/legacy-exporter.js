'use strict';

function toMs(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function requireDecrypt(callback) {
  if (typeof callback !== 'function') throw new Error('decryptSecretFromStorage callback is required.');
  return callback;
}

async function exportLegacyAccounts(client, { decryptSecretFromStorage } = {}) {
  if (!client || typeof client.query !== 'function') throw new Error('PostgreSQL client is required.');
  const decrypt = requireDecrypt(decryptSecretFromStorage);
  const [usersResult,sessionsResult,providersResult,mfaResult,entitlementsResult,vaultsResult] = await Promise.all([
    client.query('SELECT * FROM users ORDER BY id'),
    client.query('SELECT * FROM auth_sessions ORDER BY session_key_hash'),
    client.query('SELECT * FROM provider_identities ORDER BY user_id,provider,provider_subject'),
    client.query("SELECT * FROM mfa_factors WHERE enabled=true ORDER BY user_id,factor_type"),
    client.query('SELECT * FROM entitlements ORDER BY user_id,starts_at,id'),
    client.query('SELECT * FROM vaults ORDER BY user_id,id'),
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
    target[row.provider] = {
      id: row.provider_subject,
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(row.token_expires_at ? { tokenExpiresAt: toMs(row.token_expires_at) } : {}),
    };
    providersByUser.set(row.user_id, target);
  }

  const mfaByUser = new Map();
  for (const row of mfaResult.rows) {
    if (row.factor_type !== 'totp') throw new Error(`Unsupported rollback MFA factor: ${row.factor_type}`);
    const plaintext = decrypt({
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      keyVersion: row.secret_key_version,
    }, { aad: `mfa:${row.user_id}:totp` });
    mfaByUser.set(row.user_id, plaintext);
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
      planState: {
        basePlanId: base?.plan_id || 'free',
        grants,
      },
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
  return Object.freeze({ users, sessions });
}

module.exports = { exportLegacyAccounts };
