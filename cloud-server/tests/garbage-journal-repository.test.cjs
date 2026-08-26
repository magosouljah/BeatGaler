'use strict';

const assert = require('assert');
const repo = require('../garbage-journal-repository.js');

const calls = [];
const client = {
  async query(sql, params = []) {
    const text = String(sql);
    calls.push({ text, params });
    if (text.includes('RETURNING g.*')) return { rows: [{ id: 'g1', state: 'retrying', worker_lease_owner: params[2] }] };
    return { rows: [{ id: params[0] || 'g1' }] };
  },
};

(async () => {
  await repo.enqueueGarbage(client, {
    id:'g1', idempotency_key:'vault:msg:delete', vault_id:'v1', object_kind:'media', object_id:'99',
    reason:'permanent_delete', index_commit_ref:'index:123',
  });
  const enqueue = calls.at(-1);
  assert(enqueue.text.includes('ON CONFLICT(idempotency_key)'));
  assert(enqueue.text.includes("'pending'"));

  const now = new Date('2026-08-26T00:00:00Z');
  const claimed = await repo.claimGarbageBatch(client, { workerId:'worker-a', limit:10, leaseMs:60000, now });
  assert.equal(claimed.length, 1);
  const claim = calls.at(-1);
  assert(claim.text.includes('FOR UPDATE SKIP LOCKED'));
  assert(claim.text.includes("state IN ('pending','retrying')"));
  assert.equal(claim.params[2], 'worker-a');
  assert.equal(claim.params[3].toISOString(), '2026-08-26T00:01:00.000Z');

  await repo.markGarbageDone(client, { id:'g1', workerId:'worker-a', now });
  assert(calls.at(-1).text.includes("state='done'"));
  assert(calls.at(-1).text.includes('worker_lease_owner=$2'));

  await repo.markGarbageRetry(client, { id:'g1', workerId:'worker-a', nextAttemptAt:new Date(now.getTime()+5000), errorCode:'TIMEOUT', redactedError:'timeout' });
  assert(calls.at(-1).text.includes('attempt_count=attempt_count+1'));

  await repo.markGarbageBlocked(client, { id:'g1', workerId:'worker-a', errorCode:'MESSAGE_DELETE_FORBIDDEN', redactedError:'forbidden' });
  assert(calls.at(-1).text.includes("state='blocked'"));

  await assert.rejects(() => repo.claimGarbageBatch(client, { workerId:'w', limit:101 }), /1..100/);
  console.log('PASS garbage journal repository: idempotent enqueue, SKIP LOCKED lease, retry/block/done');
})().catch(error => { console.error(error); process.exitCode = 1; });
