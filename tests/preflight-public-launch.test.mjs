import test from 'node:test';
import assert from 'node:assert/strict';
import { probePublicLaunch } from '../scripts/preflight-public-launch.mjs';

const sha = 'a'.repeat(40);
function fakeFetch(environment = 'production', sourceSha = sha) {
  return async url => {
    const path = new URL(url).pathname;
    const data = {
      '/.well-known/source-sha.txt': sourceSha,
      '/web-health': 'ok',
      '/beatgaler-api/readyz': { ok: true, status: 'ready', dependencies: { postgres: 'ready', billing: 'ready', project: 'ready' }, environment },
      '/beatgaler-api/auth/health': { ok: true, account_auth: true, master_storage_ready: true },
    }[path];
    return { ok: true, status: 200, async json() { return data; }, async text() { return data; } };
  };
}

test('public probe passes only matching release and productive dependency state', async () => {
  assert.equal((await probePublicLaunch({ expectedSha: sha, fetcher: fakeFetch() })).passed, true);
  const report = await probePublicLaunch({ expectedSha: sha, fetcher: fakeFetch('development', 'b'.repeat(40)) });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.filter(check => !check.ok).map(check => check.label), ['web_source_sha', 'api_ready']);
});

test('public probe rejects non-HTTPS origins before contacting them', async () => {
  await assert.rejects(probePublicLaunch({ origin: 'http://beatgaler.com', expectedSha: sha,
    fetcher: () => { throw new Error('must not call'); } }));
});
