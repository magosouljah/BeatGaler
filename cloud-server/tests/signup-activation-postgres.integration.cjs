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
const { issueWelcomeGrant } = require('../access-grant-store');
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

    async function seed(signupId, { installation = true } = {}) {
      await poolA.query(`INSERT INTO pending_signups(
        id,email_normalized,username_base,password_hash,password_salt,installation_id,
        continuation_hash,link_token_hash,manual_code_hash,challenge_expires_at,status,verified_at,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour','VERIFIED',now(),now()+interval '1 day')`, [
        signupId, `${signupId}@example.com`, `user${signupId.slice(-4)}`, 'a'.repeat(64), 'b'.repeat(32),
        installation ? `install_${signupId}` : null, digest(pepper, 'continuation', continuation),
        'c'.repeat(64), 'd'.repeat(64),
      ]);
    }

    function coordinator(pool, signupId) {
      const counts = counters.get(signupId) || { sessions: 0, binds: 0 };
      counters.set(signupId, counts);
      let local = null;
      const lifecycleState = { email_verified: {} };
      const lifecycle = { _test: {
        stateSnapshot() { return lifecycleState; },
        stateFile: path.join(stateRoot, `${signupId}-${crypto.randomBytes(3).toString('hex')}.json`),
      } };
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
        }
        if (local.installationId) {
          await pool.query(`INSERT INTO runtime_compat_state(state_key,payload)
            VALUES('legacy-cloud-data-v1',$1::jsonb)
            ON CONFLICT(state_key) DO UPDATE SET payload=jsonb_set(runtime_compat_state.payload,
              ARRAY['linkedAccounts',$2::text],$3::jsonb,true),updated_at=now()`, [
            JSON.stringify({ linkedAccounts: { [local.installationId]: { beatgalerAccountId: local.id } } }),
            local.installationId, JSON.stringify({ beatgalerAccountId: local.id }),
          ]);
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
          return service.setActivationState(id, status, options);
        },
      };
      return createSignupActivationCoordinator({
        pool, service: wrappedService, getBridge: () => bridge, flushAuthority,
        accountLifecycle: lifecycle, issueWelcome: userId => issueWelcomeGrant(pool, userId),
        staleMs: 60_000,
      });
    }

    async function assertDurable(signupId, { sessions = 1 } = {}) {
      const id = stableUserId(signupId);
      assert.equal((await poolA.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [id])).rows[0].n, 1);
      assert.equal((await poolA.query('SELECT count(*)::int AS n FROM vaults WHERE user_id=$1', [id])).rows[0].n, 1);
      assert.equal([...groups.values()].filter(group => group.title.endsWith(`[BG:${id}]`)).length, 1);
      assert.equal((await poolA.query("SELECT count(*)::int AS n FROM entitlements WHERE user_id=$1 AND source='welcome'", [id])).rows[0].n, 1);
      assert.equal((await poolA.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [id])).rows[0].n, sessions);
      assert.equal((await poolA.query('SELECT status FROM pending_signups WHERE id=$1', [signupId])).rows[0].status, 'ACTIVE');
      const persistent = await poolA.query("SELECT payload->'linkedAccounts'->$1 AS linked FROM runtime_compat_state WHERE state_key='legacy-cloud-data-v1'", [`install_${signupId}`]);
      assert.equal(persistent.rows[0]?.linked?.beatgalerAccountId, id);
    }

    const cases = [
      ['psu_before_vault', 'before-vault'],
      ['psu_during_telegram', 'during-telegram'],
      ['psu_after_telegram', 'after-telegram'],
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
    }

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
