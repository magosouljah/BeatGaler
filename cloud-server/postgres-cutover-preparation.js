'use strict';

const { parseLegacyJson, snapshotManifest, planLegacyImport } = require('./legacy-import-plan');
const {
  CUTOVER_ID,
  replaceAuthSnapshot,
  replacePersistentSnapshot,
  loadAuthSnapshot,
  loadPersistentSnapshot,
} = require('./postgres-control-plane-runtime');

const COUNT_KEYS = Object.freeze([
  'users',
  'auth_sessions',
  'linked_accounts',
  'uploaded_files',
  'beat_topics',
  'pending_topic_deletes',
  'message_redirects',
]);

function validateSource({ authRaw, persistentRaw }) {
  const auth = parseLegacyJson(authRaw, 'accounts-data.json');
  const persistent = parseLegacyJson(persistentRaw, 'cloud-data.json');
  const plan = planLegacyImport(auth, persistent);
  const snapshot = snapshotManifest({
    'accounts-data.json': String(authRaw),
    'cloud-data.json': String(persistentRaw),
  });
  return { auth, persistent, plan, snapshot };
}

async function validateRoundTrip(pool, { plan, cryptoConfig }) {
  const [roundTripAuth, roundTripPersistent] = await Promise.all([
    loadAuthSnapshot(pool, cryptoConfig),
    loadPersistentSnapshot(pool),
  ]);
  const roundTripPlan = planLegacyImport(roundTripAuth, roundTripPersistent);
  for (const key of COUNT_KEYS) {
    if (Number(roundTripPlan.counts[key]) !== Number(plan.counts[key])) {
      throw new Error(`PostgreSQL cutover validation count mismatch for ${key}: expected ${plan.counts[key]}, got ${roundTripPlan.counts[key]}.`);
    }
  }
  return roundTripPlan;
}

async function assertNoActiveReadyCutover(pool) {
  const result = await pool.query('SELECT state FROM control_plane_cutovers WHERE id=$1', [CUTOVER_ID]);
  if (result.rows.length && result.rows[0].state === 'READY') {
    throw new Error('A READY PostgreSQL cutover already exists; staging replacement data is refused.');
  }
}

async function stagePostgresCutover(pool, { authRaw, persistentRaw, cryptoConfig, externalBundleSha256 = null }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool is required.');
  if (externalBundleSha256 != null && !/^[0-9a-f]{64}$/.test(String(externalBundleSha256))) {
    throw new Error('External cutover bundle SHA256 must be a lowercase 64-character hex digest.');
  }

  // Full source validation happens before any database mutation. Invalid input
  // belongs in the external quarantine workflow, never in a partial import.
  const validated = validateSource({ authRaw, persistentRaw });
  await assertNoActiveReadyCutover(pool);

  await replaceAuthSnapshot(pool, validated.auth, cryptoConfig);
  await replacePersistentSnapshot(pool, validated.persistent);
  const roundTripPlan = await validateRoundTrip(pool, { plan: validated.plan, cryptoConfig });

  await pool.query(`INSERT INTO control_plane_cutover_stages(id,snapshot_sha256,plan_sha256,external_bundle_sha256,staged_at,updated_at)
    VALUES($1,$2,$3,$4,now(),now())
    ON CONFLICT(id) DO UPDATE SET snapshot_sha256=EXCLUDED.snapshot_sha256, plan_sha256=EXCLUDED.plan_sha256,
      external_bundle_sha256=EXCLUDED.external_bundle_sha256, staged_at=now(), updated_at=now()`,
  [CUTOVER_ID, validated.snapshot.manifest_sha256, validated.plan.plan_sha256, externalBundleSha256]);

  return Object.freeze({
    snapshot: validated.snapshot,
    plan: validated.plan,
    roundTripPlan,
    externalBundleSha256,
    state: 'STAGED',
  });
}

async function commitStagedPostgresCutover(pool, {
  expectedSnapshotSha256,
  expectedExternalBundleSha256 = null,
  currentAuthRaw,
  currentPersistentRaw,
}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool is required.');
  const current = validateSource({ authRaw: currentAuthRaw, persistentRaw: currentPersistentRaw });
  if (String(current.snapshot.manifest_sha256) !== String(expectedSnapshotSha256)) {
    throw new Error('Final legacy source changed after staging; cutover commit is refused until the final delta is restaged.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const staged = await client.query(
      'SELECT snapshot_sha256,plan_sha256,external_bundle_sha256 FROM control_plane_cutover_stages WHERE id=$1 FOR UPDATE',
      [CUTOVER_ID],
    );
    if (staged.rows.length !== 1) throw new Error('PostgreSQL cutover stage is missing.');
    const row = staged.rows[0];
    if (String(row.snapshot_sha256) !== String(expectedSnapshotSha256)) {
      throw new Error('PostgreSQL staged snapshot does not match the expected final snapshot.');
    }
    if (String(row.plan_sha256) !== String(current.plan.plan_sha256)) {
      throw new Error('PostgreSQL staged import plan does not match the final legacy source.');
    }
    if (expectedExternalBundleSha256 != null && String(row.external_bundle_sha256 || '') !== String(expectedExternalBundleSha256)) {
      throw new Error('PostgreSQL staged external bundle digest does not match the expected sealed bundle.');
    }

    const existing = await client.query('SELECT state FROM control_plane_cutovers WHERE id=$1 FOR UPDATE', [CUTOVER_ID]);
    if (existing.rows.length && existing.rows[0].state === 'READY') {
      throw new Error('A READY PostgreSQL cutover already exists; duplicate authority commit is refused.');
    }

    await client.query(`INSERT INTO control_plane_cutovers(id,snapshot_sha256,state,rollback_export_sha256,prepared_at,updated_at)
      VALUES($1,$2,'READY',NULL,now(),now())
      ON CONFLICT(id) DO UPDATE SET snapshot_sha256=EXCLUDED.snapshot_sha256,state='READY',rollback_export_sha256=NULL,prepared_at=now(),updated_at=now()`,
    [CUTOVER_ID, expectedSnapshotSha256]);
    await client.query('DELETE FROM control_plane_cutover_stages WHERE id=$1', [CUTOVER_ID]);
    await client.query('COMMIT');
    return Object.freeze({
      state: 'READY',
      snapshotSha256: expectedSnapshotSha256,
      externalBundleSha256: row.external_bundle_sha256 || null,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function preparePostgresCutover(pool, { authRaw, persistentRaw, cryptoConfig }) {
  const staged = await stagePostgresCutover(pool, { authRaw, persistentRaw, cryptoConfig });
  await commitStagedPostgresCutover(pool, {
    expectedSnapshotSha256: staged.snapshot.manifest_sha256,
    currentAuthRaw: authRaw,
    currentPersistentRaw: persistentRaw,
  });
  return Object.freeze({ snapshot: staged.snapshot, plan: staged.plan, roundTripPlan: staged.roundTripPlan });
}

module.exports = {
  validateSource,
  stagePostgresCutover,
  commitStagedPostgresCutover,
  preparePostgresCutover,
};
