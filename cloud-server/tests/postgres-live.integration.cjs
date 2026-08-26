'use strict';

const assert = require('assert');
const { Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations.js');
const { createPostgresPool } = require('../postgres-runtime-config.js');
const { importLegacyControlPlane, buildLegacyRows } = require('../legacy-import-executor.js');
const { exportLegacyAccounts } = require('../legacy-exporter.js');
const { encryptSecretForStorage, decryptSecretFromStorage } = require('../secret-envelope.js');
const {
  beginDirectOperation,
  recordExternalEffect,
  markIndexCommitted,
  markOperationCommitted,
} = require('../direct-operation-repository.js');
const {
  reconcileIndexObservation,
  discoverOrphanUploads,
} = require('../index-reconciliation.js');
const {
  enqueueGarbage,
  claimGarbageBatch,
  markGarbageDone,
} = require('../garbage-journal-repository.js');

const env = {
  ...process.env,
  BEATGALER_POSTGRES_ENABLED: 'true',
  BEATGALER_POSTGRES_SSL_MODE: 'disable',
  BEATGALER_POSTGRES_POOL_MAX: '8',
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/beatgaler_ci',
};

const poolA = createPostgresPool(Pool, env);
const poolB = createPostgresPool(Pool, env);
const key = Buffer.alloc(32, 9);
const seal = (plaintext, { aad }) => encryptSecretForStorage(plaintext, { key, keyVersion: 7, aad });
const unseal = (stored, { aad }) => decryptSecretFromStorage(stored, { resolveKey: () => key, aad });

async function main() {
  await poolA.query('DROP SCHEMA public CASCADE');
  await poolA.query('CREATE SCHEMA public');

  const [raceA, raceB] = await Promise.all([
    applyMigrations(poolA),
    applyMigrations(poolB),
  ]);
  const appliedTotal = raceA.applied.length + raceB.applied.length;
  assert.equal(appliedTotal, 2, 'exactly two migrations should be applied across racing runners');
  assert.equal(raceA.skipped.length + raceB.skipped.length, 2, 'the second runner should skip already-applied migrations');

  const third = await applyMigrations(poolA);
  assert.deepEqual(third.applied, []);
  assert.deepEqual(third.skipped, ['0001', '0002']);

  const ledger = await poolA.query('SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version');
  assert.deepEqual(ledger.rows.map(row => row.version), ['0001', '0002']);
  assert(ledger.rows.every(row => /^[0-9a-f]{64}$/.test(row.checksum_sha256)));

  const auth = {
    users: [{
      id: 'live-u1',
      username: 'liveproducer',
      usernameSource: 'beatgaler',
      email: 'live@example.com',
      passwordSalt: '11'.repeat(16),
      passwordHash: '22'.repeat(64),
      createdAt: 1000,
      storageChatId: '-1005001',
      storageChatTitle: 'Live Vault',
      storageCreatedAt: 2000,
      mfaSecret: 'LIVE-TOTP-SECRET',
      providers: {
        google: {
          id: 'google-live-1',
          accessToken: 'LIVE-ACCESS-SECRET',
          refreshToken: 'LIVE-REFRESH-SECRET',
          tokenExpiresAt: 999999,
        },
      },
      planState: { basePlanId: 'paid_entry', grants: [] },
    }],
    sessions: {
      ['a'.repeat(64)]: { userId: 'live-u1', createdAt: 1000, expiresAt: 900000 },
    },
  };

  const countsA = await importLegacyControlPlane(poolA, auth, { encryptSecretForStorage: seal });
  const countsB = await importLegacyControlPlane(poolA, auth, { encryptSecretForStorage: seal });
  assert.deepEqual(countsA, countsB, 're-import must be deterministic in row counts');

  const users = await poolA.query('SELECT id, username, password_hash, password_salt FROM users WHERE id=$1', ['live-u1']);
  assert.equal(users.rows.length, 1);
  assert.equal(users.rows[0].username, 'liveproducer');
  assert.equal(users.rows[0].password_hash, '22'.repeat(64));
  assert.equal(users.rows[0].password_salt, '11'.repeat(16));

  const sessions = await poolA.query('SELECT session_key_hash FROM auth_sessions WHERE user_id=$1', ['live-u1']);
  assert.equal(sessions.rows.length, 1);
  assert.equal(sessions.rows[0].session_key_hash, 'a'.repeat(64));

  const provider = (await poolA.query(`SELECT access_token_ciphertext, access_token_nonce, refresh_token_ciphertext,
      refresh_token_nonce, secret_key_version FROM provider_identities WHERE user_id=$1`, ['live-u1'])).rows[0];
  assert(Buffer.isBuffer(provider.access_token_ciphertext));
  assert(!provider.access_token_ciphertext.includes(Buffer.from('LIVE-ACCESS-SECRET')));
  assert.equal(decryptSecretFromStorage({
    ciphertext: provider.access_token_ciphertext,
    nonce: provider.access_token_nonce,
    keyVersion: provider.secret_key_version,
  }, { resolveKey: () => key, aad: 'provider:google:live-u1:access' }), 'LIVE-ACCESS-SECRET');

  const mfa = (await poolA.query('SELECT secret_ciphertext, secret_nonce, secret_key_version FROM mfa_factors WHERE user_id=$1', ['live-u1'])).rows[0];
  assert.equal(decryptSecretFromStorage({
    ciphertext: mfa.secret_ciphertext,
    nonce: mfa.secret_nonce,
    keyVersion: mfa.secret_key_version,
  }, { resolveKey: () => key, aad: 'mfa:live-u1:totp' }), 'LIVE-TOTP-SECRET');

  const vault = (await poolA.query('SELECT id FROM vaults WHERE user_id=$1', ['live-u1'])).rows[0];
  const item = {
    id: 'gc-live-1', idempotency_key: 'gc-live-key-1', vault_id: vault.id,
    object_kind: 'media', object_id: 'message-777', reason: 'orphan_upload', index_commit_ref: 'index-rev-live-1',
  };
  await enqueueGarbage(poolA, item);
  await enqueueGarbage(poolA, item);
  assert.equal((await poolA.query('SELECT count(*)::int AS n FROM garbage_journal WHERE idempotency_key=$1', [item.idempotency_key])).rows[0].n, 1);

  const [claimedA, claimedB] = await Promise.all([
    claimGarbageBatch(poolA, { workerId: 'worker-a', limit: 1 }),
    claimGarbageBatch(poolB, { workerId: 'worker-b', limit: 1 }),
  ]);
  assert.equal(claimedA.length + claimedB.length, 1, 'SKIP LOCKED leasing must yield one worker');
  const winner = claimedA.length ? 'worker-a' : 'worker-b';
  await markGarbageDone(poolA, { id: 'gc-live-1', workerId: winner });
  assert.equal((await poolA.query('SELECT state FROM garbage_journal WHERE id=$1', ['gc-live-1'])).rows[0].state, 'done');

  // Pinned INDEX is supplied as the authority. Reconciliation only moves the PG observation to it.
  const indexHashA = 'b'.repeat(64);
  const indexHashB = 'c'.repeat(64);
  const firstObservation = await reconcileIndexObservation(poolA, {
    vaultId: vault.id, pinnedMessageId: 'index-msg-1', revision: 'rev-1', manifestSha256: indexHashA,
  });
  assert.equal(firstObservation.authority, 'pinned-index');
  assert.equal(firstObservation.changed, true);
  const secondObservation = await reconcileIndexObservation(poolA, {
    vaultId: vault.id, pinnedMessageId: 'index-msg-2', revision: 'rev-2', manifestSha256: indexHashB,
  });
  assert.equal(secondObservation.previous.manifest_sha256, indexHashA);
  assert.equal(secondObservation.current.manifest_sha256, indexHashB);

  // Crash-after-external-effect simulation: produced IDs survive, INDEX omits one, and only the old unreferenced ID becomes debt.
  await beginDirectOperation(poolA, {
    id: 'op-orphan-live', idempotencyKey: 'op-orphan-live-key', vaultId: vault.id, operationType: 'upload',
  });
  await recordExternalEffect(poolA, {
    idempotencyKey: 'op-orphan-live-key', producedObjectIds: ['message-kept', 'message-orphan'],
  });
  await poolA.query("UPDATE direct_operations SET updated_at=now()-interval '10 minutes' WHERE idempotency_key='op-orphan-live-key'");
  const discoveredA = await discoverOrphanUploads(poolA, {
    vaultId: vault.id,
    authoritativeObjectIds: ['message-kept'],
    indexCommitRef: indexHashB,
    safetyBefore: new Date(Date.now() - 5 * 60 * 1000),
  });
  const discoveredB = await discoverOrphanUploads(poolA, {
    vaultId: vault.id,
    authoritativeObjectIds: ['message-kept'],
    indexCommitRef: indexHashB,
    safetyBefore: new Date(Date.now() - 5 * 60 * 1000),
  });
  assert.equal(discoveredA.length, 1);
  assert.equal(discoveredB.length, 1, 'repeat discovery may return the same durable debt but must not duplicate it');
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM garbage_journal WHERE object_id='message-orphan'")).rows[0].n, 1);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM garbage_journal WHERE object_id='message-kept'")).rows[0].n, 0);

  // Normal saga transition is monotonic and replay-safe.
  await beginDirectOperation(poolA, {
    id: 'op-good-live', idempotencyKey: 'op-good-live-key', vaultId: vault.id, operationType: 'replace_asset',
  });
  await recordExternalEffect(poolA, { idempotencyKey: 'op-good-live-key', producedObjectIds: ['message-new'] });
  await markIndexCommitted(poolA, { idempotencyKey: 'op-good-live-key' });
  const committed = await markOperationCommitted(poolA, { idempotencyKey: 'op-good-live-key' });
  assert.equal(committed.state, 'COMMITTED');
  const committedReplay = await markOperationCommitted(poolA, { idempotencyKey: 'op-good-live-key' });
  assert.equal(committedReplay.state, 'COMMITTED');
  await assert.rejects(
    () => recordExternalEffect(poolA, { idempotencyKey: 'op-good-live-key', producedObjectIds: ['message-other'] }),
    /Illegal Direct operation transition/,
  );

  // Simulate an authoritative PG write after migration, then prove rollback export retains it and decrypts recoverable secrets.
  await poolA.query("INSERT INTO users(id,username,email,created_at,updated_at) VALUES('postcut-u2','postcut','postcut@example.com',now(),now())");
  await poolA.query("INSERT INTO entitlements(id,user_id,plan_id,source,starts_at) VALUES('postcut-ent','postcut-u2','highest_paid','base_plan',now())");
  const exported = await exportLegacyAccounts(poolA, { decryptSecretFromStorage: unseal });
  const exportedU1 = exported.users.find(user => user.id === 'live-u1');
  const exportedU2 = exported.users.find(user => user.id === 'postcut-u2');
  assert(exportedU1 && exportedU2, 'rollback export must retain pre- and post-cutover users');
  assert.equal(exportedU1.providers.google.accessToken, 'LIVE-ACCESS-SECRET');
  assert.equal(exportedU1.providers.google.refreshToken, 'LIVE-REFRESH-SECRET');
  assert.equal(exportedU1.mfaSecret, 'LIVE-TOTP-SECRET');
  assert.equal(exportedU2.planState.basePlanId, 'highest_paid');
  assert.equal(exported.sessions['a'.repeat(64)].userId, 'live-u1');
  const rollbackRows = buildLegacyRows(exported);
  assert.equal(rollbackRows.users.length, 2, 'legacy-compatible rollback state must validate through importer mapping');

  await poolA.query("INSERT INTO transport_bots(id) VALUES('bot-live-cap')");
  for (let i = 1; i <= 5; i += 1) {
    const userId = `cap-u${i}`;
    const vaultId = `cap-v${i}`;
    await poolA.query('INSERT INTO users(id, created_at, updated_at) VALUES($1, now(), now())', [userId]);
    await poolA.query('INSERT INTO vaults(id,user_id,telegram_chat_id,created_at,updated_at) VALUES($1,$2,$3,now(),now())', [vaultId, userId, `cap-chat-${i}`]);
    if (i <= 4) {
      await poolA.query(`INSERT INTO direct_leases(id,transport_bot_id,vault_id,installation_id,generation,credential_version,status,started_at,last_heartbeat_at)
        VALUES($1,'bot-live-cap',$2,$3,1,1,'ACTIVE',now(),now())`, [`cap-l${i}`, vaultId, `cap-install-${i}`]);
    } else {
      await assert.rejects(
        () => poolA.query(`INSERT INTO direct_leases(id,transport_bot_id,vault_id,installation_id,generation,credential_version,status,started_at,last_heartbeat_at)
          VALUES($1,'bot-live-cap',$2,$3,1,1,'ACTIVE',now(),now())`, [`cap-l${i}`, vaultId, `cap-install-${i}`]),
        /already has 4 active vault leases/,
      );
    }
  }

  console.log('PASS live PostgreSQL: migrations, encrypted import/export, INDEX reconciliation, orphan debt, saga states, garbage leasing, max-4 cap');
}

main()
  .finally(async () => { await Promise.allSettled([poolA.end(), poolB.end()]); })
  .catch(error => { console.error(error); process.exitCode = 1; });
