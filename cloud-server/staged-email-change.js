'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_DELIVERIES = 5;

function coded(message, code, extras = {}) {
  return Object.assign(new Error(message), { code, ...extras });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function sameHash(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function reauthToken(req) {
  return String(req?.body?.reauthToken || req?.body?.reauth_token || req?.headers?.['x-beatgaler-reauth'] || '');
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function markLifecycleEmailVerified(runtime, userId, email, now = () => Date.now()) {
  const state = runtime?._test?.stateSnapshot?.();
  const stateFile = runtime?._test?.stateFile;
  if (!state || !stateFile) throw coded('Email verification authority is unavailable.', 'EMAIL_VERIFICATION_AUTHORITY_UNAVAILABLE');
  state.email_verified = state.email_verified && typeof state.email_verified === 'object' ? state.email_verified : {};
  const emailHash = sha256(normalizeEmail(email));
  if (state.email_verified[String(userId)]?.email_hash === emailHash) return;
  state.email_verified[String(userId)] = {
    email_hash: emailHash,
    verified_at: new Date(now()).toISOString(),
  };
  atomicWriteJson(stateFile, state);
}

function createStagedEmailChange({
  pool,
  runtime,
  emailNotifier,
  commitLocalEmail,
  flushAuthority = async () => {},
  env = process.env,
  now = () => Date.now(),
  randomBytes = size => crypto.randomBytes(size),
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('Staged email change requires PostgreSQL.');
  if (!runtime?._test?.sessionInfoFromRequest || !runtime?._test?.consumeReauth || !runtime?._test?.revokeUserSessions) {
    throw new Error('Staged email change requires account lifecycle authority.');
  }
  if (typeof commitLocalEmail !== 'function') throw new Error('Staged email change requires local identity commit callback.');
  const ttlMs = Math.max(5 * 60 * 1000, Math.min(60 * 60 * 1000, Number(env.BEATGALER_EMAIL_CHANGE_TTL_MS || DEFAULT_TTL_MS)));

  function session(req) {
    const info = runtime._test.sessionInfoFromRequest(req);
    if (!info) throw coded('Session expired. Sign in again.', 'SESSION_REQUIRED');
    return info;
  }

  function consumeReauth(req) {
    const result = runtime._test.consumeReauth(req, reauthToken(req));
    if (!result?.ok) throw coded('Recent reauthentication is required.', result?.code || 'REAUTH_REQUIRED');
    return result;
  }

  async function currentDbUser(client, userId, { lock = false } = {}) {
    const result = await client.query(`SELECT id,email,username,username_source FROM users WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [String(userId)]);
    return result.rows[0] || null;
  }

  async function assertEmailAvailable(client, email, userId) {
    const result = await client.query('SELECT id FROM users WHERE lower(email)=lower($1) AND id<>$2 LIMIT 1', [normalizeEmail(email), String(userId)]);
    if (result.rows.length) throw coded('That email is already attached to another BeatGaler account.', 'EMAIL_CHANGE_CONFLICT');
  }

  function newChallenge() {
    const token = `emc_${randomBytes(32).toString('base64url')}`;
    return { token, tokenHash: sha256(token), requestId: `emc_${randomBytes(12).toString('hex')}` };
  }

  async function deliverConfirmation(row, token, { reserved = false } = {}) {
    if (typeof emailNotifier !== 'function') throw coded('Email delivery is unavailable.', 'EMAIL_CHANGE_DELIVERY_UNAVAILABLE');
    await emailNotifier({
      kind: 'email_change_confirmation',
      to: row.new_email,
      token,
      expires_at: new Date(row.expires_at).toISOString(),
    });
    if (!reserved) {
      await pool.query(`
        UPDATE auth_email_changes
        SET delivery_count=delivery_count+1,last_delivery_at=now(),updated_at=now()
        WHERE user_id=$1 AND request_id=$2
      `, [String(row.user_id), String(row.request_id)]);
    }
  }

  async function start(req, newEmailInput) {
    const info = session(req);
    const proof = consumeReauth(req);
    const newEmail = normalizeEmail(newEmailInput);
    if (!validEmail(newEmail)) throw coded('Enter a valid email address.', 'EMAIL_INVALID');

    const client = await pool.connect();
    let row;
    let token;
    try {
      await client.query('BEGIN');
      const user = await currentDbUser(client, info.userId, { lock: true });
      if (!user) throw coded('BeatGaler account not found.', 'ACCOUNT_NOT_FOUND');
      const priorChange = await client.query('SELECT * FROM auth_email_changes WHERE user_id=$1 FOR UPDATE', [String(info.userId)]);
      const prior = priorChange.rows[0];
      if (prior?.state === 'CONFIRMED' && prior.old_email && !prior.old_notice_sent_at) {
        throw coded('The previous email-change notice is still pending delivery.', 'EMAIL_CHANGE_NOTICE_PENDING');
      }
      const activePrior = prior?.state === 'PENDING' && new Date(prior.expires_at).getTime() > now();
      if (activePrior && Number(prior.delivery_count || 0) >= MAX_DELIVERIES) {
        throw coded('Email-change delivery limit reached. Start again later.', 'EMAIL_CHANGE_RESEND_LIMIT');
      }
      const lastDelivery = activePrior && prior.last_delivery_at ? new Date(prior.last_delivery_at).getTime() : 0;
      if (lastDelivery && now() - lastDelivery < RESEND_COOLDOWN_MS) {
        throw coded('Wait before requesting another email-change message.', 'EMAIL_CHANGE_RESEND_COOLDOWN',
          { retryAfterMs: RESEND_COOLDOWN_MS - (now() - lastDelivery) });
      }
      const oldEmail = normalizeEmail(user.email);
      if (!oldEmail && !String(proof?.method || '').startsWith('oauth:')) {
        throw coded('Provider reauthentication is required to add the first sign-in email.', 'EMAIL_CHANGE_PROVIDER_REAUTH_REQUIRED');
      }
      if (oldEmail === newEmail) throw coded('The new email must be different from the current email.', 'EMAIL_CHANGE_SAME_EMAIL');
      await assertEmailAvailable(client, newEmail, info.userId);

      const challenge = newChallenge();
      token = challenge.token;
      const expiresAt = new Date(now() + ttlMs);
      const result = await client.query(`
        INSERT INTO auth_email_changes(
          user_id,request_id,old_email,new_email,token_hash,state,attempt_count,delivery_count,last_delivery_at,expires_at,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,'PENDING',0,$7,now(),$6,now(),now())
        ON CONFLICT(user_id) DO UPDATE SET
          request_id=EXCLUDED.request_id,
          old_email=EXCLUDED.old_email,
          new_email=EXCLUDED.new_email,
          token_hash=EXCLUDED.token_hash,
          state='PENDING',
          attempt_count=0,
          delivery_count=EXCLUDED.delivery_count,
          last_delivery_at=now(),
          old_notice_attempts=0,
          old_notice_sent_at=NULL,
          expires_at=EXCLUDED.expires_at,
          confirmed_at=NULL,
          created_at=now(),
          updated_at=now()
        RETURNING *
      `, [String(info.userId), challenge.requestId, oldEmail || null, newEmail, challenge.tokenHash, expiresAt,
        activePrior ? Number(prior.delivery_count || 0) + 1 : 1]);
      row = result.rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    try {
      await deliverConfirmation(row, token, { reserved: true });
    } catch (error) {
      throw coded('The email change was saved but the verification message could not be delivered. Retry the change safely.',
        'EMAIL_CHANGE_DELIVERY_FAILED');
    }
    return {
      ok: true,
      pending: true,
      request_id: row.request_id,
      expires_at: new Date(row.expires_at).toISOString(),
    };
  }

  async function resend(req) {
    const info = session(req);
    const client = await pool.connect();
    let row;
    let token;
    try {
      await client.query('BEGIN');
      const pending = await client.query('SELECT * FROM auth_email_changes WHERE user_id=$1 FOR UPDATE', [String(info.userId)]);
      row = pending.rows[0];
      if (!row || row.state !== 'PENDING') throw coded('No email change is waiting for confirmation.', 'EMAIL_CHANGE_NOT_PENDING');
      if (new Date(row.expires_at).getTime() <= now()) {
        await client.query("UPDATE auth_email_changes SET state='EXPIRED',updated_at=now() WHERE user_id=$1", [String(info.userId)]);
        await client.query('COMMIT');
        throw coded('This email-change request expired. Start again.', 'EMAIL_CHANGE_EXPIRED');
      }
      if (Number(row.delivery_count || 0) >= MAX_DELIVERIES) {
        throw coded('Email-change delivery limit reached. Start again later.', 'EMAIL_CHANGE_RESEND_LIMIT');
      }
      const lastDelivery = row.last_delivery_at ? new Date(row.last_delivery_at).getTime() : 0;
      if (lastDelivery && now() - lastDelivery < RESEND_COOLDOWN_MS) {
        throw coded('Wait before requesting another email-change message.', 'EMAIL_CHANGE_RESEND_COOLDOWN',
          { retryAfterMs: RESEND_COOLDOWN_MS - (now() - lastDelivery) });
      }
      const challenge = newChallenge();
      token = challenge.token;
      const expiresAt = new Date(now() + ttlMs);
      const updated = await client.query(`
        UPDATE auth_email_changes
        SET request_id=$2,token_hash=$3,attempt_count=0,expires_at=$4,
            delivery_count=delivery_count+1,last_delivery_at=now(),updated_at=now()
        WHERE user_id=$1
        RETURNING *
      `, [String(info.userId), challenge.requestId, challenge.tokenHash, expiresAt]);
      row = updated.rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    try {
      await deliverConfirmation(row, token, { reserved: true });
    } catch {
      throw coded('The verification message could not be delivered. Try again later.', 'EMAIL_CHANGE_DELIVERY_FAILED');
    }
    return { ok: true, pending: true, request_id: row.request_id, expires_at: new Date(row.expires_at).toISOString() };
  }

  async function inspectToken(userId, token) {
    const tokenHash = sha256(token);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM auth_email_changes WHERE user_id=$1 FOR UPDATE', [String(userId)]);
      const row = result.rows[0];
      if (!row || row.state !== 'PENDING') throw coded('Email-change code is invalid or expired.', 'EMAIL_CHANGE_INVALID');
      if (new Date(row.expires_at).getTime() <= now()) {
        await client.query("UPDATE auth_email_changes SET state='EXPIRED',updated_at=now() WHERE user_id=$1", [String(userId)]);
        await client.query('COMMIT');
        throw coded('Email-change code is invalid or expired.', 'EMAIL_CHANGE_EXPIRED');
      }
      if (!sameHash(row.token_hash, tokenHash)) {
        const attempts = Number(row.attempt_count || 0) + 1;
        await client.query(`
          UPDATE auth_email_changes
          SET attempt_count=$2,state=CASE WHEN $2 >= $3 THEN 'FAILED' ELSE state END,updated_at=now()
          WHERE user_id=$1
        `, [String(userId), attempts, MAX_ATTEMPTS]);
        await client.query('COMMIT');
        throw coded('Email-change code is invalid or expired.', attempts >= MAX_ATTEMPTS ? 'EMAIL_CHANGE_LOCKED' : 'EMAIL_CHANGE_INVALID');
      }
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function confirm(req, rawToken) {
    const info = session(req);
    const token = String(rawToken || '');
    if (!token) throw coded('Email-change code is required.', 'EMAIL_CHANGE_INVALID');
    await inspectToken(info.userId, token);

    // Revoke all existing sessions/capabilities before the identity swap. If
    // revocation fails, the old email remains authoritative and the token can
    // be retried safely.
    await runtime._test.revokeUserSessions(String(info.userId), 'email_change');
    await flushAuthority();

    const tokenHash = sha256(token);
    const client = await pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      const pending = await client.query('SELECT * FROM auth_email_changes WHERE user_id=$1 FOR UPDATE', [String(info.userId)]);
      row = pending.rows[0];
      if (!row || row.state !== 'PENDING' || !sameHash(row.token_hash, tokenHash) || new Date(row.expires_at).getTime() <= now()) {
        throw coded('Email-change code is invalid or expired.', 'EMAIL_CHANGE_INVALID');
      }
      const user = await currentDbUser(client, info.userId, { lock: true });
      if (!user || normalizeEmail(user.email) !== normalizeEmail(row.old_email)) {
        throw coded('The account email changed while this request was pending. Start again.', 'EMAIL_CHANGE_STALE');
      }
      try {
        await assertEmailAvailable(client, row.new_email, info.userId);
      } catch (error) {
        await client.query("UPDATE auth_email_changes SET state='CONFLICT',updated_at=now() WHERE user_id=$1", [String(info.userId)]);
        throw error;
      }
      await client.query('UPDATE users SET email=$2,updated_at=now() WHERE id=$1', [String(info.userId), normalizeEmail(row.new_email)]);
      await client.query(`
        UPDATE auth_email_changes
        SET state='CONFIRMED',confirmed_at=now(),updated_at=now()
        WHERE user_id=$1
      `, [String(info.userId)]);
      await client.query("UPDATE direct_capabilities SET status='REVOKED',revoked_at=now(),revoke_reason='email_change' WHERE user_id=$1 AND status IN ('ACTIVE','AUTHORIZED')", [String(info.userId)]);
      await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [String(info.userId)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // PostgreSQL committed the identity swap. Re-read its authoritative row so
    // a crash here can be repaired by the worker without the original session.
    await reconcileConfirmedUser(String(info.userId));

    let oldEmailNotified = false;
    if (typeof emailNotifier === 'function' && row.old_email) {
      try {
        await emailNotifier({ kind: 'email_changed_notice', to: row.old_email });
        await pool.query(`
          UPDATE auth_email_changes
          SET old_notice_attempts=old_notice_attempts+1,old_notice_sent_at=now(),updated_at=now()
          WHERE user_id=$1
        `, [String(info.userId)]);
        oldEmailNotified = true;
      } catch {
        await pool.query(`
          UPDATE auth_email_changes
          SET old_notice_attempts=old_notice_attempts+1,updated_at=now()
          WHERE user_id=$1
        `, [String(info.userId)]).catch(() => {});
      }
    }

    return {
      ok: true,
      email: normalizeEmail(row.new_email),
      sessions_revoked: true,
      old_email_notified: oldEmailNotified,
    };
  }

  async function reconcileConfirmedUser(userId) {
    const result = await pool.query(`
      SELECT c.user_id,c.new_email,u.username,u.username_source
      FROM auth_email_changes c JOIN users u ON u.id=c.user_id
      WHERE c.user_id=$1 AND c.state='CONFIRMED' AND lower(u.email)=lower(c.new_email)
    `, [String(userId)]);
    const row = result.rows[0];
    if (!row) return false;
    await commitLocalEmail(String(row.user_id), normalizeEmail(row.new_email), row);
    markLifecycleEmailVerified(runtime, row.user_id, row.new_email, now);
    return true;
  }

  async function reconcileConfirmed() {
    const result = await pool.query(`
      SELECT c.user_id FROM auth_email_changes c JOIN users u ON u.id=c.user_id
      WHERE c.state='CONFIRMED' AND lower(u.email)=lower(c.new_email)
      ORDER BY c.confirmed_at ASC
    `);
    for (const row of result.rows) await reconcileConfirmedUser(row.user_id);
    return result.rows.length;
  }

  async function deliverPendingOldNotices(limit = 20) {
    if (typeof emailNotifier !== 'function') return 0;
    const result = await pool.query(`
      SELECT user_id,old_email
      FROM auth_email_changes
      WHERE state='CONFIRMED' AND old_email IS NOT NULL AND old_notice_sent_at IS NULL AND old_notice_attempts < 10
      ORDER BY confirmed_at ASC
      LIMIT $1
    `, [Math.max(1, Math.min(100, Number(limit) || 20))]);
    let delivered = 0;
    for (const row of result.rows) {
      try {
        await emailNotifier({ kind: 'email_changed_notice', to: row.old_email });
        await pool.query(`
          UPDATE auth_email_changes
          SET old_notice_attempts=old_notice_attempts+1,old_notice_sent_at=now(),updated_at=now()
          WHERE user_id=$1 AND old_notice_sent_at IS NULL
        `, [String(row.user_id)]);
        delivered += 1;
      } catch {
        await pool.query(`
          UPDATE auth_email_changes
          SET old_notice_attempts=old_notice_attempts+1,updated_at=now()
          WHERE user_id=$1 AND old_notice_sent_at IS NULL
        `, [String(row.user_id)]).catch(() => {});
      }
    }
    return delivered;
  }

  return {
    start,
    resend,
    confirm,
    inspectToken,
    reconcileConfirmed,
    reconcileConfirmedUser,
    deliverPendingOldNotices,
    constants: { ttlMs, maxAttempts: MAX_ATTEMPTS, resendCooldownMs: RESEND_COOLDOWN_MS, maxDeliveries: MAX_DELIVERIES },
  };
}

function installStagedEmailChange(express, service) {
  const application = express?.application;
  if (!application || !service || application.__beatgalerStagedEmailChangeInstalled) return;
  application.__beatgalerStagedEmailChangeInstalled = true;
  const previousPost = application.post;

  function fail(res, error) {
    const code = String(error?.code || 'EMAIL_CHANGE_UNAVAILABLE');
    const status = code === 'SESSION_REQUIRED' || code.startsWith('REAUTH_') ? 401
      : code === 'EMAIL_CHANGE_CONFLICT' ? 409
      : code === 'EMAIL_CHANGE_DELIVERY_UNAVAILABLE' || code === 'EMAIL_CHANGE_DELIVERY_FAILED' || code === 'EMAIL_VERIFICATION_AUTHORITY_UNAVAILABLE' ? 503
      : 400;
    return res.status(status).json({ error: error?.message || 'Email change is temporarily unavailable.', code });
  }

  application.post = function stagedEmailChangePost(routePath, ...handlers) {
    const pathName = String(routePath || '');
    if (pathName === '/auth/email/change/start') {
      return previousPost.call(this, routePath, (req, res) => {
        void service.start(req, req?.body?.email).then(result => res.status(202).json(result)).catch(error => fail(res, error));
      });
    }
    if (pathName === '/auth/email/change/resend') {
      return previousPost.call(this, routePath, (req, res) => {
        void service.resend(req).then(result => res.status(202).json(result)).catch(error => fail(res, error));
      });
    }
    if (pathName === '/auth/email/change/confirm') {
      return previousPost.call(this, routePath, (req, res) => {
        void service.confirm(req, req?.body?.token || req?.body?.code).then(result => res.json(result)).catch(error => fail(res, error));
      });
    }
    return previousPost.call(this, routePath, ...handlers);
  };
}

function createStagedEmailChangeNoticeWorker(service, { intervalMs = 30_000, onError = () => {} } = {}) {
  let timer = null;
  async function tick() {
    try { await service.reconcileConfirmed(); }
    catch (error) { onError(error); }
    try { await service.deliverPendingOldNotices(); }
    catch (error) { onError(error); }
  }
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, Math.max(5_000, Number(intervalMs) || 30_000));
      timer.unref?.();
      void tick();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_ATTEMPTS,
  coded,
  normalizeEmail,
  validEmail,
  sha256,
  sameHash,
  reauthToken,
  markLifecycleEmailVerified,
  createStagedEmailChange,
  installStagedEmailChange,
  createStagedEmailChangeNoticeWorker,
};
