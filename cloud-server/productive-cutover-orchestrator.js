'use strict';

const { parseLegacyJson, planLegacyImport, snapshotManifest } = require('./legacy-import-plan');
const { preparePostgresCutover } = require('./postgres-cutover-preparation');

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new Error(`${label} callback is required.`);
}

function readAndValidateLegacyState(state, label) {
  if (!state || typeof state !== 'object') throw new Error(`${label} legacy state is required.`);
  const authRaw = String(state.authRaw ?? '');
  const persistentRaw = String(state.persistentRaw ?? '');
  const auth = parseLegacyJson(authRaw, `${label}:accounts-data.json`);
  const persistent = parseLegacyJson(persistentRaw, `${label}:cloud-data.json`);
  const plan = planLegacyImport(auth, persistent);
  const snapshot = snapshotManifest({
    'accounts-data.json': authRaw,
    'cloud-data.json': persistentRaw,
  });
  return Object.freeze({ authRaw, persistentRaw, auth, persistent, plan, snapshot });
}

function assertImmutableSnapshotProof(proof, expectedManifestSha256) {
  if (!proof || typeof proof !== 'object') throw new Error('Immutable external snapshot proof is required.');
  if (proof.immutable !== true) throw new Error('External snapshot must be explicitly immutable.');
  if (!String(proof.location || '').trim()) throw new Error('External snapshot location is required.');
  if (!/^[0-9a-f]{64}$/.test(String(proof.manifestSha256 || ''))) {
    throw new Error('External snapshot manifest SHA256 is invalid.');
  }
  if (String(proof.manifestSha256) !== String(expectedManifestSha256)) {
    throw new Error('External snapshot proof does not match the captured pre-freeze legacy state.');
  }
  return Object.freeze({
    location: String(proof.location),
    immutable: true,
    manifestSha256: String(proof.manifestSha256),
    capturedAt: proof.capturedAt == null ? null : String(proof.capturedAt),
  });
}

function assertFreezeLease(lease) {
  if (!lease || typeof lease !== 'object') throw new Error('Write-freeze lease is required.');
  if (!String(lease.id || '').trim()) throw new Error('Write-freeze lease id is required.');
  assertFunction(lease.release, 'write-freeze release');
  return lease;
}

function redactedError(error) {
  const code = String(error?.code || 'CUTOVER_VALIDATION_FAILED').replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 80);
  return Object.freeze({ code });
}

async function runProductiveCutover({
  pool,
  cryptoConfig,
  readLegacyState,
  captureImmutableSnapshot,
  enterWriteFreeze,
  commitAuthoritySwitch,
  writeQuarantineRecord = async () => {},
  prepareCutover = preparePostgresCutover,
} = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool is required.');
  assertFunction(readLegacyState, 'readLegacyState');
  assertFunction(captureImmutableSnapshot, 'captureImmutableSnapshot');
  assertFunction(enterWriteFreeze, 'enterWriteFreeze');
  assertFunction(commitAuthoritySwitch, 'commitAuthoritySwitch');
  assertFunction(writeQuarantineRecord, 'writeQuarantineRecord');
  assertFunction(prepareCutover, 'prepareCutover');

  const preFreeze = readAndValidateLegacyState(await readLegacyState(), 'pre-freeze');
  const snapshotProof = assertImmutableSnapshotProof(
    await captureImmutableSnapshot({
      authRaw: preFreeze.authRaw,
      persistentRaw: preFreeze.persistentRaw,
      manifest: preFreeze.snapshot,
    }),
    preFreeze.snapshot.manifest_sha256,
  );

  const freeze = assertFreezeLease(await enterWriteFreeze({
    sourceSnapshotSha256: preFreeze.snapshot.manifest_sha256,
  }));
  let freezeReleased = false;
  let postgresReady = false;

  const releaseFreeze = async reason => {
    if (freezeReleased) return;
    freezeReleased = true;
    await freeze.release({ reason });
  };

  try {
    let frozen;
    try {
      frozen = readAndValidateLegacyState(await readLegacyState(), 'frozen');
    } catch (error) {
      await writeQuarantineRecord({
        stage: 'frozen-validation',
        sourceSnapshotSha256: preFreeze.snapshot.manifest_sha256,
        error: redactedError(error),
      });
      await releaseFreeze('validation_failed');
      throw error;
    }

    const prepared = await prepareCutover(pool, {
      authRaw: frozen.authRaw,
      persistentRaw: frozen.persistentRaw,
      cryptoConfig,
    });
    if (!prepared?.snapshot?.manifest_sha256 || prepared.snapshot.manifest_sha256 !== frozen.snapshot.manifest_sha256) {
      throw new Error('PostgreSQL READY snapshot does not match the frozen final legacy state.');
    }
    postgresReady = true;

    const switchResult = await commitAuthoritySwitch({
      authority: 'postgres',
      expectedSnapshotSha256: frozen.snapshot.manifest_sha256,
      sourceSnapshotSha256: preFreeze.snapshot.manifest_sha256,
      immutableSnapshot: snapshotProof,
      writeFreezeId: String(freeze.id),
      deltaChanged: frozen.snapshot.manifest_sha256 !== preFreeze.snapshot.manifest_sha256,
    });
    if (!switchResult || switchResult.committed !== true) {
      const error = new Error('Authority switch commit was not explicitly confirmed.');
      error.code = 'CUTOVER_SWITCH_NOT_COMMITTED';
      throw error;
    }

    await releaseFreeze('authority_switched');
    return Object.freeze({
      authority: 'postgres',
      sourceSnapshotSha256: preFreeze.snapshot.manifest_sha256,
      finalSnapshotSha256: frozen.snapshot.manifest_sha256,
      deltaChanged: frozen.snapshot.manifest_sha256 !== preFreeze.snapshot.manifest_sha256,
      immutableSnapshot: snapshotProof,
      writeFreezeId: String(freeze.id),
      switchCommitted: true,
    });
  } catch (error) {
    if (!postgresReady) {
      await releaseFreeze('cutover_aborted').catch(() => {});
    } else if (!freezeReleased) {
      error.freezeMustRemainHeld = true;
    }
    throw error;
  }
}

module.exports = {
  runProductiveCutover,
  assertImmutableSnapshotProof,
  readAndValidateLegacyState,
};
