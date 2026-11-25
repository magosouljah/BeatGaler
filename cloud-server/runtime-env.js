'use strict';

// Keep the live object for consumers that already accept an injected env.
// Call at the injection site so later reads see changes to that same object.
function getRuntimeEnv() {
  return process.env;
}

const WORKER_FLAG = 'BEATGALER_CATALOG_WORKER_ENABLED';

const catalogWorkerEnv = {
  enabled: () => String(process.env[WORKER_FLAG] || '').toLowerCase() === 'true',
  healthIntervalMs: () => Number(process.env.BEATGALER_CATALOG_WORKER_HEALTH_MS || 60_000),
};

const serverEnv = {
  billingProviderEnvironment: () => process.env.BILLING_PROVIDER_ENVIRONMENT || 'unconfigured',
  isProduction: () => String(process.env.NODE_ENV || '') === 'production',
  pendingSignupEnabled: () => String(process.env.BEATGALER_PENDING_SIGNUP_ENABLED || '') === '1',
  signupActivationStaleMs: () => Number(process.env.BEATGALER_SIGNUP_ACTIVATION_STALE_MS || 5 * 60_000),
};

// Direct retains its existing parsers and decides when to read each value.
const directEnv = {
  transportBotsFile: () => process.env.TRANSPORT_BOTS_FILE,
  transportPoolState: () => process.env.TRANSPORT_POOL_STATE,
  mastersFile: () => process.env.MASTERS_FILE,
  vaultRegistryFile: () => process.env.VAULT_REGISTRY_FILE,
  masterVaultSoftLimit: () => process.env.MASTER_VAULT_SOFT_LIMIT,
  masterGroupLimit: () => process.env.BEATGALER_MASTER_GROUP_LIMIT,
  heartbeatIntervalMs: () => process.env.DIRECT_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: () => process.env.DIRECT_HEARTBEAT_TIMEOUT_MS,
  tokenRotationEnabled: () => process.env.DIRECT_TOKEN_ROTATION_ENABLED,
  dataOperationTtlMs: () => process.env.DIRECT_DATA_OPERATION_TTL_MS,
  indexOperationLivenessTimeoutMs: () => process.env.DIRECT_INDEX_OPERATION_LIVENESS_TIMEOUT_MS,
  managedTokenFetchRetryAttempts: () => process.env.DIRECT_MANAGED_TOKEN_FETCH_RETRY_ATTEMPTS,
  managedTokenFetchRetryBaseMs: () => process.env.DIRECT_MANAGED_TOKEN_FETCH_RETRY_BASE_MS,
  managedTokenFetchRetryMaxMs: () => process.env.DIRECT_MANAGED_TOKEN_FETCH_RETRY_MAX_MS,
  managedTokenFetchTimeoutMs: () => process.env.DIRECT_MANAGED_TOKEN_FETCH_TIMEOUT_MS,
  diagnosticsDir: () => process.env.DIRECT_DIAGNOSTICS_DIR,
  transportEnabled: () => process.env.BEATGALER_DIRECT_TRANSPORT,
  poolStateRenameAttempts: () => process.env.POOL_STATE_RENAME_ATTEMPTS,
  poolLockWaitMs: () => process.env.POOL_LOCK_WAIT_MS,
  resolverChatId: () => process.env.DIRECT_BOTAPI_RESOLVER_CHAT_ID,
  credentialByName: (name) => process.env[name],
};

const telegramEnv = {
  apiId: () => process.env.TELEGRAM_API_ID,
  apiHash: () => process.env.TELEGRAM_API_HASH,
  beatGalerMasterSession: () => process.env.BEATGALER_MASTER_SESSION,
  masterSession: () => process.env.MASTER_SESSION,
  masterSessionFile: () => process.env.MASTER_SESSION_FILE,
  masterDialogLimit: () => process.env.MASTER_DIALOG_LIMIT,
};

const backupReadinessEnv = {
  failureAlertRoute: () => process.env.BACKUP_FAILURE_ALERT_ROUTE ?? 'UNCONFIGURED',
  dryRunDir: () => process.env.D10_DRY_RUN_DIR ?? '.tmp/d10-backup-readiness',
};

function criticalPathTraceFile() {
  return String(process.env.STAGE1_CRITICAL_PATH_CLOUD_TRACE_FILE || '').trim() || null;
}

// Las fábricas reciben `env` explícito del compositor; sin él, error claro.
function requiredEnv() {
  throw new TypeError('env required');
}

module.exports = {
  getRuntimeEnv,
  requiredEnv,
  WORKER_FLAG,
  catalogWorkerEnv,
  serverEnv,
  directEnv,
  telegramEnv,
  backupReadinessEnv,
  criticalPathTraceFile,
};
