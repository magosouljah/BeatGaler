'use strict';

const crypto = require('node:crypto');

function coded(message, code, extras = {}) {
  return Object.assign(new Error(message), { code, ...extras });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeXHandle(value) {
  const handle = String(value || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw coded('X returned an invalid handle.', 'X_HANDLE_INVALID');
  return handle;
}

function tempSeed(userId) {
  return Number.parseInt(crypto.createHash('sha256').update(`x-recycle\0${String(userId || '')}`).digest('hex').slice(0, 8), 16) % 10_000;
}

async function allocateTemporaryUsername(client, base, userId) {
  const normalized = normalizeXHandle(base);
  const seed = tempSeed(userId);
  for (let offset = 0; offset < 10_000; offset += 1) {
    const candidate = `${normalized}#${String((seed + offset) % 10_000).padStart(4, '0')}`;
    const occupied = await client.query('SELECT id FROM users WHERE lower(username)=lower($1) AND id<>$2 LIMIT 1', [candidate, String(userId)]);
    if (!occupied.rows.length) return candidate;
  }
  throw coded('No temporary BeatGaler username is available for X reconciliation.', 'X_USERNAME_SPACE_EXHAUSTED');
}

async function providerOwner(client, provider, subject) {
  const result = await client.query(`
    SELECT u.id,u.username,u.username_source,u.email,u.password_hash,u.password_salt,u.created_at,
           v.telegram_chat_id,v.title AS vault_title,v.created_at AS vault_created_at,
           p.profile
    FROM provider_identities p
    JOIN users u ON u.id=p.user_id
    LEFT JOIN vaults v ON v.user_id=u.id
    WHERE p.provider=$1 AND p.provider_subject=$2
    LIMIT 1
  `, [String(provider), String(subject)]);
  return result.rows[0] || null;
}

async function emailOwner(client, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const result = await client.query('SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1', [normalized]);
  return result.rows[0] || null;
}

async function handleOwners(client, handle) {
  const result = await client.query(`
    SELECT id,username,username_source,email,password_hash,password_salt,created_at
    FROM users
    WHERE lower(username)=lower($1)
    ORDER BY id
    FOR UPDATE
  `, [String(handle)]);
  return result.rows;
}

async function xSubjectsForUser(client, userId) {
  const result = await client.query("SELECT provider_subject FROM provider_identities WHERE user_id=$1 AND provider='x' ORDER BY provider_subject", [String(userId)]);
  return result.rows.map(row => String(row.provider_subject));
}

function bridgeIdentityInput(row, provider, subject, identity = {}) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: row.username,
    usernameSource: row.username_source || (provider === 'x' ? 'x' : 'beatgaler'),
    email: row.email || null,
    passwordHash: row.password_hash || null,
    passwordSalt: row.password_salt || null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    storageChatId: row.telegram_chat_id || null,
    storageChatTitle: row.vault_title || null,
    storageCreatedAt: row.vault_created_at ? new Date(row.vault_created_at).getTime() : null,
    provider,
    providerSubject: String(subject),
    providerProfile: {
      ...(row.profile && typeof row.profile === 'object' ? row.profile : {}),
      ...(identity && typeof identity === 'object' ? identity : {}),
      id: String(subject),
    },
  };
}

function createProviderIdentityAuthority({ pool, getBridge = () => null } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('Provider identity authority requires PostgreSQL.');

  async function prepareGoogle({ identity, linkUserId = null, registrationOpen = false } = {}) {
    const subject = String(identity?.id || '').trim();
    const email = normalizeEmail(identity?.email);
    if (!subject) throw coded('Google subject is required.', 'GOOGLE_SUBJECT_REQUIRED');
    if (identity?.email_verified !== true || !email) throw coded('Google did not verify this email address.', 'GOOGLE_EMAIL_NOT_VERIFIED');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`provider:google:${subject}`]);
      const existing = await providerOwner(client, 'google', subject);
      if (linkUserId && existing && String(existing.id) !== String(linkUserId)) {
        throw coded('That Google account is already connected to another BeatGaler account.', 'PROVIDER_ALREADY_CONNECTED');
      }
      if (!existing && !linkUserId && !registrationOpen) {
        throw coded('Public registration is temporarily unavailable.', 'PUBLIC_REGISTRATION_CLOSED');
      }
      if (!existing) {
        const owner = await emailOwner(client, email);
        if (owner && (!linkUserId || String(owner.id) !== String(linkUserId))) {
          throw coded('Sign in to the existing BeatGaler account, then connect Google from Settings.', 'GOOGLE_EMAIL_CONFLICT');
        }
      }
      await client.query('COMMIT');
      if (existing) getBridge()?.adoptIdentityUser?.(bridgeIdentityInput(existing, 'google', subject, identity));
      return { allow: true, existingUserId: existing ? String(existing.id) : null };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function prepareX({ identity, linkUserId = null, registrationOpen = false } = {}) {
    const subject = String(identity?.id || '').trim();
    if (!subject) throw coded('X subject is required.', 'X_SUBJECT_REQUIRED');
    const handle = normalizeXHandle(identity?.username);
    const client = await pool.connect();
    let existing = null;
    let renamed = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`provider:x:${subject}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`x-handle:${handle}`]);
      existing = await providerOwner(client, 'x', subject);
      if (linkUserId && existing && String(existing.id) !== String(linkUserId)) {
        throw coded('That X account is already connected to another BeatGaler account.', 'PROVIDER_ALREADY_CONNECTED');
      }
      if (!existing && !linkUserId && !registrationOpen) {
        throw coded('Public registration is temporarily unavailable.', 'PUBLIC_REGISTRATION_CLOSED');
      }

      const owners = await handleOwners(client, handle);
      if (owners.length > 1) {
        throw coded('Legacy case-insensitive username collision must be remediated before X reconciliation.', 'X_HANDLE_CASEFOLD_COLLISION');
      }
      const handleOwner = owners[0] || null;
      if (handleOwner) {
        const subjects = await xSubjectsForUser(client, handleOwner.id);
        const sameSubject = subjects.includes(subject);
        if (!sameSubject) {
          const temporary = await allocateTemporaryUsername(client, handle, handleOwner.id);
          await client.query("UPDATE users SET username=$2,username_source='beatgaler',updated_at=now() WHERE id=$1", [String(handleOwner.id), temporary]);
          renamed = { userId: String(handleOwner.id), from: String(handleOwner.username), to: temporary };
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const bridge = getBridge();
    if (renamed) bridge?.setUsernameByUserId?.(renamed.userId, renamed.to, 'beatgaler');
    if (existing) bridge?.adoptIdentityUser?.(bridgeIdentityInput(existing, 'x', subject, identity));
    return { allow: true, existingUserId: existing ? String(existing.id) : null, handle, renamed };
  }

  async function prepare(input = {}) {
    const provider = String(input.provider || '').toLowerCase();
    if (provider === 'google') return prepareGoogle(input);
    if (provider === 'x') return prepareX(input);
    throw coded('Unsupported OAuth provider.', 'OAUTH_PROVIDER_UNSUPPORTED');
  }

  return { prepare, prepareGoogle, prepareX };
}

module.exports = {
  normalizeEmail,
  normalizeXHandle,
  tempSeed,
  allocateTemporaryUsername,
  providerOwner,
  emailOwner,
  handleOwners,
  xSubjectsForUser,
  bridgeIdentityInput,
  createProviderIdentityAuthority,
};
