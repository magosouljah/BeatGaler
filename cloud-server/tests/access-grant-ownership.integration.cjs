'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const {
  PostgresControlPlaneRuntime,
  encryptionCallbacks,
  replaceAuthSnapshot,
  writeCutoverMarker,
} = require('../postgres-control-plane-runtime');
const { exportLegacyAccounts } = require('../legacy-exporter');

const ADMIN_URL = process.env.BEATGALER_STEP1_TEST_ADMIN_URL || '';
const SHA = 'a'.repeat(64);
const cryptoConfig = { key: Buffer.alloc(32, 37), keyVersion: 1 };

function databaseUrl(adminUrl, databaseName) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function authSnapshot(overrides = {}) {
  return {
    users: [{
      id: 'usr_f3_step1',
      username: 'step1#0001',
      usernameSource: 'beatgaler',
      email: 'initial@example.com',
      passwordSalt: '11'.repeat(16),
      passwordHash: '22'.repeat(64),
      createdAt: Date.parse('2026-10-08T00:00:00Z'),
      providers: {},
      planState: { basePlanId: 'free', grants: [] },
      ...overrides,
    }],
    sessions: {},
  };
}

async function entitlementRows(pool) {
  const result = await pool.query(`
    SELECT id,user_id,plan_id,source,source_key,starts_at,expires_at,revoked_at,
           revocation_reason,issued_by_actor,created_at
    FROM entitlements WHERE user_id='usr_f3_step1' ORDER BY id
  `);
  return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, value instanceof Date ? value.toISOString() : value,
  ])));
}

