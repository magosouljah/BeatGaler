'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  stableUserId,
  normalizeUsernameBase,
  usernameSeed,
  withCasefoldUsernameClaim,
  runLedgerStep,
  createSignupActivationCoordinator,
} = require('../signup-activation-coordinator');
const {
  storageAccountMarker,
  storageGroupTitle,
  storageGroupMatchesAccount,
} = require('../master-storage');
const {
  bridgeSuffix,
} = require('../server-core-auth-bridge-loader');
const { emailHash } = require('../email-verification-authority');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

async function main() {
  assert.equal(stableUserId('psu_abc'), stableUserId('psu_abc'));
  assert.notEqual(stableUserId('psu_abc'), stableUserId('psu_xyz'));
  assert.equal(normalizeUsernameBase(' Pe.Pi_to '), 'pe.pi_to');
  assert.throws(() => normalizeUsernameBase('ab'), error => error?.code === 'USERNAME_BASE_INVALID');
  assert.equal(Number.isInteger(usernameSeed('usr_test')), true);
  assert.equal(usernameSeed('usr_test') >= 0 && usernameSeed('usr_test') < 10000, true);

  {
    const marker = storageAccountMarker('usr_abc-123');
    assert.equal(marker, '[BG:usr_abc-123]');
    const title = storageGroupTitle('pepito#1234', 'usr_abc-123');
    assert.equal(title.endsWith(marker), true);
    assert.equal(title.length <= 120, true);
    assert.equal(storageGroupMatchesAccount({ title }, 'usr_abc-123'), true);
    assert.equal(storageGroupMatchesAccount({ title }, 'usr_other'), false);
  }

  {
    const suffix = bridgeSuffix();
    assert.equal(suffix.includes('__beatgalerAuthBridge'), true);
    assert.equal(suffix.includes('app.post('), false, 'activation bridge must not create a hidden HTTP route');
    assert.equal(suffix.includes('invokeLegacy'), false, 'activation bridge must not call legacy auth handlers');
  }

  await withCloud(async (_app, send) => {
    // Cloud carga el server-core REAL a través del cargador: si cambia un
    // marcador o el parche es ambiguo, el arranque falla antes de llegar aquí.
    const bridge = require('../server-core').__beatgalerAuthBridge;
    for (const name of ['userIdByUsername', 'adoptIdentityUser', 'setUsernameByUserId', 'adoptOrCreatePasswordUser', 'disconnectProviderByUserId']) {
      assert.equal(typeof bridge?.[name], 'function', `bridge.${name}`);
    }
    assert.equal(bridge.userIdByUsername(account.username), account.id);

    const adopted = bridge.adoptIdentityUser({ id: 'usr_adopted', username: 'adopted_one', email: 'adopted@example.test' });
    assert.deepEqual(adopted, { userId: 'usr_adopted', username: 'adopted_one', storageReady: false });
    assert.equal(bridge.userIdByUsername('adopted_one'), 'usr_adopted');
    assert.throws(() => bridge.adoptIdentityUser({ id: 'usr_other', username: 'adopted_one' }),
      error => error?.code === 'AUTH_BRIDGE_USERNAME_CONFLICT');
    assert.deepEqual(bridge.setUsernameByUserId('usr_adopted', 'renamed_one'), { found: true, userId: 'usr_adopted', username: 'renamed_one' });
    bridge.disconnectProviderByUserId('usr_adopted', 'x');
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.BEATGALER_STATE_DIR, 'accounts-data.json'), 'utf8')).users;
    assert.deepEqual(saved.map(user => user.id).sort(), ['usr_adopted', account.id]);
    assert.equal(saved.find(user => user.id === 'usr_adopted').username, 'renamed_one');

    const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1', host: '127.0.0.1' };
    const login = identifier => send('POST', '/auth/login', {
      headers: browser,
      body: { identifier, password: account.password, beatgalerUserId: account.beatgalerUserId },
    });
    assert.equal((await login(account.email)).status, 200, 'login resolves the account by email');
    assert.equal((await login(account.username)).status, 401, 'login must not resolve accounts by username');
  });

  {
    const heldLocks = new Set();
    const lockKey = 'username-base:pepito';
    const userId = 'usr_casefold';
    const seed = usernameSeed(userId);
    const usernameAt = offset => `pepito#${String((seed + offset) % 10_000).padStart(4, '0')}`;
    const users = new Set([usernameAt(0).toUpperCase(), usernameAt(1)]);
    const client = {
      async query(sql, [value]) {
        if (sql === 'SELECT pg_advisory_lock(hashtextextended($1, 0))') {
          assert.equal(heldLocks.has(value), false);
          heldLocks.add(value);
          return { rows: [] };
        }
        if (sql === 'SELECT pg_advisory_unlock(hashtextextended($1, 0))') {
          assert.equal(heldLocks.delete(value), true);
          return { rows: [] };
        }
        if (sql === 'SELECT id FROM users WHERE lower(username)=lower($1) LIMIT 1') {
          assert.ok(heldLocks.has(lockKey), 'availability check requires the normalized username lock');
          const occupied = [...users].some(username => username.toLowerCase() === value.toLowerCase());
          return { rows: occupied ? [{ id: 'busy' }] : [] };
        }
        throw new Error(`unexpected username claim query: ${sql}`);
      },
    };
    const candidate = await withCasefoldUsernameClaim(client, ' PePiTo ', userId, async username => {
      await Promise.resolve();
      assert.ok(heldLocks.has(lockKey), 'the lock must survive until async claim work completes');
      users.add(username);
      return username;
    });
    assert.equal(candidate, usernameAt(2));
    assert.equal(heldLocks.size, 0);

    const failure = new Error('synthetic claim failure');
    await assert.rejects(withCasefoldUsernameClaim(client, 'pepito', userId, async username => {
      assert.equal(username, usernameAt(3));
      assert.ok(heldLocks.has(lockKey));
      throw failure;
    }), error => error === failure);
    assert.equal(heldLocks.size, 0, 'a rejected claim releases the username lock');
  }

  {
    let workCalls = 0;
    const client = {
      async query(sql) {
        if (String(sql).startsWith('SELECT state,external_ref')) return { rows: [{ state: 'DONE', external_ref: { user_id: 'usr_done' } }] };
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const result = await runLedgerStep(client, 'psu_done', 'user', async () => { workCalls += 1; });
    assert.deepEqual(result, { user_id: 'usr_done' });
    assert.equal(workCalls, 0, 'DONE ledger step must never repeat external work');
  }

  {
    const pending = {
      id: 'psu_fault',
      status: 'VERIFIED',
      activated_user_id: null,
      email_normalized: 'fault@example.com',
      username_base: 'faultuser',
      password_hash: 'h'.repeat(64),
      password_salt: 's'.repeat(32),
      installation_id: null,
      verified_at: new Date('2026-10-21T00:00:00.000Z'),
      created_at: new Date('2026-10-21T00:00:00.000Z'),
      updated_at: new Date('2026-10-21T00:00:00.000Z'),
    };
    const userId = stableUserId(pending.id);
    const ledger = new Map();
    let durableUser = null;
    let localUser = null;
    let vaultCreates = 0;
    let userCreates = 0;
    let verification = null;
    const serviceStates = [];

    const client = {
      released: false,
      async query(sql, params = []) {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        if (text.includes('pg_advisory_lock') || text.includes('pg_advisory_unlock')) return { rows: [] };
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
        if (text.startsWith('SELECT * FROM pending_signups')) return { rows: [{ ...pending }] };
        if (text.startsWith('SELECT state,external_ref FROM auth_provisioning_ledger')) {
          const key = `${params[0]}:${params[1]}`;
          return { rows: ledger.has(key) ? [ledger.get(key)] : [] };
        }
        if (text.startsWith('INSERT INTO auth_provisioning_ledger')) {
          ledger.set(`${params[0]}:${params[1]}`, { state: 'RUNNING', external_ref: {} });
          return { rows: [] };
        }
        if (text.startsWith('UPDATE auth_provisioning_ledger')) {
          const key = `${params[0]}:${params[1]}`;
          if (text.includes("state='DONE'")) ledger.set(key, { state: 'DONE', external_ref: JSON.parse(params[2]) });
          else ledger.set(key, { state: 'RETRYABLE', external_ref: {}, last_error_code: params[2] });
          return { rows: [] };
        }
        if (text.startsWith('SELECT u.id,u.username')) return { rows: durableUser ? [{ ...durableUser }] : [] };
        if (text.startsWith('SELECT id FROM users WHERE lower(email)')) return { rows: [] };
        if (text.startsWith('SELECT id FROM users WHERE lower(username)')) return { rows: [] };
        if (text === 'SELECT email FROM users WHERE id=$1 FOR UPDATE') {
          return { rows: durableUser && params[0] === durableUser.id ? [{ email: durableUser.email }] : [] };
        }
        if (text.startsWith('INSERT INTO user_email_verifications(')) {
          verification = { userId: String(params[0]), emailHash: String(params[1]), verifiedAt: new Date(params[2]).toISOString() };
          return { rows: [{ user_id: params[0] }], rowCount: 1 };
        }
        throw new Error(`unexpected activation query: ${text}`);
      },
      release() { this.released = true; },
    };
    const pool = {
      async connect() { return client; },
      async query(sql) {
        throw new Error(`unexpected pool query after ACTIVE guard: ${sql}`);
      },
    };
    const service = {
      async status() { return { signup_id: pending.id, status: 'VERIFIED', verified: true }; },
      async claimActivation() { return { claimed: true, row: { ...pending } }; },
      async setActivationState(_id, status, options = {}) {
        serviceStates.push([status, options]);
        pending.status = status;
        if (status === 'ACTIVE') pending.activated_user_id = options.userId;
        return { status };
      },
      async recoverStaleActivations() { return 0; },
    };
    const bridge = {
      adoptOrCreatePasswordUser(input) {
        userCreates += 1;
        localUser = {
          id: input.id,
          username: input.username,
          username_source: 'beatgaler',
          email: input.email,
          password_hash: input.passwordHash,
          password_salt: input.passwordSalt,
          created_at: new Date(input.createdAt),
          telegram_chat_id: null,
          vault_title: null,
          vault_created_at: null,
        };
        return { created: true, userId: input.id, username: input.username };
      },
      adoptAuthoritativeUser(input) {
        localUser = {
          id: input.id,
          username: input.username,
          username_source: input.usernameSource,
          email: input.email,
          password_hash: input.passwordHash,
          password_salt: input.passwordSalt,
          created_at: new Date(input.createdAt),
          telegram_chat_id: input.storageChatId,
          vault_title: input.storageChatTitle,
          vault_created_at: input.storageCreatedAt ? new Date(input.storageCreatedAt) : null,
        };
        return { userId: input.id, username: input.username, storageReady: Boolean(input.storageChatId) };
      },
      async ensureStorage() {
        vaultCreates += 1;
        localUser.telegram_chat_id = '-1001234567890';
        localUser.vault_title = 'faultuser [BG:test]';
        localUser.vault_created_at = new Date();
      },
      bindInstallation() { throw new Error('no installation expected'); },
      createSession() { throw Object.assign(new Error('session delivery fault'), { code: 'FAULT_AFTER_ACTIVE' }); },
      async publicPayload() { throw new Error('must not reach public payload after session fault'); },
    };
    async function flushAuthority() {
      if (!localUser) return;
      durableUser = { ...localUser };
    }
    const coordinator = createSignupActivationCoordinator({
      pool,
      service,
      getBridge: () => bridge,
      flushAuthority,
      now: () => Date.parse('2026-10-21T00:10:00.000Z'),
    });

    await assert.rejects(
      coordinator.activate({ signupId: pending.id, continuationSecret: 'sc_fault' }),
      error => error?.code === 'FAULT_AFTER_ACTIVE',
    );
    assert.equal(userCreates, 1);
    assert.equal(vaultCreates, 1);
    assert.equal(serviceStates.some(([status]) => status === 'ACTIVE'), true);
    assert.equal(serviceStates.some(([status]) => status === 'RETRYABLE'), false, 'post-ACTIVE session failure must not downgrade activation');
    assert.equal(pending.activated_user_id, userId);
    assert.equal(verification.userId, userId);
    assert.equal(verification.emailHash, emailHash('fault@example.com'));
    assert.equal(client.released, true);
  }

  console.log('signup-activation-safety tests: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
