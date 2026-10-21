'use strict';

const crypto = require('node:crypto');
const { hashPassword } = require('./password-kdf');

function coded(message, code, extras = {}) {
  return Object.assign(new Error(message), { code, ...extras });
}

function safeErrorCode(error) {
  const raw = String(error?.code || 'SIGNUP_ACTIVATION_FAILED').toUpperCase();
  return /^[A-Z0-9_:-]{1,120}$/.test(raw) ? raw : 'SIGNUP_ACTIVATION_FAILED';
}

function createPendingSignupActivation({
  pool,
  service,
  accountLifecycle,
  legacyInvoker,
  installationClaimCoordinator = null,
  onActivated = null,
  env = process.env,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('Pending signup activation requires PostgreSQL.');
  if (!service || typeof service.claimActivation !== 'function') throw new Error('Pending signup activation requires pending signup service.');
  if (!accountLifecycle?._test?.stateSnapshot || !accountLifecycle?._test?.scrubAccountsFile) {
    throw new Error('Pending signup activation requires account lifecycle authority.');
  }
  if (!legacyInvoker || typeof legacyInvoker.invokeLegacyRegister !== 'function' || typeof legacyInvoker.invokeLegacyLogin !== 'function') {
    throw new Error('Pending signup activation requires captured legacy auth handlers.');
  }

  const staleActivationMs = Math.max(60_000, Number(env.BEATGALER_SIGNUP_ACTIVATION_STALE_MS || 5 * 60_000));

  function userByEmail(email) {
    return accountLifecycle._test.userByEmail?.(email) || null;
  }

  function cloudAccount(installationId) {
    if (!installationId) return null;
    const snapshot = accountLifecycle._test.cloudSnapshot?.() || {};
    return snapshot?.linkedAccounts?.[String(installationId)] || null;
  }

  function setPasswordAuthority(userId, passwordHash, passwordSalt) {
    const state = accountLifecycle._test.stateSnapshot();
    state.password_overrides = state.password_overrides && typeof state.password_overrides === 'object'
      ? state.password_overrides : {};
    state.password_overrides[String(userId)] = {
      passwordHash: String(passwordHash || ''),
      passwordSalt: String(passwordSalt || ''),
      updated_at: new Date().toISOString(),
    };
  }

  function persistRealPassword(userId, row) {
    if (!userId || !row?.password_hash || !row?.password_salt) {
      throw coded('Pending signup password authority is incomplete.', 'SIGNUP_PASSWORD_AUTHORITY_INVALID');
    }
    setPasswordAuthority(userId, row.password_hash, row.password_salt);
    accountLifecycle._test.scrubAccountsFile();
  }

  async function markStep(signupId, step, state, { errorCode = null, externalRef = null } = {}) {
    await pool.query(`
      INSERT INTO auth_provisioning_ledger(
        signup_id,step,state,idempotency_key,external_ref,attempt_count,last_error_code,started_at,completed_at,updated_at
      ) VALUES(
        $1,$2,$3,$4,$5::jsonb,
        CASE WHEN $3='RUNNING' THEN 1 ELSE 0 END,
        $6,
        CASE WHEN $3='RUNNING' THEN now() ELSE NULL END,
        CASE WHEN $3='DONE' THEN now() ELSE NULL END,
        now()
      )
      ON CONFLICT(signup_id,step) DO UPDATE SET
        state=EXCLUDED.state,
        external_ref=CASE WHEN EXCLUDED.external_ref='{}'::jsonb THEN auth_provisioning_ledger.external_ref ELSE EXCLUDED.external_ref END,
        attempt_count=auth_provisioning_ledger.attempt_count + CASE WHEN EXCLUDED.state='RUNNING' THEN 1 ELSE 0 END,
        last_error_code=EXCLUDED.last_error_code,
        started_at=CASE WHEN EXCLUDED.state='RUNNING' THEN now() ELSE auth_provisioning_ledger.started_at END,
        completed_at=CASE WHEN EXCLUDED.state='DONE' THEN now() ELSE auth_provisioning_ledger.completed_at END,
        updated_at=now()
    `, [
      String(signupId),
      String(step),
      String(state),
      `signup:${signupId}:${step}`,
      JSON.stringify(externalRef && typeof externalRef === 'object' ? externalRef : {}),
      errorCode ? String(errorCode).slice(0, 120) : null,
    ]);
  }

  async function recoverStale(signupId) {
    await pool.query(`
      UPDATE pending_signups
      SET status='RETRYABLE', updated_at=now()
      WHERE id=$1
        AND status IN ('ACTIVATING','PROVISIONING')
        AND updated_at <= now() - ($2::bigint * interval '1 millisecond')
    `, [String(signupId || ''), staleActivationMs]);
  }

  async function acquireInstallation(row, expectedUserId = null) {
    const installationId = String(row?.installation_id || '').trim();
    if (!installationId) throw coded('BeatGaler installation id is required.', 'INSTALLATION_REQUIRED');

    let release = null;
    if (installationClaimCoordinator) {
      release = await installationClaimCoordinator.tryAcquire(installationId);
      if (!release) throw coded('This installation is already being claimed.', 'INSTALLATION_CLAIM_BUSY');
    }

    const current = cloudAccount(installationId);
    if (current && (!expectedUserId || String(current.beatgalerAccountId || '') !== String(expectedUserId))) {
      if (release) await release().catch(() => {});
      throw coded('This installation belongs to another BeatGaler account.', 'INSTALLATION_CONFLICT');
    }
    return { installationId, release };
  }

  async function invokeExistingLogin(row, user) {
    const realHash = String(row.password_hash || '');
    const realSalt = String(row.password_salt || '');
    persistRealPassword(user.id, row);

    const sentinel = `internal-${randomBytes(24).toString('base64url')}`;
    const sentinelSalt = randomBytes(16).toString('hex');
    const sentinelHash = await hashPassword(sentinel, sentinelSalt);
    setPasswordAuthority(user.id, sentinelHash, sentinelSalt);
    try {
      return await legacyInvoker.invokeLegacyLogin({
        identifier: String(row.email_normalized),
        email: String(row.email_normalized),
        password: sentinel,
        beatgalerUserId: String(row.installation_id || ''),
      });
    } finally {
      setPasswordAuthority(user.id, realHash, realSalt);
      accountLifecycle._test.scrubAccountsFile();
    }
  }

  async function invokeNewRegistration(row) {
    const placeholder = `internal-${randomBytes(32).toString('base64url')}`;
    const response = await legacyInvoker.invokeLegacyRegister({
      usernameBase: String(row.username_base || ''),
      username: String(row.username_base || ''),
      email: String(row.email_normalized || ''),
      password: placeholder,
      beatgalerUserId: String(row.installation_id || ''),
    });
    const user = userByEmail(row.email_normalized);
    if (user) persistRealPassword(user.id, row);
    return { response, user };
  }

  function successful(response) {
    const code = Number(response?.statusCode || 0);
    return code >= 200 && code < 300 && response?.body?.user?.id;
  }

  async function activate({ signupId, continuationSecret } = {}) {
    await recoverStale(signupId);

    let claim;
    try {
      claim = await service.claimActivation({ signupId, continuationSecret });
    } catch (error) {
      if (String(error?.code || '') === 'SIGNUP_NOT_VERIFIED') {
        const current = await service.status({ signupId, continuationSecret });
        if (current && ['ACTIVATING','PROVISIONING'].includes(String(current.status))) return current;
      }
      throw error;
    }

    const row = claim?.row || null;
    if (!row) throw coded('Pending signup not found.', 'SIGNUP_NOT_FOUND');
    if (!claim.claimed) {
      return {
        status: String(row.status || 'ACTIVE'),
        active: String(row.status) === 'ACTIVE',
        user_id: row.activated_user_id || null,
      };
    }

    let releaseInstallation = null;
    let user = userByEmail(row.email_normalized);
    try {
      persistRealPassword(user?.id, row);
    } catch (error) {
      if (user) throw error;
    }

    try {
      const lock = await acquireInstallation(row, user?.id || null);
      releaseInstallation = lock.release;
      await markStep(row.id, 'activation', 'RUNNING');

      let response = null;
      if (!user) {
        const created = await invokeNewRegistration(row);
        response = created.response;
        user = created.user;
        if (!user) {
          throw coded('Account activation did not create an account.', 'SIGNUP_ACCOUNT_CREATE_FAILED');
        }
        await markStep(row.id, 'account', 'DONE', { externalRef: { user_id: user.id } });
      }

      // Registration may have created the account but failed while provisioning
      // storage. Re-enter through the legacy login primitive with an internal,
      // one-time password authority so ensureUserStorage remains the single
      // provisioning implementation.
      if (!successful(response)) {
        response = await invokeExistingLogin(row, user);
      }

      if (!successful(response)) {
        const code = Number(response?.statusCode || 503);
        const responseCode = String(response?.body?.code || 'SIGNUP_PROVISIONING_FAILED');
        throw coded(`Account provisioning failed (${code}).`, responseCode);
      }

      persistRealPassword(user.id, row);
      await service.setActivationState(row.id, 'PROVISIONING');
      await markStep(row.id, 'storage', 'DONE', {
        externalRef: {
          user_id: user.id,
          storage_ready: true,
          installation_id: String(row.installation_id || ''),
        },
      });

      if (typeof onActivated === 'function') await onActivated(String(user.id));
      await markStep(row.id, 'entitlement', 'DONE', { externalRef: { user_id: user.id } });
      await service.setActivationState(row.id, 'ACTIVE', { userId: user.id });
      await markStep(row.id, 'activation', 'DONE', { externalRef: { user_id: user.id } });

      return {
        status: 'ACTIVE',
        active: true,
        signup_pending: false,
        user_id: String(user.id),
        ...(response?.body && typeof response.body === 'object' ? response.body : {}),
      };
    } catch (error) {
      const code = safeErrorCode(error);
      if (user?.id) {
        try { persistRealPassword(user.id, row); } catch {}
      }
      await markStep(row.id, 'activation', 'RETRYABLE', { errorCode: code }).catch(() => {});
      await service.setActivationState(row.id, 'RETRYABLE', { errorCode: code }).catch(() => {});
      throw coded('Account activation could not be completed yet. Retry safely.', code, { cause: error });
    } finally {
      if (releaseInstallation) await releaseInstallation().catch(() => {});
    }
  }

  return {
    activate,
    recoverStale,
    markStep,
    _test: {
      userByEmail,
      cloudAccount,
      setPasswordAuthority,
      persistRealPassword,
      invokeExistingLogin,
      invokeNewRegistration,
    },
  };
}

module.exports = {
  coded,
  safeErrorCode,
  createPendingSignupActivation,
};