test('Auth persistence never owns commercial entitlements, including after restart', { skip: !ADMIN_URL }, async t => {
  const dbName = `beatgaler_f3s1_${crypto.randomBytes(6).toString('hex')}`;
  assert.match(dbName, /^beatgaler_f3s1_[0-9a-f]{12}$/);
  const admin = new Client({ connectionString: ADMIN_URL });
  let pool;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrl(ADMIN_URL, dbName), max: 4 });
    await applyMigrations(pool);
    await replaceAuthSnapshot(pool, authSnapshot(), cryptoConfig);
    await pool.query('DELETE FROM entitlements WHERE user_id=$1', ['usr_f3_step1']);
    await pool.query(`
      INSERT INTO entitlements(id,user_id,plan_id,source,starts_at,expires_at)
      VALUES('base_f3_step1','usr_f3_step1','free','base_plan',$1,NULL)
    `, ['2026-10-08T00:00:00Z']);
    await pool.query(`
      INSERT INTO entitlements(id,user_id,plan_id,source,source_key,starts_at,expires_at,
                               revoked_at,revocation_reason,issued_by_actor)
      VALUES('grant_f3_step1','usr_f3_step1','highest_paid','support','support-ticket-7',
             $1,$2,NULL,NULL,'support-agent')
    `, ['2026-10-08T01:00:00Z', '2026-10-15T01:00:00Z']);
    const original = await entitlementRows(pool);
    assert.equal(original.length, 2);

    await t.test('A/B: email, password, OAuth, MFA and sessions leave grants byte-for-byte identical', async () => {
      const changed = authSnapshot({
        email: 'changed@example.com',
        passwordSalt: '33'.repeat(16),
        passwordHash: '44'.repeat(64),
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        providers: { google: { id: 'google-f3-step1', email: 'changed@example.com', accessToken: 'test-token' } },
        planState: { basePlanId: 'highest_paid', grants: [{ id: 'stale_grant', planId: 'paid_entry', source: 'stale', startsAt: 1, expiresAt: 9999999999999 }] },
      });
      changed.sessions['b'.repeat(64)] = { userId: 'usr_f3_step1', createdAt: Date.parse('2026-10-08T02:00:00Z'), expiresAt: Date.parse('2026-11-08T02:00:00Z') };
      await replaceAuthSnapshot(pool, changed, cryptoConfig);
      assert.deepEqual(await entitlementRows(pool), original);
      const account = await pool.query('SELECT email,password_hash FROM users WHERE id=$1', ['usr_f3_step1']);
      assert.equal(account.rows[0].email, 'changed@example.com');
      assert.equal(account.rows[0].password_hash, '44'.repeat(64));
      assert.equal((await pool.query('SELECT count(*)::int n FROM auth_sessions')).rows[0].n, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM provider_identities')).rows[0].n, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM mfa_factors')).rows[0].n, 1);
    });

    await t.test('C: restart and a stale planState cannot reapply basePlanId or grants', async () => {
      await writeCutoverMarker(pool, SHA);
      const runtime = new PostgresControlPlaneRuntime({ pool, expectedSnapshotSha256: SHA, cryptoConfig });
      const initial = await runtime.initialize();
      assert.equal(initial.auth.users[0].planState.basePlanId, 'free');
      assert.deepEqual(initial.auth.users[0].planState.grants.map(grant => grant.id), ['grant_f3_step1']);
      initial.auth.users[0].planState = { basePlanId: 'highest_paid', grants: [] };
      initial.auth.users[0].email = 'after-restart@example.com';
      await runtime.saveAuthSnapshot(initial.auth);
      await runtime.flush();
      assert.deepEqual(await entitlementRows(pool), original);
      const restarted = new PostgresControlPlaneRuntime({ pool, expectedSnapshotSha256: SHA, cryptoConfig });
      const reloaded = await restarted.initialize();
      assert.equal(reloaded.auth.users[0].email, 'after-restart@example.com');
      assert.equal(reloaded.auth.users[0].planState.basePlanId, 'free');
      assert.deepEqual(reloaded.auth.users[0].planState.grants.map(grant => grant.id), ['grant_f3_step1']);
    });

    await t.test('D: Access issues welcome once across retries, restart and concurrent calls', async () => {
      const { issueWelcomeGrant } = require('../access-grant-store');
      const accessRuntime = require('../access-grant-runtime');
      const at = new Date('2026-10-08T03:00:00Z');
      const results = await Promise.all(Array.from({ length: 8 }, () => issueWelcomeGrant(pool, 'usr_f3_step1', { now: at })));
      assert.equal(new Set(results.map(row => row.id)).size, 1);
      const welcome = (await entitlementRows(pool)).filter(row => row.source === 'welcome');
      assert.equal(welcome.length, 1);
      assert.equal(welcome[0].plan_id, 'paid_entry');
      assert.equal(welcome[0].starts_at, at.toISOString());
      assert.equal(welcome[0].expires_at, new Date(at.getTime() + 7 * 86400_000).toISOString());
      await issueWelcomeGrant(pool, 'usr_f3_step1', { now: new Date(at.getTime() + 86400_000) });
      assert.deepEqual((await entitlementRows(pool)).filter(row => row.source === 'welcome'), welcome);
      let flushes = 0;
      let projected = null;
      accessRuntime.configure({ pool, authRuntime: { async flush() { flushes += 1; } } });
      accessRuntime.setLegacyProjectionUpdater((_userId, grant) => { projected = grant; });
      try {
        await accessRuntime.issueWelcomeAfterActivation('usr_f3_step1');
        assert.equal(flushes, 1);
        assert.equal(projected.id, welcome[0].id);
      } finally {
        accessRuntime.configure();
      }
      const restarted = new PostgresControlPlaneRuntime({ pool, expectedSnapshotSha256: SHA, cryptoConfig });
      const snapshot = (await restarted.initialize()).auth;
      await restarted.saveAuthSnapshot(snapshot);
      await restarted.flush();
      assert.deepEqual((await entitlementRows(pool)).filter(row => row.source === 'welcome'), welcome);
    });

    await t.test('legacy rollback export cannot reactivate a revoked commercial grant', async () => {
      await pool.query(`
        INSERT INTO entitlements(id,user_id,plan_id,source,source_key,starts_at,expires_at,
                                 revoked_at,revocation_reason)
        VALUES('revoked_f3_step1','usr_f3_step1','highest_paid','support','old-ticket',
               $1,$2,$3,'manual_revocation')
      `, ['2026-10-08T00:00:00Z', '2026-10-15T00:00:00Z', '2026-10-09T00:00:00Z']);
      const runtime = new PostgresControlPlaneRuntime({ pool, expectedSnapshotSha256: SHA, cryptoConfig });
      const loaded = (await runtime.initialize()).auth.users[0];
      assert.equal(loaded.planState.grants.some(grant => grant.id === 'revoked_f3_step1'), false);
      const exported = await exportLegacyAccounts(pool, {
        decryptSecretFromStorage: encryptionCallbacks(cryptoConfig).decrypt,
      });
      assert.equal(exported.users[0].planState.grants.some(grant => grant.id === 'revoked_f3_step1'), false);
    });
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
});
