'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Pool } = require('pg');
const { createPendingSignupRuntime } = require('../pending-signup-runtime');
const { createPendingSignupService } = require('../pending-signup-service');
const { createSignupActivationCoordinator } = require('../signup-activation-coordinator');
const { issueWelcomeGrant } = require('../access-grant-store');
const { createPostgresInstallationClaimCoordinator } = require('../postgres-installation-claim-coordinator');

async function main() {
  const groups = JSON.parse(process.env.TEST_TELEGRAM_GROUPS || '[]');
  let createAttempts = 0;
  class CreateChannel { constructor(input) { Object.assign(this, input); } }
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'telegram') return { TelegramClient: class {
      setLogLevel() {}
      async connect() {}
      async checkAuthorization() { return true; }
      async disconnect() {}
      async getDialogs() { return groups.map(entity => ({ entity })); }
      async invoke(requestObject) {
        if (requestObject instanceof CreateChannel) {
          createAttempts += 1;
          if (process.env.TEST_CRASH_AFTER_TELEGRAM === '1') {
            const entity = { id: 900001, title: requestObject.title };
            fs.writeFileSync(process.env.TEST_TELEGRAM_GROUP_FILE,
              JSON.stringify([...groups, entity]));
            process.exit(82); // Simulate process death after Telegram accepted CreateChannel.
          }
          throw new Error('retry attempted a duplicate Telegram CreateChannel');
        }
        return {};
      }
    }, Api: { channels: { CreateChannel } } };
    if (request === 'telegram/sessions') return { StringSession: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.BEATGALER_MASTER_SESSION = 'activation-test-session';
  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'activation-test-hash';
  const { createPrivateUserStorageGroup } = require('../master-storage');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 6 });
  const pepper = 'activation-integration-pepper-32-bytes';
  const runtime = createPendingSignupRuntime({ pool, keyring: { key: Buffer.alloc(32, 7), keyVersion: 1 },
    env: { BEATGALER_SIGNUP_PEPPER: pepper } });
  const service = createPendingSignupService({ pool, runtime, env: { BEATGALER_SIGNUP_PEPPER: pepper } });
  let local = null;
  const bridge = {
    adoptOrCreatePasswordUser() { throw new Error('durable user was not found after restart'); },
    adoptAuthoritativeUser(input) {
      local = { id: input.id, username: input.username, email: input.email,
        passwordHash: input.passwordHash, passwordSalt: input.passwordSalt,
        storageChatId: input.storageChatId || null, storageChatTitle: input.storageChatTitle || null };
    },
    async ensureStorage() {
      const created = await createPrivateUserStorageGroup({ username: local.username, accountId: local.id });
      local.storageChatId = String(created.botApiChatId);
      local.storageChatTitle = created.title;
    },
    bindInstallation(_userId, installationId) { local.installationId = installationId; },
    createSession() { local.sessionToken = `session_restart_${process.env.TEST_SIGNUP_ID}`; return local.sessionToken; },
    async publicPayload(_userId, token) { return { token }; },
  };
  async function flushAuthority() {
    if (!local) return;
    if (local.storageChatId) await pool.query(`INSERT INTO vaults(id,user_id,telegram_chat_id,title)
      VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO NOTHING`,
    [`vault_${local.id}`, local.id, local.storageChatId, local.storageChatTitle]);
    if (local.installationId) await pool.query(`INSERT INTO runtime_compat_state(state_key,payload)
      VALUES('legacy-cloud-data-v1',$1::jsonb)
      ON CONFLICT(state_key) DO UPDATE SET payload=jsonb_set(runtime_compat_state.payload,
        ARRAY['linkedAccounts',$2::text],$3::jsonb,true),updated_at=now()`, [
      JSON.stringify({ linkedAccounts: { [local.installationId]: { beatgalerAccountId: local.id } } }),
      local.installationId, JSON.stringify({ beatgalerAccountId: local.id }),
    ]);
    if (local.sessionToken) await pool.query(`INSERT INTO auth_sessions(session_key_hash,user_id,created_at,expires_at)
      VALUES($1,$2,now(),now()+interval '30 days') ON CONFLICT DO NOTHING`,
    [crypto.createHash('sha256').update(local.sessionToken).digest('hex'), local.id]);
  }
  try {
    const coordinator = createSignupActivationCoordinator({ pool, service, getBridge: () => bridge,
      flushAuthority, issueWelcome: userId => issueWelcomeGrant(pool, userId),
      installationClaimCoordinator: createPostgresInstallationClaimCoordinator(pool), staleMs: 60_000 });
    const result = await coordinator.activate({ signupId: process.env.TEST_SIGNUP_ID,
      continuationSecret: 'sc_activation_test' });
    if (result.status !== 'ACTIVE' || createAttempts !== 0) throw new Error('restart did not recover the existing Telegram group');
    process.stdout.write(JSON.stringify({ status: result.status, userId: result.user_id, createAttempts }));
  } finally {
    Module._load = originalLoad;
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
