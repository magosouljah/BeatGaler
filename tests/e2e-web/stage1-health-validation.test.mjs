import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthHealth } from './stage1-health-validation.mjs';
const entry = phase => ({ route:'/beatgaler-api/auth/health', state:'response', status:200, harness_phase:phase, duration_ms:10 });
const healthy = [entry('submitting-sign-in'),entry('simultaneous-reload')];
test('successful final UI cannot hide a timed-out health probe', () => {
  assert.throws(() => validateAuthHealth([...healthy,{...entry('simultaneous-reload'),state:'aborted',status:null,duration_ms:1501}], '01'), {code:'STAGE1_HEALTH_UNSTABLE'});
});
test('health requires successful login and reload observations', () => {
  assert.doesNotThrow(() => validateAuthHealth(healthy, '01'));
  assert.throws(() => validateAuthHealth([healthy[0]], '01'), {code:'STAGE1_HEALTH_UNPROVEN'});
  assert.throws(() => validateAuthHealth([...healthy,{...healthy[0],status:503}], '01'), {code:'STAGE1_HEALTH_UNSTABLE'});
});
