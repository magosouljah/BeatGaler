'use strict';

const crypto = require('node:crypto');
const { hashPassword } = require('./password-kdf');
const { encryptSecretForStorage, decryptSecretFromStorage } = require('./secret-envelope');
const { normalizeSecretKeyring } = require('./secret-keyring');

const ACTIVE_PENDING_STATES = new Set(['NEW','DELIVERY_PENDING','CODE_SENT','VERIFIED','ACTIVATING','PROVISIONING','RETRYABLE']);
const FINAL_PENDING_STATES = new Set(['ACTIVE','EXPIRED','CANCELLED']);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBase(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function validBase(base) {
  return /^[a-z0-9._]{3,20}$/.test(base) && !base.includes('#');
}

function requirePassword(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 200) {
    const error = new Error('Password must be between 8 and 200 characters.');
    error.code = 'PASSWORD_POLICY';
    throw error;
  }
  return value;
}

function requirePepper(env = process.env) {
  const pepper = String(env.BEATGALER_SIGNUP_PEPPER || '').trim();
  if (!pepper) {
    const error = new Error('BEATGALER_SIGNUP_PEPPER is required for pending signup challenges.');
    error.code = 'SIGNUP_PEPPER_REQUIRED';
    throw error;
  }
  if (String(env.NODE_ENV || '').toLowerCase() === 'production' && Buffer.byteLength(pepper, 'utf8') < 32) {
    const error = new Error('BEATGALER_SIGNUP_PEPPER must contain at least 32 bytes in production.');
    error.code = 'SIGNUP_PEPPER_WEAK';
    throw error;
  }
  return pepper;
}

function digest(pepper, kind, value) {
  return crypto.createHmac('sha256', pepper).update(`${kind}\0${String(value || '')}`).digest('hex');
}

function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(String(left || ''), 'hex');
    const b = Buffer.from(String(right || ''), 'hex');
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function randomManualCode(randomBytes = crypto.randomBytes) {
  const max = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  while (true) {
    const value = randomBytes(4).readUInt32BE(0);
    if (value < limit) return String(value % max).padStart(6, '0');
  }
}

function normalizeManualCode(value) {
  const match = String(value ?? '').trim().match(/^([0-9]{3})(?:[ -]?)([0-9]{3})$/);
  return match ? `${match[1]}${match[2]}` : null;
}

function formatManualCode(value) {
  const canonical = normalizeManualCode(value);
  if (!canonical) throw new TypeError('Manual verification code must contain exactly 6 digits.');
  return `${canonical.slice(0, 3)}-${canonical.slice(3)}`;
}

function randomId(prefix, randomBytes = crypto.randomBytes) {
  return `${prefix}${randomBytes(18).toString('base64url')}`;
}

function pendingPublic(row) {
  if (!row) return null;
  return {
    signup_id: String(row.id),
    status: String(row.status),
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    challenge_expires_at: row.challenge_expires_at ? new Date(row.challenge_expires_at).toISOString() : null,
    resend_count: Number(row.resend_count || 0),
    verified: Boolean(row.verified_at),
    active: String(row.status) === 'ACTIVE',
  };
}

