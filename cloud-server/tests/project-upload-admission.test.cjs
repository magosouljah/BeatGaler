'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TEMP_BUDGET_BYTES,
  projectUploadAdmissionConfig,
  createProjectUploadAdmission,
} = require('../project-upload-admission');

test('PROJECT admission defaults protect one near-commercial-ceiling tempfile', () => {
  const config = projectUploadAdmissionConfig({});
  assert.equal(config.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  assert.equal(config.tempBudgetBytes, DEFAULT_TEMP_BUDGET_BYTES);
  assert.equal(config.maxConcurrent, 1);
  assert.equal(config.tempBudgetBytes, 2_000_000_000);

  const admission = createProjectUploadAdmission(config);
  const first = admission.acquire({ maxBytes: 1_900_000_000 });
  assert.equal(first.reservationBytes, 1_900_000_000);
  assert.throws(() => admission.acquire({ maxBytes: 1_000_000_000 }), error =>
    error?.code === 'PROJECT_UPLOAD_BUSY' && error?.status === 503 && error?.retryAfter === 5);
  first.release();
  first.release();
  assert.deepEqual(admission.snapshot(), {
    active: 0,
    reservedBytes: 0,
    maxConcurrent: 1,
    tempBudgetBytes: 2_000_000_000,
  });
});

test('PROJECT admission uses request Content-Length when available and enforces byte budget', () => {
  const admission = createProjectUploadAdmission({ maxConcurrent: 2, tempBudgetBytes: 10_000_000 });
  const first = admission.acquire({ maxBytes: 1_900_000_000, contentLength: '6000000' });
  assert.equal(first.reservationBytes, 6_000_000);
  assert.throws(() => admission.acquire({ maxBytes: 1_900_000_000, contentLength: '5000000' }),
    error => error?.code === 'PROJECT_UPLOAD_BUSY');
  first.release();
  const second = admission.acquire({ maxBytes: 1_900_000_000, contentLength: '5000000' });
  second.release();
  assert.equal(admission.snapshot().reservedBytes, 0);
});

test('PROJECT admission config is bounded and rejects unsafe operator values', () => {
  assert.deepEqual(projectUploadAdmissionConfig({
    BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT: '2',
    BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES: '4000000000',
  }), { maxConcurrent: 2, tempBudgetBytes: 4_000_000_000 });
  assert.throws(() => projectUploadAdmissionConfig({ BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT: '0' }),
    /BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT/);
  assert.throws(() => projectUploadAdmissionConfig({ BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT: '9' }),
    /BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT/);
  assert.throws(() => projectUploadAdmissionConfig({ BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES: '0' }),
    /BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES/);
});
