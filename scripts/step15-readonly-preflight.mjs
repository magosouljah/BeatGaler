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

function projectIngressAllowsCommercialCeiling(config) {
  return /location\s*=\s*\/beatgaler-api\/transport\/project\/upload\s*\{[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:4000\/transport\/project\/upload\s*;[\s\S]*?client_max_body_size\s+2g\s*;/m.test(config);
}

function genericApiRemainsSmall(config) {
  return /location\s+\/beatgaler-api\/\s*\{[^}]*client_max_body_size\s+2m\s*;/s.test(config);
}

const nginx = source('deploy/web/beatgaler.com.conf');
const nginxBootstrap = source('deploy/web/beatgaler.com.bootstrap.conf');
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
  nginxProjectUpload2GiB: projectIngressAllowsCommercialCeiling(nginx),
  nginxBootstrapProjectUpload2GiB: projectIngressAllowsCommercialCeiling(nginxBootstrap),
  nginxApiDefault2MiB: genericApiRemainsSmall(nginx) && genericApiRemainsSmall(nginxBootstrap),
  billingSandboxOnly: billing.includes("env.BILLING_PROVIDER_ENVIRONMENT !== 'sandbox'"),
  settingsSubscriptionChangesUnavailable: settings.includes('Subscription changes are not yet available in Web'),
};

const violations = [];
if (!facts.projectUsesCloudMultipart) violations.push('PROJECT_WEB_MULTIPART_ROUTE_MISSING');
if (!facts.nginxProjectUpload2GiB) violations.push('PROJECT_INGRESS_FINAL_BELOW_COMMERCIAL_CEILING');
if (!facts.nginxBootstrapProjectUpload2GiB) violations.push('PROJECT_INGRESS_BOOTSTRAP_BELOW_COMMERCIAL_CEILING');
if (!facts.nginxApiDefault2MiB) violations.push('GENERIC_API_BODY_LIMIT_WIDENED');

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
  note: 'No financial, Telegram, backup, or production infrastructure state is proven by this report.',
};
console.log(JSON.stringify(report, null, 2));
if (violations.length > 0) process.exitCode = 2;
