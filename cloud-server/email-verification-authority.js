'use strict';

const crypto = require('node:crypto');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function emailHash(value) {
  return crypto.createHash('sha256').update(normalizeEmail(value)).digest('hex');
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

async function statusForUser(pool, userId) {
  if (!pool?.query) throw coded('EMAIL_VERIFICATION_POSTGRES_REQUIRED');
  const id = String(userId || '').trim();
  if (!id) return { email_verified: false, email_verified_at: null };
  const result = await pool.query(`
    SELECT u.email, v.email_hash, v.verified_at,
      NOT EXISTS (
        SELECT 1 FROM users other
        WHERE other.id<>u.id AND lower(btrim(other.email))=lower(btrim(u.email))
      ) AS unique_email
    FROM users u LEFT JOIN user_email_verifications v ON v.user_id=u.id
    WHERE u.id=$1
  `, [id]);
  const row = result.rows[0];
  const verified = Boolean(row?.email && row?.unique_email && row?.email_hash === emailHash(row.email));
  return {
    email_verified: verified,
    email_verified_at: verified ? new Date(row.verified_at).toISOString() : null,
  };
}

async function writeVerified(client, userId, email, verifiedAt) {
  const id = String(userId || '').trim();
  const normalized = normalizeEmail(email);
  const timestamp = new Date(verifiedAt);
  if (!id || !normalized || !Number.isFinite(timestamp.getTime())) throw coded('EMAIL_VERIFICATION_INPUT_INVALID');

  const user = await client.query('SELECT email FROM users WHERE id=$1 FOR UPDATE', [id]);
  if (user.rows.length !== 1 || normalizeEmail(user.rows[0].email) !== normalized) {
    throw coded('EMAIL_VERIFICATION_CURRENT_EMAIL_MISMATCH');
  }
  const result = await client.query(`
    INSERT INTO user_email_verifications(user_id,email_hash,verified_at)
    VALUES($1,$2,$3)
    ON CONFLICT(user_id) DO UPDATE SET
      email_hash=EXCLUDED.email_hash,
      verified_at=CASE
        WHEN user_email_verifications.email_hash=EXCLUDED.email_hash
          THEN LEAST(user_email_verifications.verified_at, EXCLUDED.verified_at)
        ELSE EXCLUDED.verified_at
      END
    RETURNING user_id
  `, [id, emailHash(normalized), timestamp]);
  if (result.rowCount !== 1) throw coded('EMAIL_VERIFICATION_WRITE_FAILED');
  return { userId: id, emailHash: emailHash(normalized) };
}

async function markVerifiedEmail(pool, userId, email, { verifiedAt = new Date(), client = null } = {}) {
  if (!pool?.connect && !client?.query) throw coded('EMAIL_VERIFICATION_POSTGRES_REQUIRED');
  if (client) return writeVerified(client, userId, email, verifiedAt);
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const result = await writeVerified(connection, userId, email, verifiedAt);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function clearVerifiedEmail(pool, userId) {
  if (!pool?.query) throw coded('EMAIL_VERIFICATION_POSTGRES_REQUIRED');
  await pool.query('DELETE FROM user_email_verifications WHERE user_id=$1', [String(userId || '')]);
}

module.exports = { normalizeEmail, emailHash, statusForUser, markVerifiedEmail, clearVerifiedEmail };
