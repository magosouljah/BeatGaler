'use strict';

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_TEMP_BUDGET_BYTES = 2_000_000_000;
const MAX_TEMP_BUDGET_BYTES = 16_000_000_000;

class ProjectUploadBusyError extends Error {
  constructor(message = 'PROJECT upload capacity is busy; retry shortly.') {
    super(message);
    this.name = 'ProjectUploadBusyError';
    this.code = 'PROJECT_UPLOAD_BUSY';
    this.status = 503;
    this.retryAfter = 5;
  }
}

function boundedInt(raw, fallback, min, max, name) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a safe integer between ${min} and ${max}.`);
  }
  return value;
}

function projectUploadAdmissionConfig(env = process.env) {
  return Object.freeze({
    maxConcurrent: boundedInt(env.BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT,
      DEFAULT_MAX_CONCURRENT, 1, 8, 'BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT'),
    tempBudgetBytes: boundedInt(env.BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES,
      DEFAULT_TEMP_BUDGET_BYTES, 1, MAX_TEMP_BUDGET_BYTES, 'BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES'),
  });
}

function createProjectUploadAdmission(config = projectUploadAdmissionConfig()) {
  const maxConcurrent = boundedInt(config.maxConcurrent, DEFAULT_MAX_CONCURRENT,
    1, 8, 'projectUploadAdmission.maxConcurrent');
  const tempBudgetBytes = boundedInt(config.tempBudgetBytes, DEFAULT_TEMP_BUDGET_BYTES,
    1, MAX_TEMP_BUDGET_BYTES, 'projectUploadAdmission.tempBudgetBytes');
  let active = 0;
  let reservedBytes = 0;

  function snapshot() {
    return Object.freeze({ active, reservedBytes, maxConcurrent, tempBudgetBytes });
  }

  function acquire({ maxBytes, contentLength } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('PROJECT admission requires a positive maxBytes plan ceiling.');
    }
    const stated = Number(contentLength);
    const reservationBytes = Number.isSafeInteger(stated) && stated > 0 ? stated : maxBytes;
    if (active >= maxConcurrent || reservationBytes > tempBudgetBytes || reservedBytes + reservationBytes > tempBudgetBytes) {
      throw new ProjectUploadBusyError();
    }
    active += 1;
    reservedBytes += reservationBytes;
    let released = false;
    return Object.freeze({
      reservationBytes,
      release() {
        if (released) return;
        released = true;
        active -= 1;
        reservedBytes -= reservationBytes;
      },
    });
  }

  return Object.freeze({ acquire, snapshot });
}

module.exports = {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TEMP_BUDGET_BYTES,
  ProjectUploadBusyError,
  projectUploadAdmissionConfig,
  createProjectUploadAdmission,
};
