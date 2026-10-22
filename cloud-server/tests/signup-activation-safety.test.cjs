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
  REQUIRED_MARKERS,
  validateCoreSource,
  bridgeSuffix,
} = require('../server-core-auth-bridge-loader');
const { emailHash } = require('../email-verification-authority');

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
    const core = fs.readFileSync(path.join(__dirname, '..', 'server-core.js'), 'utf8');
    assert.equal(validateCoreSource(core), true);
    for (const marker of REQUIRED_MARKERS) assert.equal(core.includes(marker), true);
    const suffix = bridgeSuffix();
    assert.equal(suffix.includes('__beatgalerAuthBridge'), true);
    assert.equal(suffix.includes('app.post('), false, 'activation bridge must not create a hidden HTTP route');
    assert.equal(suffix.includes('invokeLegacy'), false, 'activation bridge must not call legacy auth handlers');
  }

  {
    const seen = [];
    let occupiedChecks = 0;
    const client = {
      async query(sql, params) {
        seen.push([String(sql), params]);
        if (String(sql).includes('SELECT id FROM users WHERE lower(username)')) {
          occupiedChecks += 1;
          return { rows: occupiedChecks <= 2 ? [{ id: `busy_${occupiedChecks}` }] : [] };
        }
        return { rows: [] };
      },
    };
    const candidate = await withCasefoldUsernameClaim(client, 'pepito', 'usr_casefold', async value => value);
    assert.match(candidate, /^pepito#[0-9]{4}$/);
    assert.equal(occupiedChecks, 3);
    assert.equal(seen.some(([sql, params]) => sql.includes('pg_advisory_lock') && params[0] === 'username-base:pepito'), true);
    assert.equal(seen.some(([sql, params]) => sql.includes('pg_advisory_unlock') && params[0] === 'username-base:pepito'), true);
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
    let welcomeCalls = 0;
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
      issueWelcome: async id => { welcomeCalls += 1; return { id: `welcome:${id}` }; },
      now: () => Date.parse('2026-10-21T00:10:00.000Z'),
    });

    await assert.rejects(
      coordinator.activate({ signupId: pending.id, continuationSecret: 'sc_fault' }),
      error => error?.code === 'FAULT_AFTER_ACTIVE',
    );
    assert.equal(userCreates, 1);
    assert.equal(vaultCreates, 1);
    assert.equal(welcomeCalls, 1);
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
