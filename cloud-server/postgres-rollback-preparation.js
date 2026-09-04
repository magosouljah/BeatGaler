'use strict';

const { exportLegacyAccounts } = require('./legacy-exporter');
const { buildLegacyRows } = require('./legacy-import-executor');
const { snapshotManifest, planLegacyImport } = require('./legacy-import-plan');
const { encryptionCallbacks, loadPersistentSnapshot, CUTOVER_ID } = require('./postgres-control-plane-runtime');

async function exportCurrentPostgresForRollback(pool, { cryptoConfig }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool is required.');
  const marker = await pool.query('SELECT snapshot_sha256,state FROM control_plane_cutovers WHERE id=$1', [CUTOVER_ID]);
  if (marker.rows.length !== 1 || marker.rows[0].state !== 'READY') {
    throw new Error('Rollback export requires an active READY PostgreSQL cutover marker.');
  }

  const decrypt = encryptionCallbacks(cryptoConfig).decrypt;
  const auth = await exportLegacyAccounts(pool, { decryptSecretFromStorage: decrypt });
  const persistent = await loadPersistentSnapshot(pool);

  // Validate that the exported account state can be consumed by the legacy
  // importer before any rollback can be committed.
  buildLegacyRows(auth);
  const plan = planLegacyImport(auth, persistent);
  const authRaw = JSON.stringify(auth, null, 2);
  const persistentRaw = JSON.stringify(persistent, null, 2);
  const snapshot = snapshotManifest({
    'accounts-data.json': authRaw,
    'cloud-data.json': persistentRaw,
  });

  return Object.freeze({
    originalCutoverSnapshotSha256: marker.rows[0].snapshot_sha256,
    auth,
    persistent,
    authRaw,
    persistentRaw,
    plan,
    snapshot,
  });
}

async function commitPostgresRollback(pool, { originalCutoverSnapshotSha256, rollbackExportSha256 }) {
  const result = await pool.query(`UPDATE control_plane_cutovers
    SET state='ROLLED_BACK', rollback_export_sha256=$3, updated_at=now()
    WHERE id=$1 AND state='READY' AND snapshot_sha256=$2
    RETURNING snapshot_sha256,rollback_export_sha256,state`,
  [CUTOVER_ID, originalCutoverSnapshotSha256, rollbackExportSha256]);
  if (result.rows.length !== 1) {
    throw new Error('Rollback commit refused because the active cutover marker changed or is not READY.');
  }
  return Object.freeze(result.rows[0]);
}

async function assertJsonRollbackSnapshot(pool, expectedRollbackSha256, { authRaw, persistentRaw }) {
  const result = await pool.query(
    'SELECT state,rollback_export_sha256 FROM control_plane_cutovers WHERE id=$1',
    [CUTOVER_ID],
  );
  if (!result.rows.length) return Object.freeze({ cutover: false });
  const marker = result.rows[0];
  if (marker.state === 'READY') {
    throw new Error('JSON authority is refused while PostgreSQL cutover is READY. Export current PostgreSQL state and commit rollback first.');
  }
  if (marker.state !== 'ROLLED_BACK') throw new Error(`Unsupported cutover state: ${marker.state}.`);
  if (!expectedRollbackSha256 || String(marker.rollback_export_sha256) !== String(expectedRollbackSha256)) {
    throw new Error('JSON rollback SHA256 does not match the committed PostgreSQL rollback export.');
  }
  const actual = snapshotManifest({
    'accounts-data.json': String(authRaw),
    'cloud-data.json': String(persistentRaw),
  }).manifest_sha256;
  if (actual !== expectedRollbackSha256) {
    throw new Error('Legacy JSON files do not match the committed PostgreSQL rollback export SHA256.');
  }
  return Object.freeze({ cutover: true, rollbackExportSha256: actual });
}

module.exports = {
  exportCurrentPostgresForRollback,
  commitPostgresRollback,
  assertJsonRollbackSnapshot,
};
