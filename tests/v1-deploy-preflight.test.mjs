import test from 'node:test';
import assert from 'node:assert/strict';
import { assessProductionEnv, assessStatic } from '../scripts/v1-deploy-preflight.mjs';

const production = {
  NODE_ENV: 'production', BEATGALER_DEPLOYMENT_ENV: 'production',
  BEATGALER_POSTGRES_ENABLED: 'true', BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
  BEATGALER_POSTGRES_SSL_MODE: 'require', BEATGALER_SECRET_ENVELOPE_PROVIDER: 'aws-secrets-manager',
  BEATGALER_DIRECT_TRANSPORT: 'true', BEATGALER_DIRECT_REQUIRED: 'true',
  BILLING_PROVIDER_ENVIRONMENT: 'production', BEATGALER_HTTP_REQUEST_TIMEOUT_MS: '1800000',
  BEATGALER_HTTP_SOCKET_TIMEOUT_MS: '1800000', BEATGALER_SOURCE_SHA: 'a'.repeat(40),
  BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: 'b'.repeat(64),
  BILLING_WEB_ORIGIN: 'https://beatgaler.com',
  BEATGALER_OAUTH_PUBLIC_BASE: 'https://api.beatgaler.com',
  BEATGALER_ALLOWED_ORIGINS: 'https://beatgaler.com',
  DATABASE_URL: 'postgresql://user:private@db.beatgaler.com:5432/beatgaler',
  BEATGALER_PROJECT_UPLOAD_TEMP_DIR: '/var/lib/beatgaler/project-upload',
  BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES: '2000000000',
  BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT: '1',
  BEATGALER_MASTER_SESSION: 'private-master-session',
  MASTERS_FILE: '/var/lib/beatgaler/masters.json', VAULT_REGISTRY_FILE: '/var/lib/beatgaler/vaults.json',
  TRANSPORT_BOTS_FILE: '/var/lib/beatgaler/transport-bots.json', TRANSPORT_POOL_STATE: '/var/lib/beatgaler/transport-pool.json',
  BEATGALER_AWS_SECRET_ENVELOPE_ID: 'arn:aws:secretsmanager:region:account:secret:fake', AWS_REGION: 'us-east-1',
  GOOGLE_CLIENT_ID: 'google-id', GOOGLE_CLIENT_SECRET: 'private-google',
  X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'private-x',
  BEATGALER_SES_REGION: 'us-east-1', BEATGALER_SES_FROM_EMAIL: 'support@beatgaler.com',
  TELEGRAM_API_ID: '1234', TELEGRAM_API_HASH: 'private-hash', MANAGER_BOT_TOKEN_1: 'private-manager',
  POLAR_PRODUCTION_ACCESS_TOKEN: 'private-polar', POLAR_PRODUCTION_WEBHOOK_SECRET: 'private-webhook',
  POLAR_PRODUCTION_ORGANIZATION_ID: 'prod-org',
  POLAR_PRODUCTION_PAID_ENTRY_MONTHLY_PRODUCT_ID: 'prod-entry-product',
  POLAR_PRODUCTION_PAID_ENTRY_MONTHLY_PRICE_ID: 'prod-entry-price',
  POLAR_PRODUCTION_HIGHEST_PAID_MONTHLY_PRODUCT_ID: 'prod-high-product',
  POLAR_PRODUCTION_HIGHEST_PAID_MONTHLY_PRICE_ID: 'prod-high-price',
  BEATGALER_ALERT_AUTH_ROUTE: 'ops-auth', BEATGALER_ALERT_API_ROUTE: 'ops-api',
  BEATGALER_ALERT_DB_ROUTE: 'ops-db', BEATGALER_ALERT_BILLING_ROUTE: 'ops-billing',
  BEATGALER_ALERT_PROVIDER_ROUTE: 'ops-provider', BEATGALER_ALERT_POOL_ROUTE: 'ops-pool',
  BEATGALER_ALERT_QUEUE_ROUTE: 'ops-queue', BEATGALER_ALERT_RELEASE_ROUTE: 'ops-release',
  BACKUP_FAILURE_ALERT_ROUTE: 'ops-backup',
  BEATGALER_ALERT_DIRECT_ROUTE: 'ops-direct', BEATGALER_ALERT_MASTER_ROUTE: 'ops-master',
  BEATGALER_ALERT_PROJECT_ROUTE: 'ops-project', BEATGALER_ALERT_INDEX_ROUTE: 'ops-index',
  BEATGALER_ALERT_WEBHOOK_ROUTE: 'ops-webhook', BEATGALER_ALERT_LATENCY_ROUTE: 'ops-latency',
  BEATGALER_ALERT_MIGRATION_ROUTE: 'ops-migration', BEATGALER_ALERT_TEMP_ROUTE: 'ops-temp',
};

test('static deployment wiring includes production Polar, portal, migrations, and no machine LAN log', () => {
  const result = assessStatic();
  assert.equal(result.ready, true, JSON.stringify(result.checks));
});

test('production environment preflight accepts a complete isolated configuration without contacting providers', () => {
  const result = assessProductionEnv(production, 'a'.repeat(40));
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(result.providerNetworkChecked, false);
  assert.equal(result.credentialValuesExposed, false);
});

test('production environment preflight rejects a mismatched deployed source SHA', () => {
  const result = assessProductionEnv(production, 'b'.repeat(40));
  assert.equal(result.ready, false);
  assert(result.invalid.includes('BEATGALER_SOURCE_SHA_MISMATCH'));
});

test('production environment preflight rejects absent alert routes', () => {
  const result = assessProductionEnv({ ...production, BACKUP_FAILURE_ALERT_ROUTE: '' });
  assert(result.invalid.includes('ALERT_ROUTE_backup_failure'));
});

test('missing credentials, sandbox selection, local URLs and temporary upload storage fail closed without leaking values', () => {
  const result = assessProductionEnv({ ...production,
    BILLING_PROVIDER_ENVIRONMENT: 'sandbox',
    POLAR_PRODUCTION_ACCESS_TOKEN: '',
    DATABASE_URL: 'postgres://user:private@localhost/beatgaler',
    BEATGALER_PROJECT_UPLOAD_TEMP_DIR: '/tmp/beatgaler',
  });
  assert.equal(result.ready, false);
  assert(result.invalid.includes('BILLING_PROVIDER_ENVIRONMENT'));
  assert(result.invalid.includes('POLAR_PRODUCTION_CONFIG'));
  assert(result.invalid.includes('DATABASE_URL'));
  assert(result.invalid.includes('BEATGALER_PROJECT_UPLOAD_TEMP_DIR'));
  assert(!JSON.stringify(result).includes('private'));
});
