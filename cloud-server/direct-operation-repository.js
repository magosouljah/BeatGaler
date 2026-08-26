'use strict';

function requireClient(client) {
  if (!client || typeof client.query !== 'function') throw new Error('PostgreSQL client is required.');
}

function normalizeProducedObjectIds(value) {
  if (!Array.isArray(value)) throw new Error('producedObjectIds must be an array.');
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].sort();
}

async function beginDirectOperation(client, input) {
  requireClient(client);
  const id = String(input?.id || '').trim();
  const idempotencyKey = String(input?.idempotencyKey || '').trim();
  const vaultId = String(input?.vaultId || '').trim();
  const leaseId = input?.leaseId == null ? null : String(input.leaseId).trim();
  const operationType = String(input?.operationType || '').trim();
  if (!id || !idempotencyKey || !vaultId || !operationType) throw new Error('Direct operation identity fields are required.');

  const inserted = await client.query(`INSERT INTO direct_operations(
      id,idempotency_key,vault_id,lease_id,operation_type,state,produced_object_ids,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'PREPARED','[]'::jsonb,now(),now())
    ON CONFLICT(idempotency_key) DO NOTHING
    RETURNING *`, [id,idempotencyKey,vaultId,leaseId,operationType]);
  if (inserted.rows.length) return inserted.rows[0];

  const existing = (await client.query('SELECT * FROM direct_operations WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
  if (!existing) throw new Error('Direct operation idempotency race produced no row.');
  if (existing.id !== id || existing.vault_id !== vaultId || existing.operation_type !== operationType || (existing.lease_id || null) !== leaseId) {
    throw new Error('Direct operation idempotency key was reused with different immutable fields.');
  }
  return existing;
}

async function transitionDirectOperation(client, { idempotencyKey, fromStates, toState, producedObjectIds }) {
  requireClient(client);
  const key = String(idempotencyKey || '').trim();
  if (!key) throw new Error('idempotencyKey is required.');
  if (!Array.isArray(fromStates) || !fromStates.length) throw new Error('fromStates is required.');
  const ids = producedObjectIds == null ? null : normalizeProducedObjectIds(producedObjectIds);
  const result = await client.query(`UPDATE direct_operations
    SET state=$2,
        produced_object_ids=CASE WHEN $3::jsonb IS NULL THEN produced_object_ids ELSE $3::jsonb END,
        updated_at=now()
    WHERE idempotency_key=$1 AND state = ANY($4::text[])
    RETURNING *`, [key, toState, ids == null ? null : JSON.stringify(ids), fromStates]);
  if (result.rows.length === 1) return result.rows[0];

  const existing = (await client.query('SELECT * FROM direct_operations WHERE idempotency_key=$1', [key])).rows[0];
  if (!existing) throw new Error(`Direct operation not found: ${key}`);
  if (existing.state === toState) {
    if (ids != null && JSON.stringify(normalizeProducedObjectIds(existing.produced_object_ids || [])) !== JSON.stringify(ids)) {
      throw new Error(`Direct operation ${key} already reached ${toState} with different produced objects.`);
    }
    return existing;
  }
  throw new Error(`Illegal Direct operation transition ${existing.state} -> ${toState}.`);
}

function recordExternalEffect(client, { idempotencyKey, producedObjectIds }) {
  return transitionDirectOperation(client, {
    idempotencyKey,
    fromStates: ['PREPARED'],
    toState: 'EXTERNAL_EFFECT',
    producedObjectIds,
  });
}

function markIndexCommitted(client, { idempotencyKey }) {
  return transitionDirectOperation(client, {
    idempotencyKey,
    fromStates: ['EXTERNAL_EFFECT'],
    toState: 'INDEX_COMMITTED',
  });
}

function markOperationCommitted(client, { idempotencyKey }) {
  return transitionDirectOperation(client, {
    idempotencyKey,
    fromStates: ['INDEX_COMMITTED'],
    toState: 'COMMITTED',
  });
}

function markOperationForReconcile(client, { idempotencyKey, producedObjectIds }) {
  return transitionDirectOperation(client, {
    idempotencyKey,
    fromStates: ['PREPARED','EXTERNAL_EFFECT','INDEX_COMMITTED','FAILED'],
    toState: 'RECONCILE',
    producedObjectIds,
  });
}

module.exports = {
  normalizeProducedObjectIds,
  beginDirectOperation,
  transitionDirectOperation,
  recordExternalEffect,
  markIndexCommitted,
  markOperationCommitted,
  markOperationForReconcile,
};
