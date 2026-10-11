#!/usr/bin/env node
// Read-only Phase 3 handoff. It never loads .env files or connects to PostgreSQL,
// Telegram, Polar, or the STEP 14 run directories.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
if (process.argv.some(arg => arg !== '--live' && arg !== process.argv[0] && arg !== process.argv[1])) {
  console.error('usage: node scripts/step15-readonly-preflight.mjs [--live]');
  process.exit(64);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function source(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function projectIngressReady(config) {
  const match = config.match(/location\s*=\s*\/beatgaler-api\/transport\/project\/upload\s*\{([\s\S]*?)\n\s*\}/m);
  const block = match?.[1] || '';
  return /proxy_pass\s+http:\/\/127\.0\.0\.1:4000\/transport\/project\/upload\s*;/.test(block) &&
    /proxy_request_buffering\s+off\s*;/.test(block) &&
    /client_body_timeout\s+30m\s*;/.test(block) &&
    /proxy_read_timeout\s+30m\s*;/.test(block) &&
    /proxy_send_timeout\s+30m\s*;/.test(block) &&
    /send_timeout\s+30m\s*;/.test(block) &&
    /client_max_body_size\s+2g\s*;/.test(block);
}

function genericApiRemainsSmall(config) {
  return /location\s+\/beatgaler-api\/\s*\{[^}]*client_max_body_size\s+2m\s*;/s.test(config);
}

function runtimeAllowsProjectWindow(runtime) {
  return /BEATGALER_HTTP_REQUEST_TIMEOUT_MS[\s\S]*?1000,\s*1800000/.test(runtime) &&
    /BEATGALER_HTTP_SOCKET_TIMEOUT_MS[\s\S]*?1000,\s*1800000/.test(runtime);
}

function projectUploadAdmissionReady(admission, envExample, route) {
  return /DEFAULT_MAX_CONCURRENT\s*=\s*1/.test(admission) &&
    /DEFAULT_TEMP_BUDGET_BYTES\s*=\s*2_000_000_000/.test(admission) &&
    /BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT/.test(admission) &&
    /BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES/.test(admission) &&
    /PROJECT_UPLOAD_BUSY/.test(admission) &&
    /BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT=1/.test(envExample) &&
    /BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES=2000000000/.test(envExample) &&
    /BEATGALER_PROJECT_UPLOAD_TEMP_DIR/.test(route) &&
    /BEATGALER_PROJECT_UPLOAD_TEMP_DIR=\.\/uploads-tmp\//.test(envExample);
}

const nginx = source('deploy/web/beatgaler.com.conf');
const nginxBootstrap = source('deploy/web/beatgaler.com.bootstrap.conf');
const runtime = source('cloud-server/runtime-operability.js');
const admission = source('cloud-server/project-upload-admission.js');
const projectRoute = source('cloud-server/project-upload-route.js');
const envExample = source('cloud-server/.env.example');
const billing = source('cloud-server/billing-web-runtime.js');
const settings = source('src/components/SettingsPanel.tsx');
const smoke = source('tests/e2e-web/web-smoke.e2e.mjs');
const upload = source('src/features/cloud/webTransportSession.ts');
const facts = {
  step14SourceSha: 'bafacba9c6b03948f6081831a7f58723d4467092',
  candidateSha: git('rev-parse', 'HEAD'),
  branch: git('branch', '--show-current'),
  changedPaths: git('status', '--porcelain', '--untracked-files=all').split(/\r?\n/).filter(Boolean).map(line => line.slice(3)),
  migration0018Present: existsSync(resolve(root, 'cloud-server/migrations/0018_library_trash_purge.sql')),
  stage1RealHarnessPresent: existsSync(resolve(root, 'tests/e2e-web/stage1-real-multi-account.e2e.mjs')),
  webSmokeMountOnly: smoke.includes('root.childElementCount > 0') && !smoke.includes('/billing/checkout'),
  projectUsesCloudMultipart: upload.includes('/transport/project/upload') && upload.includes('new FormData()'),
  nginxProjectUploadStreamed30m: projectIngressReady(nginx),
  nginxBootstrapProjectUploadStreamed30m: projectIngressReady(nginxBootstrap),
  nginxApiDefault2MiB: genericApiRemainsSmall(nginx) && genericApiRemainsSmall(nginxBootstrap),
  runtimeProjectTimeout30mOptIn: runtimeAllowsProjectWindow(runtime),
  projectUploadAdmissionBounded: projectUploadAdmissionReady(admission, envExample, projectRoute),
  projectUploadAdmissionTestPresent: existsSync(resolve(root, 'cloud-server/tests/project-upload-admission.test.cjs')),
  projectIngressSmokePresent: existsSync(resolve(root, 'scripts/step15-project-ingress-smoke.mjs')),
  projectCloudRouteSmokePresent: existsSync(resolve(root, 'cloud-server/scripts/step15-project-route-smoke.cjs')),
  projectProxyRouteSmokePresent: existsSync(resolve(root, 'cloud-server/scripts/step15-project-proxy-route-smoke.cjs')),
  isolatedEnvGuardPresent: existsSync(resolve(root, 'scripts/step15-isolated-env-guard.mjs')),
  isolatedEnvGuardTestPresent: existsSync(resolve(root, 'tests/step15-isolated-env-guard.test.mjs')),
  billingSandboxOnly: billing.includes("env.BILLING_PROVIDER_ENVIRONMENT !== 'sandbox'"),
  settingsSubscriptionChangesUnavailable: settings.includes('Subscription changes are not yet available in Web'),
};

const violations = [];
if (!facts.projectUsesCloudMultipart) violations.push('PROJECT_WEB_MULTIPART_ROUTE_MISSING');
if (!facts.nginxProjectUploadStreamed30m) violations.push('PROJECT_INGRESS_FINAL_NOT_STREAMED_30M');
if (!facts.nginxBootstrapProjectUploadStreamed30m) violations.push('PROJECT_INGRESS_BOOTSTRAP_NOT_STREAMED_30M');
if (!facts.nginxApiDefault2MiB) violations.push('GENERIC_API_BODY_LIMIT_WIDENED');
if (!facts.runtimeProjectTimeout30mOptIn) violations.push('PROJECT_RUNTIME_TIMEOUT_CAP_BELOW_BROWSER_WINDOW');
if (!facts.projectUploadAdmissionBounded) violations.push('PROJECT_UPLOAD_TEMP_ADMISSION_MISSING');
if (!facts.projectUploadAdmissionTestPresent) violations.push('PROJECT_UPLOAD_ADMISSION_TEST_MISSING');
if (!facts.projectIngressSmokePresent) violations.push('PROJECT_INGRESS_SMOKE_MISSING');
if (!facts.projectCloudRouteSmokePresent) violations.push('PROJECT_CLOUD_ROUTE_SMOKE_MISSING');
if (!facts.projectProxyRouteSmokePresent) violations.push('PROJECT_PROXY_ROUTE_SMOKE_MISSING');
if (!facts.isolatedEnvGuardPresent) violations.push('STEP15_ISOLATED_ENV_GUARD_MISSING');
if (!facts.isolatedEnvGuardTestPresent) violations.push('STEP15_ISOLATED_ENV_GUARD_TEST_MISSING');

async function getPublic(path) {
  const url = `https://beatgaler.com${path}`;
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Cache-Control': 'no-cache' } });
    if (path.endsWith('source-sha.txt')) {
      const body = (await response.text()).trim();
      return { httpStatus: response.status, sourceSha: /^[0-9a-f]{40}$/.test(body) ? body : 'INVALID_MARKER' };
    }
    const body = await response.json();
    return { httpStatus: response.status, ready: body?.ok === true && body?.status === 'ready',
      environment: typeof body?.environment === 'string' ? body.environment : 'UNKNOWN',
      postgres: typeof body?.dependencies?.postgres === 'string' ? body.dependencies.postgres : 'UNKNOWN' };
  } catch (error) {
    return { state: 'UNVERIFIED', error: error?.name || 'FETCH_FAILED' };
  }
}

const report = {
  kind: 'STEP15_READONLY_PREFLIGHT',
  proof: 'REPO_AND_OPTIONAL_PUBLIC_HTTP_ONLY',
  checkedAtUtc: new Date().toISOString(),
  ...facts,
  violations,
  ...(live ? { publicHttp: {
    webSource: await getPublic('/.well-known/source-sha.txt'),
    apiReady: await getPublic('/beatgaler-api/readyz'),
  } } : {}),
  note: 'STEP15 isolated/non-financial work may proceed while STEP14 remains PARTIAL, but Phase 3 cannot close until the remaining STEP14 financial gate is resolved. PROJECT defaults admit one upload and reserve up to 2,000,000,000 temporary bytes; STEP15 must use a run-specific temp directory and the isolated-env guard before starting Cloud. The 30 minute runtime timeout remains opt-in. This report does not inspect deployment secrets or environment variables. Local PROJECT smokes use simulated publishers and prove no financial, Telegram, backup, or production infrastructure state.',
};
console.log(JSON.stringify(report, null, 2));
if (violations.length > 0) process.exitCode = 2;
