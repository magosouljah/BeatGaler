'use strict';

const crypto = require('node:crypto');
const { markLifecycleEmailVerified } = require('./account-lifecycle-verified-email-activation');

function coded(message, code, extras = {}) {
  return Object.assign(new Error(message), { code, ...extras });
}

function stableUserId(signupId) {
  const value = String(signupId || '').trim();
  if (!value) throw coded('Signup id is required.', 'SIGNUP_ID_REQUIRED');
  return `usr_${crypto.createHash('sha256').update(`signup\0${value}`).digest('hex').slice(0, 24)}`;
}

function errorCode(error) {
  return String(error?.code || 'SIGNUP_ACTIVATION_FAILED').slice(0, 120);
}

function permanentActivationError(error) {
  return new Set([
    'AUTH_BRIDGE_EMAIL_CONFLICT',
    'AUTH_BRIDGE_USER_ID_CONFLICT',
    'EMAIL_CONFLICT_DURING_ACTIVATION',
  ]).has(String(error?.code || ''));
}

function authoritativeBridgeInput(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: row.username || null,
    usernameSource: row.username_source || 'beatgaler',
    email: row.email || null,
    passwordHash: row.password_hash || null,
    passwordSalt: row.password_salt || null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    storageChatId: row.telegram_chat_id || null,
    storageChatTitle: row.vault_title || null,
    storageCreatedAt: row.vault_created_at ? new Date(row.vault_created_at).getTime() : null,
  };
}

async function loadAuthoritativeUser(client, userId) {
  const result = await client.query(`
    SELECT u.id,u.username,u.username_source,u.email,u.password_hash,u.password_salt,u.created_at,
           v.telegram_chat_id,v.title AS vault_title,v.created_at AS vault_created_at
    FROM users u
    LEFT JOIN vaults v ON v.user_id=u.id
    WHERE u.id=$1
    LIMIT 1
  `, [String(userId)]);
  return result.rows[0] || null;
}

async function loadEmailOwner(client, email) {
  const result = await client.query('SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1', [String(email || '')]);
  return result.rows[0] || null;
}

async function runLedgerStep(client, signupId, step, work) {
  const key = `signup:${signupId}:${step}`;
  const current = await client.query('SELECT state,external_ref FROM auth_provisioning_ledger WHERE signup_id=$1 AND step=$2', [signupId, step]);
  if (String(current.rows[0]?.state || '') === 'DONE') return current.rows[0].external_ref || {};

  await client.query(`
    INSERT INTO auth_provisioning_ledger(signup_id,step,state,idempotency_key,attempt_count,started_at,updated_at)
    VALUES($1,$2,'RUNNING',$3,1,now(),now())
    ON CONFLICT(signup_id,step) DO UPDATE SET
      state='RUNNING',attempt_count=auth_provisioning_ledger.attempt_count+1,
      started_at=COALESCE(auth_provisioning_ledger.started_at,now()),last_error_code=NULL,updated_at=now()
  `, [signupId, step, key]);

  try {
    const ref = await work();
    const safeRef = ref && typeof ref === 'object' && !Array.isArray(ref) ? ref : {};
    await client.query(`UPDATE auth_provisioning_ledger
      SET state='DONE',external_ref=$3::jsonb,last_error_code=NULL,completed_at=now(),updated_at=now()
      WHERE signup_id=$1 AND step=$2`, [signupId, step, JSON.stringify(safeRef)]);
    return safeRef;
  } catch (error) {
    await client.query(`UPDATE auth_provisioning_ledger
      SET state='RETRYABLE',last_error_code=$3,updated_at=now()
      WHERE signup_id=$1 AND step=$2`, [signupId, step, errorCode(error)]).catch(() => {});
    throw error;
  }
}

