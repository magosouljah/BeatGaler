import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCanaryConfig, runPublicCanary } from '../scripts/v1-public-canary.mjs';

const sha = 'a'.repeat(40);
const env = { V1_PUBLIC_CANARY_ACK: 'READ_ONLY_NO_CHARGES', V1_EXPECTED_SOURCE_SHA: sha,
  V1_PUBLIC_WEB_ORIGIN: 'https://beatgaler.com', V1_PUBLIC_CLOUD_ORIGIN: 'https://api.beatgaler.com' };
const ready = { ok: true, environment: 'production', sourceSha: sha,
  status: 'ready', dependencies: { postgres: 'ready' } };

test('public canary refuses absent acknowledgement, local origins and imprecise SHA', () => {
  assert.throws(() => validateCanaryConfig({ ...env, V1_PUBLIC_CANARY_ACK: '' }), /ACK/);
  assert.throws(() => validateCanaryConfig({ ...env, V1_PUBLIC_WEB_ORIGIN: 'http://localhost:1420' }), /TLS/);
  assert.throws(() => validateCanaryConfig({ ...env, V1_EXPECTED_SOURCE_SHA: 'a'.repeat(7) }), /exact/);
});

test('public canary probes only allowlisted GET URLs and checks exact Web/Cloud SHA', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push([url, options]);
    const body = url.endsWith('/web-health') ? 'ok' :
      url.endsWith('/source-sha.txt') ? sha : ready;
    return { status: 200, text: async () => body, json: async () => body };
  };
  const report = await runPublicCanary(validateCanaryConfig(env), fetcher);
  assert.equal(report.result, 'PASS');
  assert.equal(report.financialMutation, false);
  assert.equal(seen.length, 5);
  for (const [url, options] of seen) {
    assert.match(url, /^https:\/\/(beatgaler|api\.beatgaler)\.com\//);
    assert.equal(options.method, undefined);
    assert.equal(options.redirect, 'error');
  }
  await assert.rejects(() => runPublicCanary(validateCanaryConfig(env), async (url, options) => {
    const response = await fetcher(url, options);
    if (url.endsWith('/readyz')) response.json = async () => ({ ...ready, sourceSha: 'b'.repeat(40) });
    return response;
  }), /SHA mismatch/);
});