function createPendingSignupRuntime({
  pool,
  keyring,
  env = process.env,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('Pending signup runtime requires PostgreSQL.');
  const ring = normalizeSecretKeyring(keyring);
  const pepper = requirePepper(env);
  const challengeTtlMs = Math.max(60_000, Number(env.BEATGALER_SIGNUP_CHALLENGE_TTL_MS || 10 * 60_000));
  const pendingTtlMs = Math.max(challengeTtlMs, Number(env.BEATGALER_SIGNUP_TTL_MS || 24 * 60 * 60_000));
  const resendCooldownMs = Math.max(1_000, Number(env.BEATGALER_SIGNUP_RESEND_COOLDOWN_MS || 60_000));
  const maxFailures = Math.max(1, Number(env.BEATGALER_SIGNUP_MAX_CHALLENGE_FAILURES || 5));
  const maxResends = Math.max(1, Number(env.BEATGALER_SIGNUP_MAX_RESENDS || 5));

  function encryptDelivery(outboxId, payload) {
    const packed = encryptSecretForStorage(JSON.stringify(payload), {
      key: ring.encryptKey,
      keyVersion: ring.activeKeyVersion,
      aad: `auth-delivery:${outboxId}`,
    });
    return {
      ciphertext: packed.ciphertext.toString('base64'),
      nonce: packed.nonce.toString('base64'),
      keyVersion: packed.keyVersion,
    };
  }

  function decryptDelivery(row) {
    return JSON.parse(decryptSecretFromStorage({
      ciphertext: Buffer.from(String(row.secret_ciphertext || ''), 'base64'),
      nonce: Buffer.from(String(row.secret_nonce || ''), 'base64'),
      keyVersion: Number(row.secret_key_version),
    }, {
      resolveKey: version => ring.resolveKey(version),
      aad: `auth-delivery:${row.id}`,
    }));
  }

  function newChallenge(email, signupId) {
    const linkToken = randomId('sv_', randomBytes);
    const manualCode = randomManualCode(randomBytes);
    const expiresAt = new Date(now() + challengeTtlMs);
    const outboxId = randomId('out_', randomBytes);
    const encrypted = encryptDelivery(outboxId, {
      email,
      link_token: linkToken,
      manual_code: formatManualCode(manualCode),
      expires_at: expiresAt.toISOString(),
    });
    return {
      signupId,
      linkToken,
      manualCode,
      linkHash: digest(pepper, 'link', linkToken),
      codeHash: digest(pepper, 'code', manualCode),
      expiresAt,
      outboxId,
      encrypted,
    };
  }

  async function create({ email, usernameBase, password, installationId = null } = {}) {
    const normalizedEmail = normalizeEmail(email);
    const base = normalizeBase(usernameBase);
    if (!validEmail(normalizedEmail)) throw Object.assign(new Error('Valid email is required.'), { code: 'EMAIL_INVALID' });
    if (!validBase(base)) throw Object.assign(new Error('Username base must be 3-20 lowercase letters, digits, dot or underscore.'), { code: 'USERNAME_BASE_INVALID' });
    const rawPassword = requirePassword(password);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(rawPassword, salt);
    const continuation = randomId('sc_', randomBytes);
    const continuationHash = digest(pepper, 'continuation', continuation);
    const candidateId = randomId('psu_', randomBytes);
    const challenge = newChallenge(normalizedEmail, candidateId);
    const expiresAt = new Date(now() + pendingTtlMs);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingUser = await client.query('SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1', [normalizedEmail]);
      if (existingUser.rows.length) {
        const error = new Error('Email is already associated with a BeatGaler account.');
        error.code = 'EMAIL_CONFLICT';
        throw error;
      }
      const existing = await client.query('SELECT * FROM pending_signups WHERE email_normalized=$1 FOR UPDATE', [normalizedEmail]);
      const current = existing.rows[0] || null;
      const signupId = current && ACTIVE_PENDING_STATES.has(String(current.status)) ? String(current.id) : candidateId;
      const actualChallenge = signupId === candidateId ? challenge : newChallenge(normalizedEmail, signupId);
      if (current && signupId === candidateId) {
        await client.query('DELETE FROM pending_signups WHERE id=$1', [current.id]);
      }
      if (current && signupId !== candidateId) {
        await client.query("UPDATE auth_delivery_outbox SET state='CANCELLED',updated_at=now() WHERE signup_id=$1 AND state IN ('PENDING','SENDING','RETRYABLE')", [signupId]);
      }
      await client.query(`
        INSERT INTO pending_signups(
          id,email_normalized,username_base,password_hash,password_salt,installation_id,continuation_hash,
          link_token_hash,manual_code_hash,challenge_expires_at,challenge_failures,resend_count,last_sent_at,status,
          verified_at,activated_user_id,expires_at,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,NULL,'DELIVERY_PENDING',NULL,NULL,$11,now(),now())
        ON CONFLICT(id) DO UPDATE SET
          username_base=EXCLUDED.username_base,password_hash=EXCLUDED.password_hash,password_salt=EXCLUDED.password_salt,
          installation_id=EXCLUDED.installation_id,continuation_hash=EXCLUDED.continuation_hash,
          link_token_hash=EXCLUDED.link_token_hash,manual_code_hash=EXCLUDED.manual_code_hash,
          challenge_expires_at=EXCLUDED.challenge_expires_at,challenge_failures=0,resend_count=0,last_sent_at=NULL,
          status='DELIVERY_PENDING',verified_at=NULL,activated_user_id=NULL,expires_at=EXCLUDED.expires_at,updated_at=now()
      `, [signupId, normalizedEmail, base, passwordHash, salt, installationId ? String(installationId) : null,
        continuationHash, actualChallenge.linkHash, actualChallenge.codeHash, actualChallenge.expiresAt, expiresAt]);
      await client.query(`
        INSERT INTO auth_delivery_outbox(
          id,idempotency_key,signup_id,kind,destination_hash,public_payload,secret_ciphertext,secret_nonce,secret_key_version,state
        ) VALUES($1,$2,$3,'signup_verification',$4,$5::jsonb,$6,$7,$8,'PENDING')
      `, [actualChallenge.outboxId, `signup:${signupId}:verify:${actualChallenge.outboxId}`, signupId,
        digest(pepper, 'destination', normalizedEmail), JSON.stringify({ challenge_expires_at: actualChallenge.expiresAt.toISOString() }),
        actualChallenge.encrypted.ciphertext, actualChallenge.encrypted.nonce, actualChallenge.encrypted.keyVersion]);
      await client.query('COMMIT');
      return {
        signup_id: signupId,
        continuation_secret: continuation,
        status: 'DELIVERY_PENDING',
        expires_at: expiresAt.toISOString(),
        challenge_expires_at: actualChallenge.expiresAt.toISOString(),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  function verifyContinuation(row, continuationSecret) {
    return safeEqualHex(String(row?.continuation_hash || ''), digest(pepper, 'continuation', continuationSecret));
  }

  async function verify({ signupId, continuationSecret, challenge } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM pending_signups WHERE id=$1 FOR UPDATE', [String(signupId || '')]);
      const row = result.rows[0];
      if (!row || !verifyContinuation(row, continuationSecret)) throw Object.assign(new Error('Signup continuation is invalid.'), { code: 'SIGNUP_CONTINUATION_INVALID' });
      const status = String(row.status || '');
      if (status === 'VERIFIED' || status === 'ACTIVATING' || status === 'PROVISIONING' || status === 'ACTIVE') {
        await client.query('COMMIT');
        return pendingPublic(row);
      }
      if (!ACTIVE_PENDING_STATES.has(status)) throw Object.assign(new Error('Signup is no longer active.'), { code: 'SIGNUP_NOT_ACTIVE' });
      if (new Date(row.expires_at).getTime() <= now()) {
        await client.query("UPDATE pending_signups SET status='EXPIRED',updated_at=now() WHERE id=$1", [row.id]);
        await client.query('COMMIT');
        throw Object.assign(new Error('Signup expired.'), { code: 'SIGNUP_EXPIRED' });
      }
      if (Number(row.challenge_failures || 0) >= maxFailures || new Date(row.challenge_expires_at).getTime() <= now()) {
        throw Object.assign(new Error('Verification challenge expired.'), { code: 'SIGNUP_CHALLENGE_EXPIRED' });
      }
      const raw = String(challenge || '').trim();
      const canonicalManualCode = normalizeManualCode(raw);
      const matched = safeEqualHex(row.link_token_hash, digest(pepper, 'link', raw)) ||
        (canonicalManualCode !== null && safeEqualHex(row.manual_code_hash, digest(pepper, 'code', canonicalManualCode)));
      if (!matched) {
        if (String(env.BEATGALER_SIGNUP_DIAGNOSTICS || '') === '1') {
          try {
            const deliveries = await client.query(`SELECT id,secret_ciphertext,secret_nonce,secret_key_version,sent_at
              FROM auth_delivery_outbox WHERE signup_id=$1 AND kind='signup_verification'
              ORDER BY created_at DESC LIMIT 5`, [row.id]);
            const candidateHash = canonicalManualCode === null ? '' : digest(pepper, 'code', canonicalManualCode);
            const deliveryMatches = deliveries.rows.map(delivery => {
              const sentCode = normalizeManualCode(decryptDelivery(delivery).manual_code);
              return sentCode !== null && safeEqualHex(candidateHash, digest(pepper, 'code', sentCode));
            });
            console.warn('[signup-verify-audit]', {
              format_valid: canonicalManualCode !== null,
              challenge_failures_before: Number(row.challenge_failures || 0),
              resend_count: Number(row.resend_count || 0),
              challenge_expires_at: new Date(row.challenge_expires_at).toISOString(),
              delivery_matches_newest_first: deliveryMatches,
            });
          } catch (auditError) {
            console.warn('[signup-verify-audit]', { audit_error: String(auditError?.code || 'UNAVAILABLE') });
          }
        }
        const failures = Number(row.challenge_failures || 0) + 1;
        await client.query('UPDATE pending_signups SET challenge_failures=$2,updated_at=now() WHERE id=$1', [row.id, failures]);
        await client.query('COMMIT');
        throw Object.assign(new Error('Verification challenge is invalid.'), { code: failures >= maxFailures ? 'SIGNUP_CHALLENGE_LOCKED' : 'SIGNUP_CHALLENGE_INVALID' });
      }
      const updated = await client.query("UPDATE pending_signups SET status='VERIFIED',verified_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [row.id]);
      await client.query('COMMIT');
      return pendingPublic(updated.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function resend({ signupId, continuationSecret } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM pending_signups WHERE id=$1 FOR UPDATE', [String(signupId || '')]);
      const row = result.rows[0];
      if (!row || !verifyContinuation(row, continuationSecret)) throw Object.assign(new Error('Signup continuation is invalid.'), { code: 'SIGNUP_CONTINUATION_INVALID' });
      if (!['DELIVERY_PENDING','CODE_SENT','RETRYABLE'].includes(String(row.status || ''))) {
        throw Object.assign(new Error('Signup challenge cannot be resent in this state.'), { code: 'SIGNUP_RESEND_NOT_ALLOWED' });
      }
      if (new Date(row.expires_at).getTime() <= now()) throw Object.assign(new Error('Signup expired.'), { code: 'SIGNUP_EXPIRED' });
      if (Number(row.resend_count || 0) >= maxResends) throw Object.assign(new Error('Signup resend limit reached.'), { code: 'SIGNUP_RESEND_LIMIT' });
      const lastSent = row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;
      if (lastSent && now() - lastSent < resendCooldownMs) {
        const error = new Error('Please wait before requesting another verification email.');
        error.code = 'SIGNUP_RESEND_COOLDOWN';
        error.retryAfterMs = resendCooldownMs - (now() - lastSent);
        throw error;
      }
      const challenge = newChallenge(String(row.email_normalized), String(row.id));
      await client.query("UPDATE auth_delivery_outbox SET state='CANCELLED',updated_at=now() WHERE signup_id=$1 AND state IN ('PENDING','SENDING','RETRYABLE')", [row.id]);
      const updated = await client.query(`UPDATE pending_signups SET
        link_token_hash=$2,manual_code_hash=$3,challenge_expires_at=$4,challenge_failures=0,
        resend_count=resend_count+1,last_sent_at=NULL,status='DELIVERY_PENDING',updated_at=now()
        WHERE id=$1 RETURNING *`, [row.id, challenge.linkHash, challenge.codeHash, challenge.expiresAt]);
      await client.query(`INSERT INTO auth_delivery_outbox(
        id,idempotency_key,signup_id,kind,destination_hash,public_payload,secret_ciphertext,secret_nonce,secret_key_version,state
      ) VALUES($1,$2,$3,'signup_verification',$4,$5::jsonb,$6,$7,$8,'PENDING')`, [
        challenge.outboxId, `signup:${row.id}:verify:${challenge.outboxId}`, row.id,
        digest(pepper, 'destination', row.email_normalized), JSON.stringify({ challenge_expires_at: challenge.expiresAt.toISOString() }),
        challenge.encrypted.ciphertext, challenge.encrypted.nonce, challenge.encrypted.keyVersion,
      ]);
      await client.query('COMMIT');
      return pendingPublic(updated.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async function status({ signupId, continuationSecret } = {}) {
    const result = await pool.query('SELECT * FROM pending_signups WHERE id=$1', [String(signupId || '')]);
    const row = result.rows[0];
    if (!row || !verifyContinuation(row, continuationSecret)) return null;
    return pendingPublic(row);
  }

  async function claimActivation({ signupId, continuationSecret } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM pending_signups WHERE id=$1 FOR UPDATE', [String(signupId || '')]);
      const row = result.rows[0];
      if (!row || !verifyContinuation(row, continuationSecret)) throw Object.assign(new Error('Signup continuation is invalid.'), { code: 'SIGNUP_CONTINUATION_INVALID' });
      if (String(row.status) === 'ACTIVE') {
        await client.query('COMMIT');
        return { claimed: false, row };
      }
      if (String(row.status) !== 'VERIFIED' && String(row.status) !== 'RETRYABLE') {
        throw Object.assign(new Error('Signup is not ready for activation.'), { code: 'SIGNUP_NOT_VERIFIED' });
      }
      const updated = await client.query("UPDATE pending_signups SET status='ACTIVATING',updated_at=now() WHERE id=$1 RETURNING *", [row.id]);
      await client.query('COMMIT');
      return { claimed: true, row: updated.rows[0] };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async function setActivationState(signupId, status, { userId = null, errorCode = null } = {}) {
    const allowed = new Set(['PROVISIONING','ACTIVE','RETRYABLE']);
    if (!allowed.has(String(status))) throw new Error('Invalid activation state.');
    const result = await pool.query(`UPDATE pending_signups SET status=$2,
      activated_user_id=CASE WHEN $2='ACTIVE' THEN COALESCE($3,activated_user_id) ELSE activated_user_id END,
      updated_at=now() WHERE id=$1 RETURNING *`, [String(signupId), String(status), userId ? String(userId) : null]);
    if (!result.rows.length) throw Object.assign(new Error('Pending signup not found.'), { code: 'SIGNUP_NOT_FOUND' });
    if (errorCode && status === 'RETRYABLE') {
      await pool.query(`INSERT INTO auth_provisioning_ledger(signup_id,step,state,idempotency_key,last_error_code,updated_at)
        VALUES($1,'activation','RETRYABLE',$2,$3,now())
        ON CONFLICT(signup_id,step) DO UPDATE SET state='RETRYABLE',last_error_code=EXCLUDED.last_error_code,updated_at=now()`,
      [String(signupId), `signup:${signupId}:activation`, String(errorCode).slice(0, 120)]);
    }
    return pendingPublic(result.rows[0]);
  }

  async function claimDelivery() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT * FROM auth_delivery_outbox
        WHERE state IN ('PENDING','RETRYABLE') AND available_at<=now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = result.rows[0];
      if (!row) { await client.query('COMMIT'); return null; }
      await client.query("UPDATE auth_delivery_outbox SET state='SENDING',attempt_count=attempt_count+1,updated_at=now() WHERE id=$1", [row.id]);
      await client.query('COMMIT');
      return { row: { ...row, state: 'SENDING', attempt_count: Number(row.attempt_count || 0) + 1 }, secret: decryptDelivery(row) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async function completeDelivery(id, { ok, errorCode = null, retryDelayMs = 60_000 } = {}) {
    if (ok) {
      const result = await pool.query(`UPDATE auth_delivery_outbox SET state='SENT',sent_at=now(),last_error_code=NULL,updated_at=now()
        WHERE id=$1 RETURNING signup_id`, [String(id)]);
      const signupId = result.rows[0]?.signup_id;
      if (signupId) await pool.query("UPDATE pending_signups SET status=CASE WHEN status='DELIVERY_PENDING' THEN 'CODE_SENT' ELSE status END,last_sent_at=now(),updated_at=now() WHERE id=$1", [signupId]);
      return;
    }
    await pool.query(`UPDATE auth_delivery_outbox SET state='RETRYABLE',last_error_code=$2,
      available_at=now() + ($3::bigint * interval '1 millisecond'),updated_at=now() WHERE id=$1`,
    [String(id), String(errorCode || 'DELIVERY_FAILED').slice(0, 120), Math.max(1_000, Number(retryDelayMs || 60_000))]);
  }

  return {
    create,
    verify,
    resend,
    status,
    claimActivation,
    setActivationState,
    claimDelivery,
    completeDelivery,
    decryptDelivery,
    constants: { challengeTtlMs, pendingTtlMs, resendCooldownMs, maxFailures, maxResends },
  };
}

module.exports = {
  ACTIVE_PENDING_STATES,
  FINAL_PENDING_STATES,
  normalizeEmail,
  normalizeBase,
  validEmail,
  validBase,
  requirePepper,
  digest,
  safeEqualHex,
  randomManualCode,
  normalizeManualCode,
  formatManualCode,
  pendingPublic,
  createPendingSignupRuntime,
};
