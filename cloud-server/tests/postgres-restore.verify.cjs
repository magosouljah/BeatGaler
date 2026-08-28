'use strict';

const assert = require('assert');
const { Pool } = require('pg');
const { exportLegacyAccounts } = require('../legacy-exporter.js');
const { decryptSecretFromStorage } = require('../secret-envelope.js');
const { rotateStoredControlPlaneSecrets } = require('../postgres-secret-rotation.js');

const connectionString = process.env.RESTORE_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/beatgaler_restore';
const pool = new Pool({ connectionString, ssl: false, application_name: 'beatgaler-restore-verifier' });
const key = Buffer.alloc(32, 9);
const keyVersion = 7;
const unseal = (stored, { aad }) => decryptSecretFromStorage(stored, { resolveKey: () => key, aad });

async function main() {
  const started = Date.now();
  const ledger = await pool.query('SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version');
  assert.deepEqual(ledger.rows.map(row => row.version), ['0001', '0002', '0003', '0004', '0005']);
  assert(ledger.rows.every(row => /^[0-9a-f]{64}$/.test(row.checksum_sha256)));

  const counts = {};
  for (const table of ['users','auth_sessions','provider_identities','mfa_factors','vaults','direct_operations','direct_capabilities','index_observations','garbage_journal']) {
    counts[table] = (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  }
  assert(counts.users >= 7);
  assert.equal(counts.auth_sessions, 1);
  assert.equal(counts.provider_identities, 1);
  assert.equal(counts.mfa_factors, 1);
  assert(counts.direct_operations >= 2);
  assert.equal(counts.direct_capabilities, 0);
  assert.equal(counts.index_observations, 1);
  assert(counts.garbage_journal >= 2);

  const stageTable = await pool.query("SELECT to_regclass('public.control_plane_cutover_stages') AS name");
  assert.equal(stageTable.rows[0].name, 'control_plane_cutover_stages');

  const observation = (await pool.query("SELECT manifest_sha256,revision FROM index_observations WHERE revision='rev-2'")).rows[0];
  assert(observation);
  assert.equal(observation.manifest_sha256, 'c'.repeat(64));

  const orphan = (await pool.query("SELECT state,index_commit_ref FROM garbage_journal WHERE object_id='message-orphan'")).rows[0];
  assert(orphan);
  assert.equal(orphan.index_commit_ref, 'c'.repeat(64));

  // A stolen/restored database contains ciphertext, nonce and key version only.
  // Without the external key material, authenticated decryption must fail closed.
  const providerRaw = (await pool.query(`SELECT user_id,provider,access_token_ciphertext,access_token_nonce,
    refresh_token_ciphertext,refresh_token_nonce,secret_key_version FROM provider_identities LIMIT 1`)).rows[0];
  const mfaRaw = (await pool.query(`SELECT user_id,secret_ciphertext,secret_nonce,secret_key_version
    FROM mfa_factors LIMIT 1`)).rows[0];
  assert(Buffer.isBuffer(providerRaw.access_token_ciphertext));
  assert(Buffer.isBuffer(providerRaw.refresh_token_ciphertext));
  assert(Buffer.isBuffer(mfaRaw.secret_ciphertext));
  assert(!providerRaw.access_token_ciphertext.includes(Buffer.from('LIVE-ACCESS-SECRET')));
  assert(!providerRaw.refresh_token_ciphertext.includes(Buffer.from('LIVE-REFRESH-SECRET')));
  assert(!mfaRaw.secret_ciphertext.includes(Buffer.from('LIVE-TOTP-SECRET')));
  assert.equal(providerRaw.secret_key_version, keyVersion);
  assert.equal(mfaRaw.secret_key_version, keyVersion);

  const wrongKey = Buffer.alloc(32, 3);
  assert.throws(() => decryptSecretFromStorage({
    ciphertext: providerRaw.access_token_ciphertext,
    nonce: providerRaw.access_token_nonce,
    keyVersion: providerRaw.secret_key_version,
  }, {
    aad: `provider:${providerRaw.provider}:${providerRaw.user_id}:access`,
    resolveKey: () => wrongKey,
  }));
  assert.throws(() => decryptSecretFromStorage({
    ciphertext: mfaRaw.secret_ciphertext,
    nonce: mfaRaw.secret_nonce,
    keyVersion: mfaRaw.secret_key_version,
  }, {
    aad: `mfa:${mfaRaw.user_id}:totp`,
    resolveKey: () => { throw new Error('KMS unavailable'); },
  }), /KMS unavailable/);

  const exported = await exportLegacyAccounts(pool, { decryptSecretFromStorage: unseal });
  assert(exported.users.some(user => user.id === 'postcut-u2'), 'restored rollback export must retain post-cutover write');
  const u1 = exported.users.find(user => user.id === 'live-u1');
  assert.equal(u1.providers.google.accessToken, 'LIVE-ACCESS-SECRET');
  assert.equal(u1.mfaSecret, 'LIVE-TOTP-SECRET');

  // Rotate the restored database under transaction from key version 7 to 8.
  // The old key remains source-only; every stored OAuth/MFA secret must leave the transaction on v8.
  const nextKey = Buffer.alloc(32, 10);
  const rotation = await rotateStoredControlPlaneSecrets(pool, {
    sourceKeyring: { key, keyVersion },
    targetKeyring: { key: nextKey, keyVersion: 8 },
  });
  assert.equal(rotation.activeKeyVersion, 8);
  assert.equal(rotation.providerRows, 1);
  assert.equal(rotation.providerSecrets, 2);
  assert.equal(rotation.mfaRows, 1);

  const rotatedProvider = (await pool.query(`SELECT user_id,provider,access_token_ciphertext,access_token_nonce,
    refresh_token_ciphertext,refresh_token_nonce,secret_key_version FROM provider_identities LIMIT 1`)).rows[0];
  const rotatedMfa = (await pool.query(`SELECT user_id,secret_ciphertext,secret_nonce,secret_key_version FROM mfa_factors LIMIT 1`)).rows[0];
  assert.equal(rotatedProvider.secret_key_version, 8);
  assert.equal(rotatedMfa.secret_key_version, 8);
  assert.notDeepEqual(rotatedProvider.access_token_ciphertext, providerRaw.access_token_ciphertext);
  assert.notDeepEqual(rotatedMfa.secret_ciphertext, mfaRaw.secret_ciphertext);

  await assert.rejects(
    () => exportLegacyAccounts(pool, { decryptSecretFromStorage: unseal }),
    /authenticate|unable|Unsupported|key|decrypt/i,
  );
  const rotatedUnseal = (stored, { aad }) => decryptSecretFromStorage(stored, {
    aad,
    resolveKey: version => {
      if (Number(version) !== 8) throw new Error(`unexpected key version ${version}`);
      return nextKey;
    },
  });
  const rotatedExport = await exportLegacyAccounts(pool, { decryptSecretFromStorage: rotatedUnseal });
  const rotatedU1 = rotatedExport.users.find(user => user.id === 'live-u1');
  assert.equal(rotatedU1.providers.google.accessToken, 'LIVE-ACCESS-SECRET');
  assert.equal(rotatedU1.providers.google.refreshToken, 'LIVE-REFRESH-SECRET');
  assert.equal(rotatedU1.mfaSecret, 'LIVE-TOTP-SECRET');

  // A failed follow-up rotation must roll back every row rather than leaving mixed versions.
  const beforeFailedRotation = await Promise.all([
    pool.query('SELECT id,access_token_ciphertext,access_token_nonce,refresh_token_ciphertext,refresh_token_nonce,secret_key_version FROM provider_identities ORDER BY id'),
    pool.query('SELECT id,secret_ciphertext,secret_nonce,secret_key_version FROM mfa_factors ORDER BY id'),
  ]);
  await assert.rejects(
    () => rotateStoredControlPlaneSecrets(pool, {
      sourceKeyring: { key: Buffer.alloc(32, 99), keyVersion: 8 },
      targetKeyring: { key: Buffer.alloc(32, 11), keyVersion: 9 },
    }),
  );
  const afterFailedRotation = await Promise.all([
    pool.query('SELECT id,access_token_ciphertext,access_token_nonce,refresh_token_ciphertext,refresh_token_nonce,secret_key_version FROM provider_identities ORDER BY id'),
    pool.query('SELECT id,secret_ciphertext,secret_nonce,secret_key_version FROM mfa_factors ORDER BY id'),
  ]);
  assert.deepEqual(afterFailedRotation[0].rows, beforeFailedRotation[0].rows);
  assert.deepEqual(afterFailedRotation[1].rows, beforeFailedRotation[1].rows);

  await assert.rejects(
    () => pool.query("INSERT INTO entitlements(id,user_id,plan_id,source,starts_at) VALUES('restore-bad-plan','live-u1','impossible','restore-test',now())"),
    error => error && error.code === '23514',
  );
  await assert.rejects(
    () => pool.query("INSERT INTO auth_sessions(session_key_hash,user_id,created_at,expires_at) VALUES('short','live-u1',now(),now()+interval '1 hour')"),
    error => error && error.code === '23514',
  );

  console.log(JSON.stringify({
    restore_verified: true,
    schema_versions: ledger.rows.map(row => row.version),
    counts,
    verification_elapsed_ms: Date.now() - started,
    post_cutover_write_retained: true,
    recoverable_secret_roundtrip: true,
    stolen_db_without_kms_plaintext_exposure: false,
    wrong_or_missing_kms_key_rejected: true,
    secret_key_rotation_7_to_8_proven: true,
    failed_rotation_atomic_rollback_proven: true,
    index_authority_observation_retained: true,
    cutover_stage_schema_retained: true,
    direct_capability_schema_retained: true,
  }));
}

main()
  .finally(() => pool.end())
  .catch(error => { console.error(error); process.exitCode = 1; });
