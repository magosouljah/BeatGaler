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
    // Different X handles may converge on the same manual fallback. Lock each
    // candidate before testing it so two processes cannot both select it.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`username:${candidate}`]);
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

async function providerForUser(client, userId, provider) {
  const userResult = await client.query('SELECT id,username,username_source,email,password_hash FROM users WHERE id=$1 FOR UPDATE', [String(userId)]);
  const user = userResult.rows[0] || null;
  if (!user) return null;
  const providerResult = await client.query('SELECT provider_subject FROM provider_identities WHERE user_id=$1 AND provider=$2 LIMIT 1', [String(userId), String(provider)]);
  return { user, subject: providerResult.rows[0]?.provider_subject ? String(providerResult.rows[0].provider_subject) : null };
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

function createProviderIdentityAuthority({ pool, getBridge = () => null, flushAuthority = async () => {} } = {}) {
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
    let staleLocal = null;
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
          if (!existing) {
            // Creating B happens later in the legacy callback. Moving A now
            // would commit only half of the transfer if that callback fails.
            throw coded('This X handle needs an atomic account claim before sign-in can continue.', 'X_HANDLE_ATOMIC_CLAIM_REQUIRED');
          }
          if (String(handleOwner.username_source || '') !== 'x' || subjects.length === 0) {
            throw coded('This username belongs to another BeatGaler account.', 'X_HANDLE_NOT_RECLAIMABLE');
          }
          const temporary = await allocateTemporaryUsername(client, handle, handleOwner.id);
          await client.query("UPDATE users SET username=$2,username_source='beatgaler',updated_at=now() WHERE id=$1", [String(handleOwner.id), temporary]);
          renamed = { userId: String(handleOwner.id), from: String(handleOwner.username), to: temporary };
        }
      }

      // For an already-known X subject, the provider row tells us exactly which
      // immutable BeatGaler user owns it. Transfer the recycled handle to that
      // stable user in the *same transaction* that moves the previous display
      // owner away. This is the A -> base#NNNN / B -> handle atomic pair.
      if (existing) {
        await client.query("UPDATE users SET username=$2,username_source='x',updated_at=now() WHERE id=$1", [String(existing.id), handle]);
        await client.query(`
          UPDATE provider_identities
          SET profile=COALESCE(profile,'{}'::jsonb) || $3::jsonb,updated_at=now()
          WHERE provider=$1 AND provider_subject=$2
        `, ['x', subject, JSON.stringify({
          id: subject,
          username: handle,
          ...(identity?.name ? { name: String(identity.name) } : {}),
          profileSyncedAt: Date.now(),
        })]);
        existing = await providerOwner(client, 'x', subject);
        const localOwnerId = getBridge()?.userIdByUsername?.(handle);
        if (localOwnerId && String(localOwnerId) !== String(existing.id) && !renamed) {
          const ownerResult = await client.query('SELECT id,username,username_source FROM users WHERE id=$1', [String(localOwnerId)]);
          const owner = ownerResult.rows[0];
          if (owner && String(owner.username).toLowerCase() !== handle) {
            staleLocal = { userId: String(owner.id), username: String(owner.username), source: String(owner.username_source || 'beatgaler') };
          }
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
    if (staleLocal) bridge?.setUsernameByUserId?.(staleLocal.userId, staleLocal.username, staleLocal.source);
    if (existing) bridge?.adoptIdentityUser?.(bridgeIdentityInput(existing, 'x', subject, identity));
    return { allow: true, existingUserId: existing ? String(existing.id) : null, handle, renamed };
  }

  async function prepareDisconnect({ provider: providerInput, userId: userIdInput, usablePassword = false } = {}) {
    const provider = String(providerInput || '').trim().toLowerCase();
    const userId = String(userIdInput || '').trim();
    if (!userId) throw coded('BeatGaler user id is required.', 'USER_ID_REQUIRED');
    if (!['google', 'x'].includes(provider)) throw coded('Unsupported OAuth provider.', 'OAUTH_PROVIDER_UNSUPPORTED');
    if (typeof getBridge()?.disconnectProviderByUserId !== 'function') {
      throw coded('Local provider identity bridge is unavailable.', 'OAUTH_IDENTITY_BRIDGE_UNAVAILABLE');
    }
    // Drain local writes that were queued before the direct PostgreSQL mutation.
    await flushAuthority();

    const client = await pool.connect();
    let temporary = null;
    let authoritativeUsername = null;
    let connected = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`provider-unlink:${provider}:${userId}`]);
      const current = await providerForUser(client, userId, provider);
      if (!current) throw coded('BeatGaler account not found.', 'ACCOUNT_NOT_FOUND');
      authoritativeUsername = String(current.user.username || '');
      connected = Boolean(current.subject);
      if (connected) {
        const others = await client.query('SELECT provider FROM provider_identities WHERE user_id=$1 AND provider<>$2 LIMIT 1', [userId, provider]);
        if (!others.rows.length && !(usablePassword && current.user.password_hash && current.user.email)) {
          throw coded('Add another usable sign-in method before disconnecting this provider.', 'LAST_SIGNIN_METHOD_REQUIRED');
        }
        if (provider === 'x' && String(current.user.username_source || '') === 'x') {
          temporary = await allocateTemporaryUsername(client, current.user.username, userId);
          await client.query("UPDATE users SET username=$2,username_source='beatgaler',updated_at=now() WHERE id=$1", [userId, temporary]);
          authoritativeUsername = temporary;
        }
        await client.query('DELETE FROM provider_identities WHERE user_id=$1 AND provider=$2', [userId, provider]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    getBridge()?.disconnectProviderByUserId?.(userId, provider, authoritativeUsername);
    await flushAuthority();
    return { ok: true, connected, provider, userId, ...(temporary ? { username: temporary } : {}) };
  }

  async function prepare(input = {}) {
    const provider = String(input.provider || '').toLowerCase();
    if (provider === 'google') return prepareGoogle(input);
    if (provider === 'x') return prepareX(input);
    throw coded('Unsupported OAuth provider.', 'OAUTH_PROVIDER_UNSUPPORTED');
  }

  return { prepare, prepareGoogle, prepareX, prepareDisconnect };
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
  providerForUser,
  bridgeIdentityInput,
  createProviderIdentityAuthority,
};