function createSignupActivationCoordinator({
  pool,
  service,
  getBridge,
  flushAuthority,
  accountLifecycle,
  issueWelcome,
  now = () => Date.now(),
  staleMs = 5 * 60_000,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('Signup activation requires PostgreSQL.');
  if (!service || typeof service.claimActivation !== 'function') throw new Error('Signup activation requires pending signup service.');
  if (typeof getBridge !== 'function') throw new Error('Signup activation requires a server-core bridge resolver.');
  if (typeof flushAuthority !== 'function') throw new Error('Signup activation requires control-plane flush authority.');
  if (typeof issueWelcome !== 'function') throw new Error('Signup activation requires welcome grant authority.');

  async function activate({ signupId, continuationSecret } = {}) {
    const id = String(signupId || '').trim();
    const continuation = String(continuationSecret || '').trim();
    const initial = await service.status({ signupId: id, continuationSecret: continuation });
    if (!initial) throw coded('Signup continuation is invalid.', 'SIGNUP_CONTINUATION_INVALID');

    const client = await pool.connect();
    const lockKey = `signup-activation:${id}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
      const stateResult = await client.query('SELECT * FROM pending_signups WHERE id=$1 LIMIT 1', [id]);
      let pending = stateResult.rows[0] || null;
      if (!pending) throw coded('Pending signup was not found.', 'SIGNUP_NOT_FOUND');

      if (String(pending.status) === 'ACTIVE') {
        const userId = String(pending.activated_user_id || stableUserId(id));
        const authoritative = await loadAuthoritativeUser(client, userId);
        const bridge = getBridge();
        if (authoritative && bridge) bridge.adoptAuthoritativeUser(authoritativeBridgeInput(authoritative));
        return {
          status: 'ACTIVE',
          user_id: userId,
          username: authoritative?.username || null,
          session_required: true,
        };
      }

      if (['ACTIVATING','PROVISIONING'].includes(String(pending.status))) {
        const updatedAt = pending.updated_at ? new Date(pending.updated_at).getTime() : 0;
        if (updatedAt && now() - updatedAt < Math.max(60_000, Number(staleMs))) {
          return { status: String(pending.status), signup_pending: true };
        }
        await client.query("UPDATE pending_signups SET status='RETRYABLE',updated_at=now() WHERE id=$1", [id]);
      }

      const claimed = await service.claimActivation({ signupId: id, continuationSecret: continuation });
      if (!claimed?.claimed && String(claimed?.row?.status || '') === 'ACTIVE') {
        return { status: 'ACTIVE', user_id: String(claimed.row.activated_user_id || stableUserId(id)), session_required: true };
      }
      pending = claimed.row;
      await service.setActivationState(id, 'PROVISIONING');

      const bridge = getBridge();
      if (!bridge) throw coded('Server-core activation bridge is unavailable.', 'AUTH_BRIDGE_UNAVAILABLE');
      const userId = String(pending.activated_user_id || stableUserId(id));

      const userRef = await runLedgerStep(client, id, 'user', async () => {
        let authoritative = await loadAuthoritativeUser(client, userId);
        if (!authoritative) {
          const emailOwner = await loadEmailOwner(client, pending.email_normalized);
          if (emailOwner && String(emailOwner.id) !== userId) {
            throw coded('Email was claimed by another account before activation completed.', 'EMAIL_CONFLICT_DURING_ACTIVATION');
          }
          bridge.adoptOrCreatePasswordUser({
            id: userId,
            usernameBase: pending.username_base,
            email: pending.email_normalized,
            passwordHash: pending.password_hash,
            passwordSalt: pending.password_salt,
            createdAt: pending.created_at ? new Date(pending.created_at).getTime() : now(),
          });
          await flushAuthority();
          authoritative = await loadAuthoritativeUser(client, userId);
          if (!authoritative) throw coded('Activated user was not durable after control-plane flush.', 'AUTH_USER_DURABILITY_FAILED');
        } else {
          bridge.adoptAuthoritativeUser(authoritativeBridgeInput(authoritative));
        }
        markLifecycleEmailVerified(accountLifecycle, userId, pending.email_normalized, {
          verifiedAt: pending.verified_at ? new Date(pending.verified_at).toISOString() : new Date(now()).toISOString(),
        });
        return { user_id: userId, username: authoritative.username };
      });

      const vaultRef = await runLedgerStep(client, id, 'vault', async () => {
        const authoritative = await loadAuthoritativeUser(client, userId);
        if (!authoritative) throw coded('Activation user disappeared before storage provisioning.', 'AUTH_USER_DURABILITY_FAILED');
        bridge.adoptAuthoritativeUser(authoritativeBridgeInput(authoritative));
        await bridge.ensureStorage(userId);
        await flushAuthority();
        const durable = await loadAuthoritativeUser(client, userId);
        if (!durable?.telegram_chat_id) throw coded('Vault was not durable after control-plane flush.', 'AUTH_VAULT_DURABILITY_FAILED');
        return { user_id: userId, telegram_chat_id: String(durable.telegram_chat_id) };
      });

      if (pending.installation_id) {
        await runLedgerStep(client, id, 'installation', async () => {
          const authoritative = await loadAuthoritativeUser(client, userId);
          bridge.adoptAuthoritativeUser(authoritativeBridgeInput(authoritative));
          bridge.bindInstallation(userId, String(pending.installation_id));
          await flushAuthority();
          return { user_id: userId, installation_id: String(pending.installation_id) };
        });
      }

      await runLedgerStep(client, id, 'welcome', async () => {
        const grant = await issueWelcome(userId);
        return { user_id: userId, grant_id: grant?.id || null };
      });

      await service.setActivationState(id, 'ACTIVE', { userId });

      // Session issuance is deliberately after the durable ACTIVE transition.
      const token = bridge.createSession(userId);
      await flushAuthority();
      const account = await bridge.publicPayload(userId, token);
      return {
        status: 'ACTIVE',
        signup_pending: false,
        user_id: userId,
        username: userRef.username || null,
        storage_ready: Boolean(vaultRef.telegram_chat_id),
        account,
      };
    } catch (error) {
      const code = errorCode(error);
      if (permanentActivationError(error)) {
        await pool.query("UPDATE pending_signups SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status<>'ACTIVE'", [id]).catch(() => {});
      } else {
        await service.setActivationState(id, 'RETRYABLE', { errorCode: code }).catch(() => {});
      }
      throw error;
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); } catch {}
      client.release();
    }
  }

  return {
    activate,
    recoverStale: options => service.recoverStaleActivations(options),
  };
}

module.exports = {
  stableUserId,
  errorCode,
  permanentActivationError,
  authoritativeBridgeInput,
  loadAuthoritativeUser,
  loadEmailOwner,
  runLedgerStep,
  createSignupActivationCoordinator,
};
