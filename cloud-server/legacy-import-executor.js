'use strict';

const crypto = require('crypto');

function deterministicId(prefix, ...parts) {
  const digest = crypto.createHash('sha256').update(parts.map(value => String(value ?? '')).join('\0')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function msToDate(value) {
  const n = Number(value || 0);
  return n > 0 ? new Date(n) : null;
}

function providerEntries(user) {
  const providers = user?.providers && typeof user.providers === 'object' ? user.providers : {};
  return Object.entries(providers).filter(([, value]) => value && typeof value === 'object');
}

function buildLegacyRows(authData) {
  const users = [];
  const sessions = [];
  const providers = [];
  const mfa = [];
  const entitlements = [];
  const vaults = [];

  for (const user of authData.users || []) {
    const userId = String(user.id);
    users.push({
      id: userId,
      username: user.username || null,
      username_source: user.usernameSource || null,
      email: user.email || null,
      password_hash: user.passwordHash || null,
      password_hash_algorithm: user.passwordHash ? 'scrypt-v1' : null,
      password_salt: user.passwordHash ? (user.passwordSalt || null) : null,
      created_at: msToDate(user.createdAt) || new Date(0),
    });

    if (user.passwordHash && !user.passwordSalt) {
      throw new Error(`Legacy password user ${userId} is missing passwordSalt.`);
    }

    for (const [provider, record] of providerEntries(user)) {
      const subject = String(record.id || record.sub || '').trim();
      if (!subject) throw new Error(`Legacy provider ${provider} for ${userId} is missing subject id.`);
      providers.push({
        id: deterministicId('prv', userId, provider, subject),
        user_id: userId,
        provider,
        provider_subject: subject,
        record,
      });
    }

    if (user.mfaSecret) {
      mfa.push({
        id: deterministicId('mfa', userId, 'totp'),
        user_id: userId,
        factor_type: 'totp',
        plaintext_secret: String(user.mfaSecret),
        enabled: true,
      });
    }
    // pendingMfaSecret is intentionally not migrated: an incomplete enrollment
    // must restart after cutover rather than becoming an active factor accidentally.

    const planState = user.planState || {};
    entitlements.push({
      id: deterministicId('ent', userId, 'base_plan'),
      user_id: userId,
      plan_id: planState.basePlanId || 'free',
      source: 'base_plan',
      starts_at: msToDate(user.createdAt) || new Date(0),
      expires_at: null,
    });
    for (const grant of Array.isArray(planState.grants) ? planState.grants : []) {
      entitlements.push({
        id: String(grant.id || deterministicId('ent', userId, grant.source, grant.planId, grant.startsAt, grant.expiresAt)),
        user_id: userId,
        plan_id: grant.planId,
        source: grant.source || 'legacy_grant',
        starts_at: msToDate(grant.startsAt) || new Date(0),
        expires_at: msToDate(grant.expiresAt),
      });
    }

    if (user.storageChatId != null) {
      vaults.push({
        id: deterministicId('vlt', userId, user.storageChatId),
        user_id: userId,
        telegram_chat_id: String(user.storageChatId),
        title: user.storageChatTitle || null,
        created_at: msToDate(user.storageCreatedAt) || msToDate(user.createdAt) || new Date(0),
      });
    }
  }

  for (const [sessionHash, session] of Object.entries(authData.sessions || {})) {
    sessions.push({
      session_key_hash: String(sessionHash),
      user_id: String(session.userId),
      created_at: msToDate(session.createdAt) || new Date(0),
      expires_at: msToDate(session.expiresAt),
    });
  }

  return { users, sessions, providers, mfa, entitlements, vaults };
}

async function importLegacyControlPlane(client, authData, { encryptSecret, keyVersion = 1 } = {}) {
  if (!client || typeof client.query !== 'function') throw new Error('PostgreSQL client is required.');
  if (typeof encryptSecret !== 'function') throw new Error('encryptSecret callback is required.');
  const rows = buildLegacyRows(authData);
  await client.query('BEGIN');
  try {
    for (const row of rows.users) {
      await client.query(`INSERT INTO users(id, username, username_source, email, password_hash, password_hash_algorithm, password_salt, created_at, updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
        ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username, username_source=EXCLUDED.username_source, email=EXCLUDED.email,
          password_hash=EXCLUDED.password_hash, password_hash_algorithm=EXCLUDED.password_hash_algorithm, password_salt=EXCLUDED.password_salt`,
      [row.id,row.username,row.username_source,row.email,row.password_hash,row.password_hash_algorithm,row.password_salt,row.created_at]);
    }

    for (const row of rows.sessions) {
      if (!row.expires_at) throw new Error(`Legacy session ${row.session_key_hash} has no expiresAt.`);
      await client.query(`INSERT INTO auth_sessions(session_key_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(session_key_hash) DO UPDATE SET user_id=EXCLUDED.user_id, created_at=EXCLUDED.created_at, expires_at=EXCLUDED.expires_at`,
      [row.session_key_hash,row.user_id,row.created_at,row.expires_at]);
    }

    for (const row of rows.providers) {
      const access = row.record.accessToken ? encryptSecret(row.record.accessToken, { keyVersion, aad: `provider:${row.provider}:${row.user_id}:access` }) : null;
      const refresh = row.record.refreshToken ? encryptSecret(row.record.refreshToken, { keyVersion, aad: `provider:${row.provider}:${row.user_id}:refresh` }) : null;
      await client.query(`INSERT INTO provider_identities(id,user_id,provider,provider_subject,access_token_ciphertext,access_token_nonce,refresh_token_ciphertext,refresh_token_nonce,secret_key_version,token_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(provider,provider_subject) DO UPDATE SET user_id=EXCLUDED.user_id, access_token_ciphertext=EXCLUDED.access_token_ciphertext,
          access_token_nonce=EXCLUDED.access_token_nonce, refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext, refresh_token_nonce=EXCLUDED.refresh_token_nonce,
          secret_key_version=EXCLUDED.secret_key_version, token_expires_at=EXCLUDED.token_expires_at`,
      [row.id,row.user_id,row.provider,row.provider_subject,access?.ciphertext || null,access?.nonce || null,refresh?.ciphertext || null,refresh?.nonce || null,
        access || refresh ? keyVersion : null, msToDate(row.record.tokenExpiresAt)]);
    }

    for (const row of rows.mfa) {
      const encrypted = encryptSecret(row.plaintext_secret, { keyVersion, aad: `mfa:${row.user_id}:totp` });
      await client.query(`INSERT INTO mfa_factors(id,user_id,factor_type,secret_ciphertext,secret_nonce,secret_key_version,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(user_id,factor_type) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext, secret_nonce=EXCLUDED.secret_nonce,
          secret_key_version=EXCLUDED.secret_key_version, enabled=EXCLUDED.enabled`,
      [row.id,row.user_id,row.factor_type,encrypted.ciphertext,encrypted.nonce,keyVersion,row.enabled]);
    }

    for (const row of rows.entitlements) {
      await client.query(`INSERT INTO entitlements(id,user_id,plan_id,source,starts_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(id) DO UPDATE SET plan_id=EXCLUDED.plan_id, source=EXCLUDED.source, starts_at=EXCLUDED.starts_at, expires_at=EXCLUDED.expires_at`,
      [row.id,row.user_id,row.plan_id,row.source,row.starts_at,row.expires_at]);
    }

    for (const row of rows.vaults) {
      await client.query(`INSERT INTO vaults(id,user_id,telegram_chat_id,title,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)
        ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id, title=EXCLUDED.title`,
      [row.id,row.user_id,row.telegram_chat_id,row.title,row.created_at]);
    }

    await client.query('COMMIT');
    return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length]));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { deterministicId, buildLegacyRows, importLegacyControlPlane };
