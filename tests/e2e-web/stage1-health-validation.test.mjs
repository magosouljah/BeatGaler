import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthHealth } from './stage1-health-validation.mjs';
const entry = phase => ({ route:'/beatgaler-api/auth/health', state:'response', status:200, harness_phase:phase, duration_ms:10 });
test('successful final UI cannot hide an observed timed-out health probe', () => {
  assert.throws(() => validateAuthHealth([{...entry('simultaneous-reload'),state:'aborted',status:null,duration_ms:1501}], '01'), {code:'STAGE1_HEALTH_UNSTABLE'});
});
test('Web auth does not require health preflights, but any observed health failure remains fatal', () => {
  assert.deepEqual(validateAuthHealth([], '01'), {observed:0, successful:0});
  assert.deepEqual(validateAuthHealth([entry('diagnostic')], '01'), {observed:1, successful:1});
  assert.throws(() => validateAuthHealth([{...entry('diagnostic'),status:503}], '01'), {code:'STAGE1_HEALTH_UNSTABLE'});
});
