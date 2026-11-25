'use strict';

const { canonicalJson } = require('./authority');

function insertJob(connection, uid, { jobId, kind, operationId, payload }, variant, rejectDuplicate) {
  // Preserve the existing placeholder order, including the two fixed-kind statements.
  const fixedKind = variant === 'direct' && kind === 'TRANSFER_RECONCILE' ? "'TRANSFER_RECONCILE'"
    : variant === 'purge' && kind === 'PURGE' ? "'PURGE'" : null;
  const json = canonicalJson(payload);
  const params = fixedKind ? [jobId, uid, operationId, json] : [jobId, uid, kind, operationId, json];
  const values = fixedKind ? `$1, $2, ${fixedKind}, $3, $4` : rejectDuplicate ? '$1,$2,$3,$4,$5' : '$1, $2, $3, $4, $5';
  const conflict = rejectDuplicate ? '' : ' ON CONFLICT (job_id) DO NOTHING';
  return connection.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES (${values})${conflict}`, params);
}

function enqueueOnConflictDoNothing(connection, uid, job, variant) {
  return insertJob(connection, uid, job, variant, false);
}

function enqueue(connection, uid, job, variant) {
  return job.onConflict === 'fail'
    ? insertJob(connection, uid, job, variant, true)
    : enqueueOnConflictDoNothing(connection, uid, job, variant);
}

function enqueueToleratingUniqueViolation(operations, job) {
  return operations.enqueueJob(job).catch((error) => {
    if (error?.detail?.sqlstate !== '23505') throw error;
  });
}

function continueLater(operations, kind, job, payload = job.payload) {
  const continuation = (job.payload.continuation || 0) + 1;
  const root = job.payload.root || job.jobId;
  return enqueueToleratingUniqueViolation(operations, {
    userId: job.userId,
    kind,
    ...(kind !== 'QUERY_SET_BUILD' && { operationId: job.operationId }),
    payload: { ...payload, continuation, root },
    jobId: `${root}-c${continuation}`.slice(0, 64),
  });
}

module.exports = { enqueue, enqueueOnConflictDoNothing, enqueueToleratingUniqueViolation, continueLater };
