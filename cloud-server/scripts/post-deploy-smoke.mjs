import { assertPublicHttpsOrigin } from '../deployment-promotion-contract.mjs';

const origin = assertPublicHttpsOrigin(process.env.BEATGALER_API_ORIGIN);
const expectedSha = process.env.BEATGALER_EXPECTED_SOURCE_SHA;
if (!/^[0-9a-f]{40}$/.test(expectedSha ?? '')) throw new Error('BEATGALER_EXPECTED_SOURCE_SHA must be exact');

for (const path of ['/healthz', '/readyz']) {
  const response = await fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${path} smoke failed with HTTP ${response.status}`);
}

console.log(JSON.stringify({ smoke: 'PASS', origin, sourceSha: expectedSha }));
