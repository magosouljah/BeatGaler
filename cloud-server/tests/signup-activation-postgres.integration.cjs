'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const { createPendingSignupService } = require('../pending-signup-service');
const { digest, createPendingSignupRuntime } = require('../pending-signup-runtime');
const { createSignupActivationCoordinator, stableUserId } = require('../signup-activation-coordinator');
const { statusForUser } = require('../email-verification-authority');
const { issueWelcomeGrant } = require('../access-grant-store');
const { createPostgresInstallationClaimCoordinator } = require('../postgres-installation-claim-coordinator');
const execFileAsync = promisify(execFile);

function databaseUrl(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function main() {
  const base = String(process.env.DATABASE_URL || '');
  if (!base) throw new Error('DATABASE_URL is required for signup activation PostgreSQL integration.');
  const name = `beatgaler_activation_ci_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl(base, 'postgres'), ssl: false, max: 1 });
  let poolA;
  let poolB;
  const originalLoad = Module._load;
  const groups = new Map();
  const telegram = { creates: 0, failure: null };
  let nextChannel = 200000;

  class CreateChannel { constructor(input) { Object.assign(this, input); } }
  class EditForumTopic { constructor(input) { Object.assign(this, input); } }
  class UpdatePinnedForumTopic { constructor(input) { Object.assign(this, input); } }
  class FakeTelegramClient {
    setLogLevel() {}
    async connect() {}
    async checkAuthorization() { return true; }
    async disconnect() {}
    async getDialogs() { return [...groups.values()].map(entity => ({ entity })); }
    async invoke(request) {
      if (!(request instanceof CreateChannel)) return {};
      if (telegram.failure === 'during') {
        telegram.failure = null;
        throw new Error('injected Telegram CreateChannel failure');
      }
      telegram.creates += 1;
      const entity = { id: ++nextChannel, title: request.title };
      groups.set(entity.id, entity);
      if (telegram.failure === 'after-create') {
        telegram.failure = null;
        throw new Error('injected lost Telegram CreateChannel response');
      }
      return { chats: [entity] };
    }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'telegram') return { TelegramClient: FakeTelegramClient,
      Api: { channels: { CreateChannel, EditForumTopic, UpdatePinnedForumTopic } } };
    if (request === 'telegram/sessions') return { StringSession: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.BEATGALER_MASTER_SESSION = 'activation-test-session';
  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'activation-test-hash';
  const { createPrivateUserStorageGroup } = require('../master-storage');
  const pepper = 'activation-integration-pepper-32-bytes';
  const continuation = 'sc_activation_test';
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-activation-pg-'));
  const activeFaults = new Map();
  const counters = new Map();

  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = databaseUrl(base, name);
    poolA = new Pool({ connectionString: url, ssl: false, max: 8 });
    poolB = new Pool({ connectionString: url, ssl: false, max: 8 });
    await applyMigrations(poolA);
    const runtime = createPendingSignupRuntime({ pool: poolA,
      keyring: { key: Buffer.alloc(32, 7), keyVersion: 1 },
      env: { BEATGALER_SIGNUP_PEPPER: pepper } });
    const service = createPendingSignupService({ pool: poolA, runtime,
      env: { BEATGALER_SIGNUP_PEPPER: pepper } });

    async function seed(signupId, { installation = true, installationId = null } = {}) {
      await poolA.query(`INSERT INTO pending_signups(
        id,email_normalized,username_base,password_hash,password_salt,installation_id,
        continuation_hash,link_token_hash,manual_code_hash,challenge_expires_at,status,verified_at,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour','VERIFIED',now(),now()+interval '1 day')`, [
        signupId, `${signupId}@example.com`, `user${signupId.slice(-4)}`, 'a'.repeat(64), 'b'.repeat(32),
        installation ? (installationId || `install_${signupId}`) : null, digest(pepper, 'continuation', continuation),
        'c'.repeat(64), 'd'.repeat(64),
      ]);
    }

    function coordinator(pool, signupId) {
      const counts = counters.get(signupId) || { sessions: 0, binds: 0 };
      counters.set(signupId, counts);
      let local = null;
      let activeObserved = false;
      const bridge = {
        adoptOrCreatePasswordUser(input) {
          local = { id: input.id, username: input.username, email: input.email,
            passwordHash: input.passwordHash, passwordSalt: input.passwordSalt };
        },
        adoptAuthoritativeUser(input) {
          local = { id: input.id, username: input.username, email: input.email,
            passwordHash: input.passwordHash, passwordSalt: input.passwordSalt,
            storageChatId: input.storageChatId || null, storageChatTitle: input.storageChatTitle || null };
        },
        async ensureStorage() {
          assert.ok(local, 'user must be adopted before Telegram');
          if (activeFaults.get(signupId) === 'before-vault') {
            activeFaults.delete(signupId);
            throw new Error('injected crash after user before vault');
          }
          const created = await createPrivateUserStorageGroup({ username: local.username, accountId: local.id });
          local.storageChatId = String(created.botApiChatId);
          local.storageChatTitle = created.title;
          if (activeFaults.get(signupId) === 'after-telegram') {
            activeFaults.delete(signupId);
            throw new Error('injected crash after Telegram before vault persistence');
          }
        },
        bindInstallation(_userId, installationId) {
          assert.ok(local?.storageChatId);
          counts.binds += 1;
          local.installationId = installationId;
        },
        createSession(userId) {
          assert.equal(activeObserved, true, 'a session must never be created before durable ACTIVE');
          if (activeFaults.get(signupId) === 'after-active') {
            activeFaults.delete(signupId);
            throw new Error('injected crash after ACTIVE before session');
          }
          assert.equal(userId, local?.id, 'session requires adopted user');
          counts.sessions += 1;
          local.sessionToken = `session_${signupId}`;
          return local.sessionToken;
        },
        async publicPayload(_userId, token) { return { token }; },
      };
      async function flushAuthority() {
        if (!local) return;
        await pool.query(`INSERT INTO users(id,username,username_source,email,password_hash,password_hash_algorithm,password_salt)
          VALUES($1,$2,'beatgaler',$3,$4,'scrypt',$5) ON CONFLICT(id) DO NOTHING`,
        [local.id, local.username, local.email, local.passwordHash, local.passwordSalt]);
        if (local.storageChatId) {
          await pool.query(`INSERT INTO vaults(id,user_id,telegram_chat_id,title)
            VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO NOTHING`,
          [`vault_${local.id}`, local.id, local.storageChatId, local.storageChatTitle]);
          if (!local.installationId && activeFaults.get(signupId) === 'after-vault-flush') {
            activeFaults.delete(signupId);
            throw new Error('injected crash after vault persistence before ledger DONE');
          }
        }
        if (local.installationId) {
          await pool.query(`INSERT INTO runtime_compat_state(state_key,payload)
            VALUES('legacy-cloud-data-v1',$1::jsonb)
            ON CONFLICT(state_key) DO UPDATE SET payload=jsonb_set(runtime_compat_state.payload,
              ARRAY['linkedAccounts',$2::text],$3::jsonb,true),updated_at=now()`, [
            JSON.stringify({ linkedAccounts: { [local.installationId]: { beatgalerAccountId: local.id } } }),
            local.installationId, JSON.stringify({ beatgalerAccountId: local.id }),
          ]);
          if (activeFaults.get(signupId) === 'after-installation') {
            activeFaults.delete(signupId);
            throw new Error('injected crash after installation persistence before ledger DONE');
          }
        }
        if (local.sessionToken) {
          await pool.query(`INSERT INTO auth_sessions(session_key_hash,user_id,created_at,expires_at)
            VALUES($1,$2,now(),now()+interval '30 days') ON CONFLICT DO NOTHING`,
          [crypto.createHash('sha256').update(local.sessionToken).digest('hex'), local.id]);
        }
      }
      const wrappedService = { ...service,
        async setActivationState(id, status, options) {
          if (status === 'ACTIVE' && activeFaults.get(signupId) === 'before-active') {
            activeFaults.delete(signupId);
            throw new Error('injected crash after provisioning before ACTIVE');
          }
          const result = await service.setActivationState(id, status, options);
          if (status === 'ACTIVE') activeObserved = true;
          return result;
        },
      };
      return createSignupActivationCoordinator({
        pool, service: wrappedService, getBridge: () => bridge, flushAuthority,
        issueWelcome: userId => issueWelcomeGrant(pool, userId),
        installationClaimCoordinator: createPostgresInstallationClaimCoordinator(pool),
        staleMs: 60_000,
      });
    }

    async function assertDurable(signupId, { sessions = 1 } = {}) {
      const id = stableUserId(signupId);
      assert.equal((await poolA.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [id])).rows[0].n, 1);
      assert.equal((await statusForUser(poolA, id)).email_verified, true);
      assert.equal((await poolA.query('SELECT count(*)::int AS n FROM users WHERE lower(email)=lower($1)',
        [`${signupId}@example.com`])).rows[0].n, 1);
      assert.equal((await poolA.query('SELECT count(*)::int AS n FROM vaults WHERE user_id=$1', [id])).rows[0].n, 1);
      assert.equal([...groups.values()].filter(group => group.title.endsWith(`[BG:${id}]`)).length, 1);
      assert.equal((await poolA.query("SELECT count(*)::int AS n FROM entitlements WHERE user_id=$1 AND source='welcome'", [id])).rows[0].n, 1);
      assert.equal((await poolA.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [id])).rows[0].n, sessions);
      assert.equal((await poolA.query('SELECT status FROM pending_signups WHERE id=$1', [signupId])).rows[0].status, 'ACTIVE');
      const ledger = await poolA.query("SELECT step,state FROM auth_provisioning_ledger WHERE signup_id=$1 AND step IN ('user','vault','installation','welcome')", [signupId]);
      assert.deepEqual(ledger.rows.map(row => `${row.step}:${row.state}`).sort(),
        ['installation:DONE', 'user:DONE', 'vault:DONE', 'welcome:DONE']);
      const persistent = await poolA.query("SELECT payload->'linkedAccounts'->$1 AS linked FROM runtime_compat_state WHERE state_key='legacy-cloud-data-v1'", [`install_${signupId}`]);
      assert.equal(persistent.rows[0]?.linked?.beatgalerAccountId, id);
    }

    // Exercise the real pending runtime and verification transition without
    // SES. Neither the pending row nor a verified code creates a user or vault.
    const begun = await service.begin({ email: 'flow@example.com', usernameBase: 'flowuser',
      password: 'password-123', installationId: 'install_flow' });
    assert.equal(begun.created, true);
    const flowUserId = stableUserId(begun.signup_id);
    const beforeVerify = await poolA.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [flowUserId]);
    assert.equal(beforeVerify.rows[0].n, 0);
    const delivery = await runtime.claimDelivery();
    assert.equal(delivery.row.signup_id, begun.signup_id);
    await runtime.completeDelivery(delivery.row.id, { ok: true });
    const verified = await service.verify({ signupId: begun.signup_id,
      continuationSecret: begun.continuation_secret, challenge: delivery.secret.manual_code });
    assert.equal(verified.status, 'VERIFIED');
    assert.equal((await poolA.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [flowUserId])).rows[0].n, 0);
    assert.equal((await poolA.query('SELECT count(*)::int AS n FROM vaults WHERE user_id=$1', [flowUserId])).rows[0].n, 0);
    assert.equal((await poolA.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [flowUserId])).rows[0].n, 0);
    const flowActive = await coordinator(poolA, begun.signup_id).activate({ signupId: begun.signup_id,
      continuationSecret: begun.continuation_secret });
    assert.equal(flowActive.status, 'ACTIVE');
    assert.equal(flowActive.user_id, flowUserId);
    assert.equal((await poolA.query('SELECT count(*)::int AS n FROM vaults WHERE user_id=$1', [flowUserId])).rows[0].n, 1);

    const cases = [
      ['psu_before_vault', 'before-vault'],
      ['psu_during_telegram', 'during-telegram'],
      ['psu_after_telegram', 'after-telegram'],
      ['psu_after_vault_flush', 'after-vault-flush'],
      ['psu_after_installation', 'after-installation'],
      ['psu_before_active', 'before-active'],
      ['psu_after_active', 'after-active'],
    ];
    for (const [signupId, fault] of cases) {
      await seed(signupId);
      if (fault === 'during-telegram') telegram.failure = 'during';
      else if (fault === 'after-telegram') telegram.failure = 'after-create';
      else activeFaults.set(signupId, fault);
      const first = coordinator(poolA, signupId);
      await assert.rejects(first.activate({ signupId, continuationSecret: continuation }), /injected/);
      const afterFailure = await poolA.query('SELECT status FROM pending_signups WHERE id=$1', [signupId]);
      assert.equal(afterFailure.rows[0].status, fault === 'after-active' ? 'ACTIVE' : 'RETRYABLE');
      assert.equal((await poolA.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [stableUserId(signupId)])).rows[0].n, 0);
      const recovered = fault === 'after-telegram'
        ? await (async () => {
          const worker = path.join(__dirname, 'signup-activation-postgres.worker.cjs');
          const result = await execFileAsync(process.execPath, [worker], {
            env: { ...process.env, DATABASE_URL: url, TEST_SIGNUP_ID: signupId,
              TEST_TELEGRAM_GROUPS: JSON.stringify([...groups.values()]) },
            timeout: 20_000,
          });
          const output = JSON.parse(result.stdout);
          assert.equal(output.createAttempts, 0, 'restart must reuse the Telegram group created before the crash');
          return { status: output.status, user_id: output.userId };
        })()
        : await coordinator(poolB, signupId).activate({ signupId, continuationSecret: continuation });
      assert.equal(recovered.status, 'ACTIVE');
      await assertDurable(signupId, { sessions: fault === 'after-active' ? 0 : 1 });
      if (fault === 'after-active') {
        assert.equal((await statusForUser(poolB, stableUserId(signupId))).email_verified, true,
          'ACTIVE retry must retain durable PostgreSQL verification');
      }
      if (fault === 'after-installation') {
        assert.equal(counters.get(signupId).binds, 2, 'installation replay must converge to one durable owner');
      }
    }

    // Kill an actual Node process after the mocked Telegram transport accepts
    // CreateChannel. PostgreSQL still says PROVISIONING/RUNNING. A restarted
    // process must find that external group instead of issuing CreateChannel.
    const killedId = 'psu_killed_telegram';
    await seed(killedId);
    activeFaults.set(killedId, 'before-vault');
    await assert.rejects(coordinator(poolA, killedId).activate({ signupId: killedId,
      continuationSecret: continuation }), /injected crash after user/);
    const groupFile = path.join(stateRoot, 'telegram-after-process-death.json');
    const worker = path.join(__dirname, 'signup-activation-postgres.worker.cjs');
    await assert.rejects(execFileAsync(process.execPath, [worker], {
      env: { ...process.env, DATABASE_URL: url, TEST_SIGNUP_ID: killedId,
        TEST_TELEGRAM_GROUPS: JSON.stringify([...groups.values()]),
        TEST_TELEGRAM_GROUP_FILE: groupFile, TEST_CRASH_AFTER_TELEGRAM: '1' },
      timeout: 20_000,
    }), error => error?.code === 82);
    const createdBeforeDeath = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
    const orphan = createdBeforeDeath.at(-1);
    groups.set(orphan.id, orphan);
    assert.equal((await poolA.query('SELECT status FROM pending_signups WHERE id=$1', [killedId])).rows[0].status,
      'PROVISIONING');
    assert.equal((await poolA.query("SELECT state FROM auth_provisioning_ledger WHERE signup_id=$1 AND step='vault'",
      [killedId])).rows[0].state, 'RUNNING');
    assert.equal((await poolA.query('SELECT count(*)::int AS n FROM vaults WHERE user_id=$1',
      [stableUserId(killedId)])).rows[0].n, 0);
    await poolA.query("UPDATE pending_signups SET updated_at=now()-interval '2 minutes' WHERE id=$1", [killedId]);
    assert.equal(await service.recoverStaleActivations({ staleMs: 60_000 }), 1);
    const restartedWorker = await execFileAsync(process.execPath, [worker], {
      env: { ...process.env, DATABASE_URL: url, TEST_SIGNUP_ID: killedId,
        TEST_TELEGRAM_GROUPS: JSON.stringify([...groups.values()]) },
      timeout: 20_000,
    });
    assert.equal(JSON.parse(restartedWorker.stdout).createAttempts, 0);
    await assertDurable(killedId);

    const concurrentId = 'psu_concurrent';
    await seed(concurrentId);
    const [one, two] = await Promise.all([
      coordinator(poolA, concurrentId).activate({ signupId: concurrentId, continuationSecret: continuation }),
      coordinator(poolB, concurrentId).activate({ signupId: concurrentId, continuationSecret: continuation }),
    ]);
    assert.equal(one.status, 'ACTIVE');
    assert.equal(two.status, 'ACTIVE');
    assert.equal(one.user_id, two.user_id);
    await assertDurable(concurrentId);
    assert.equal(counters.get(concurrentId).sessions, 1);

    const ownerId = 'psu_install_owner';
    const rejectedId = 'psu_install_conflict';
    await seed(ownerId, { installationId: 'install_shared_activation' });
    await seed(rejectedId, { installationId: 'install_shared_activation' });
    assert.equal((await coordinator(poolA, ownerId).activate({ signupId: ownerId,
      continuationSecret: continuation })).status, 'ACTIVE');
    await assert.rejects(coordinator(poolB, rejectedId).activate({ signupId: rejectedId,
      continuationSecret: continuation }), error => error?.code === 'INSTALLATION_CONFLICT');
    assert.equal((await poolA.query('SELECT count(*)::int AS n FROM users WHERE id=$1',
      [stableUserId(rejectedId)])).rows[0].n, 0, 'conflicting installation must fail before user creation');
    assert.equal((await poolA.query('SELECT count(*)::int AS n FROM vaults WHERE user_id=$1',
      [stableUserId(rejectedId)])).rows[0].n, 0, 'conflicting installation must fail before Telegram');
    assert.equal((await poolA.query('SELECT status FROM pending_signups WHERE id=$1', [rejectedId])).rows[0].status,
      'CANCELLED');
    console.log('signup activation PostgreSQL fault injection: PASS');
  } finally {
    Module._load = originalLoad;
    if (poolA) await poolA.end();
    if (poolB) await poolB.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {});
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
