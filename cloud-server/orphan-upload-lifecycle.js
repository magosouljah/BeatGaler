'use strict';

const { markOperationForReconcile } = require('./direct-operation-repository.js');
const { reconcileVault, processGarbageBatch } = require('./garbage-reconciliation-worker.js');

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`${name} is required`);
}

function normalizeIds(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('producedObjectIds must contain at least one upload id.');
  const ids = [...new Set(value.map(id => String(id || '').trim()).filter(Boolean))].sort();
  if (!ids.length) throw new Error('producedObjectIds must contain at least one upload id.');
  return ids;
}

async function registerAbandonedUploads(client, input = {}) {
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!idempotencyKey) throw new Error('idempotencyKey is required.');
  return markOperationForReconcile(client, {
    idempotencyKey,
    producedObjectIds: normalizeIds(input.producedObjectIds),
  });
}

function createAuthoritativeOrphanGuard(fetchAuthoritativeIndex) {
  requireFunction(fetchAuthoritativeIndex, 'fetchAuthoritativeIndex');
  return async function isObjectStillOrphan(item) {
    const vaultId = String(item?.vault_id || '').trim();
    const objectId = String(item?.object_id || '').trim();
    const expectedRef = String(item?.index_commit_ref || '').trim();
    if (!vaultId || !objectId || !expectedRef) throw new Error('Garbage item lacks authoritative identity.');
    const authoritative = await fetchAuthoritativeIndex(vaultId);
    const currentRef = String(authoritative?.manifestSha256 || authoritative?.revision || authoritative?.pinnedMessageId || '').trim();
    if (!currentRef || currentRef !== expectedRef) return false;
    const ids = new Set((authoritative?.objectIds || []).map(String));
    return !ids.has(objectId);
  };
}

async function reconcileAbandonedUploads(client, options = {}) {
  requireFunction(options.fetchAuthoritativeIndex, 'fetchAuthoritativeIndex');
  requireFunction(options.deleteObject, 'deleteObject');
  const reconciliation = await reconcileVault(client, options);
  const garbage = await processGarbageBatch(client, {
    ...options,
    isObjectStillOrphan: createAuthoritativeOrphanGuard(options.fetchAuthoritativeIndex),
  });
  return Object.freeze({ reconciliation, garbage });
}

module.exports = {
  registerAbandonedUploads,
  createAuthoritativeOrphanGuard,
  reconcileAbandonedUploads,
};
