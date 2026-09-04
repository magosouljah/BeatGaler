'use strict';

const assert = require('assert');
const { parseLegacyJson, snapshotManifest, planLegacyImport } = require('../legacy-import-plan.js');

const authRaw = JSON.stringify({
  users: [
    { id: 'u2', email: 'B@Example.com', passwordHash: 'x', storageChatId: '-200', planState: { basePlanId: 'paid_entry', grants: [] }, providers: {} },
    { id: 'u1', email: 'A@Example.com', mfaSecret: 'legacy', storageChatId: '-100', planState: { basePlanId: 'free', grants: [{ planId: 'paid_entry' }] }, providers: { google: { id: 'g1' } } },
  ],
  sessions: { abc: { userId: 'u1' }, def: { userId: 'u2' } },
});
const dataRaw = JSON.stringify({
  linkedAccounts: {
    'install-a': { beatgalerAccountId: 'u1', storageChatId: '-100' },
    'install-b': { beatgalerAccountId: 'u2', storageChatId: '-200' },
  },
  uploadedFiles: [],
  beatTopics: { 'u1:b1': 11 },
  pendingTopicDeletes: {},
  messageRedirects: {},
});

const manifest1 = snapshotManifest({ 'accounts-data.json': authRaw, 'cloud-data.json': dataRaw });
const manifest2 = snapshotManifest({ 'cloud-data.json': dataRaw, 'accounts-data.json': authRaw });
assert.deepEqual(manifest1, manifest2);
assert.match(manifest1.manifest_sha256, /^[0-9a-f]{64}$/);

const plan1 = planLegacyImport(parseLegacyJson(authRaw, 'auth'), parseLegacyJson(dataRaw, 'persistent'));
const plan2 = planLegacyImport(parseLegacyJson(authRaw, 'auth'), parseLegacyJson(dataRaw, 'persistent'));
assert.deepEqual(plan1, plan2);
assert.equal(plan1.counts.users, 2);
assert.equal(plan1.counts.auth_sessions, 2);
assert.equal(plan1.counts.linked_accounts, 2);
assert.equal(plan1.users[0].id, 'u1');
assert.equal(plan1.users[0].email, 'a@example.com');
assert.equal(plan1.users[0].has_mfa_secret, true);
assert.equal(plan1.users[0].provider_count, 1);
assert.match(plan1.plan_sha256, /^[0-9a-f]{64}$/);

assert.throws(() => parseLegacyJson('{broken', 'auth'), /invalid JSON/);
assert.throws(() => planLegacyImport({ users: [{ id: 'dup' }, { id: 'dup' }], sessions: {} }, { linkedAccounts: {} }), /Duplicate legacy user id/);
assert.throws(() => planLegacyImport({ users: [{ id: 'u1' }], sessions: {} }, { linkedAccounts: { installation: { beatgalerAccountId: 'missing' } } }), /unknown users/);
assert.throws(() => planLegacyImport({ users: [{ id: 'u1' }], sessions: {} }, { linkedAccounts: { installation: {} } }), /missing beatgalerAccountId/);

console.log('PASS legacy import planner: deterministic, hashed, installation-owner aware, fail-closed');
