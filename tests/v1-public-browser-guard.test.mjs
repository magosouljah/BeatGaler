import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicBrowserEnv } from '../scripts/v1-public-browser-guard.mjs';

const env = { V1_PUBLIC_CANARY_ACK: 'READ_ONLY_NO_CHARGES', V1_EXPECTED_SOURCE_SHA: 'a'.repeat(40),
  V1_PUBLIC_WEB_ORIGIN: 'https://beatgaler.com', V1_PUBLIC_CLOUD_ORIGIN: 'https://api.beatgaler.com',
  V1_PUBLIC_BROWSER_ACK: 'ACCOUNT_LOGIN_ONLY', V1_PUBLIC_ACCOUNT_DISPOSABLE: '1',
  V1_PUBLIC_ACCOUNT_IDENTIFIER: 'disposable@example.invalid', V1_PUBLIC_ACCOUNT_PASSWORD: 'redacted',
  V1_PUBLIC_RUN_ID: 'v1-public-20261017-a' };

test('public browser guard requires explicit disposable account and confines artifacts', () => {
  const result = validatePublicBrowserEnv(env, '/workspace');
  assert.equal(result.runDir, '/workspace/tmp/v1-public/v1-public-20261017-a');
  assert(!JSON.stringify(result).includes('redacted'));
  assert.throws(() => validatePublicBrowserEnv({ ...env, V1_PUBLIC_ACCOUNT_DISPOSABLE: '' }, '/workspace'), /DISPOSABLE/);
  assert.throws(() => validatePublicBrowserEnv({ ...env, V1_PUBLIC_RUN_ID: '../step14' }, '/workspace'), /RUN_ID/);
  assert.throws(() => validatePublicBrowserEnv({ ...env, V1_PUBLIC_BROWSER_ACK: '' }, '/workspace'), /BROWSER_ACK/);
  assert.equal(validatePublicBrowserEnv({ ...env, V1_PUBLIC_EXPECTED_PLAN: 'free' }, '/workspace').expectedPlan, 'free');
  assert.throws(() => validatePublicBrowserEnv({ ...env, V1_PUBLIC_EXPECTED_PLAN: 'annual' }, '/workspace'), /EXPECTED_PLAN/);
});
