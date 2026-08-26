'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations.js');
const { preparePostgresCutover } = require('../postgres-cutover-preparation.js');
const {
  PostgresControlPlaneRuntime,
  assertCutoverReady,
  loadAuthSnapshot,
  loadPersistentSnapshot,
} = require('../postgres-control-plane-runtime.js');

function databaseUrl(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

(async () => {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is required.');

  const dbName = `beatgaler_cutover_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl(baseUrl, 'postgres'), ssl: false, max: 1 });
  let pool = null;
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrl(baseUrl, dbName), ssl: false, max: 4 });
    await applyMigrations(pool);

    const key = Buffer.alloc(32, 11);
    const cryptoConfig = { key, keyVersion: 4 };
    const sessionA = 'a'.repeat(64);
    const auth = {
      users: [{
        id: 'usr_cutover_1',
        username: 'cutover#0001',
        usernameSource: 'beatgaler',
        email: 'before@example.com',
        passwordSalt: '11'.repeat(16),
        passwordHash: '22'.repeat(64),
        createdAt: 1000,
        storageChatId: '-1009000000001',
        storageChatTitle: 'Cutover Vault',
        storageCreatedAt: 2000,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        providers: {
          google: {
            id: 'google-cutover-1',
            email: 'before@example.com',
            name: 'Cutover User',
            connectedAt: 3000,
            profileSyncedAt: 4000,
            accessToken: 'access-before',
            refreshToken: 'refresh-before',
            tokenExpiresAt: 9999999999999,
          },
        },
        planState: {
          basePlanId: 'paid_entry',
          grants: [{ id: 'grant-cutover', planId: 'highest_paid', source: 'probe', startsAt: 5000, expiresAt: 9999999999999 }],
        },
      }],
      sessions: {
        [sessionA]: { userId: 'usr_cutover_1', createdAt: 6000, expiresAt: 9999999999999 },
      },
    };
    const persistent = {
      linkedAccounts: {
        'installation-cutover': {
          beatgalerAccountId: 'usr_cutover_1',
          storageChatId: -1009000000001,
          beatgalerUsername: 'cutover#0001',
        },
      },
      uploadedFiles: { 'direct:123': { beatgalerUserId: 'installation-cutover', telegramMessageId: 123 } },
      beatTopics: { 'installation-cutover:beat-1': 77 },
      pendingTopicDeletes: { 'installation-cutover:beat-old': { beatId: 'beat-old', telegramTopicId: 88 } },
      messageRedirects: { 'installation-cutover:100': 101 },
    };
    const authRaw = JSON.stringify(auth, null, 2);
    const persistentRaw = JSON.stringify(persistent, null, 2);

    const first = await preparePostgresCutover(pool, { authRaw, persistentRaw, cryptoConfig });
    const second = await preparePostgresCutover(pool, { authRaw, persistentRaw, cryptoConfig });
    assert.deepEqual(second.snapshot, first.snapshot);
    assert.deepEqual(second.plan.counts, first.plan.counts);
    assert.match(first.snapshot.manifest_sha256, /^[0-9a-f]{64}$/);

    await assertCutoverReady(pool, first.snapshot.manifest_sha256);
    await assert.rejects(() => assertCutoverReady(pool, 'f'.repeat(64)), /does not match/);

    const runtime = new PostgresControlPlaneRuntime({
      pool,
      expectedSnapshotSha256: first.snapshot.manifest_sha256,
      cryptoConfig,
    });
    const initial = await runtime.initialize();
    assert.equal(initial.auth.users.length, 1);
    assert.equal(initial.auth.users[0].email, 'before@example.com');
    assert.equal(initial.auth.users[0].mfaSecret, 'JBSWY3DPEHPK3PXP');
    assert.equal(initial.auth.users[0].providers.google.accessToken, 'access-before');
    assert.equal(initial.auth.users[0].providers.google.refreshToken, 'refresh-before');
    assert.equal(initial.auth.users[0].providers.google.name, 'Cutover User');
    assert.equal(initial.auth.sessions[sessionA].userId, 'usr_cutover_1');
    assert.equal(initial.persistent.linkedAccounts['installation-cutover'].beatgalerAccountId, 'usr_cutover_1');

    const sessionB = 'b'.repeat(64);
    const afterAuth = JSON.parse(JSON.stringify(initial.auth));
    afterAuth.users[0].email = 'after@example.com';
    afterAuth.users[0].providers = {};
    delete afterAuth.users[0].mfaSecret;
    afterAuth.users[0].planState = { basePlanId: 'highest_paid', grants: [] };
    afterAuth.sessions = {
      [sessionB]: { userId: 'usr_cutover_1', createdAt: 7000, expiresAt: 9999999999999 },
    };
    await runtime.saveAuthSnapshot(afterAuth);

    const afterPersistent = JSON.parse(JSON.stringify(initial.persistent));
    afterPersistent.messageRedirects['installation-cutover:101'] = 102;
    delete afterPersistent.pendingTopicDeletes['installation-cutover:beat-old'];
    await runtime.savePersistentSnapshot(afterPersistent);
    await runtime.flush();

    const persistedAuth = await loadAuthSnapshot(pool, cryptoConfig);
    const persistedState = await loadPersistentSnapshot(pool);
    assert.equal(persistedAuth.users[0].email, 'after@example.com');
    assert.deepEqual(persistedAuth.users[0].providers || {}, {});
    assert.equal(persistedAuth.users[0].mfaSecret, undefined);
    assert.equal(persistedAuth.users[0].planState.basePlanId, 'highest_paid');
    assert.equal(persistedAuth.sessions[sessionA], undefined);
    assert.equal(persistedAuth.sessions[sessionB].userId, 'usr_cutover_1');
    assert.equal(persistedState.pendingTopicDeletes['installation-cutover:beat-old'], undefined);
    assert.equal(persistedState.messageRedirects['installation-cutover:101'], 102);

    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM users) users,
      (SELECT count(*)::int FROM auth_sessions) sessions,
      (SELECT count(*)::int FROM provider_identities) providers,
      (SELECT count(*)::int FROM mfa_factors) mfa,
      (SELECT count(*)::int FROM entitlements) entitlements,
      (SELECT count(*)::int FROM control_plane_cutovers WHERE state='READY') ready_markers`);
    assert.deepEqual(counts.rows[0], { users: 1, sessions: 1, providers: 0, mfa: 0, entitlements: 1, ready_markers: 1 });

    console.log(JSON.stringify({
      postgres_cutover_proven: true,
      import_twice_idempotent: true,
      exact_snapshot_sha_required: true,
      oauth_mfa_envelope_roundtrip_proven: true,
      post_cutover_writes_persisted: true,
      stale_auth_rows_removed: true,
      json_disk_dual_write_used: false,
      production_kms_proven: false,
      production_rpo_rto_proven: false,
    }));
    console.log('PASS PostgreSQL controlled cutover integration');
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
