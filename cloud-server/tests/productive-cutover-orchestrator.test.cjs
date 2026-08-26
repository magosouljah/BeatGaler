'use strict';

const assert = require('assert');
const { runProductiveCutover } = require('../productive-cutover-orchestrator.js');
const { snapshotManifest } = require('../legacy-import-plan.js');

function validState(email = 'before@example.com') {
  return {
    authRaw: JSON.stringify({
      users: [{ id: 'u1', email, providers: {}, planState: { basePlanId: 'free', grants: [] } }],
      sessions: {},
    }),
    persistentRaw: JSON.stringify({
      linkedAccounts: {
        install1: { beatgalerAccountId: 'u1' },
      },
      uploadedFiles: {}, beatTopics: {}, pendingTopicDeletes: {}, messageRedirects: {},
    }),
  };
}

function manifest(state) {
  return snapshotManifest({
    'accounts-data.json': state.authRaw,
    'cloud-data.json': state.persistentRaw,
  });
}

async function happyPathWithDelta() {
  const before = validState('before@example.com');
  const frozen = validState('after@example.com');
  const reads = [before, frozen];
  const releases = [];
  const switches = [];

  const result = await runProductiveCutover({
    pool: { query: async () => ({ rows: [] }) },
    cryptoConfig: { key: Buffer.alloc(32), keyVersion: 1 },
    readLegacyState: async () => reads.shift(),
    captureImmutableSnapshot: async ({ manifest: captured }) => ({
      immutable: true,
      location: 'immutable://snapshot-001',
      manifestSha256: captured.manifest_sha256,
      capturedAt: '2026-08-26T19:10:00Z',
    }),
    enterWriteFreeze: async () => ({
      id: 'freeze-001',
      release: async info => releases.push(info),
    }),
    prepareCutover: async (_pool, { authRaw, persistentRaw }) => ({
      snapshot: snapshotManifest({ 'accounts-data.json': authRaw, 'cloud-data.json': persistentRaw }),
    }),
    commitAuthoritySwitch: async payload => {
      switches.push(payload);
      return { committed: true };
    },
  });

  assert.equal(result.switchCommitted, true);
  assert.equal(result.deltaChanged, true);
  assert.equal(result.sourceSnapshotSha256, manifest(before).manifest_sha256);
  assert.equal(result.finalSnapshotSha256, manifest(frozen).manifest_sha256);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].expectedSnapshotSha256, result.finalSnapshotSha256);
  assert.equal(switches[0].sourceSnapshotSha256, result.sourceSnapshotSha256);
  assert.equal(switches[0].deltaChanged, true);
  assert.deepEqual(releases, [{ reason: 'authority_switched' }]);
}

async function immutableProofMustMatch() {
  const before = validState();
  let freezeEntered = false;
  await assert.rejects(() => runProductiveCutover({
    pool: { query: async () => ({ rows: [] }) },
    readLegacyState: async () => before,
    captureImmutableSnapshot: async () => ({
      immutable: true,
      location: 'immutable://wrong',
      manifestSha256: 'f'.repeat(64),
    }),
    enterWriteFreeze: async () => { freezeEntered = true; return { id: 'never', release: async () => {} }; },
    commitAuthoritySwitch: async () => ({ committed: true }),
  }), /does not match/);
  assert.equal(freezeEntered, false, 'freeze must not start until immutable snapshot proof matches');
}

async function invalidFrozenStateIsQuarantinedBeforeMutation() {
  const before = validState();
  const invalid = {
    authRaw: JSON.stringify({ users: [{ id: 'u1' }], sessions: {} }),
    persistentRaw: JSON.stringify({ linkedAccounts: { install1: {} } }),
  };
  const reads = [before, invalid];
  const quarantined = [];
  const releases = [];
  let prepared = false;

  await assert.rejects(() => runProductiveCutover({
    pool: { query: async () => ({ rows: [] }) },
    readLegacyState: async () => reads.shift(),
    captureImmutableSnapshot: async ({ manifest: captured }) => ({
      immutable: true, location: 'immutable://snapshot-002', manifestSha256: captured.manifest_sha256,
    }),
    enterWriteFreeze: async () => ({ id: 'freeze-002', release: async info => releases.push(info) }),
    writeQuarantineRecord: async record => quarantined.push(record),
    prepareCutover: async () => { prepared = true; throw new Error('must not run'); },
    commitAuthoritySwitch: async () => ({ committed: true }),
  }), /missing beatgalerAccountId/);

  assert.equal(prepared, false);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].stage, 'frozen-validation');
  assert.equal(quarantined[0].error.code, 'CUTOVER_VALIDATION_FAILED');
  assert.deepEqual(releases, [{ reason: 'validation_failed' }]);
}

async function prepareFailureReleasesFreeze() {
  const before = validState();
  const reads = [before, before];
  const releases = [];
  await assert.rejects(() => runProductiveCutover({
    pool: { query: async () => ({ rows: [] }) },
    readLegacyState: async () => reads.shift(),
    captureImmutableSnapshot: async ({ manifest: captured }) => ({
      immutable: true, location: 'immutable://snapshot-003', manifestSha256: captured.manifest_sha256,
    }),
    enterWriteFreeze: async () => ({ id: 'freeze-003', release: async info => releases.push(info) }),
    prepareCutover: async () => { throw new Error('postgres unavailable'); },
    commitAuthoritySwitch: async () => ({ committed: true }),
  }), /postgres unavailable/);
  assert.deepEqual(releases, [{ reason: 'cutover_aborted' }]);
}

async function switchFailureKeepsFreezeHeldAfterPgReady() {
  const before = validState();
  const reads = [before, before];
  const releases = [];
  let thrown;
  try {
    await runProductiveCutover({
      pool: { query: async () => ({ rows: [] }) },
      readLegacyState: async () => reads.shift(),
      captureImmutableSnapshot: async ({ manifest: captured }) => ({
        immutable: true, location: 'immutable://snapshot-004', manifestSha256: captured.manifest_sha256,
      }),
      enterWriteFreeze: async () => ({ id: 'freeze-004', release: async info => releases.push(info) }),
      prepareCutover: async (_pool, { authRaw, persistentRaw }) => ({
        snapshot: snapshotManifest({ 'accounts-data.json': authRaw, 'cloud-data.json': persistentRaw }),
      }),
      commitAuthoritySwitch: async () => ({ committed: false }),
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown);
  assert.match(thrown.message, /not explicitly confirmed/);
  assert.equal(thrown.freezeMustRemainHeld, true);
  assert.deepEqual(releases, [], 'freeze must remain held after PG READY if authority switch is not committed');
}

(async () => {
  await happyPathWithDelta();
  await immutableProofMustMatch();
  await invalidFrozenStateIsQuarantinedBeforeMutation();
  await prepareFailureReleasesFreeze();
  await switchFailureKeepsFreezeHeldAfterPgReady();
  console.log('PASS productive-cutover-orchestrator');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
