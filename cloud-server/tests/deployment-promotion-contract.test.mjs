import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePromotion, validateRollback } from '../deployment-promotion-contract.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('PR preview preserves exact SHA and public TLS origin', () => {
  assert.equal(validatePromotion({ sourceSha: A, artifactSha: A, target: 'preview', trigger: 'pull_request', apiOrigin: 'https://preview-api.example.test', requiredHeaders: { 'X-BeatGaler-Env': 'preview' } }).sourceSha, A);
});

test('candidate tag promotes same SHA to staging', () => {
  assert.equal(validatePromotion({ sourceSha: A, artifactSha: A, target: 'staging', trigger: 'candidate_tag', apiOrigin: 'https://staging-api.example.test' }).target, 'staging');
});

test('production requires explicit approval', () => {
  assert.throws(() => validatePromotion({ sourceSha: A, artifactSha: A, target: 'production', trigger: 'approval', approved: false, apiOrigin: 'https://api.example.test' }));
  assert.equal(validatePromotion({ sourceSha: A, artifactSha: A, target: 'production', trigger: 'approval', approved: true, apiOrigin: 'https://api.example.test' }).target, 'production');
});

test('release origin fails closed for local, tailscale, http and SHA drift', () => {
  for (const apiOrigin of ['http://api.example.test', 'https://localhost:3000', 'https://service.ts.net']) {
    assert.throws(() => validatePromotion({ sourceSha: A, artifactSha: A, target: 'staging', trigger: 'candidate_tag', apiOrigin }));
  }
  assert.throws(() => validatePromotion({ sourceSha: A, artifactSha: B, target: 'staging', trigger: 'candidate_tag', apiOrigin: 'https://staging-api.example.test' }));
});

test('rollback requires previous artifact, DB compatibility and passing smoke', () => {
  assert.deepEqual(validateRollback({ currentSha: A, previousSha: B, databaseCompatibility: 'compatible', smokePassed: true }), { rollbackTo: B });
  assert.throws(() => validateRollback({ currentSha: A, previousSha: B, databaseCompatibility: 'unknown', smokePassed: true }));
  assert.throws(() => validateRollback({ currentSha: A, previousSha: B, databaseCompatibility: 'compatible', smokePassed: false }));
});
