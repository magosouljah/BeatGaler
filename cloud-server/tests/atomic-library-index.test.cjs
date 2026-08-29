'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAtomicLibraryIndexCoordinator } = require('../atomic-library-index');

function fakeAdvisoryPool() {
  let tail = Promise.resolve();
  return {
    async connect() {
      let releaseLock = null;
      return {
        async query(sql) {
          if (/pg_advisory_lock/.test(sql) && !/unlock/.test(sql)) {
            const previous = tail;
            let unlock;
            tail = new Promise(resolve => { unlock = resolve; });
            await previous;
            releaseLock = unlock;
            return { rows: [{}] };
          }
          if (/pg_advisory_unlock/.test(sql)) {
            releaseLock?.();
            releaseLock = null;
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
        release() { releaseLock?.(); releaseLock = null; },
      };
    },
  };
}

function harness({ initial = 0, failCreate = false, failRecord = false } = {}) {
  let pointer = initial;
  let creates = 0;
  const deleted = [];
  const coordinator = createAtomicLibraryIndexCoordinator({
    pool: fakeAdvisoryPool(),
    getPointer: async () => ({ message_id: pointer }),
    createIndex: async () => {
      creates += 1;
      if (failCreate) throw new Error('provider failed');
      await new Promise(resolve => setTimeout(resolve, 5));
      return { messageId: 100 + creates };
    },
    recordPointer: async (_vault, messageId) => {
      if (failRecord) throw new Error('pointer failed');
      pointer = messageId;
    },
    deleteIndex: async (_vault, messageId) => { deleted.push(messageId); },
  });
  return { coordinator, get pointer() { return pointer; }, get creates() { return creates; }, deleted };
}

test('two concurrent callers serialize to one winning index', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.coordinator.ensure('vault-1'), h.coordinator.ensure('vault-1')]);
  assert.deepEqual([a.status, b.status].sort(), ['created', 'existing']);
  assert.equal(a.messageId, b.messageId);
  assert.equal(h.creates, 1);
  assert.equal(h.pointer, a.messageId);
});

test('retry is idempotent and returns the same winner', async () => {
  const h = harness();
  const first = await h.coordinator.ensure('vault-2');
  const second = await h.coordinator.ensure('vault-2');
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'existing');
  assert.equal(second.messageId, first.messageId);
  assert.equal(h.creates, 1);
});

test('existing index is never overwritten', async () => {
  const h = harness({ initial: 77 });
  const result = await h.coordinator.ensure('vault-3');
  assert.deepEqual(result, { status: 'existing', messageId: 77 });
  assert.equal(h.creates, 0);
});

test('provider failure does not report success or publish a pointer', async () => {
  const h = harness({ failCreate: true });
  await assert.rejects(() => h.coordinator.ensure('vault-4'), /provider failed/);
  assert.equal(h.pointer, 0);
});

test('durability failure cleans the candidate and does not report success', async () => {
  const h = harness({ failRecord: true });
  await assert.rejects(() => h.coordinator.ensure('vault-5'), /pointer failed/);
  assert.equal(h.pointer, 0);
  assert.deepEqual(h.deleted, [101]);
});
