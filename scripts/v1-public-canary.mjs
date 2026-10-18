#!/usr/bin/env node
// Read-only public canary. No account creation, checkout, or provider mutation.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertPublicHttpsOrigin } from '../cloud-server/deployment-promotion-contract.mjs';

const SHA = /^[0-9a-f]{40}$/;

export function validateCanaryConfig(env = process.env) {
  if (env.V1_PUBLIC_CANARY_ACK !== 'READ_ONLY_NO_CHARGES') {
    throw new Error('V1_PUBLIC_CANARY_ACK=READ_ONLY_NO_CHARGES is required.');
  }
  const sourceSha = String(env.V1_EXPECTED_SOURCE_SHA || '');
  if (!SHA.test(sourceSha)) throw new Error('V1_EXPECTED_SOURCE_SHA must be an exact Git SHA.');
  const webOrigin = assertPublicHttpsOrigin(env.V1_PUBLIC_WEB_ORIGIN, 'Web origin');
  const cloudOrigin = assertPublicHttpsOrigin(env.V1_PUBLIC_CLOUD_ORIGIN, 'Cloud origin');
  if (webOrigin !== 'https://beatgaler.com' || cloudOrigin !== 'https://api.beatgaler.com') {
    throw new Error('V1 public origins must match the production Web and Cloud origins.');
  }
  return { sourceSha, webOrigin, cloudOrigin };
}

async function get(fetcher, url) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Cache-Control': 'no-cache' } });
  if (response.status !== 200) throw new Error(`Public canary received HTTP ${response.status}.`);
  return response;
}

export async function runPublicCanary(config, fetcher = fetch) {
  const webHealth = (await (await get(fetcher, `${config.webOrigin}/web-health`)).text()).trim();
  if (webHealth !== 'ok') throw new Error('Web health marker mismatch.');
  const webSha = (await (await get(fetcher, `${config.webOrigin}/.well-known/source-sha.txt`)).text()).trim();
  if (webSha !== config.sourceSha) throw new Error('Web source SHA mismatch.');
  const results = {};
  for (const [name, url] of [
    ['cloudHealth', `${config.cloudOrigin}/healthz`],
    ['cloudReady', `${config.cloudOrigin}/readyz`],
    ['webProxyReady', `${config.webOrigin}/beatgaler-api/readyz`],
  ]) {
    const body = await (await get(fetcher, url)).json();
    if (body?.ok !== true || body?.environment !== 'production' || body?.sourceSha !== config.sourceSha) {
      throw new Error(`${name} environment or source SHA mismatch.`);
    }
    if (name !== 'cloudHealth' && (body.status !== 'ready' || body.dependencies?.postgres !== 'ready')) {
      throw new Error(`${name} PostgreSQL readiness mismatch.`);
    }
    results[name] = 'PASS';
  }
  return { kind: 'V1_PUBLIC_READ_ONLY_CANARY', result: 'PASS', sourceSha: config.sourceSha,
    webOrigin: config.webOrigin, cloudOrigin: config.cloudOrigin, webHealth: 'PASS',
    webSource: 'PASS', ...results, accountsTested: false, financialMutation: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const config = validateCanaryConfig();
    console.log(JSON.stringify(await runPublicCanary(config), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ kind: 'V1_PUBLIC_READ_ONLY_CANARY', result: 'FAIL',
      reason: error?.message || String(error) }));
    process.exitCode = 2;
  }
}
