'use strict';

const assert = require('assert');
const {
  normalizeErrorCode,
  redactedError,
  retryDelayMs,
  ALREADY_GONE_CODES,
  PERMANENT_BLOCK_CODES,
} = require('../garbage-reconciliation-worker.js');

assert.equal(retryDelayMs(0), 5_000);
assert.equal(retryDelayMs(1), 10_000);
assert.equal(retryDelayMs(20), 15 * 60_000, 'backoff must stay bounded');
assert.throws(() => retryDelayMs(-1), /non-negative/);
assert.equal(normalizeErrorCode({ message: '400: MESSAGE_DELETE_FORBIDDEN' }), 'MESSAGE_DELETE_FORBIDDEN');
assert.equal(normalizeErrorCode({ code: 'ETIMEDOUT' }), 'ETIMEDOUT');
assert.equal(redactedError({ message: 'secret-bearing arbitrary error', status: 503 }, 'UPSTREAM_FAILURE'), 'UPSTREAM_FAILURE (status 503)');
assert(ALREADY_GONE_CODES.has('MESSAGE_ID_INVALID'));
assert(PERMANENT_BLOCK_CODES.has('MESSAGE_DELETE_FORBIDDEN'));

console.log('PASS garbage reconciliation worker: bounded retry, error classification, redaction policy');
