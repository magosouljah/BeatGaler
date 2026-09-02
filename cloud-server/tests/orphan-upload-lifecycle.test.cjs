'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registerAbandonedUploads,
  createAuthoritativeOrphanGuard,
} = require('../orphan-upload-lifecycle.js');
const { processGarbageBatch } = require('../garbage-reconciliation-worker.js');

function transitionClient(existing = null) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE direct_operations')) return { rows: existing ? [] : [{ id: 'op_1', state: 'RECONCILE', produced_object_ids: params[2] }] };
      if (sql.startsWith('SELECT * FROM direct_operations')) return { rows: existing ? [existing] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function garbageClient(item) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('WITH candidates')) return { rows: [item] };
      if (sql.startsWith('UPDATE garbage_journal') && sql.includes("state='done'")) return { rows: [{ ...item, state: 'done' }] };
      if (sql.startsWith('UPDATE garbage_journal') && sql.includes("state='retrying'")) return { rows: [{ ...item, state: 'retrying' }] };
      if (sql.startsWith('UPDATE garbage_journal') && sql.includes("state='blocked'")) return { rows: [{ ...item, state: 'blocked' }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('Web-callable registration durably transitions an upload operation to RECONCILE and is idempotent', async () => {
  const client = transitionClient();
  const first = await registerAbandonedUploads(client, { idempotencyKey: 'web-save-1', producedObjectIds: ['m2', 'm1', 'm1'] });
  assert.equal(first.state, 'RECONCILE');
  assert.deepEqual(JSON.parse(first.produced_object_ids), ['m1', 'm2']);

  const existing = { id: 'op_1', state: 'RECONCILE', produced_object_ids: ['m1', 'm2'] };
  const replay = await registerAbandonedUploads(transitionClient(existing), { idempotencyKey: 'web-save-1', producedObjectIds: ['m2', 'm1'] });
  assert.equal(replay.state, 'RECONCILE');
});

test('authoritative guard protects an upload that is now committed/valid', async () => {
  const guard = createAuthoritativeOrphanGuard(async () => ({ revision: 'rev-1', objectIds: ['media-1'] }));
  assert.equal(await guard({ vault_id: 'v1', object_id: 'media-1', index_commit_ref: 'rev-1' }), false);
});

test('authoritative guard fails safe when INDEX moved after journal discovery', async () => {
  const guard = createAuthoritativeOrphanGuard(async () => ({ revision: 'rev-2', objectIds: [] }));
  assert.equal(await guard({ vault_id: 'v1', object_id: 'media-1', index_commit_ref: 'rev-1' }), false);
});

test('garbage worker does not delete orphan_upload unless authoritative revalidation says still orphan', async () => {
  const item = { id: 'gc1', reason: 'orphan_upload', vault_id: 'v1', object_id: 'media-1', index_commit_ref: 'rev-1', attempt_count: 0 };
  const client = garbageClient(item);
  let deleted = 0;
  const summary = await processGarbageBatch(client, {
    workerId: 'w1',
    deleteObject: async () => { deleted += 1; },
    isObjectStillOrphan: async () => false,
  });
  assert.equal(deleted, 0);
  assert.equal(summary.protectedValid, 1);
  assert.equal(summary.done, 1);
});

test('garbage worker deletes only after positive orphan revalidation', async () => {
  const item = { id: 'gc2', reason: 'orphan_upload', vault_id: 'v1', object_id: 'media-2', index_commit_ref: 'rev-1', attempt_count: 0 };
  let deleted = 0;
  const summary = await processGarbageBatch(garbageClient(item), {
    workerId: 'w1',
    deleteObject: async () => { deleted += 1; },
    isObjectStillOrphan: async () => true,
  });
  assert.equal(deleted, 1);
  assert.equal(summary.done, 1);
});

test('missing authoritative revalidation fails closed into durable retry instead of deleting', async () => {
  const item = { id: 'gc3', reason: 'orphan_upload', vault_id: 'v1', object_id: 'media-3', index_commit_ref: 'rev-1', attempt_count: 0 };
  let deleted = 0;
  const summary = await processGarbageBatch(garbageClient(item), {
    workerId: 'w1',
    deleteObject: async () => { deleted += 1; },
    now: new Date('2026-08-30T00:00:00Z'),
  });
  assert.equal(deleted, 0);
  assert.equal(summary.retried, 1);
});
