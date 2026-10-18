#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { readPolarProductionConfig } = require('../cloud-server/billing-polar-sandbox.js');
const { alertRoute } = require('../cloud-server/operations-observability.js');
const SHA = /^[0-9a-f]{40}$/;
const alertConditions = [
  'auth_failure_spike', 'api_error_spike', 'postgres_unavailable',
  'billing_reconciliation_exception', 'provider_failure', 'pool_exhausted',
  'queue_backlog', 'release_failure', 'backup_failure', 'direct_unavailable',
  'master_upload_failure', 'project_failure', 'index_publish_failure',
  'billing_webhook_failure', 'api_latency_spike', 'migration_failure',
  'temp_storage_pressure',
];
const requiredSecrets = [
  'DATABASE_URL', 'BEATGALER_AWS_SECRET_ENVELOPE_ID', 'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET', 'X_CLIENT_ID', 'X_CLIENT_SECRET',
  'AWS_REGION', 'BEATGALER_SES_REGION', 'BEATGALER_SES_FROM_EMAIL',
  'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'MANAGER_BOT_TOKEN_1',
];

function isPublicHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      Boolean(url.hostname) && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(url.hostname) &&
      !/\.(localhost|test|invalid)$/i.test(url.hostname);
  } catch { return false; }
}

export function assessProductionEnv(env = process.env, expectedSourceSha = null) {
  const missing = requiredSecrets.filter(name => !String(env[name] || '').trim());
  const invalid = [];
  const equal = (name, expected) => {
    if (String(env[name] || '').trim() !== expected) invalid.push(name);
  };
  equal('NODE_ENV', 'production');
  equal('BEATGALER_DEPLOYMENT_ENV', 'production');
  equal('BEATGALER_POSTGRES_ENABLED', 'true');
  equal('BEATGALER_CONTROL_PLANE_AUTHORITY', 'postgres');
  equal('BEATGALER_POSTGRES_SSL_MODE', 'require');
  equal('BEATGALER_SECRET_ENVELOPE_PROVIDER', 'aws-secrets-manager');
  equal('BEATGALER_DIRECT_TRANSPORT', 'true');
  equal('BEATGALER_DIRECT_REQUIRED', 'true');
  equal('BILLING_PROVIDER_ENVIRONMENT', 'production');
  equal('BEATGALER_HTTP_REQUEST_TIMEOUT_MS', '1800000');
  equal('BEATGALER_HTTP_SOCKET_TIMEOUT_MS', '1800000');
  if (!SHA.test(String(env.BEATGALER_SOURCE_SHA || ''))) invalid.push('BEATGALER_SOURCE_SHA');
  else if (expectedSourceSha && env.BEATGALER_SOURCE_SHA !== expectedSourceSha) invalid.push('BEATGALER_SOURCE_SHA_MISMATCH');
  if (!/^[0-9a-f]{64}$/.test(String(env.BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256 || ''))) {
    invalid.push('BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256');
  }
  const webOrigin = String(env.BILLING_WEB_ORIGIN || '');
  const cloudOrigin = String(env.BEATGALER_OAUTH_PUBLIC_BASE || '');
  if (webOrigin !== 'https://beatgaler.com') invalid.push('BILLING_WEB_ORIGIN');
  if (!isPublicHttps(cloudOrigin) || cloudOrigin !== 'https://api.beatgaler.com') invalid.push('BEATGALER_OAUTH_PUBLIC_BASE');
  if (!String(env.BEATGALER_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).includes(webOrigin)) {
    invalid.push('BEATGALER_ALLOWED_ORIGINS');
  }
  try {
    const db = new URL(String(env.DATABASE_URL || ''));
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname ||
        /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(db.hostname) ||
        /\.(localhost|test|invalid)$/i.test(db.hostname)) invalid.push('DATABASE_URL');
  } catch { if (!missing.includes('DATABASE_URL')) invalid.push('DATABASE_URL'); }
  const temp = String(env.BEATGALER_PROJECT_UPLOAD_TEMP_DIR || '');
  if (!temp.startsWith('/') || /(^|\/)(tmp|uploads-tmp)(\/|$)/.test(temp)) {
    invalid.push('BEATGALER_PROJECT_UPLOAD_TEMP_DIR');
  }
  const budget = Number(env.BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES);
  const concurrent = Number(env.BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT);
  if (!Number.isSafeInteger(budget) || budget < 2_000_000_000 ||
      !Number.isSafeInteger(concurrent) || concurrent < 1 || concurrent > 8) {
    invalid.push('BEATGALER_PROJECT_UPLOAD_BUDGET');
  }
  if (!String(env.BEATGALER_MASTER_SESSION || '').trim() && !String(env.MASTER_SESSION_FILE || '').trim()) {
    missing.push('BEATGALER_MASTER_SESSION_OR_MASTER_SESSION_FILE');
  }
  for (const name of ['MASTERS_FILE', 'VAULT_REGISTRY_FILE', 'TRANSPORT_BOTS_FILE', 'TRANSPORT_POOL_STATE']) {
    if (!String(env[name] || '').trim()) missing.push(name);
  }
  if (String(env.BEATGALER_SECRET_ENVELOPE_KEY_B64 || '').trim()) invalid.push('BEATGALER_SECRET_ENVELOPE_KEY_B64');
  for (const condition of alertConditions) {
    if (!alertRoute(condition, env).routable) invalid.push(`ALERT_ROUTE_${condition}`);
  }
  try { readPolarProductionConfig(env); }
  catch { invalid.push('POLAR_PRODUCTION_CONFIG'); }
  return Object.freeze({
    ready: missing.length === 0 && invalid.length === 0,
    missing: [...new Set(missing)].sort(),
    invalid: [...new Set(invalid)].sort(),
    providerNetworkChecked: false,
    credentialValuesExposed: false,
  });
}

