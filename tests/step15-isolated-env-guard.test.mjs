import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStep15Env } from '../scripts/step15-isolated-env-guard.mjs';

function valid(overrides = {}) {
  const runId = 'step15-smoke-a1';
  return {
    STEP15_RUN_ID: runId,
    STEP15_CLOUD_PORT: '4150',
    STEP15_WEB_PORT: '4151',
    STEP15_DATABASE_URL: 'postgres://user:secret@127.0.0.1:5432/beatgaler_step15_smoke_a1',
    STEP15_TEMP_DIR: `/tmp/${runId}/uploads`,
    STEP15_RUN_DIR: `/tmp/${runId}/evidence`,
    STEP15_CLOUD_URL: 'http://127.0.0.1:4150',
    BEATGALER_PROJECT_UPLOAD_TEMP_DIR: `/tmp/${runId}/uploads`,
    BEATGALER_HTTP_REQUEST_TIMEOUT_MS: '1800000',
    BEATGALER_HTTP_SOCKET_TIMEOUT_MS: '1800000',
    BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT: '1',
    BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES: '2000000000',
    ...overrides,
  };
}

test('isolated STEP15 environment passes without exposing database credentials', () => {
  const report = validateStep15Env(valid());
  assert.equal(report.result, 'PASS');
  assert.equal(report.databaseName, 'beatgaler_step15_smoke_a1');
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('guard rejects STEP14/Stage1 paths, ports and inherited identities', () => {
  assert.throws(() => validateStep15Env(valid({ STEP15_CLOUD_PORT: '4013', STEP15_CLOUD_URL: 'http://127.0.0.1:4013' })), /reserved/);
  assert.throws(() => validateStep15Env(valid({ STEP15_RUN_DIR: '/tmp/.billing-e2e/step15-smoke-a1' })), /.billing-e2e/);
  assert.throws(() => validateStep15Env(valid({ STAGE1_COHORT_ID: 'old-cohort' })), /forbidden/);
  assert.throws(() => validateStep15Env(valid({ BILLING_E2E_EXPECTED_HEAD: 'abc' })), /forbidden/);
});

test('guard rejects non-isolated database, tempdir and timeout contracts', () => {
  assert.throws(() => validateStep15Env(valid({ STEP15_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/billing_step14' })), /database name/);
  assert.throws(() => validateStep15Env(valid({ BEATGALER_PROJECT_UPLOAD_TEMP_DIR: '/tmp/other' })), /must exactly equal/);
  assert.throws(() => validateStep15Env(valid({ BEATGALER_HTTP_REQUEST_TIMEOUT_MS: '30000' })), /1800000ms/);
  assert.throws(() => validateStep15Env(valid({ BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES: '1899999999' })), /TEMP_BUDGET/);
});
