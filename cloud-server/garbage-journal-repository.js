'use strict';

async function enqueueGarbage(client, item) {
  const required = ['id','idempotency_key','vault_id','object_kind','object_id','reason','index_commit_ref'];
  for (const key of required) if (!item?.[key]) throw new Error(`garbage item missing ${key}`);
  const result = await client.query(`INSERT INTO garbage_journal(
      id,idempotency_key,vault_id,operation_id,object_kind,object_id,beat_id,reason,state,attempt_count,next_attempt_at,index_commit_ref,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,$9,$10,now(),now())
    ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=now()
    RETURNING *`, [
      item.id,item.idempotency_key,item.vault_id,item.operation_id || null,item.object_kind,item.object_id,item.beat_id || null,
      item.reason,item.next_attempt_at || null,item.index_commit_ref,
    ]);
  return result.rows[0];
}

async function claimGarbageBatch(client, { workerId, limit = 25, leaseMs = 60000, now = new Date() }) {
  if (!workerId) throw new Error('workerId is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 15 * 60 * 1000) throw new Error('leaseMs out of bounds');
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const result = await client.query(`WITH candidates AS (
      SELECT id FROM garbage_journal
      WHERE state IN ('pending','retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        AND (worker_lease_until IS NULL OR worker_lease_until <= $1)
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $2
    )
    UPDATE garbage_journal g
      SET state='retrying', worker_lease_owner=$3, worker_lease_until=$4, updated_at=now()
    FROM candidates c
    WHERE g.id=c.id
    RETURNING g.*`, [now, limit, workerId, leaseUntil]);
  return result.rows;
}

async function markGarbageDone(client, { id, workerId, now = new Date() }) {
  const result = await client.query(`UPDATE garbage_journal
    SET state='done', completed_at=$3, worker_lease_owner=NULL, worker_lease_until=NULL, last_error_code=NULL,
      last_error_redacted=NULL, updated_at=now()
    WHERE id=$1 AND worker_lease_owner=$2 AND state='retrying'
    RETURNING *`, [id, workerId, now]);
  if (result.rows.length !== 1) throw new Error('garbage lease lost before done');
  return result.rows[0];
}

async function markGarbageRetry(client, { id, workerId, nextAttemptAt, errorCode, redactedError }) {
  const result = await client.query(`UPDATE garbage_journal
    SET state='retrying', attempt_count=attempt_count+1, next_attempt_at=$3,
      last_error_code=$4, last_error_redacted=$5, worker_lease_owner=NULL, worker_lease_until=NULL, updated_at=now()
    WHERE id=$1 AND worker_lease_owner=$2 AND state='retrying'
    RETURNING *`, [id, workerId, nextAttemptAt || new Date(), errorCode || null, redactedError || null]);
  if (result.rows.length !== 1) throw new Error('garbage lease lost before retry');
  return result.rows[0];
}

async function markGarbageBlocked(client, { id, workerId, errorCode, redactedError }) {
  const result = await client.query(`UPDATE garbage_journal
    SET state='blocked', attempt_count=attempt_count+1, last_error_code=$3, last_error_redacted=$4,
      worker_lease_owner=NULL, worker_lease_until=NULL, updated_at=now()
    WHERE id=$1 AND worker_lease_owner=$2 AND state='retrying'
    RETURNING *`, [id, workerId, errorCode || null, redactedError || null]);
  if (result.rows.length !== 1) throw new Error('garbage lease lost before blocked');
  return result.rows[0];
}

module.exports = {
  enqueueGarbage,
  claimGarbageBatch,
  markGarbageDone,
  markGarbageRetry,
  markGarbageBlocked,
};
