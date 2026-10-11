// Read-only external probe. No credentials, writes, checkout, or privileged endpoints.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_ORIGIN = 'https://beatgaler.com';

export async function probePublicLaunch({ origin = DEFAULT_ORIGIN, expectedSha, fetcher = fetch } = {}) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Origin must be a bare HTTPS origin.');
  }
  if (!/^[0-9a-f]{40}$/.test(expectedSha || '')) throw new Error('Expected source SHA must be 40 lowercase hex characters.');
  const checks = [];
  async function request(path, label, validate, asJson = true) {
    try {
      const response = await fetcher(new URL(path, base), {
        method: 'GET', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10_000),
      });
      const body = asJson ? await response.json() : (await response.text()).trim();
      const result = validate(body);
      checks.push({ label, ok: response.ok && result.ok, httpStatus: response.status, observation: result.observation });
    } catch (error) {
      checks.push({ label, ok: false, observation: error?.name === 'TimeoutError' ? 'timeout' : 'unavailable_or_invalid_response' });
    }
  }
  await request('/.well-known/source-sha.txt', 'web_source_sha', value => ({
    ok: value === expectedSha, observation: value,
  }), false);
  await request('/web-health', 'web_health', value => ({ ok: value === 'ok', observation: value }), false);
  await request('/beatgaler-api/readyz', 'api_ready', value => ({
    ok: value?.ok === true && value?.status === 'ready' && value?.dependencies?.postgres === 'ready' &&
      value?.dependencies?.billing === 'ready' && value?.dependencies?.project === 'ready' &&
      value?.environment === 'production',
    observation: { status: value?.status || null, postgres: value?.dependencies?.postgres || null,
      billing: value?.dependencies?.billing || null, project: value?.dependencies?.project || null,
      environment: value?.environment || null },
  }));
  await request('/beatgaler-api/auth/health', 'account_and_master', value => ({
    ok: value?.ok === true && value?.account_auth === true && value?.master_storage_ready === true,
    observation: { accountAuth: value?.account_auth === true, masterStorageReady: value?.master_storage_ready === true },
  }));
  return { origin: base.origin, expectedSha, passed: checks.every(check => check.ok), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2] || DEFAULT_ORIGIN;
  const expectedSha = process.argv[3] || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  try {
    const report = await probePublicLaunch({ origin, expectedSha });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
