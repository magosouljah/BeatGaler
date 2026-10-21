'use strict';

const {
  ACTIVE_PENDING_STATES,
  normalizeEmail,
  requirePepper,
  digest,
  safeEqualHex,
} = require('./pending-signup-runtime');

function coded(message, code, extras = {}) {
  return Object.assign(new Error(message), { code, ...extras });
}

function createPendingSignupService({
  pool,
  runtime,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('Pending signup service requires PostgreSQL.');
  if (!runtime || typeof runtime.create !== 'function') throw new Error('Pending signup service requires pending signup runtime.');
  const pepper = requirePepper(env);
  const cooldownMs = Math.max(1_000, Number(env.BEATGALER_SIGNUP_RESEND_COOLDOWN_MS || 60_000));

  async function withEmailLock(email, work) {
    const client = await pool.connect();
    const normalized = normalizeEmail(email);
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`pending-signup:${normalized}`]);
      return await work(client, normalized);
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`pending-signup:${normalized}`]); } catch {}
      client.release();
    }
  }

  async function begin(input = {}) {
    const email = normalizeEmail(input.email);
    return withEmailLock(email, async client => {
      const existingUser = await client.query('SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1', [email]);
      if (existingUser.rows.length) {
        return { accepted: true, created: false, reason: 'existing_account' };
      }
      const existing = await client.query('SELECT id,status,expires_at FROM pending_signups WHERE email_normalized=$1 LIMIT 1', [email]);
      const row = existing.rows[0] || null;
      const active = row && ACTIVE_PENDING_STATES.has(String(row.status)) && new Date(row.expires_at).getTime() > now();
      if (active) {
        return { accepted: true, created: false, reason: 'pending_exists' };
      }
      const created = await runtime.create(input);
      return { accepted: true, created: true, ...created };
    });
  }

  async function loginGate(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return { blocked: false };
    const result = await pool.query(`SELECT id,status,updated_at,expires_at
      FROM pending_signups WHERE email_normalized=$1 LIMIT 1`, [normalized]);
    const row = result.rows[0] || null;
    if (!row) return { blocked: false };
    const status = String(row.status || '');
    if (status === 'ACTIVE' || status === 'EXPIRED' || status === 'CANCELLED') return { blocked: false, status };
    if (ACTIVE_PENDING_STATES.has(status)) {
      return { blocked: true, status, signupId: String(row.id) };
    }
    return { blocked: false, status };
  }

  async function resend({ signupId, continuationSecret } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM pending_signups WHERE id=$1 FOR UPDATE', [String(signupId || '')]);
      const row = result.rows[0];
      const expected = digest(pepper, 'continuation', continuationSecret);
      if (!row || !safeEqualHex(String(row.continuation_hash || ''), expected)) {
        throw coded('Signup continuation is invalid.', 'SIGNUP_CONTINUATION_INVALID');
      }
      if (!['DELIVERY_PENDING','CODE_SENT','RETRYABLE'].includes(String(row.status || ''))) {
        throw coded('Signup challenge cannot be resent in this state.', 'SIGNUP_RESEND_NOT_ALLOWED');
      }
      const requestedAt = row.last_requested_at ? new Date(row.last_requested_at).getTime() : 0;
      const remaining = requestedAt ? cooldownMs - (now() - requestedAt) : 0;
      if (remaining > 0) {
        throw coded('Please wait before requesting another verification email.', 'SIGNUP_RESEND_COOLDOWN', { retryAfterMs: remaining });
      }
      await client.query('UPDATE pending_signups SET last_requested_at=now(),updated_at=now() WHERE id=$1', [row.id]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
    return runtime.resend({ signupId, continuationSecret });
  }

  async function requeueStaleDeliveries({ staleMs = 5 * 60_000 } = {}) {
    const delay = Math.max(60_000, Number(staleMs || 5 * 60_000));
    const result = await pool.query(`
      UPDATE auth_delivery_outbox
      SET state='RETRYABLE', available_at=now(), last_error_code=COALESCE(last_error_code,'STALE_SENDING_RECOVERED'), updated_at=now()
      WHERE state='SENDING' AND updated_at <= now() - ($1::bigint * interval '1 millisecond')
      RETURNING id
    `, [delay]);
    return result.rows.length;
  }

  async function recoverStaleActivations({ staleMs = 5 * 60_000 } = {}) {
    const delay = Math.max(60_000, Number(staleMs || 5 * 60_000));
    const result = await pool.query(`
      UPDATE pending_signups
      SET status='RETRYABLE',updated_at=now()
      WHERE status IN ('ACTIVATING','PROVISIONING')
        AND updated_at <= now() - ($1::bigint * interval '1 millisecond')
      RETURNING id
    `, [delay]);
    return result.rows.length;
  }

  return {
    begin,
    loginGate,
    resend,
    verify: input => runtime.verify(input),
    status: input => runtime.status(input),
    claimActivation: input => runtime.claimActivation(input),
    setActivationState: (...args) => runtime.setActivationState(...args),
    claimDelivery: () => runtime.claimDelivery(),
    completeDelivery: (...args) => runtime.completeDelivery(...args),
    requeueStaleDeliveries,
    recoverStaleActivations,
    constants: { cooldownMs },
  };
}

module.exports = { createPendingSignupService };
