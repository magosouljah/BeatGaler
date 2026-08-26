'use strict';

const assert = require('assert');
const { Pool } = require('pg');
const { exportLegacyAccounts } = require('../legacy-exporter.js');
const { decryptSecretFromStorage } = require('../secret-envelope.js');

const connectionString = process.env.RESTORE_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/beatgaler_restore';
const pool = new Pool({ connectionString, ssl: false, application_name: 'beatgaler-restore-verifier' });
const key = Buffer.alloc(32, 9);
const unseal = (stored, { aad }) => decryptSecretFromStorage(stored, { resolveKey: () => key, aad });

async function main() {
  const started = Date.now();
  const ledger = await pool.query('SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version');
  assert.deepEqual(ledger.rows.map(row => row.version), ['0001', '0002', '0003', '0004']);
  assert(ledger.rows.every(row => /^[0-9a-f]{64}$/.test(row.checksum_sha256)));

  const counts = {};
  for (const table of ['users','auth_sessions','provider_identities','mfa_factors','vaults','direct_operations','index_observations','garbage_journal']) {
    counts[table] = (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  }
  assert(counts.users >= 7);
  assert.equal(counts.auth_sessions, 1);
  assert.equal(counts.provider_identities, 1);
  assert.equal(counts.mfa_factors, 1);
  assert(counts.direct_operations >= 2);
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

  const exported = await exportLegacyAccounts(pool, { decryptSecretFromStorage: unseal });
  assert(exported.users.some(user => user.id === 'postcut-u2'), 'restored rollback export must retain post-cutover write');
  const u1 = exported.users.find(user => user.id === 'live-u1');
  assert.equal(u1.providers.google.accessToken, 'LIVE-ACCESS-SECRET');
  assert.equal(u1.mfaSecret, 'LIVE-TOTP-SECRET');

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
    index_authority_observation_retained: true,
    cutover_stage_schema_retained: true,
  }));
}

main()
  .finally(() => pool.end())
  .catch(error => { console.error(error); process.exitCode = 1; });
