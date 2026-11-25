'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');
const { installImmediateAccountDeletion } = require('../d8-ro-resolutions');

test('account deletion uses the default until D8 provides its implementation', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-lifecycle-api-'));
  try {
    const runtime = createAccountLifecycleRuntime({ dataDir, env: {} });
    const response = {
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };

    await runtime.api.data.deleteAccount({}, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'ACCOUNT_RETENTION_POLICY_REQUIRED');

    installImmediateAccountDeletion(runtime);
    await runtime.api.data.deleteAccount({}, response);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, 'SESSION_REQUIRED');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('static guard: Cloud production code has no _test member accesses', () => {
  const result = spawnSync('git', [
    'grep', '-nE', String.raw`(\.\s*_test\b|\[\s*['"]_test['"]\s*\])`,
    '--', 'cloud-server/*.js', 'cloud-server/*.cjs', 'cloud-server/*.mjs', ':!cloud-server/tests',
  ], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stdout || result.stderr);
});
