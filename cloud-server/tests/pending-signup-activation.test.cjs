'use strict';

const assert = require('node:assert/strict');
const { createPendingSignupActivation } = require('../pending-signup-activation');
const { invokeCapturedHandler } = require('../pending-signup-boundary');

function fakePool() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push([String(sql), params]);
      return { rows: [] };
    },
  };
}

function lifecycleHarness({ initialUser = null, linkedAccount = null } = {}) {
  let user = initialUser;
  const state = { password_overrides: {} };
  let scrubs = 0;
  const runtime = {
    _test: {
      stateSnapshot: () => state,
      scrubAccountsFile: () => { scrubs += 1; },
      userByEmail: email => user && String(user.email).toLowerCase() === String(email).toLowerCase() ? user : null,
      cloudSnapshot: () => ({ linkedAccounts: linkedAccount ? { install_1: linkedAccount } : {} }),
    },
  };
  return {
    runtime,
    state,
    get scrubs() { return scrubs; },
    setUser(next) { user = next; },
    getUser() { return user; },
  };
}

function serviceHarness(row) {
  const states = [];
  return {
    states,
    async claimActivation() { return { claimed: true, row: { ...row } }; },
    async status() { return { signup_id: row.id, status: 'ACTIVATING' }; },
    async setActivationState(signupId, status, extras = {}) {
      states.push([signupId, status, extras]);
      return { signup_id: signupId, status };
    },
  };
}

(async () => {
  {
    const row = {
      id: 'psu_new',
      email_normalized: 'new@example.com',
      username_base: 'new.user',
      password_hash: 'a'.repeat(128),
      password_salt: 'b'.repeat(32),
      installation_id: 'install_1',
    };
    const pool = fakePool();
    const lifecycle = lifecycleHarness();
    const service = serviceHarness(row);
    let released = 0;
    let activated = 0;
    const invoker = {
      async invokeLegacyRegister(body) {
        assert.equal(body.email, row.email_normalized);
        assert.equal(body.beatgalerUserId, row.installation_id);
        lifecycle.setUser({ id: 'usr_new', email: row.email_normalized });
        return { statusCode: 201, body: { token: 'session-new', user: { id: 'usr_new', email: row.email_normalized } } };
      },
      async invokeLegacyLogin() { throw new Error('new successful registration must not need login retry'); },
    };
    const activation = createPendingSignupActivation({
      pool,
      service,
      accountLifecycle: lifecycle.runtime,
      legacyInvoker: invoker,
      installationClaimCoordinator: { async tryAcquire() { return async () => { released += 1; }; } },
      onActivated: async userId => { assert.equal(userId, 'usr_new'); activated += 1; },
    });

    const result = await activation.activate({ signupId: row.id, continuationSecret: 'sc_1' });
    assert.equal(result.status, 'ACTIVE');
    assert.equal(result.token, 'session-new');
    assert.equal(result.user.id, 'usr_new');
    assert.equal(lifecycle.state.password_overrides.usr_new.passwordHash, row.password_hash);
    assert.equal(lifecycle.state.password_overrides.usr_new.passwordSalt, row.password_salt);
    assert.ok(lifecycle.scrubs >= 1);
    assert.equal(activated, 1);
    assert.equal(released, 1);
    assert.equal(service.states.some(([, state]) => state === 'PROVISIONING'), true);
    assert.equal(service.states.some(([, state]) => state === 'ACTIVE'), true);
    assert.equal(pool.queries.some(([sql]) => sql.includes('auth_provisioning_ledger')), true);
  }

  {
    const row = {
      id: 'psu_retry',
      email_normalized: 'retry@example.com',
      username_base: 'retry.user',
      password_hash: 'c'.repeat(128),
      password_salt: 'd'.repeat(32),
      installation_id: 'install_1',
    };
    const user = { id: 'usr_retry', email: row.email_normalized };
    const lifecycle = lifecycleHarness({
      initialUser: user,
      linkedAccount: { beatgalerAccountId: user.id },
    });
    const service = serviceHarness(row);
    const pool = fakePool();
    let sawTemporaryAuthority = false;
    const invoker = {
      async invokeLegacyRegister() { throw new Error('existing activation retry must not register again'); },
      async invokeLegacyLogin(body) {
        assert.equal(body.identifier, row.email_normalized);
        const authority = lifecycle.state.password_overrides[user.id];
        sawTemporaryAuthority = authority.passwordHash !== row.password_hash || authority.passwordSalt !== row.password_salt;
        return { statusCode: 200, body: { token: 'session-retry', user: { id: user.id } } };
      },
    };
    const activation = createPendingSignupActivation({
      pool,
      service,
      accountLifecycle: lifecycle.runtime,
      legacyInvoker: invoker,
      installationClaimCoordinator: { async tryAcquire() { return async () => {}; } },
    });

    const result = await activation.activate({ signupId: row.id, continuationSecret: 'sc_2' });
    assert.equal(result.status, 'ACTIVE');
    assert.equal(result.token, 'session-retry');
    assert.equal(sawTemporaryAuthority, true);
    assert.equal(lifecycle.state.password_overrides[user.id].passwordHash, row.password_hash);
    assert.equal(lifecycle.state.password_overrides[user.id].passwordSalt, row.password_salt);
  }

  {
    const row = {
      id: 'psu_fail',
      email_normalized: 'fail@example.com',
      username_base: 'fail.user',
      password_hash: 'e'.repeat(128),
      password_salt: 'f'.repeat(32),
      installation_id: 'install_1',
    };
    const user = { id: 'usr_fail', email: row.email_normalized };
    const lifecycle = lifecycleHarness({ initialUser: user });
    const service = serviceHarness(row);
    const activation = createPendingSignupActivation({
      pool: fakePool(),
      service,
      accountLifecycle: lifecycle.runtime,
      legacyInvoker: {
        async invokeLegacyRegister() { throw new Error('not expected'); },
        async invokeLegacyLogin() { return { statusCode: 503, body: { code: 'STORAGE_TEMPORARILY_UNAVAILABLE' } }; },
      },
      installationClaimCoordinator: { async tryAcquire() { return async () => {}; } },
    });
    await assert.rejects(
      activation.activate({ signupId: row.id, continuationSecret: 'sc_3' }),
      error => error?.code === 'STORAGE_TEMPORARILY_UNAVAILABLE',
    );
    assert.equal(service.states.some(([, state]) => state === 'RETRYABLE'), true);
    assert.equal(lifecycle.state.password_overrides[user.id].passwordHash, row.password_hash);
  }

  {
    const response = await invokeCapturedHandler(async (req, res) => {
      assert.equal(req.body.email, 'capture@example.com');
      return res.status(201).json({ ok: true });
    }, { email: 'capture@example.com' });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.body, { ok: true });
  }

  console.log('pending-signup-activation tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
