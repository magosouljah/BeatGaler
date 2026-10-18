import { assertPublicHttpsOrigin } from '../deployment-promotion-contract.mjs';

export async function runPostDeploySmoke({ origin, expectedSha, fetcher = fetch }) {
  const apiOrigin = assertPublicHttpsOrigin(origin);
  if (!/^[0-9a-f]{40}$/.test(expectedSha ?? '')) throw new Error('BEATGALER_EXPECTED_SOURCE_SHA must be exact');
  const results = {};
  for (const path of ['/healthz', '/readyz']) {
    const response = await fetcher(`${apiOrigin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${path} smoke failed with HTTP ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true || body?.environment !== 'production' || body?.sourceSha !== expectedSha) {
      throw new Error(`${path} returned a mismatched production environment or source SHA`);
    }
    if (path === '/readyz' && (body.status !== 'ready' || body.dependencies?.postgres !== 'ready')) {
      throw new Error('/readyz did not confirm PostgreSQL readiness');
    }
    results[path] = { status: response.status, environment: body.environment, sourceSha: body.sourceSha };
  }
  return { smoke: 'PASS', origin: apiOrigin, sourceSha: expectedSha, results };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  runPostDeploySmoke({ origin: process.env.BEATGALER_API_ORIGIN, expectedSha: process.env.BEATGALER_EXPECTED_SOURCE_SHA })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error?.message || String(error)); process.exitCode = 1; });
}
