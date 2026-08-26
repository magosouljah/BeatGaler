'use strict';

const crypto = require('crypto');
const { enqueueGarbage } = require('./garbage-journal-repository.js');

function requireClient(client) {
  if (!client || typeof client.query !== 'function') throw new Error('PostgreSQL client is required.');
}

function normalizeObservation(value) {
  const vaultId = String(value?.vaultId || '').trim();
  const pinnedMessageId = value?.pinnedMessageId == null ? null : String(value.pinnedMessageId).trim();
  const revision = value?.revision == null ? null : String(value.revision).trim();
  const manifestSha256 = value?.manifestSha256 == null ? null : String(value.manifestSha256).trim().toLowerCase();
  if (!vaultId) throw new Error('Authoritative INDEX observation requires vaultId.');
  if (manifestSha256 != null && !/^[0-9a-f]{64}$/.test(manifestSha256)) throw new Error('manifestSha256 must be SHA-256 hex.');
  return Object.freeze({ vaultId, pinnedMessageId: pinnedMessageId || null, revision: revision || null, manifestSha256 });
}

async function reconcileIndexObservation(client, authoritativeInput) {
  requireClient(client);
  const authoritative = normalizeObservation(authoritativeInput);
  await client.query('BEGIN');
  try {
    const previous = (await client.query('SELECT * FROM index_observations WHERE vault_id=$1 FOR UPDATE', [authoritative.vaultId])).rows[0] || null;
    const changed = !previous
      || (previous.pinned_message_id || null) !== authoritative.pinnedMessageId
      || (previous.revision || null) !== authoritative.revision
      || (previous.manifest_sha256 || null) !== authoritative.manifestSha256;

    const current = (await client.query(`INSERT INTO index_observations(vault_id,pinned_message_id,revision,manifest_sha256,observed_at)
      VALUES($1,$2,$3,$4,now())
      ON CONFLICT(vault_id) DO UPDATE SET pinned_message_id=EXCLUDED.pinned_message_id,
        revision=EXCLUDED.revision, manifest_sha256=EXCLUDED.manifest_sha256, observed_at=now()
      RETURNING *`, [authoritative.vaultId,authoritative.pinnedMessageId,authoritative.revision,authoritative.manifestSha256])).rows[0];
    await client.query('COMMIT');
    return Object.freeze({ changed, previous, current, authority: 'pinned-index' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function deterministicGarbageIdentity(vaultId, operationId, objectId, indexCommitRef) {
  const digest = crypto.createHash('sha256')
    .update([vaultId, operationId, objectId, indexCommitRef].map(String).join('\0'))
    .digest('hex');
  return {
    id: `gc_${digest.slice(0, 24)}`,
    idempotencyKey: `orphan:${digest}`,
  };
}

async function discoverOrphanUploads(client, options) {
  requireClient(client);
  const vaultId = String(options?.vaultId || '').trim();
  const indexCommitRef = String(options?.indexCommitRef || '').trim();
  const safetyBefore = options?.safetyBefore instanceof Date ? options.safetyBefore : null;
  if (!vaultId || !indexCommitRef || !safetyBefore || Number.isNaN(safetyBefore.getTime())) {
    throw new Error('vaultId, indexCommitRef and safetyBefore are required for orphan discovery.');
  }
  const authoritativeObjectIds = new Set((options.authoritativeObjectIds || []).map(value => String(value)));
  const observation = (await client.query('SELECT * FROM index_observations WHERE vault_id=$1', [vaultId])).rows[0];
  if (!observation) throw new Error('Orphan discovery requires a persisted current INDEX observation.');
  const observationRef = observation.manifest_sha256 || observation.revision || observation.pinned_message_id;
  if (String(observationRef || '') !== indexCommitRef) {
    throw new Error('Orphan discovery indexCommitRef does not match the persisted INDEX observation.');
  }

  const operations = (await client.query(`SELECT id, produced_object_ids FROM direct_operations
    WHERE vault_id=$1 AND state IN ('EXTERNAL_EFFECT','RECONCILE') AND updated_at <= $2
    ORDER BY created_at,id`, [vaultId, safetyBefore])).rows;
  const discovered = [];
  for (const operation of operations) {
    for (const objectIdRaw of Array.isArray(operation.produced_object_ids) ? operation.produced_object_ids : []) {
      const objectId = String(objectIdRaw || '').trim();
      if (!objectId || authoritativeObjectIds.has(objectId)) continue;
      const identity = deterministicGarbageIdentity(vaultId, operation.id, objectId, indexCommitRef);
      const row = await enqueueGarbage(client, {
        id: identity.id,
        idempotency_key: identity.idempotencyKey,
        vault_id: vaultId,
        operation_id: operation.id,
        object_kind: 'media',
        object_id: objectId,
        reason: 'orphan_upload',
        index_commit_ref: indexCommitRef,
      });
      discovered.push(row);
    }
  }
  return discovered;
}

module.exports = {
  normalizeObservation,
  reconcileIndexObservation,
  deterministicGarbageIdentity,
  discoverOrphanUploads,
};
