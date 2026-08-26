'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations.js');
const {
  stagePostgresCutover,
  commitStagedPostgresCutover,
} = require('../postgres-cutover-preparation.js');
const {
  createCutoverSnapshotBundle,
  verifyCutoverSnapshotBundle,
} = require('../cutover-snapshot-bundle.js');
const {
  exportCurrentPostgresForRollback,
  commitPostgresRollback,
  assertJsonRollbackSnapshot,
} = require('../postgres-rollback-preparation.js');
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

function raw(value) {
  return JSON.stringify(value, null, 2);
}

(async () => {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is required.');

  const dbName = `beatgaler_cutover_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl(baseUrl, 'postgres'), ssl: false, max: 1 });
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-cutover-integration-'));
  let pool = null;
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrl(baseUrl, dbName), ssl: false, max: 4 });
    await applyMigrations(pool);

    const key = Buffer.alloc(32, 11);
    const cryptoConfig = { key, keyVersion: 4 };
    const sessionA = 'a'.repeat(64);
    const initialAuth = {
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
    const initialPersistent = {
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
    const initialAuthRaw = raw(initialAuth);
    const initialPersistentRaw = raw(initialPersistent);

    const initialBundleDir = path.join(bundleRoot, 'initial');
    const initialBundle = createCutoverSnapshotBundle(initialBundleDir, {
      authRaw: initialAuthRaw,
      persistentRaw: initialPersistentRaw,
    });
    const verifiedInitialBundle = verifyCutoverSnapshotBundle(initialBundleDir);
    assert.equal(verifiedInitialBundle.bundleSha256, initialBundle.bundle_sha256);

    const firstStage = await stagePostgresCutover(pool, {
      authRaw: initialAuthRaw,
      persistentRaw: initialPersistentRaw,
      cryptoConfig,
      externalBundleSha256: initialBundle.bundle_sha256,
    });
    const secondStage = await stagePostgresCutover(pool, {
      authRaw: initialAuthRaw,
      persistentRaw: initialPersistentRaw,
      cryptoConfig,
      externalBundleSha256: initialBundle.bundle_sha256,
    });
    assert.deepEqual(secondStage.snapshot, firstStage.snapshot);
    assert.deepEqual(secondStage.plan.counts, firstStage.plan.counts);
    assert.equal(secondStage.state, 'STAGED');
    assert.match(firstStage.snapshot.manifest_sha256, /^[0-9a-f]{64}$/);

    await assert.rejects(
      () => assertCutoverReady(pool, firstStage.snapshot.manifest_sha256),
      /marker is missing/,
    );
    const stageCountBeforeCommit = await pool.query('SELECT count(*)::int n FROM control_plane_cutover_stages');
    assert.equal(stageCountBeforeCommit.rows[0].n, 1);

    // Simulate the short-write-freeze final delta: source changed after the
    // initial bulk stage. A commit against stale staged bytes must fail closed.
    const finalAuth = JSON.parse(JSON.stringify(initialAuth));
    finalAuth.users[0].email = 'final-before-switch@example.com';
    const finalPersistent = JSON.parse(JSON.stringify(initialPersistent));
    finalPersistent.messageRedirects['installation-cutover:101'] = 102;
    const finalAuthRaw = raw(finalAuth);
    const finalPersistentRaw = raw(finalPersistent);

    await assert.rejects(
      () => commitStagedPostgresCutover(pool, {
        expectedSnapshotSha256: firstStage.snapshot.manifest_sha256,
        expectedExternalBundleSha256: initialBundle.bundle_sha256,
        currentAuthRaw: finalAuthRaw,
        currentPersistentRaw: finalPersistentRaw,
      }),
      /changed after staging/,
    );
    await assert.rejects(
      () => assertCutoverReady(pool, firstStage.snapshot.manifest_sha256),
      /marker is missing/,
    );

    const finalBundleDir = path.join(bundleRoot, 'final');
    const finalBundle = createCutoverSnapshotBundle(finalBundleDir, {
      authRaw: finalAuthRaw,
      persistentRaw: finalPersistentRaw,
    });
    verifyCutoverSnapshotBundle(finalBundleDir);
    const finalStage = await stagePostgresCutover(pool, {
      authRaw: finalAuthRaw,
      persistentRaw: finalPersistentRaw,
      cryptoConfig,
      externalBundleSha256: finalBundle.bundle_sha256,
    });

    await assert.rejects(
      () => commitStagedPostgresCutover(pool, {
        expectedSnapshotSha256: finalStage.snapshot.manifest_sha256,
        expectedExternalBundleSha256: 'f'.repeat(64),
        currentAuthRaw: finalAuthRaw,
        currentPersistentRaw: finalPersistentRaw,
      }),
      /external bundle digest/,
    );

    const committed = await commitStagedPostgresCutover(pool, {
      expectedSnapshotSha256: finalStage.snapshot.manifest_sha256,
      expectedExternalBundleSha256: finalBundle.bundle_sha256,
      currentAuthRaw: finalAuthRaw,
      currentPersistentRaw: finalPersistentRaw,
    });
    assert.equal(committed.state, 'READY');
    assert.equal(committed.snapshotSha256, finalStage.snapshot.manifest_sha256);
    await assertCutoverReady(pool, finalStage.snapshot.manifest_sha256);
    await assert.rejects(() => assertCutoverReady(pool, 'f'.repeat(64)), /does not match/);
    const stageCountAfterCommit = await pool.query('SELECT count(*)::int n FROM control_plane_cutover_stages');
    assert.equal(stageCountAfterCommit.rows[0].n, 0);

    const runtime = new PostgresControlPlaneRuntime({
      pool,
      expectedSnapshotSha256: finalStage.snapshot.manifest_sha256,
      cryptoConfig,
    });
    const initial = await runtime.initialize();
    assert.equal(initial.auth.users.length, 1);
    assert.equal(initial.auth.users[0].email, 'final-before-switch@example.com');
    assert.equal(initial.auth.users[0].mfaSecret, 'JBSWY3DPEHPK3PXP');
    assert.equal(initial.auth.users[0].providers.google.accessToken, 'access-before');
    assert.equal(initial.auth.users[0].providers.google.refreshToken, 'refresh-before');
    assert.equal(initial.auth.users[0].providers.google.name, 'Cutover User');
    assert.equal(initial.auth.sessions[sessionA].userId, 'usr_cutover_1');
    assert.equal(initial.persistent.messageRedirects['installation-cutover:101'], 102);

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
    delete afterPersistent.pendingTopicDeletes['installation-cutover:beat-old'];
    afterPersistent.messageRedirects['installation-cutover:102'] = 103;
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
    assert.equal(persistedState.messageRedirects['installation-cutover:102'], 103);

    await assert.rejects(() => assertJsonRollbackSnapshot(pool, '', {
      authRaw: finalAuthRaw,
      persistentRaw: finalPersistentRaw,
    }), /refused while PostgreSQL cutover is READY/);

    const rollback = await exportCurrentPostgresForRollback(pool, { cryptoConfig });
    assert.equal(rollback.auth.users[0].email, 'after@example.com');
    assert.equal(rollback.auth.sessions[sessionB].userId, 'usr_cutover_1');
    assert.equal(rollback.auth.sessions[sessionA], undefined);
    assert.equal(rollback.persistent.messageRedirects['installation-cutover:102'], 103);
    assert.match(rollback.snapshot.manifest_sha256, /^[0-9a-f]{64}$/);

    const committedRollback = await commitPostgresRollback(pool, {
      originalCutoverSnapshotSha256: finalStage.snapshot.manifest_sha256,
      rollbackExportSha256: rollback.snapshot.manifest_sha256,
    });
    assert.equal(committedRollback.state, 'ROLLED_BACK');
    assert.equal(committedRollback.rollback_export_sha256, rollback.snapshot.manifest_sha256);
    await assert.rejects(() => assertCutoverReady(pool, finalStage.snapshot.manifest_sha256), /ROLLED_BACK/);
    await assert.rejects(() => assertJsonRollbackSnapshot(pool, rollback.snapshot.manifest_sha256, {
      authRaw: finalAuthRaw,
      persistentRaw: finalPersistentRaw,
    }), /do not match/);
    const jsonRollback = await assertJsonRollbackSnapshot(pool, rollback.snapshot.manifest_sha256, {
      authRaw: rollback.authRaw,
      persistentRaw: rollback.persistentRaw,
    });
    assert.equal(jsonRollback.rollbackExportSha256, rollback.snapshot.manifest_sha256);

    console.log(JSON.stringify({
      postgres_cutover_proven: true,
      staged_before_ready_proven: true,
      external_snapshot_bundle_sealed: true,
      stale_final_delta_rejected: true,
      exact_final_snapshot_commit_required: true,
      import_twice_idempotent: true,
      oauth_mfa_envelope_roundtrip_proven: true,
      post_cutover_writes_persisted: true,
      blind_json_rollback_rejected: true,
      rollback_current_state_exported: true,
      rollback_exact_digest_required: true,
      json_disk_dual_write_used: false,
      production_kms_proven: false,
      production_pitr_proven: false,
      production_rpo_rto_proven: false,
    }));
    console.log('PASS PostgreSQL staged cutover + final delta + rollback integration');
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.end().catch(() => {});
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
