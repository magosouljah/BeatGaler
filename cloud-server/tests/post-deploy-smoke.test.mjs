import test from 'node:test';
import assert from 'node:assert/strict';
import { runPostDeploySmoke } from '../scripts/post-deploy-smoke.mjs';

const sha = 'a'.repeat(40);
const origin = 'https://api.beatgaler.com';
const fetcher = async url => ({
  ok: true, status: 200,
  json: async () => ({ ok: true, environment: 'production', sourceSha: sha,
    ...(url.endsWith('/readyz') ? { status: 'ready', dependencies: { postgres: 'ready' } } : { status: 'live' }) }),
});

test('deploy smoke confirms health, readiness, environment and exact SHA', async () => {
  const result = await runPostDeploySmoke({ origin, expectedSha: sha, fetcher });
  assert.equal(result.smoke, 'PASS');
  assert.equal(result.results['/readyz'].sourceSha, sha);
});

test('deploy smoke refuses a healthy but stale or development Cloud', async () => {
  for (const body of [
    { ok: true, environment: 'development', sourceSha: sha, status: 'ready', dependencies: { postgres: 'ready' } },
    { ok: true, environment: 'production', sourceSha: 'b'.repeat(40), status: 'ready', dependencies: { postgres: 'ready' } },
    { ok: true, environment: 'production', sourceSha: sha, status: 'ready', dependencies: { postgres: 'missing' } },
  ]) {
    await assert.rejects(() => runPostDeploySmoke({ origin, expectedSha: sha,
      fetcher: async () => ({ ok: true, status: 200, json: async () => body }),
    }));
  }
});
