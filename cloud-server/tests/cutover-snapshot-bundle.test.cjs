'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createCutoverSnapshotBundle,
  verifyCutoverSnapshotBundle,
} = require('../cutover-snapshot-bundle.js');

function fixture() {
  return {
    authRaw: JSON.stringify({
      users: [{ id: 'usr_bundle_1', email: 'bundle@example.com' }],
      sessions: {},
    }, null, 2),
    persistentRaw: JSON.stringify({
      linkedAccounts: {
        'installation-bundle': { beatgalerAccountId: 'usr_bundle_1' },
      },
      uploadedFiles: {},
      beatTopics: {},
      pendingTopicDeletes: {},
      messageRedirects: {},
    }, null, 2),
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-cutover-bundle-'));
try {
  const validDir = path.join(root, 'valid');
  const created = createCutoverSnapshotBundle(validDir, fixture());
  assert.equal(created.status, 'SEALED');
  assert.match(created.bundle_sha256, /^[0-9a-f]{64}$/);
  const verified = verifyCutoverSnapshotBundle(validDir);
  assert.equal(verified.bundleSha256, created.bundle_sha256);
  assert.equal(verified.snapshot.manifest_sha256, created.snapshot_sha256);
  assert.equal(verified.plan.counts.users, 1);

  assert.throws(() => createCutoverSnapshotBundle(validDir, fixture()), /exist|EEXIST/i);

  fs.appendFileSync(path.join(validDir, 'accounts-data.json'), '\n ');
  assert.throws(() => verifyCutoverSnapshotBundle(validDir), /do not match/);

  const invalidDir = path.join(root, 'invalid');
  const invalid = fixture();
  invalid.persistentRaw = JSON.stringify({
    linkedAccounts: { broken: { beatgalerAccountId: 'missing-user' } },
  });
  assert.throws(() => createCutoverSnapshotBundle(invalidDir, invalid), /quarantined/i);
  assert.equal(fs.existsSync(path.join(invalidDir, 'QUARANTINED.json')), true);
  assert.equal(fs.existsSync(path.join(invalidDir, 'SEALED')), false);
  assert.throws(() => verifyCutoverSnapshotBundle(invalidDir), /quarantined/i);

  console.log('PASS cutover snapshot bundle sealed/quarantine contract');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