export function assessStatic(sourceRoot = root) {
  const read = path => readFileSync(join(sourceRoot, path), 'utf8');
  const checks = {
    webNginx: /location = \/beatgaler-api\/transport\/project\/upload/.test(read('deploy/web/beatgaler.com.conf')) &&
      /proxy_request_buffering off/.test(read('deploy/web/beatgaler.com.conf')) &&
      /client_max_body_size 2g/.test(read('deploy/web/beatgaler.com.conf')),
    webShaMarker: /source-sha\.txt/.test(read('deploy/web/install-web-production.sh')),
    cloudRuntime: /BEATGALER_DEPLOYMENT_ENV/.test(read('cloud-server/runtime-operability.js')) &&
      /\/readyz/.test(read('cloud-server/runtime-operability.js')),
    cloudCutover: /BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256/.test(read('cloud-server/control-plane-authority.js')) &&
      /resolveSecretEnvelopeKeyring/.test(read('cloud-server/control-plane-cutover-runtime.js')),
    productionPolar: /POLAR_PRODUCTION_/.test(read('cloud-server/billing-polar-sandbox.js')),
    portalRoute: /\/billing\/portal/.test(read('cloud-server/server-core.js')),
    migration0018: existsSync(join(sourceRoot, 'cloud-server/migrations/0018_library_trash_purge.sql')),
    noMachineLanLog: !/192\.168\.86\.98/.test(read('cloud-server/server-core.js')),
    envTemplate: /POLAR_PRODUCTION_ACCESS_TOKEN/.test(read('cloud-server/.env.example')) &&
      /BEATGALER_AWS_SECRET_ENVELOPE_ID/.test(read('cloud-server/.env.example')),
  };
  return { ready: Object.values(checks).every(Boolean), checks };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--static', '--production-env'].includes(args[0])) {
    console.error('usage: node scripts/v1-deploy-preflight.mjs --static | --production-env');
    process.exit(64);
  }
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const sourceTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
  const result = args[0] === '--static' ? assessStatic() : assessProductionEnv(process.env, headSha);
  const effective = args[0] === '--production-env' && sourceTreeDirty
    ? { ...result, ready: false, invalid: [...result.invalid, 'SOURCE_TREE_DIRTY'].sort() } : result;
  console.log(JSON.stringify({ kind: 'V1_DEPLOY_PREFLIGHT', mode: args[0], headSha, sourceTreeDirty,
    result: effective.ready ? 'PASS' : 'FAIL', ...effective }, null, 2));
  if (!effective.ready) process.exitCode = 2;
}
