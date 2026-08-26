'use strict';

const assert = require('assert');
const { snapshotManifest } = require('../legacy-import-plan.js');
const { assertJsonRollbackSnapshot, commitPostgresRollback } = require('../postgres-rollback-preparation.js');

const authRaw = JSON.stringify({ users: [], sessions: {} }, null, 2);
const persistentRaw = JSON.stringify({
  linkedAccounts: {}, uploadedFiles: {}, beatTopics: {}, pendingTopicDeletes: {}, messageRedirects: {},
}, null, 2);
const sha = snapshotManifest({ 'accounts-data.json': authRaw, 'cloud-data.json': persistentRaw }).manifest_sha256;

(async () => {
  const readyPool = {
    async query() { return { rows: [{ state: 'READY', rollback_export_sha256: null }] }; },
  };
  await assert.rejects(
    () => assertJsonRollbackSnapshot(readyPool, '', { authRaw, persistentRaw }),
    /refused while PostgreSQL cutover is READY/,
  );

  const rolledBackPool = {
    async query() { return { rows: [{ state: 'ROLLED_BACK', rollback_export_sha256: sha }] }; },
  };
  await assert.rejects(
    () => assertJsonRollbackSnapshot(rolledBackPool, 'f'.repeat(64), { authRaw, persistentRaw }),
    /does not match the committed/,
  );
  await assert.rejects(
    () => assertJsonRollbackSnapshot(rolledBackPool, sha, { authRaw: '{}', persistentRaw }),
    /Legacy JSON files do not match/,
  );
  const ok = await assertJsonRollbackSnapshot(rolledBackPool, sha, { authRaw, persistentRaw });
  assert.equal(ok.rollbackExportSha256, sha);

  const calls = [];
  const commitPool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [{ snapshot_sha256: 'a'.repeat(64), rollback_export_sha256: sha, state: 'ROLLED_BACK' }] };
    },
  };
  const committed = await commitPostgresRollback(commitPool, {
    originalCutoverSnapshotSha256: 'a'.repeat(64),
    rollbackExportSha256: sha,
  });
  assert.equal(committed.state, 'ROLLED_BACK');
  assert(calls[0].sql.includes("state='ROLLED_BACK'"));
  assert.deepEqual(calls[0].params, ['legacy-json-v1', 'a'.repeat(64), sha]);

  console.log('PASS PostgreSQL rollback guard: no blind JSON rollback, exact export digest required');
})().catch(error => { console.error(error); process.exitCode = 1; });
