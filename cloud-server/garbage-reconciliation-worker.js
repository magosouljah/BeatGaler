'use strict';

const {
  claimGarbageBatch,
  markGarbageDone,
  markGarbageRetry,
  markGarbageBlocked,
} = require('./garbage-journal-repository.js');
const {
  reconcileIndexObservation,
  discoverOrphanUploads,
} = require('./index-reconciliation.js');

const DEFAULT_BASE_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const ALREADY_GONE_CODES = new Set(['MESSAGE_ID_INVALID', 'MESSAGE_NOT_FOUND', 'OBJECT_NOT_FOUND']);
const PERMANENT_BLOCK_CODES = new Set(['MESSAGE_DELETE_FORBIDDEN']);

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`${name} is required`);
}

function normalizeErrorCode(error) {
  const raw = error?.code || error?.errorCode || error?.error_message || error?.message || 'UNKNOWN';
  const text = String(raw).trim().toUpperCase();
  const mtproto = text.match(/[A-Z][A-Z0-9_]{2,}/g);
  return mtproto?.at(-1) || 'UNKNOWN';
}

function redactedError(error, code = normalizeErrorCode(error)) {
  const status = Number(error?.status || error?.statusCode || 0);
  return status > 0 ? `${code} (status ${status})` : code;
}

function retryDelayMs(attemptCount, { baseRetryMs = DEFAULT_BASE_RETRY_MS, maxRetryMs = DEFAULT_MAX_RETRY_MS } = {}) {
  if (!Number.isInteger(attemptCount) || attemptCount < 0) throw new Error('attemptCount must be a non-negative integer');
  if (!Number.isInteger(baseRetryMs) || baseRetryMs < 1) throw new Error('baseRetryMs must be a positive integer');
  if (!Number.isInteger(maxRetryMs) || maxRetryMs < baseRetryMs) throw new Error('maxRetryMs must be >= baseRetryMs');
  return Math.min(maxRetryMs, baseRetryMs * (2 ** Math.min(attemptCount, 20)));
}

async function processGarbageBatch(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) throw new Error('workerId is required');
  requireFunction(options.deleteObject, 'deleteObject');
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error('maxAttempts must be 1..100');

  const claimed = await claimGarbageBatch(client, {
    workerId,
    limit: options.limit ?? 25,
    leaseMs: options.leaseMs ?? 60_000,
    now,
  });
  const summary = { claimed: claimed.length, done: 0, retried: 0, blocked: 0, recoveredAlreadyGone: 0 };

  for (const item of claimed) {
    try {
      await options.deleteObject(item);
      await markGarbageDone(client, { id: item.id, workerId, now });
      summary.done += 1;
    } catch (error) {
      const code = normalizeErrorCode(error);
      if (ALREADY_GONE_CODES.has(code)) {
        await markGarbageDone(client, { id: item.id, workerId, now });
        summary.done += 1;
        summary.recoveredAlreadyGone += 1;
        continue;
      }
      const nextAttemptNumber = Number(item.attempt_count || 0) + 1;
      if (PERMANENT_BLOCK_CODES.has(code) || nextAttemptNumber >= maxAttempts) {
        await markGarbageBlocked(client, {
          id: item.id,
          workerId,
          errorCode: code,
          redactedError: redactedError(error, code),
        });
        summary.blocked += 1;
        continue;
      }
      const delayMs = retryDelayMs(Number(item.attempt_count || 0), options);
      await markGarbageRetry(client, {
        id: item.id,
        workerId,
        nextAttemptAt: new Date(now.getTime() + delayMs),
        errorCode: code,
        redactedError: redactedError(error, code),
      });
      summary.retried += 1;
    }
  }
  return Object.freeze(summary);
}

async function reconcileVault(client, options = {}) {
  const vaultId = String(options.vaultId || '').trim();
  if (!vaultId) throw new Error('vaultId is required');
  requireFunction(options.fetchAuthoritativeIndex, 'fetchAuthoritativeIndex');
  const authoritative = await options.fetchAuthoritativeIndex(vaultId);
  const objectIds = Array.isArray(authoritative?.objectIds) ? authoritative.objectIds.map(String) : [];
  const observation = await reconcileIndexObservation(client, {
    vaultId,
    pinnedMessageId: authoritative?.pinnedMessageId,
    revision: authoritative?.revision,
    manifestSha256: authoritative?.manifestSha256,
  });
  const indexCommitRef = observation.current.manifest_sha256 || observation.current.revision || observation.current.pinned_message_id;
  if (!indexCommitRef) throw new Error('Authoritative INDEX must expose a stable commit reference before orphan discovery.');
  const safetyBefore = options.safetyBefore instanceof Date
    ? options.safetyBefore
    : new Date(Date.now() - (options.safetyWindowMs ?? 5 * 60_000));
  const discovered = await discoverOrphanUploads(client, {
    vaultId,
    authoritativeObjectIds: objectIds,
    indexCommitRef: String(indexCommitRef),
    safetyBefore,
  });
  return Object.freeze({ observation, discovered });
}

async function runGarbageReconciliationCycle(client, options = {}) {
  const reconciliation = await reconcileVault(client, options);
  const garbage = await processGarbageBatch(client, options);
  return Object.freeze({ reconciliation, garbage });
}

module.exports = {
  ALREADY_GONE_CODES,
  PERMANENT_BLOCK_CODES,
  normalizeErrorCode,
  redactedError,
  retryDelayMs,
  processGarbageBatch,
  reconcileVault,
  runGarbageReconciliationCycle,
};
