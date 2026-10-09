'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const { ProjectAccessError } = require('./project-access');

const { noDirectStartupTrace } = require('./direct-startup-trace');

const ROOT = __dirname;
function backendPath(value, fallbackName) {
  const raw = String(value || '').trim();
  if (!raw) return path.join(ROOT, fallbackName);
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

const POOL_FILE = backendPath(process.env.TRANSPORT_BOTS_FILE, 'transport-bots.local.json');
const STATE_FILE = backendPath(process.env.TRANSPORT_POOL_STATE, 'transport-pool-state.json');
const MASTERS_FILE = backendPath(process.env.MASTERS_FILE, 'masters.local.json');
const VAULT_REGISTRY_FILE = backendPath(process.env.VAULT_REGISTRY_FILE, 'vault-registry.json');
const MASTER_SOFT_LIMIT = Number(process.env.MASTER_VAULT_SOFT_LIMIT || process.env.BEATGALER_MASTER_GROUP_LIMIT || 400);
const POOL_LOCK_FILE = `${STATE_FILE}.lock`;
const PROCESS_INSTANCE_ID = crypto.randomBytes(8).toString('hex');
const HEARTBEAT_INTERVAL_MS = Math.max(30_000, Number(process.env.DIRECT_HEARTBEAT_INTERVAL_MS || 60_000));
const HEARTBEAT_TIMEOUT_MS = Math.max(60_000, Number(process.env.DIRECT_HEARTBEAT_TIMEOUT_MS || 5 * 60_000));
const TOKEN_ROTATION_ENABLED = ['1','true','on','yes'].includes(String(process.env.DIRECT_TOKEN_ROTATION_ENABLED || 'false').trim().toLowerCase());
const DATA_OPERATION_TTL_MS = Math.max(15 * 60_000, Number(process.env.DIRECT_DATA_OPERATION_TTL_MS || 4 * 60 * 60_000));
// INDEX locks are renewable leases.  A dead tab therefore releases quickly,
// while a deliberately paused but still-live Worker keeps renewing its lease.
const INDEX_OPERATION_LIVENESS_TIMEOUT_MS = Math.max(5_000, Number(process.env.DIRECT_INDEX_OPERATION_LIVENESS_TIMEOUT_MS || 15_000));
const MANAGED_TOKEN_FETCH_RETRY_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.DIRECT_MANAGED_TOKEN_FETCH_RETRY_ATTEMPTS || 3)));
const MANAGED_TOKEN_FETCH_RETRY_BASE_MS = Math.max(25, Math.min(500, Number(process.env.DIRECT_MANAGED_TOKEN_FETCH_RETRY_BASE_MS || 150)));
const MANAGED_TOKEN_FETCH_RETRY_MAX_MS = Math.max(MANAGED_TOKEN_FETCH_RETRY_BASE_MS, Math.min(1_000, Number(process.env.DIRECT_MANAGED_TOKEN_FETCH_RETRY_MAX_MS || 500)));
const MANAGED_TOKEN_FETCH_TIMEOUT_MS = Math.max(500, Math.min(5_000, Number(process.env.DIRECT_MANAGED_TOKEN_FETCH_TIMEOUT_MS || 3_000)));
const DIAG_DIR = backendPath(process.env.DIRECT_DIAGNOSTICS_DIR, 'diagnostics');
const DIAG_FILE = path.join(DIAG_DIR, 'telegram-direct-control.txt');

// Runtime-only material. Tokens never go to the JSON state file.
const runtimeSessions = new Map(); // session_id -> hydrated session + current token
const managedTokenCache = new Map(); // bot_id -> { credentialVersion, token }; process memory only
const managedTokenFetches = new Map();
const botRotationLocks = new Map();
const leaseCleanupLocks = new Map();
const unconfirmedOperationSince = new Map();
let monotonicNowImpl = () => performance.now();
const busyOperationDiagnostics = new Map();
let resolverBootstrapPromise = null;
let maintenanceStarted = false;
let managerBotFetch = (...args) => fetch(...args);
let managedTokenFetchRetryPolicy = {
  attempts: MANAGED_TOKEN_FETCH_RETRY_ATTEMPTS,
  baseMs: MANAGED_TOKEN_FETCH_RETRY_BASE_MS,
  maxMs: MANAGED_TOKEN_FETCH_RETRY_MAX_MS,
  timeoutMs: MANAGED_TOKEN_FETCH_TIMEOUT_MS,
};

function enabled() {
  const raw = String(process.env.BEATGALER_DIRECT_TRANSPORT || 'true').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return fs.existsSync(POOL_FILE) && Boolean(process.env.TELEGRAM_API_ID) && Boolean(process.env.TELEGRAM_API_HASH);
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function apiCredentials() {
  const apiId = Number(required('TELEGRAM_API_ID'));
  if (!Number.isInteger(apiId) || apiId <= 0) throw new Error('TELEGRAM_API_ID must be a positive integer.');
  return { apiId, apiHash: required('TELEGRAM_API_HASH') };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const payload = JSON.stringify(value, null, 2) + '\n';
  let fd = null;

  try {
    // Write + flush the complete replacement before exposing it. This keeps
    // transport-pool-state.json valid even if the process/PC dies mid-write.
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch (_) {}
    fs.closeSync(fd);
    fd = null;

    // Windows can transiently reject rename() with EPERM/EBUSY/EACCES when
    // Defender, an indexer, or another process briefly has the destination
    // open. The pool mutation is already protected by POOL_LOCK_FILE, so do
    // not fail the user operation for this short OS-level contention.
    const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
    const maxAttempts = Math.max(1, Number(process.env.POOL_STATE_RENAME_ATTEMPTS || 8));
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        if (attempt > 1) {
          diag('POOL_STATE_RENAME_RECOVERED', { file: path.basename(file), attempt });
        }
        return;
      } catch (error) {
        lastError = error;
        if (!retryable.has(String(error?.code || '')) || attempt >= maxAttempts) throw error;
        const delayMs = Math.min(500, 25 * (2 ** (attempt - 1)));
        diag('POOL_STATE_RENAME_RETRY', {
          file: path.basename(file),
          attempt,
          delay_ms: delayMs,
          code: error?.code || null,
        });
        sleepSync(delayMs);
      }
    }
    if (lastError) throw lastError;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    // rename() removes tmp on success. On any failure, never leave stale
    // temporaries around to confuse a later run.
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

function nowIso() { return new Date().toISOString(); }
function diag(event, fields = {}) {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    const safe = {};
    for (const [key, value] of Object.entries(fields || {})) {
      if (/token|api_hash|secret|password/i.test(key)) safe[key] = '<redacted>';
      else safe[key] = value;
    }
    fs.appendFileSync(DIAG_FILE, `${nowIso()} ${event} ${JSON.stringify(safe)}\n`, 'utf8');
  } catch (_) {}
}
function todayKey() { return nowIso().slice(0, 10); }
function parseTime(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}
function monotonicNow() { return monotonicNowImpl(); }
function elapsedSinceMonotonic(value) {
  const elapsed = monotonicNow() - Number(value || 0);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}
function operationLivenessTimeout(op) {
  return op?.kind === 'get_index' || op?.kind === 'replace_index'
    ? INDEX_OPERATION_LIVENESS_TIMEOUT_MS
    : DATA_OPERATION_TTL_MS;
}
function operationLivenessAge(op, opId) {
  // performance.now() is process-local and monotonic.  A persisted operation
  // from an earlier process has no comparable monotonic timestamp, so it gets
  // a bounded re-confirmation grace period instead of trusting wall-clock age.
  if (op?.liveness_owner_instance === PROCESS_INSTANCE_ID && Number.isFinite(Number(op?.last_liveness_monotonic_ms))) {
    return elapsedSinceMonotonic(op.last_liveness_monotonic_ms);
  }
  const key = String(opId || op?.operation_id || 'unknown');
  let firstSeen = unconfirmedOperationSince.get(key);
  if (firstSeen === undefined) {
    firstSeen = monotonicNow();
    unconfirmedOperationSince.set(key, firstSeen);
  }
  return elapsedSinceMonotonic(firstSeen);
}
function operationIsStale(op, opId) {
  return !op || operationLivenessAge(op, opId) >= operationLivenessTimeout(op);
}
function operationDurationMs(op) {
  if (op?.liveness_owner_instance === PROCESS_INSTANCE_ID && Number.isFinite(Number(op?.started_monotonic_ms))) {
    return elapsedSinceMonotonic(op.started_monotonic_ms);
  }
  return Math.max(0, Date.now() - parseTime(op?.started_at));
}
function operationDiagnosticOwner(op) {
  if (!op) return {};
  return {
    owner_session_id: op.session_id || null,
    owner_installation: op.installation_id ? `${String(op.installation_id).slice(0, 8)}…` : null,
    owner_tab_id: op.document_tab_id || null,
    owner_document_id: op.document_id || null,
    owner_document_generation: op.document_generation || null,
    owner_kind: op.kind || null,
    owner_liveness_age_ms: Math.round(operationLivenessAge(op, op.operation_id)),
  };
}
function diagBusyOperationOnce(key, fields) {
  const now = monotonicNow();
  const previous = busyOperationDiagnostics.get(key) || 0;
  if (now - previous < 2_000) return;
  busyOperationDiagnostics.set(key, now);
  diag('OPERATION_BEGIN_WAIT', fields);
}

function loadPool() {
  if (!fs.existsSync(POOL_FILE)) throw new Error(`Transport bot pool not found: ${POOL_FILE}`);
  const raw = readJson(POOL_FILE, null);
  const bots = Array.isArray(raw) ? raw : raw?.bots;
  if (!Array.isArray(bots) || bots.length === 0) throw new Error('Transport bot pool must contain at least one bot.');
  const seen = new Set();
  return bots.map((bot, index) => {
    const id = String(bot.id || bot.name || `bot-${index + 1}`).trim();
    if (!id || seen.has(id)) throw new Error(`Invalid or duplicate transport bot id: ${id || index + 1}`);
    seen.add(id);
    const managed = Boolean(bot.managed);
    const token = String(bot.token || '').trim();
    if (!managed && !token) throw new Error(`${id} needs token or managed=true.`);
    return {
      ...bot,
      id,
      managed,
      token,
      label: String(bot.label || id),
      telegram_user_id: bot.telegram_user_id ? String(bot.telegram_user_id) : null,
      telegram_username: bot.telegram_username ? String(bot.telegram_username).replace(/^@/, '') : null,
      manager_token_env: bot.manager_token_env ? String(bot.manager_token_env) : null,
    };
  });
}

function defaultBotState() {
  return {
    generation: 0,
    credential_version: 1,
    rotation_pending: false,
    quarantined: false,
    quarantine_reason: null,
    last_assigned_at: null,
  };
}

function normalizeState(pool) {
  const raw = readJson(STATE_FILE, {}) || {};
  const ids = pool.map(b => b.id);
  const state = {
    version: 4,
    bots: raw.bots && typeof raw.bots === 'object' ? raw.bots : {},
    leases: raw.leases && typeof raw.leases === 'object' ? raw.leases : {},
    operations: raw.operations && typeof raw.operations === 'object' ? raw.operations : {},
    metrics: raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {},
    rotation: raw.rotation && typeof raw.rotation === 'object' ? raw.rotation : {},
  };

  // One-release migration from the old one-vault-per-bot state. Keep these
  // leases until stale cleanup retires their ephemeral state. Persistent vault
  // membership and PostgreSQL ownership remain untouched.
  if (raw.active_leases && typeof raw.active_leases === 'object') {
    for (const [botId, lease] of Object.entries(raw.active_leases)) {
      if (!ids.includes(botId) || !lease?.chat_id) continue;
      const sessionId = `legacy_${String(lease.lease_id || crypto.randomBytes(8).toString('hex'))}`;
      if (state.leases[sessionId]) continue;
      state.leases[sessionId] = {
        session_id: sessionId,
        bot_id: botId,
        installation_id: String(lease.installation_id || `legacy:${botId}`),
        chat_id: String(lease.chat_id),
        generation: 0,
        credential_version: Number(state.bots?.[botId]?.credential_version || 1),
        status: 'SUSPECTED',
        started_at: String(lease.started_at || nowIso()),
        last_heartbeat_at: String(lease.started_at || nowIso()),
        owner_instance: String(lease.owner_instance || ''),
      };
    }
  }

  for (const id of ids) {
    state.bots[id] = { ...defaultBotState(), ...(state.bots[id] || {}) };
    state.bots[id].generation = Number(state.bots[id].generation || 0);
    state.bots[id].credential_version = Math.max(1, Number(state.bots[id].credential_version || 1));
    state.bots[id].rotation_pending = Boolean(state.bots[id].rotation_pending);
    state.bots[id].quarantined = Boolean(state.bots[id].quarantined);
    if (!state.metrics[id]) state.metrics[id] = { date: todayKey(), sessions_today: 0, total_sessions: 0, last_used_at: null };
    if (state.metrics[id].date !== todayKey()) {
      state.metrics[id].date = todayKey();
      state.metrics[id].sessions_today = 0;
    }
    if (!state.rotation[id]) state.rotation[id] = { last_rotated_at: null, last_status: 'never', last_error: null };
  }

  for (const sessionId of Object.keys(state.leases)) {
    const lease = state.leases[sessionId];
    if (!lease || !ids.includes(String(lease.bot_id || ''))) {
      delete state.leases[sessionId];
      continue;
    }
    lease.session_id = String(lease.session_id || sessionId);
    lease.bot_id = String(lease.bot_id);
    lease.installation_id = String(lease.installation_id || '');
    lease.chat_id = String(lease.chat_id || '');
    lease.generation = Number(lease.generation || 0);
    lease.credential_version = Math.max(1, Number(lease.credential_version || state.bots[lease.bot_id].credential_version || 1));
    lease.status = String(lease.status || 'ACTIVE');
    lease.started_at = String(lease.started_at || nowIso());
    lease.last_heartbeat_at = String(lease.last_heartbeat_at || lease.started_at);
  }
  for (const opId of Object.keys(state.operations)) {
    const op = state.operations[opId];
    const stale = operationIsStale(op, opId);
    if (!op || !state.leases[String(op.session_id || '')] || stale) {
      if (op && stale) diag('STALE_OPERATION_REAPED', {
        operation_id: opId,
        session_id: op.session_id || null,
        kind: op.kind || null,
        liveness_age_ms: Math.round(operationLivenessAge(op, opId)),
        liveness_timeout_ms: operationLivenessTimeout(op),
        reason: 'operation_liveness_expired',
      });
      delete state.operations[opId];
      unconfirmedOperationSince.delete(opId);
    }
  }
  return state;
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withPoolLock(fn) {
  const started = Date.now();
  const waitMs = Number(process.env.POOL_LOCK_WAIT_MS || 15000);
  while (true) {
    let fd = null;
    try {
      fd = fs.openSync(POOL_LOCK_FILE, 'wx');
      fs.writeFileSync(fd, `${process.pid} ${nowIso()}\n`);
      try { return fn(); }
      finally {
        try { fs.closeSync(fd); } catch (_) {}
        try { fs.unlinkSync(POOL_LOCK_FILE); } catch (_) {}
      }
    } catch (error) {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
      if (error?.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(POOL_LOCK_FILE).mtimeMs;
        if (age > 30000) { fs.unlinkSync(POOL_LOCK_FILE); continue; }
      } catch (_) {}
      if (Date.now() - started > waitMs) throw new Error('Timed out waiting for transport pool lock.');
      sleepSync(25);
    }
  }
}

function mutateState(pool, mutator) {
  return withPoolLock(() => {
    const state = normalizeState(pool);
    const result = mutator(state);
    writeJsonAtomic(STATE_FILE, state);
    return result;
  });
}

function stateSnapshot(pool) {
  return withPoolLock(() => normalizeState(pool));
}

function leasesForBot(state, botId) {
  return Object.values(state.leases).filter(lease => lease.bot_id === botId && lease.status !== 'CLEANED');
}
function activeOpsForBot(state, botId) {
  return Object.values(state.operations).filter(op => op.bot_id === botId);
}
function findLeaseByInstallation(state, installationId) {
  return Object.values(state.leases).find(lease => lease.installation_id === installationId && lease.status !== 'CLEANED') || null;
}
function leaseExpired(lease) {
  return Date.now() - parseTime(lease?.last_heartbeat_at) >= HEARTBEAT_TIMEOUT_MS;
}

function finalizeLease(sessionId) {
  const pool = loadPool();
  return mutateState(pool, state => {
    const lease = state.leases[sessionId];
    if (!lease) return null;
    lease.status = 'ACTIVE';
    lease.last_heartbeat_at = nowIso();
    const metric = state.metrics[lease.bot_id];
    metric.sessions_today = Number(metric.sessions_today || 0) + 1;
    metric.total_sessions = Number(metric.total_sessions || 0) + 1;
    metric.last_used_at = nowIso();
    return { ...lease };
  });
}

function deleteLease(sessionId) {
  const pool = loadPool();
  return mutateState(pool, state => {
    const lease = state.leases[sessionId];
    if (!lease) return null;
    for (const [opId, op] of Object.entries(state.operations)) {
      if (op.session_id === sessionId) {
        delete state.operations[opId];
        unconfirmedOperationSince.delete(opId);
      }
    }
    delete state.leases[sessionId];
    return { ...lease };
  });
}

function loadVaultRegistry() {
  const raw = readJson(VAULT_REGISTRY_FILE, { version: 1, vaults: {} }) || { version: 1, vaults: {} };
  if (!raw.vaults || typeof raw.vaults !== 'object') raw.vaults = {};
  return raw;
}

function loadMasterSession(config = null) {
  if (config?.session) return String(config.session).trim();
  if (config?.session_env) {
    const value = String(process.env[String(config.session_env)] || '').trim();
    if (value) return value;
  }
  if (config?.session_file) {
    const file = path.resolve(String(config.session_file));
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  }
  const inline = String(process.env.BEATGALER_MASTER_SESSION || process.env.MASTER_SESSION || '').trim();
  if (inline) return inline;
  const envFile = String(process.env.MASTER_SESSION_FILE || '').trim();
  const candidates = [envFile && path.resolve(envFile), path.join(ROOT, 'master-session.txt')].filter(Boolean);
  for (const file of candidates) if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  throw new Error('MASTER Telegram session is not configured.');
}

function loadMasters() {
  if (fs.existsSync(MASTERS_FILE)) {
    const raw = readJson(MASTERS_FILE, null);
    const masters = Array.isArray(raw) ? raw : raw?.masters;
    if (Array.isArray(masters) && masters.length) {
      return masters.map((m, i) => ({
        ...m,
        id: String(m.id || `Master${String(i + 1).padStart(2, '0')}`),
        label: String(m.label || m.id || `MASTER ${i + 1}`),
        soft_limit: Number(m.soft_limit || MASTER_SOFT_LIMIT),
      }));
    }
  }
  return [{ id: 'Master01', label: 'MASTER 01', soft_limit: MASTER_SOFT_LIMIT }];
}

function markedChatId(entity) {
  if (!entity?.id) return null;
  const raw = entity.id.toString();
  if (entity.className === 'Channel' || entity.megagroup || entity.broadcast) return `-100${raw}`;
  if (entity.className === 'Chat') return `-${raw}`;
  return raw;
}

async function openMaster(config) {
  const { apiId, apiHash } = apiCredentials();
  const client = new TelegramClient(new StringSession(loadMasterSession(config)), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    useWSS: false,
  });
  try { client.setLogLevel?.('none'); } catch (_) {}
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error(`${config?.id || 'MASTER'} session is not authorized.`);
  }
  return client;
}

async function resolveVault(client, chatId) {
  const wanted = String(chatId);
  for await (const dialog of client.iterDialogs({ limit: Number(process.env.MASTER_DIALOG_LIMIT || 1000) })) {
    if (markedChatId(dialog.entity) === wanted) return dialog.entity;
  }
  throw new Error(`MASTER cannot find private vault ${wanted}.`);
}

async function masterForVault(chatId) {
  const key = String(chatId);
  const masters = loadMasters();
  const registry = loadVaultRegistry();
  const assigned = registry.vaults[key]?.master_id;
  const ordered = assigned
    ? [...masters.filter(m => m.id === assigned), ...masters.filter(m => m.id !== assigned)]
    : masters;
  let lastError = null;
  for (const config of ordered) {
    let client = null;
    try {
      client = await openMaster(config);
      const vault = await resolveVault(client, key);
      if (!registry.vaults[key] || registry.vaults[key].master_id !== config.id) {
        registry.vaults[key] = {
          master_id: config.id,
          assigned_at: registry.vaults[key]?.assigned_at || nowIso(),
          discovered_at: nowIso(),
        };
        writeJsonAtomic(VAULT_REGISTRY_FILE, registry);
      }
      return { config, client, vault };
    } catch (error) {
      lastError = error;
      try { if (client) await client.disconnect(); } catch (_) {}
    }
  }
  throw lastError || new Error(`No MASTER could resolve vault ${key}.`);
}

async function managerBotApiCall(token, method, payload, options = {}) {
  const response = await managerBotFetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    const error = new Error(body.description || `${method} failed (${response.status}).`);
    // API responses are deliberately non-retryable here. This retry is only
    // a narrow guard for transient transport/fetch failures.
    error.manager_bot_api_response = true;
    error.http_status = Number(response.status) || null;
    error.api_error_code = Number(body?.error_code) || null;
    throw error;
  }
  return body.result;
}

function boundedDiagnosticValue(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 120) : null;
}

function managedTokenErrorDiagnostic(error) {
  const cause = error?.cause;
  return {
    error_class: boundedDiagnosticValue(error?.name) || 'Error',
    error_code: boundedDiagnosticValue(error?.code),
    http_status: Number.isInteger(error?.http_status) ? error.http_status : null,
    api_error_code: Number.isInteger(error?.api_error_code) ? error.api_error_code : null,
    cause_class: boundedDiagnosticValue(cause?.name),
    cause_code: boundedDiagnosticValue(cause?.code),
    errno: boundedDiagnosticValue(error?.errno || cause?.errno),
  };
}

function transientManagedTokenFetchError(error) {
  if (!error || error.manager_bot_api_response === true) return false;
  const cause = error.cause || {};
  const codes = new Set([
    error.code, cause.code, error.errno, cause.errno,
  ].map(value => String(value || '').toUpperCase()));
  if ([
    'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN',
    'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  ].some(code => codes.has(code))) return true;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  const message = `${error?.message || ''} ${cause?.message || ''}`;
  return error?.name === 'TypeError' && /fetch failed|socket hang up|network error/i.test(message);
}

function managedTokenRetryDelayMs(attempt) {
  return Math.min(
    managedTokenFetchRetryPolicy.maxMs,
    managedTokenFetchRetryPolicy.baseMs * (2 ** Math.max(0, attempt - 1)),
  );
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getManagedTokenWithRetry(managerToken, botConfig) {
  let lastError = null;
  const { attempts } = managedTokenFetchRetryPolicy;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = performance.now();
    try {
      const token = await managerBotApiCall(
        managerToken,
        'getManagedBotToken',
        { user_id: Number(botConfig.telegram_user_id) },
        { signal: AbortSignal.timeout(managedTokenFetchRetryPolicy.timeoutMs) },
      );
      if (attempt > 1) {
        diag('MANAGED_TOKEN_FETCH_RECOVERED', {
          attempt,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
      return token;
    } catch (error) {
      lastError = error;
      const retryable = transientManagedTokenFetchError(error);
      const durationMs = Math.round(performance.now() - startedAt);
      const detail = {
        attempt,
        attempts,
        duration_ms: durationMs,
        timeout_ms: managedTokenFetchRetryPolicy.timeoutMs,
        retryable,
        ...managedTokenErrorDiagnostic(error),
      };
      if (!retryable || attempt >= attempts) {
        diag('MANAGED_TOKEN_FETCH_FAILED', detail);
        throw error;
      }
      const delayMs = managedTokenRetryDelayMs(attempt);
      diag('MANAGED_TOKEN_FETCH_RETRY', { ...detail, delay_ms: delayMs });
      await wait(delayMs);
    }
  }
  throw lastError || new Error('Managed token fetch failed.');
}

// IMPORTANT: transport tokens are NOT rotated on lease/start. They are fetched
// JIT and remain unchanged for the whole active BeatGaler session. Rotation is
// triggered only by session end / stale-session cleanup, then delayed until all
// in-flight operations on the shared bot have drained.
async function resolveBotIdentityViaHttp(token) {
  // Control-plane metadata lookup only. This is ordinary HTTPS Bot API and
  // does not create an MTProto bot authorization/session.
  const me = await managerBotApiCall(token, 'getMe', {});
  return {
    telegram_user_id: me?.id ? String(me.id) : null,
    telegram_username: me?.username ? String(me.username).replace(/^@/, '') : null,
  };
}

async function resolveManagedToken(botConfig) {
  if (!botConfig.managed) return botConfig.token;
  if (!botConfig.telegram_user_id || !botConfig.manager_token_env) {
    throw new Error(`${botConfig.id}: managed bot requires telegram_user_id and manager_token_env.`);
  }
  const managerToken = String(process.env[botConfig.manager_token_env] || '').trim();
  if (!managerToken) throw new Error(`${botConfig.id}: missing ${botConfig.manager_token_env}.`);
  const token = await getManagedTokenWithRetry(managerToken, botConfig);
  if (!token) throw new Error(`${botConfig.id}: Telegram returned no managed token.`);
  return String(token);
}

async function tokenForCredentialVersion(botConfig, credentialVersion) {
  if (!botConfig.managed) return botConfig.token;
  const botId = String(botConfig.id);
  const version = Number(credentialVersion);
  const cached = managedTokenCache.get(botId);
  if (cached?.credentialVersion === version) return cached.token;
  const key = `${botId}:${version}`;
  let pending = managedTokenFetches.get(key);
  if (!pending) {
    pending = resolveManagedToken(botConfig).then(token => {
      if (!managedTokenCache.has(botId) || managedTokenCache.get(botId).credentialVersion <= version) {
        managedTokenCache.set(botId, { credentialVersion: version, token });
      }
      return token;
    }).finally(() => managedTokenFetches.delete(key));
    managedTokenFetches.set(key, pending);
  }
  return pending;
}

async function rotateManagedToken(botConfig) {
  if (!botConfig.managed) throw new Error(`${botConfig.id}: automatic token rotation requires managed=true.`);
  const managerToken = String(process.env[botConfig.manager_token_env] || '').trim();
  if (!managerToken) throw new Error(`${botConfig.id}: missing ${botConfig.manager_token_env}.`);
  const replacement = await managerBotApiCall(managerToken, 'replaceManagedBotToken', { user_id: Number(botConfig.telegram_user_id) });
  if (!replacement) throw new Error(`${botConfig.id}: Telegram returned no replacement token.`);
  return String(replacement);
}


function directBotAdminRights() {
  return new Api.ChatAdminRights({ deleteMessages: false, editMessages: false,
    pinMessages: false, other: true });
}

async function inviteAndPromote(master, vault, botEntity) {
  try {
    await master.invoke(new Api.channels.InviteToChannel({ channel: vault, users: [botEntity] }));
  } catch (error) {
    const msg = String(error?.errorMessage || error?.message || error);
    if (!/USER_ALREADY_PARTICIPANT/i.test(msg)) throw error;
  }
  // The bot may write its own media. MASTER documents must remain protected
  // from a client holding the temporary bot credential.
  await master.invoke(new Api.channels.EditAdmin({
    channel: vault,
    userId: botEntity,
    adminRights: directBotAdminRights(),
    rank: 'BeatGaler',
  }));
}

async function restrictBotPinRights(chatId, botId) {
  const config = loadPool().find(bot => String(bot.id) === String(botId));
  if (!config) throw new Error('Assigned Direct bot is unavailable.');
  let username = config.telegram_username;
  let userId = config.telegram_user_id;
  if (!username && !userId) {
    const identity = await resolveBotIdentityViaHttp(config.managed
      ? await resolveManagedToken(config) : config.token);
    username = identity.telegram_username;
    userId = identity.telegram_user_id;
  }
  const masterInfo = await masterForVault(chatId);
  try {
    const entity = await masterInfo.client.getEntity(userId || `@${username}`);
    await masterInfo.client.invoke(new Api.channels.EditAdmin({
      channel: masterInfo.vault,
      userId: entity,
      adminRights: directBotAdminRights(),
      rank: 'BeatGaler',
    }));
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

function botMembershipError(error) {
  const message = String(error?.errorMessage || error?.message || error || '');
  const status = Number(error?.http_status || error?.api_error_code || 0) || null;
  return {
    message,
    status,
    absent: /chat not found|bot was kicked|bot is not a member|forbidden|USER_NOT_PARTICIPANT|CHANNEL_PRIVATE/i.test(message),
  };
}

function membershipAbsentError(error, runtime) {
  const detail = botMembershipError(error);
  if (!detail.absent) return error;
  const failure = new Error(`Transport bot ${runtime.bot.id} cannot observe vault ${runtime.chatId}.`);
  failure.code = 'TRANSPORT_BOT_MEMBERSHIP_ABSENT';
  failure.telegram_error = detail.message;
  failure.http_status = detail.status;
  return failure;
}

async function probeRuntimeVaultMembership(runtime, startupTrace = noDirectStartupTrace) {
  startupTrace.mark('BOT_MEMBERSHIP_PROBE', {
    membership_state: 'probing',
    vault_chat_id: String(runtime.chatId),
    channel_id: String(runtime.chatId).startsWith('-100') ? String(runtime.chatId).slice(4) : null,
    transport_id: runtime.bot.id,
    expected_bot_id: runtime.bot.telegram_user_id || null,
  });
  try {
    const chat = await startupTrace.step('BOT_MEMBERSHIP_GET_CHAT', () => managerBotApiCall(runtime.token, 'getChat', {
      chat_id: String(runtime.chatId),
    }));
    const observedChatId = String(chat?.id || '');
    if (observedChatId !== String(runtime.chatId)) {
      const mismatch = new Error(`Transport bot observed vault ${observedChatId || '<none>'}, expected ${runtime.chatId}.`);
      mismatch.code = 'TRANSPORT_BOT_VAULT_MISMATCH';
      throw mismatch;
    }
    const proof = {
      state: 'bot_visible',
      source: 'bot_api_getChat',
      vault_chat_id: String(runtime.chatId),
      channel_id: String(runtime.chatId).startsWith('-100') ? String(runtime.chatId).slice(4) : null,
      transport_id: runtime.bot.id,
      expected_bot_id: runtime.bot.telegram_user_id || null,
    };
    startupTrace.mark('BOT_MEMBERSHIP_VISIBLE', {
      membership_state: proof.state,
      membership_source: proof.source,
      vault_chat_id: proof.vault_chat_id,
      channel_id: proof.channel_id,
      transport_id: proof.transport_id,
      expected_bot_id: proof.expected_bot_id,
    });
    return proof;
  } catch (error) {
    const failure = membershipAbsentError(error, runtime);
    const detail = botMembershipError(error);
    diag('BOT_MEMBERSHIP_PROBE_FAILED', {
      transport_id: runtime.bot.id,
      membership_state: detail.absent ? 'absent' : 'probe_failed',
      ...managedTokenErrorDiagnostic(error),
    });
    startupTrace.mark('BOT_MEMBERSHIP_NOT_VISIBLE', {
      membership_state: detail.absent ? 'absent' : 'probe_failed',
      membership_source: 'bot_api_getChat',
      vault_chat_id: String(runtime.chatId),
      channel_id: String(runtime.chatId).startsWith('-100') ? String(runtime.chatId).slice(4) : null,
      transport_id: runtime.bot.id,
      expected_bot_id: runtime.bot.telegram_user_id || null,
      probe_error_code: detail.status,
    });
    throw failure;
  }
}

async function cleanupLegacyVisibleHandshakes(master, vault) {
  // One-time migration cleanup for protocol messages created by V4/V4.1.
  // Current Direct transport NEVER posts a handshake message.
  const ids = [];
  try {
    for await (const message of master.iterMessages(vault, { limit: 250 })) {
      const text = String(message?.message || message?.text || '').trim();
      if (!text) continue;
      if (
        text.startsWith('/beatgaler_transport') ||
        text.startsWith('/beatgaler_ready') ||
        text.includes('BEATGALER_DIRECT_') ||
        text.includes('BEATGALER_HANDSHAKE_')
      ) {
        const id = Number(message.id || 0);
        if (Number.isInteger(id) && id > 0) ids.push(id);
      }
    }
    for (let i = 0; i < ids.length; i += 100) {
      await master.invoke(new Api.channels.DeleteMessages({ channel: vault, id: ids.slice(i, i + 100) }));
    }
    if (ids.length) console.log(`[direct] LEGACY_HANDSHAKES_REMOVED count=${ids.length}`);
  } catch (error) {
    console.warn('[direct] legacy handshake cleanup skipped:', error?.message || error);
  }
}

async function kickAndUnban(master, vault, botEntity) {
  try {
    await master.invoke(new Api.channels.EditBanned({
      channel: vault,
      participant: botEntity,
      bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
    }));
  } catch (error) {
    const msg = String(error?.errorMessage || error?.message || error);
    if (!/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID/i.test(msg)) throw error;
  }
  try {
    await master.invoke(new Api.channels.EditBanned({
      channel: vault,
      participant: botEntity,
      bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: false }),
    }));
  } catch (_) {}
}

async function ensureBotApiResolverChat() {
  // Resolver infrastructure is process-singleflight. It is not part of every
  // user session startup; once created/bootstraped, subsequent leases only use
  // its chat id. This removes repeated MASTER resolver work on every warmup.
  if (resolverBootstrapPromise) return resolverBootstrapPromise;
  resolverBootstrapPromise = (async () => {
    const registry = loadVaultRegistry();
    const existingId = String(registry.resolver?.chat_id || process.env.DIRECT_BOTAPI_RESOLVER_CHAT_ID || '').trim();
    const pool = loadPool();
    let masterInfo = null;
    try {
      if (existingId) {
        // The resolver group and its bot memberships are persistent infrastructure.
        // A warm process only needs the durable chat id; re-resolving it through
        // MASTER here would put MASTER back on every normal READY startup.
        diag('RESOLVER_READY', { chat_id: existingId, bots: pool.length, bootstrap: 'persisted' });
        return existingId;
      } else {
        const config = loadMasters()[0];
        const client = await openMaster(config);
        let updates;
        try {
          updates = await client.invoke(new Api.channels.CreateChannel({
            title: 'BeatGaler Transport Resolver',
            about: 'Private internal transport resolver. End users are not members.',
            megagroup: true,
          }));
        } catch (error) {
          try { await client.disconnect(); } catch (_) {}
          throw error;
        }
        const vault = (updates?.chats || []).find(chat => chat?.id) || null;
        if (!vault) {
          try { await client.disconnect(); } catch (_) {}
          throw new Error('MASTER created resolver group but no channel entity was returned.');
        }
        masterInfo = { config, client, vault };
        const resolverId = markedChatId(vault);
        registry.resolver = { chat_id: resolverId, created_at: nowIso(), master_id: config.id };
        writeJsonAtomic(VAULT_REGISTRY_FILE, registry);
        diag('RESOLVER_CREATED', { chat_id: resolverId, master: config.id });
      }

      // One-time bootstrap only. Prefer @username because GramJS can't always
      // resolve an arbitrary numeric bot id that MASTER hasn't seen before.
      for (const configured of pool) {
        try {
          let username = configured.telegram_username;
          if (!username) {
            const token = await resolveManagedToken(configured);
            const identity = await resolveBotIdentityViaHttp(token);
            username = identity.telegram_username;
          }
          if (!username) throw new Error('Transport bot username could not be resolved.');
          const botEntity = await masterInfo.client.getEntity(`@${String(username).replace(/^@/, '')}`);
          await inviteAndPromote(masterInfo.client, masterInfo.vault, botEntity);
        } catch (error) {
          diag('RESOLVER_BOT_ENSURE_FAILED', { transport_id: configured.id, error: error?.message || error });
        }
      }
      const chatId = markedChatId(masterInfo.vault);
      diag('RESOLVER_READY', { chat_id: chatId, bots: pool.length, bootstrap: 'once' });
      return chatId;
    } finally {
      try { if (masterInfo?.client) await masterInfo.client.disconnect(); } catch (_) {}
    }
  })();
  try {
    return await resolverBootstrapPromise;
  } catch (error) {
    resolverBootstrapPromise = null;
    throw error;
  }
}

async function runtimeForLease(
  lease,
  { freshMarker = false, startupTrace = noDirectStartupTrace } = {},
) {
  const pool = await startupTrace.step("START_POOL", async () => loadPool());
  const bot = pool.find(item => item.id === lease.bot_id);
  if (!bot) throw new Error(`Unknown transport bot ${lease.bot_id}.`);

  const state = await startupTrace.step("START_STATE", async () => stateSnapshot(pool));
  const botState = state.bots[bot.id];

  let runtime = runtimeSessions.get(lease.session_id);
  if (!runtime || runtime.credentialVersion !== botState.credential_version) {
    if (bot.managed) {
      const cached = managedTokenCache.get(String(bot.id));
      startupTrace.mark(cached?.credentialVersion === Number(botState.credential_version)
        ? "START_TOKEN_CACHE_HIT" : "START_TOKEN_CACHE_MISS");
    }
    const token = await startupTrace.step(
      "START_TOKEN",
      () => tokenForCredentialVersion(bot, botState.credential_version),
    );

    let username = bot.telegram_username || runtime?.bot?.telegram_username || null;
    let userId = bot.telegram_user_id || runtime?.bot?.telegram_user_id || null;

    if (!username || !userId) {
      const identity = await startupTrace.step(
        "START_IDENTITY",
        () => resolveBotIdentityViaHttp(token),
      );
      username = username || identity.telegram_username;
      userId = userId || identity.telegram_user_id;
    }

    runtime = {
      id: lease.session_id,
      installationId: lease.installation_id,
      chatId: lease.chat_id,
      bot: { ...bot, telegram_username: username, telegram_user_id: userId },
      token,
      generation: lease.generation,
      credentialVersion: botState.credential_version,
      startedAt: parseTime(lease.started_at) || Date.now(),
      masterId: null,
      resolverChatId: null,
    };

    runtimeSessions.set(lease.session_id, runtime);
  }

  if (!runtime.resolverChatId) {
    runtime.resolverChatId = await startupTrace.step(
      "START_RESOLVER",
      () => ensureBotApiResolverChat(),
    );
  }

  return runtime;
}

function sessionPublic(runtime, leaseState = null) {
  return {
    ok: true,
    mode: 'telegram-direct-botapi-local',
    session_id: runtime.id,
    transport_id: runtime.bot.id,
    transport_user_id: runtime.bot.telegram_user_id || null,
    transport_username: runtime.bot.telegram_username || null,
    chat_id: String(runtime.chatId),
    bot_token: runtime.token,
    // The Bot API server is part of the Desktop data plane. The Desktop
    // chooses and owns its loopback port; the control plane never dictates it.
    telegram_api_id: apiCredentials().apiId,
    telegram_api_hash: apiCredentials().apiHash,
    resolver_chat_id: runtime.resolverChatId || String(process.env.DIRECT_BOTAPI_RESOLVER_CHAT_ID || '').trim() || null,
    generation: runtime.generation,
    credential_version: runtime.credentialVersion,
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
    token_rotation_enabled: TOKEN_ROTATION_ENABLED,
    started_at: runtime.startedAt,
    lease_state: leaseState || null,
  };
}

function getLeaseChecked({ installationId, sessionId, generation, allowExpired = false }) {
  const pool = loadPool();
  const state = stateSnapshot(pool);
  const lease = state.leases[String(sessionId || '')];
  if (!lease || lease.installation_id !== String(installationId || '')) return null;
  if (generation != null && Number(generation) !== Number(lease.generation)) return null;
  if (!allowExpired && leaseExpired(lease)) return null;
  return { pool, state, lease };
}

async function startSession({ installationId, chatId, startupTrace = noDirectStartupTrace }) {
  if (!enabled()) throw new Error('Telegram Direct transport is not configured on this server.');
  startMaintenance();
  const installation = String(installationId || '').trim();
  const vaultId = String(chatId || '').trim();
  if (!installation || !vaultId) throw new Error('installationId and chatId are required.');

  const pool = loadPool();
  const snapshot = stateSnapshot(pool);
  const existing = findLeaseByInstallation(snapshot, installation);
  if (existing) {
    if (!leaseExpired(existing) && existing.chat_id === vaultId && existing.status !== 'STOPPING') {
      startupTrace.mark("LEASE_SELECTED", { server_lease: "reused", lease_state: existing.status });
      const runtime = await startupTrace.step("START_RUNTIME", () => runtimeForLease(existing, { startupTrace }));
      mutateState(pool, state => {
        if (state.leases[existing.session_id]) {
          // The desktop helper will call /activate only after its raw Telegram
          // membership listener is running. ACTIVE is preserved for an already
          // leased vault; ASSIGNING is finalized by activateSession.
          state.leases[existing.session_id].last_heartbeat_at = nowIso();
        }
      });
      return sessionPublic(runtime, existing.status);
    }
  }

  // PostgreSQL's session wrapper must prepare the exact assigned lease first.
  // Never choose a different bot from ephemeral load when that contract fails.
  const error = new Error('A persistent-assignment lease is required before Direct startup.');
  error.code = 'TRANSPORT_ASSIGNMENT_LEASE_REQUIRED';
  throw error;
}

async function activateSession({ installationId, sessionId, generation, startupTrace = noDirectStartupTrace }) {
  const checked = getLeaseChecked({ installationId, sessionId, generation });
  if (!checked) throw new Error('Direct transport session is not active.');
  startupTrace.mark("ACTIVATE_LEASE", { lease_state: checked.lease.status });
  const runtime = await startupTrace.step("ACTIVATE_RUNTIME", () => runtimeForLease(checked.lease));
  const masterInfo = await startupTrace.step("ACTIVATE_MASTER", () => masterForVault(checked.lease.chat_id));
  try {
    const botEntity = await startupTrace.step("ACTIVATE_GET_ENTITY", () => runtime.bot.telegram_username
      ? masterInfo.client.getEntity(`@${runtime.bot.telegram_username}`)
      : masterInfo.client.getEntity(runtime.bot.telegram_user_id));

    // IMPORTANT: no Telegram handshake message is sent. The desktop BOT client
    // starts a raw-update listener first; only then MASTER adds/promotes the bot.
    // Telegram's participant/service update contains the Channel entity as seen
    // by THIS bot account, including its own access_hash.
    startupTrace.mark("ACTIVATE_INVITE_PROMOTE", { invite_promote_executed: true });
    await startupTrace.step("ACTIVATE_INVITE_PROMOTE", () => inviteAndPromote(masterInfo.client, masterInfo.vault, botEntity));

    // Do not tell Desktop that activation is complete until MASTER can read the
    // bot back as a real participant of this exact vault. Telegram may still
    // need a short propagation window before Bot API getChat sees membership,
    // so Desktop has a second same-bot retry barrier after this confirmation.
    {
      const started = Date.now();
      const deadline = started + 15_000;
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          const participant = await startupTrace.step("ACTIVATE_GET_PARTICIPANT", () => masterInfo.client.invoke(new Api.channels.GetParticipant({
            channel: masterInfo.vault,
            participant: botEntity,
          })));
          if (participant?.participant) {
            startupTrace.mark("ACTIVATE_MEMBERSHIP", { membership_confirmed: true, attempt });
            diag('SESSION_MEMBERSHIP_CONFIRMED', { session_id: checked.lease.session_id, transport_id: runtime.bot.id, vault: checked.lease.chat_id, attempt, ms: Date.now() - started });
            break;
          }
        } catch (error) {
          const message = String(error?.errorMessage || error?.message || error);
          if (!/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|CHANNEL_PRIVATE/i.test(message) || Date.now() >= deadline) throw error;
          diag('SESSION_MEMBERSHIP_WAIT', { session_id: checked.lease.session_id, transport_id: runtime.bot.id, vault: checked.lease.chat_id, attempt, ms: Date.now() - started, error: message });
        }
        if (Date.now() >= deadline) throw new Error('MASTER could not confirm transport bot membership in the vault within 15 seconds.');
        await new Promise(resolve => setTimeout(resolve, Math.min(1500, 250 * attempt)));
      }

      // MASTER membership is not yet a readiness proof for the bot's own
      // authorization. Do not release /activate until the assigned bot can
      // observe this exact vault through Telegram itself.
      let botAttempt = 0;
      while (true) {
        botAttempt += 1;
        try {
          await probeRuntimeVaultMembership(runtime, startupTrace);
          startupTrace.mark('ACTIVATE_BOT_MEMBERSHIP', { membership_confirmed: true, attempt: botAttempt });
          break;
        } catch (error) {
          if (error?.code !== 'TRANSPORT_BOT_MEMBERSHIP_ABSENT' || Date.now() >= deadline) throw error;
          startupTrace.mark('ACTIVATE_BOT_MEMBERSHIP_WAIT', { membership_confirmed: false, attempt: botAttempt });
          await new Promise(resolve => setTimeout(resolve, Math.min(1500, 250 * botAttempt)));
        }
      }
    }

    await startupTrace.step("ACTIVATE_CLEANUP", () => cleanupLegacyVisibleHandshakes(masterInfo.client, masterInfo.vault));
    runtime.masterId = masterInfo.config?.id || 'Master01';
    const finalized = finalizeLease(checked.lease.session_id);
    console.log(`[direct] SESSION_READY installation=${String(installationId).slice(0, 8)}… transport=${runtime.bot.id} master=${runtime.masterId}`);
    diag('SESSION_READY', { installation: String(installationId).slice(0, 8), session_id: checked.lease.session_id, transport_id: runtime.bot.id, vault: checked.lease.chat_id, master: runtime.masterId });
    return {
      ok: true,
      activated: true,
      status: finalized?.status || 'ACTIVE',
      membership: {
        state: 'bot_visible',
        source: 'bot_api_getChat',
        vault_chat_id: String(checked.lease.chat_id),
        channel_id: String(checked.lease.chat_id).startsWith('-100') ? String(checked.lease.chat_id).slice(4) : null,
        transport_id: runtime.bot.id,
        expected_bot_id: runtime.bot.telegram_user_id || null,
      },
    };
  } finally {
    try { await startupTrace.step("ACTIVATE_DISCONNECT", () => masterInfo.client.disconnect()); } catch (_) {}
  }
}

async function probeSessionMembership({ installationId, sessionId, generation, startupTrace = noDirectStartupTrace }) {
  const checked = getLeaseChecked({ installationId, sessionId, generation });
  if (!checked) throw new Error('Direct transport session is not active.');
  startupTrace.mark('BOT_MEMBERSHIP_LEASE', {
    lease_state: checked.lease.status,
    vault_chat_id: String(checked.lease.chat_id),
    transport_id: String(checked.lease.bot_id),
  });
  const runtime = await startupTrace.step('BOT_MEMBERSHIP_RUNTIME', () => runtimeForLease(checked.lease, { startupTrace }));
  return probeRuntimeVaultMembership(runtime, startupTrace);
}

async function heartbeat({ installationId, sessionId, generation, credentialVersion }) {
  const pool = loadPool();
  const snapshot = stateSnapshot(pool);
  const lease = snapshot.leases[String(sessionId || '')];
  if (!lease || lease.installation_id !== String(installationId || '') || Number(lease.generation) !== Number(generation)) {
    return { ok: false, expired: true };
  }
  if (leaseExpired(lease)) {
    void cleanupLease(lease, { reason: 'heartbeat_timeout' }).catch(error => {
      console.warn('[direct] stale heartbeat cleanup failed:', error?.message || error);
    });
    return { ok: false, expired: true };
  }
  mutateState(pool, state => {
    const current = state.leases[lease.session_id];
    if (current) {
      current.last_heartbeat_at = nowIso();
      if (current.status === 'SUSPECTED') current.status = 'ACTIVE';
    }
  });

  const fresh = stateSnapshot(pool);
  const botState = fresh.bots[lease.bot_id];
  if (Number(credentialVersion || 0) !== Number(botState.credential_version)) {
    const runtime = await runtimeForLease(fresh.leases[lease.session_id], { freshMarker: true });
    return { ok: true, credential_refresh: sessionPublic(runtime) };
  }
  return {
    ok: true,
    status: botState.rotation_pending ? 'ROTATION_PENDING' : 'ACTIVE',
    credential_version: botState.credential_version,
  };
}

async function maybeRotatePendingBot(botId) {
  if (!TOKEN_ROTATION_ENABLED) {
    const pool = loadPool();
    mutateState(pool, state => {
      if (state.bots[botId]) state.bots[botId].rotation_pending = false;
    });
    return { rotated: false, pending: false, disabled: true };
  }
  if (botRotationLocks.has(botId)) return botRotationLocks.get(botId);
  const promise = (async () => {
    const pool = loadPool();
    let snapshot = stateSnapshot(pool);
    const botState = snapshot.bots[botId];
    if (!botState?.rotation_pending) return { rotated: false, pending: false };
    if (activeOpsForBot(snapshot, botId).length > 0) return { rotated: false, pending: true };
    const bot = pool.find(item => item.id === botId);
    if (!bot) throw new Error(`Unknown transport bot ${botId}.`);
    try {
      const newToken = await rotateManagedToken(bot);
      const rotatedAt = nowIso();
      let version = 1;
      mutateState(pool, state => {
        const bs = state.bots[botId];
        bs.credential_version = Number(bs.credential_version || 1) + 1;
        bs.rotation_pending = false;
        bs.quarantined = false;
        bs.quarantine_reason = null;
        version = bs.credential_version;
        state.rotation[botId] = { last_rotated_at: rotatedAt, last_status: 'rotated_after_session_end', last_error: null };
        for (const lease of Object.values(state.leases)) {
          if (lease.bot_id === botId) lease.status = lease.status === 'SUSPECTED' ? 'SUSPECTED' : 'ACTIVE';
        }
      });
      for (const [sessionId, runtime] of runtimeSessions.entries()) {
        if (runtime.bot.id !== botId) continue;
        runtime.token = newToken;
        runtime.credentialVersion = version;
        runtimeSessions.set(sessionId, runtime);
      }
      managedTokenCache.set(botId, { credentialVersion: version, token: newToken });
      console.log(`[direct] TOKEN_ROTATED transport=${botId} credential_version=${version}`);
      return { rotated: true, pending: false, credential_version: version };
    } catch (error) {
      mutateState(pool, state => {
        state.bots[botId].quarantined = true;
        state.bots[botId].quarantine_reason = `rotation failed: ${error?.message || error}`;
        state.rotation[botId] = {
          last_rotated_at: state.rotation[botId]?.last_rotated_at || null,
          last_status: 'error',
          last_error: String(error?.message || error),
        };
      });
      console.error(`[direct] TOKEN_ROTATION_FAILED transport=${botId}:`, error?.message || error);
      return { rotated: false, pending: true, quarantined: true, error: String(error?.message || error) };
    }
  })().finally(() => botRotationLocks.delete(botId));
  botRotationLocks.set(botId, promise);
  return promise;
}

function normalizeOperationDocumentContext(input) {
  const tabId = String(input?.tab_id || '').trim();
  const documentId = String(input?.document_id || '').trim();
  const documentGeneration = Number(input?.generation || 0);
  if (
    !tabId ||
    !documentId ||
    tabId.length > 128 ||
    documentId.length > 128 ||
    !Number.isSafeInteger(documentGeneration) ||
    documentGeneration <= 0
  ) {
    return null;
  }
  return {
    tab_id: tabId,
    document_id: documentId,
    generation: documentGeneration,
  };
}

async function beginOperation({ installationId, sessionId, generation, credentialVersion, kind, documentContext }) {
  const beginStartedAt = monotonicNow();
  const checked = getLeaseChecked({ installationId, sessionId, generation });
  if (!checked) {
    diag('OPERATION_BEGIN_EXPIRED', {
      session_id: String(sessionId || ''),
      generation: Number(generation || 0),
      kind: String(kind || 'data'),
      elapsed_ms: Math.round(elapsedSinceMonotonic(beginStartedAt)),
    });
    return { ok: false, expired: true };
  }
  const { pool, lease } = checked;
  diag('OPERATION_BEGIN_ENTER', {
    session_id: lease.session_id,
    transport_id: lease.bot_id,
    vault: lease.chat_id,
    kind: String(kind || 'data'),
    generation: Number(generation || 0),
  });
  mutateState(pool, state => {
    if (state.leases[lease.session_id]) state.leases[lease.session_id].last_heartbeat_at = nowIso();
  });

  let snapshot = stateSnapshot(pool);
  let botState = snapshot.bots[lease.bot_id];
  if (botState.rotation_pending) {
    const rotation = await maybeRotatePendingBot(lease.bot_id);
    snapshot = stateSnapshot(pool);
    botState = snapshot.bots[lease.bot_id];
    if (botState.rotation_pending) {
      diag('OPERATION_BEGIN_WAIT', {
        session_id: lease.session_id,
        transport_id: lease.bot_id,
        vault: lease.chat_id,
        kind: String(kind || 'data'),
        reason: 'rotation_pending',
        elapsed_ms: Math.round(elapsedSinceMonotonic(beginStartedAt)),
      });
      return { ok: false, wait: true, retry_after_ms: 250, reason: 'rotation_pending' };
    }
  }

  if (Number(credentialVersion || 0) !== Number(botState.credential_version)) {
    const runtime = await runtimeForLease(snapshot.leases[lease.session_id], { freshMarker: true });
    diag('OPERATION_BEGIN_REFRESH_REQUIRED', {
      session_id: lease.session_id,
      transport_id: lease.bot_id,
      vault: lease.chat_id,
      kind: String(kind || 'data'),
      elapsed_ms: Math.round(elapsedSinceMonotonic(beginStartedAt)),
    });
    return { ok: false, refresh_required: true, credential_refresh: sessionPublic(runtime) };
  }

  const normalizedKind = String(kind || 'data');
  const normalizedDocumentContext = normalizeOperationDocumentContext(documentContext);
  const opId = `op_${crypto.randomBytes(12).toString('hex')}`;
  const admitted = mutateState(pool, state => {
    const current = state.leases[lease.session_id];
    if (!current) return false;

    // A vault has exactly one authoritative pinned INDEX. Serialize EVERY
    // INDEX read/write by Telegram chat id, not by installation. A get_index
    // must never race a replace_index that pins the new document and deletes
    // the previous one; otherwise the reader can obtain the old pinned message
    // just before it disappears. This also protects multiple BeatGaler devices
    // connected to the same vault.
    const isIndexOperation = normalizedKind === 'get_index' || normalizedKind === 'replace_index';
    if (isIndexOperation) {
      // Browser reload/navigation replaces the active Document and terminates its
      // dedicated Worker. A later generation from the SAME tab + SAME Direct
      // session may therefore fence and reclaim only that tab's older orphaned
      // INDEX operation. Different tabs/devices remain serialized, and an older
      // request arriving late can never steal a newer generation's operation.
      if (normalizedDocumentContext) {
        for (const [existingId, existing] of Object.entries(state.operations)) {
          const existingIsIndex = existing?.kind === 'get_index' || existing?.kind === 'replace_index';
          const sameVault = String(existing?.chat_id || '') === String(lease.chat_id || '');
          const sameSession = String(existing?.session_id || '') === String(lease.session_id || '');
          const sameTab = String(existing?.document_tab_id || '') === normalizedDocumentContext.tab_id;
          const existingGeneration = Number(existing?.document_generation || 0);
          const supersededDocument =
            Number.isSafeInteger(existingGeneration) &&
            existingGeneration > 0 &&
            existingGeneration < normalizedDocumentContext.generation;

          if (existingIsIndex && sameVault && sameSession && sameTab && supersededDocument) {
            delete state.operations[existingId];
            unconfirmedOperationSince.delete(existingId);
            diag('INDEX_OPERATION_DOCUMENT_SUPERSEDED', {
              operation_id: existingId,
              session_id: existing.session_id,
              vault: existing.chat_id,
              old_document_generation: existingGeneration,
              new_document_generation: normalizedDocumentContext.generation,
            });
          }
        }
      }

      const busy = Object.values(state.operations).some(op =>
        (op.kind === 'get_index' || op.kind === 'replace_index') &&
        String(op.chat_id || '') === String(lease.chat_id || '')
      );
      if (busy) return false;
    }

    current.last_heartbeat_at = nowIso();
    state.operations[opId] = {
      operation_id: opId,
      session_id: lease.session_id,
      bot_id: lease.bot_id,
      installation_id: lease.installation_id,
      chat_id: lease.chat_id,
      kind: normalizedKind,
      ...(normalizedDocumentContext ? {
        document_tab_id: normalizedDocumentContext.tab_id,
        document_id: normalizedDocumentContext.document_id,
        document_generation: normalizedDocumentContext.generation,
      } : {}),
      started_at: nowIso(),
      started_monotonic_ms: monotonicNow(),
      liveness_owner_instance: PROCESS_INSTANCE_ID,
      last_liveness_at: nowIso(),
      last_liveness_monotonic_ms: monotonicNow(),
    };
    return true;
  });
  if (!admitted) {
    const blocking = Object.values(stateSnapshot(pool).operations).find(op =>
      (op.kind === 'get_index' || op.kind === 'replace_index') &&
      String(op.chat_id || '') === String(lease.chat_id || '')
    );
    diagBusyOperationOnce(`${lease.chat_id}:${normalizedKind}`, {
      session_id: lease.session_id,
      transport_id: lease.bot_id,
      vault: lease.chat_id,
      kind: normalizedKind,
      reason: 'index_busy',
      elapsed_ms: Math.round(elapsedSinceMonotonic(beginStartedAt)),
      document_generation: normalizedDocumentContext?.generation || null,
      ...operationDiagnosticOwner(blocking),
    });
    return { ok: false, wait: true, retry_after_ms: 200, reason: 'index_busy' };
  }
  diag('OPERATION_BEGIN_GRANTED', {
    operation_id: opId,
    session_id: lease.session_id,
    transport_id: lease.bot_id,
    vault: lease.chat_id,
    kind: normalizedKind,
    elapsed_ms: Math.round(elapsedSinceMonotonic(beginStartedAt)),
    document_generation: normalizedDocumentContext?.generation || null,
  });
  return {
    ok: true,
    operation_id: opId,
    credential_version: botState.credential_version,
    operation_liveness_timeout_ms: operationLivenessTimeout({ kind: normalizedKind }),
  };
}

async function endOperation({ installationId, sessionId, generation, operationId }) {
  const pool = loadPool();
  let botId = null;
  let endedOperation = null;
  mutateState(pool, state => {
    const lease = state.leases[String(sessionId || '')];
    if (lease && lease.installation_id === String(installationId || '') && Number(lease.generation) === Number(generation)) {
      lease.last_heartbeat_at = nowIso();
      botId = lease.bot_id;
    }
    const op = state.operations[String(operationId || '')];
    if (op && op.session_id === String(sessionId || '')) {
      botId = botId || op.bot_id;
      endedOperation = { ...op };
      delete state.operations[String(operationId)];
      unconfirmedOperationSince.delete(String(operationId));
    }
  });
  if (endedOperation) {
    diag('OPERATION_END', {
      operation_id: String(operationId || ''),
      session_id: endedOperation.session_id,
      transport_id: endedOperation.bot_id,
      vault: endedOperation.chat_id,
      kind: endedOperation.kind,
      duration_ms: Math.round(operationDurationMs(endedOperation)),
      last_liveness_age_ms: Math.round(operationLivenessAge(endedOperation, operationId)),
      document_generation: endedOperation.document_generation || null,
    });
  }
  if (botId) await maybeRotatePendingBot(botId);
  return { ok: true };
}

async function renewOperation({ installationId, sessionId, generation, operationId }) {
  const pool = loadPool();
  let renewed = false;
  let operation = null;
  mutateState(pool, state => {
    const lease = state.leases[String(sessionId || '')];
    const current = state.operations[String(operationId || '')];
    if (!lease || !current) return;
    if (lease.installation_id !== String(installationId || '') || Number(lease.generation) !== Number(generation)) return;
    if (current.session_id !== lease.session_id) return;
    lease.last_heartbeat_at = nowIso();
    current.last_liveness_at = nowIso();
    current.last_liveness_monotonic_ms = monotonicNow();
    current.liveness_owner_instance = PROCESS_INSTANCE_ID;
    unconfirmedOperationSince.delete(String(operationId));
    operation = { ...current };
    renewed = true;
  });
  if (!renewed) return { ok: false, expired: true };
  return { ok: true, operation_id: String(operationId || ''), liveness_timeout_ms: operationLivenessTimeout(operation) };
}

async function cleanupLease(leaseInput, { reason = 'session_end' } = {}) {
  const pool = loadPool();
  const snapshot = stateSnapshot(pool);
  const lease = snapshot.leases[String(leaseInput?.session_id || leaseInput || '')];
  if (!lease) return { ok: true, released: false };

  // Session lifecycle is intentionally membership-neutral. Persistent
  // vault<->transport ownership survives logout, tab close, heartbeat timeout,
  // crash/stale cleanup and session replacement. No MASTER lookup, getEntity,
  // kick, unban or membership probe belongs on this path.
  mutateState(pool, state => {
    const current = state.leases[lease.session_id];
    if (current) current.status = 'STOPPING';
  });

  // deleteLease removes every operation owned by the lease. runtimeSessions is
  // the remaining process-local credential/session material for this lease.
  deleteLease(lease.session_id);
  runtimeSessions.delete(lease.session_id);

  const remaining = leasesForBot(stateSnapshot(pool), lease.bot_id).length;
  let rotation = { rotated: false, pending: false, disabled: !TOKEN_ROTATION_ENABLED };
  if (TOKEN_ROTATION_ENABLED && remaining === 0) {
    mutateState(pool, state => {
      const botState = state.bots[lease.bot_id];
      if (botState && !botState.quarantined) botState.rotation_pending = true;
    });
    rotation = await maybeRotatePendingBot(lease.bot_id);
  }

  if (!TOKEN_ROTATION_ENABLED) {
    diag('SESSION_RELEASE_NO_TOKEN_REVOKE', { session_id: lease.session_id, transport_id: lease.bot_id, reason });
  }
  diag('SESSION_RELEASE_MEMBERSHIP_PRESERVED', {
    session_id: lease.session_id,
    transport_id: lease.bot_id,
    vault: lease.chat_id,
    reason,
    remaining_leases: remaining,
  });
  console.log('[direct] SESSION_RELEASED installation=' + lease.installation_id.slice(0, 8) + '… transport=' + lease.bot_id + ' reason=' + reason + ' remaining_leases=' + remaining + ' rotation_pending=' + Boolean(rotation?.pending) + ' membership=preserved');
  return {
    ok: true,
    released: true,
    rotation_pending: Boolean(rotation?.pending),
    transport_id: lease.bot_id,
    membership_preserved: true,
  };
}

async function decommissionVaultMembership({ chatId, transportBotId }) {
  const vaultId = String(chatId || '').trim();
  const botId = String(transportBotId || '').trim();
  if (!vaultId || !botId) throw new Error('chatId and transportBotId are required for explicit Direct membership decommission.');
  const pool = loadPool();
  const bot = pool.find(item => item.id === botId);
  if (!bot) throw new Error('Unknown transport bot ' + botId + '.');

  let username = bot.telegram_username || null;
  let userId = bot.telegram_user_id || null;
  if (!username || !userId) {
    const token = await resolveManagedToken(bot);
    const identity = await resolveBotIdentityViaHttp(token);
    username = username || identity.telegram_username;
    userId = userId || identity.telegram_user_id;
  }

  const masterInfo = await masterForVault(vaultId);
  try {
    const botEntity = username
      ? await masterInfo.client.getEntity('@' + String(username).replace(/^@/, ''))
      : await masterInfo.client.getEntity(userId);
    await kickAndUnban(masterInfo.client, masterInfo.vault, botEntity);
    diag('VAULT_MEMBERSHIP_DECOMMISSIONED', { vault: vaultId, transport_id: botId });
    return { ok: true, decommissioned: true, chat_id: vaultId, transport_id: botId };
  } finally {
    try { await masterInfo.client.disconnect(); } catch (_) {}
  }
}

async function cleanupLeaseSingleflight(leaseInput, options = {}) {
  const sessionId = String(leaseInput?.session_id || leaseInput || '');
  if (!sessionId) return { ok: true, released: false };
  const existing = leaseCleanupLocks.get(sessionId);
  if (existing) {
    diag('SESSION_RELEASE_JOIN_EXISTING', { session_id: sessionId, reason: options.reason || 'session_end' });
    return existing;
  }
  const pending = cleanupLease(leaseInput, options)
    .finally(() => leaseCleanupLocks.delete(sessionId));
  leaseCleanupLocks.set(sessionId, pending);
  return pending;
}

async function stopSession({ installationId, sessionId, generation }) {
  const checked = getLeaseChecked({ installationId, sessionId, generation, allowExpired: true });
  if (!checked) return { ok: true, released: false };
  return cleanupLeaseSingleflight(checked.lease, { reason: 'normal_close' });
}

async function cleanupExpiredSessions() {
  if (!enabled()) return;
  const pool = loadPool();
  const snapshot = stateSnapshot(pool);
  const expired = Object.values(snapshot.leases).filter(lease => leaseExpired(lease));
  for (const lease of expired) {
    try {
      console.warn(`[direct] HEARTBEAT_EXPIRED session=${lease.session_id.slice(0, 12)} transport=${lease.bot_id} vault=${lease.chat_id}`);
      await cleanupLeaseSingleflight(lease, { reason: 'heartbeat_timeout' });
    } catch (error) {
      console.warn(`[direct] stale session retained/quarantined ${lease.session_id}:`, error?.message || error);
    }
  }
  // If a crashed session left an operation entry, cleanupLease removed it. This
  // may finally allow a token rotation that was waiting for the operation drain.
  const after = stateSnapshot(pool);
  for (const bot of pool) {
    if (after.bots[bot.id]?.rotation_pending && activeOpsForBot(after, bot.id).length === 0) {
      await maybeRotatePendingBot(bot.id);
    }
  }
}

function startMaintenance() {
  if (maintenanceStarted || !enabled()) return;
  maintenanceStarted = true;
  const timer = setInterval(() => {
    cleanupExpiredSessions().catch(error => console.warn('[direct] maintenance sweep failed:', error?.message || error));
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => cleanupExpiredSessions().catch(() => {}), 1000).unref?.();
}

async function verifyMessage({ installationId, sessionId, messageId }) {
  // Compatibility endpoint only. The normal Direct app no longer calls this;
  // successful sendFile from the client is the data-plane acknowledgement.
  const checked = getLeaseChecked({ installationId, sessionId });
  if (!checked) throw new Error('Direct transport session is not active.');
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid Telegram message id.');
  return true;
}

// Compatibility helpers retained for server-side migration/admin tools. New
// BeatGaler clients do not use MASTER for index reads/writes or media bytes.
async function commitIndexCopyOnWrite({ chatId, filePath, caption, previousMessageId }) {
  const masterInfo = await masterForVault(chatId);
  try {
    const stat = fs.statSync(filePath);
    const sent = await masterInfo.client.sendFile(masterInfo.vault, {
      file: new CustomFile(path.basename(filePath), stat.size, filePath),
      forceDocument: true,
      caption,
      workers: 1,
    });
    await masterInfo.client.invoke(new Api.messages.UpdatePinnedMessage({ peer: masterInfo.vault, id: Number(sent.id), silent: true, unpin: false, pmOneside: false }));
    if (Number(previousMessageId) > 0) {
      try { await masterInfo.client.invoke(new Api.channels.DeleteMessages({ channel: masterInfo.vault, id: [Number(previousMessageId)] })); } catch (_) {}
    }
    return { messageId: Number(sent.id), backups: [] };
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function publishIndexBuffer({ chatId, bytes, caption }) {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'beatgaler-index-'));
  const filePath = path.join(directory, 'library.json');
  try {
    fs.writeFileSync(filePath, bytes, { flag: 'wx' });
    return await commitIndexCopyOnWrite({ chatId, filePath, caption, previousMessageId: null });
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmdirSync(directory);
  }
}

async function pinExistingIndexMessage(chatId, messageId) {
  const id = Number(messageId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Valid INDEX message id required.');
  const masterInfo = await masterForVault(chatId);
  try {
    const message = (await masterInfo.client.getMessages(masterInfo.vault, { ids: [id] }))?.[0];
    const caption = String(message?.message || '');
    if (!message?.media || !(caption === 'BEATGALER_LIBRARY_INDEX_V1' || caption.startsWith('BEATGALER_LIBRARY_INDEX_V1\n'))) {
      throw new Error('Stored INDEX copy is unavailable for recovery.');
    }
    await masterInfo.client.invoke(new Api.messages.UpdatePinnedMessage({
      peer: masterInfo.vault, id, silent: true, unpin: false, pmOneside: false,
    }));
    const full = await masterInfo.client.invoke(new Api.channels.GetFullChannel({ channel: masterInfo.vault }));
    if (Number(full?.fullChat?.pinnedMsgId) !== id) throw new Error('INDEX recovery pin could not be verified.');
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function downloadMessageBuffer(chatId, messageId) {
  const masterInfo = await masterForVault(chatId);
  try {
    const message = (await masterInfo.client.getMessages(masterInfo.vault, { ids: [Number(messageId)] }))?.[0];
    if (!message?.media) throw new Error(`Message ${messageId} has no downloadable media.`);
    const result = await masterInfo.client.downloadMedia(message, {});
    if (!Buffer.isBuffer(result)) throw new Error(`Message ${messageId} download returned no buffer.`);
    return result;
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

function projectCaption(beatId, sha256) {
  return `BEATGALER_PROJECT_V1 beat=${beatId} sha256=${sha256}`;
}

function legacyProjectCaption(beatId, sourceMessageId, partIndex) {
  return `BEATGALER_LEGACY_PROJECT_V1 beat=${beatId} source=${sourceMessageId} part=${partIndex}`;
}

async function copyLegacyProjectPartFromClient(client, vault, { beatId, sourceMessageId, partIndex }) {
    const caption = legacyProjectCaption(beatId, sourceMessageId, partIndex);
    const source = (await client.getMessages(vault, { ids: [sourceMessageId] }))?.[0];
    if (!(source?.media?.document instanceof Api.Document)) {
      throw new ProjectAccessError('Legacy PROJECT document is unavailable.', 'PROJECT_LEGACY_UNAVAILABLE', 503);
    }
    const documentId = String(source.media.document.id);
    const sizeBytes = Number(source.media.document.size);
    for (const options of [{ search: caption, limit: 100 }, { limit: 100 }]) {
      for await (const message of client.iterMessages(vault, options)) {
        if (message?.out === true && String(message.message || '') === caption &&
            String(message.media?.document?.id || '') === documentId &&
            Number(message.media.document.size) === sizeBytes) {
          return { sourceMessageId, messageId: Number(message.id), documentId, sizeBytes, partIndex };
        }
      }
    }
    const sent = await client.sendFile(vault, {
      file: source.media, forceDocument: true, caption, workers: 1,
    });
    if (!Number.isSafeInteger(Number(sent?.id)) || String(sent?.media?.document?.id || '') !== documentId) {
      throw new ProjectAccessError('MASTER did not copy the legacy PROJECT.', 'PROJECT_LEGACY_UNAVAILABLE', 503);
    }
    return { sourceMessageId, messageId: Number(sent.id), documentId, sizeBytes, partIndex };
}

async function copyLegacyProjectPart({ chatId, ...input }) {
  const masterInfo = await masterForVault(chatId);
  try {
    return await copyLegacyProjectPartFromClient(masterInfo.client, masterInfo.vault, input);
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function verifyLegacyProjectCopy({ chatId, beatId, sourceMessageId, messageId, documentId, sizeBytes, partIndex }) {
  const masterInfo = await masterForVault(chatId);
  try {
    const message = (await masterInfo.client.getMessages(masterInfo.vault, { ids: [messageId] }))?.[0];
    if (message?.out !== true || String(message.message || '') !== legacyProjectCaption(beatId, sourceMessageId, partIndex) ||
        !(message.media?.document instanceof Api.Document) ||
        String(message.media.document.id) !== documentId || Number(message.media.document.size) !== sizeBytes) {
      throw new ProjectAccessError('MASTER legacy PROJECT copy changed.', 'PROJECT_LEGACY_UNAVAILABLE', 503);
    }
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function publishProjectFile({ chatId, filePath, filename, beatId, sha256, sizeBytes, threadId }) {
  const masterInfo = await masterForVault(chatId);
  try {
    const sent = await masterInfo.client.sendFile(masterInfo.vault, {
      file: new CustomFile(path.basename(String(filename || 'project.zip')), sizeBytes, filePath),
      forceDocument: true,
      caption: projectCaption(beatId, sha256),
      ...(Number.isSafeInteger(Number(threadId)) && Number(threadId) > 0 ? { replyTo: Number(threadId) } : {}),
      workers: 1,
    });
    const id = Number(sent?.id || 0);
    const documentId = String(sent?.media?.document?.id || '');
    if (!Number.isSafeInteger(id) || id <= 0 || !documentId) {
      throw new ProjectAccessError('MASTER returned no PROJECT document.', 'PROJECT_BYTES_UNVERIFIED', 503);
    }
    return { messageId: id, documentId };
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function verifyProjectMediaFromClient(client, vault, { messageId, beatId, sha256, documentId, sizeBytes }) {
  const message = (await client.getMessages(vault, { ids: [Number(messageId)] }))?.[0];
  if (message?.out !== true || String(message?.message || '') !== projectCaption(beatId, sha256) ||
      !(message?.media?.document instanceof Api.Document) ||
      String(message.media.document.id) !== String(documentId) ||
      Number(message.media.document.size) !== Number(sizeBytes)) {
    throw new ProjectAccessError('MASTER PROJECT document changed or is unavailable.', 'PROJECT_BYTES_UNVERIFIED', 503);
  }
  return true;
}

async function findProjectFile({ chatId, beatId, sha256, sizeBytes }) {
  const masterInfo = await masterForVault(chatId);
  try {
    const caption = projectCaption(beatId, sha256);
    for (const options of [{ search: caption, limit: 100 }, { limit: 100 }]) {
      for await (const message of masterInfo.client.iterMessages(masterInfo.vault, options)) {
        if (message?.out !== true || String(message?.message || '') !== caption ||
            !(message?.media?.document instanceof Api.Document) ||
            Number(message.media.document.size) !== sizeBytes) continue;
        return { messageId: Number(message.id), documentId: String(message.media.document.id) };
      }
    }
    return null;
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function verifyProjectMessage({ chatId, ...input }) {
  const masterInfo = await masterForVault(chatId);
  try {
    return await verifyProjectMediaFromClient(masterInfo.client, masterInfo.vault, input);
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function deleteMessages(chatId, ids) {
  const list = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!list.length) return 0;
  const masterInfo = await masterForVault(chatId);
  try {
    for (let i = 0; i < list.length; i += 100) {
      await masterInfo.client.invoke(new Api.channels.DeleteMessages({ channel: masterInfo.vault, id: list.slice(i, i + 100) }));
    }
    return list.length;
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function deleteAndVerifyMessages(chatId, ids) {
  const list = [...new Set((ids || []).map(Number))];
  if (list.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid purge message ID.');
  if (!list.length) throw new Error('Purge has no verified assets.');
  const masterInfo = await masterForVault(chatId);
  try {
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100);
      const states = async () => {
        const response = await masterInfo.client.invoke(new Api.channels.GetMessages({
          channel: masterInfo.vault,
          id: batch.map(id => new Api.InputMessageID({ id })),
        }));
        const byId = new Map((response?.messages || []).map(message => [Number(message.id), message]));
        if (batch.some(id => !byId.has(id))) throw new Error('MASTER returned an incomplete asset verification.');
        return byId;
      };
      const before = await states();
      const existing = batch.filter(id => !(before.get(id) instanceof Api.MessageEmpty));
      if (existing.length) {
        await masterInfo.client.invoke(new Api.channels.DeleteMessages({ channel: masterInfo.vault, id: existing }));
      }
      const after = await states();
      if (batch.some(id => !(after.get(id) instanceof Api.MessageEmpty))) {
        throw new Error('MASTER could not verify permanent asset deletion.');
      }
    }
    return list.length;
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function getPinnedMessage(chatId) {
  const masterInfo = await masterForVault(chatId);
  try {
    const full = await masterInfo.client.invoke(new Api.channels.GetFullChannel({ channel: masterInfo.vault }));
    const pinnedId = Number(full?.fullChat?.pinnedMsgId || 0);
    if (!Number.isInteger(pinnedId) || pinnedId <= 0) return null;
    const message = (await masterInfo.client.getMessages(masterInfo.vault, { ids: [pinnedId] }))?.[0];
    if (!message) return null;
    return { message_id: Number(message.id), caption: String(message.message || ''), text: String(message.message || ''), has_media: Boolean(message.media) };
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function readPinnedIndexBuffer(chatId) {
  const masterInfo = await masterForVault(chatId);
  try {
    const full = await masterInfo.client.invoke(new Api.channels.GetFullChannel({ channel: masterInfo.vault }));
    const id = Number(full?.fullChat?.pinnedMsgId || 0);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const message = (await masterInfo.client.getMessages(masterInfo.vault, { ids: [id] }))?.[0];
    if (!message?.media) throw new Error('Pinned INDEX has no downloadable media.');
    const raw = await masterInfo.client.downloadMedia(message, {});
    if (!Buffer.isBuffer(raw)) throw new Error('Pinned INDEX download returned no buffer.');
    const checked = await masterInfo.client.invoke(new Api.channels.GetFullChannel({ channel: masterInfo.vault }));
    if (Number(checked?.fullChat?.pinnedMsgId || 0) !== id) {
      throw new Error('Pinned INDEX changed during download.');
    }
    return { message_id: id, caption: String(message.message || ''), raw };
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

function topicIdFromCreateUpdates(updates) {
  for (const update of updates?.updates || []) {
    const message = update?.message;
    if (message?.id && message?.action?.className === 'MessageActionTopicCreate') return Number(message.id);
  }
  for (const update of updates?.updates || []) if (update?.message?.id) return Number(update.message.id);
  return null;
}

async function createForumTopic(chatId, title) {
  const masterInfo = await masterForVault(chatId);
  try {
    const updates = await masterInfo.client.invoke(new Api.channels.CreateForumTopic({ channel: masterInfo.vault, title: String(title || 'Untitled Beat').slice(0, 128) }));
    const topicId = topicIdFromCreateUpdates(updates);
    if (!Number.isInteger(topicId) || topicId <= 0) throw new Error('MASTER created a forum topic but no topic id was returned.');
    return topicId;
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function editForumTopic(chatId, topicId, title) {
  const masterInfo = await masterForVault(chatId);
  try {
    await masterInfo.client.invoke(new Api.channels.EditForumTopic({ channel: masterInfo.vault, topicId: Number(topicId), title: String(title || 'Untitled Beat').slice(0, 128) }));
    return true;
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

async function deleteForumTopic(chatId, topicId) {
  const masterInfo = await masterForVault(chatId);
  try {
    await masterInfo.client.invoke(new Api.channels.DeleteTopicHistory({ channel: masterInfo.vault, topMsgId: Number(topicId) }));
    return true;
  } finally { try { await masterInfo.client.disconnect(); } catch (_) {} }
}

function poolStatus() {
  if (!fs.existsSync(POOL_FILE)) return { configured: false, bots: [], sessions: 0, operations: 0 };
  const pool = loadPool();
  const state = normalizeState(pool);
  return {
    configured: enabled(),
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
    sessions: Object.keys(state.leases).length,
    operations: Object.keys(state.operations).length,
    bots: pool.map(bot => ({
      id: bot.id,
      label: bot.label,
      managed: bot.managed,
      // Compatibility name: counts ephemeral leases, never persistent ownership.
      active_vaults: leasesForBot(state, bot.id).length,
      active_operations: activeOpsForBot(state, bot.id).length,
      credential_version: state.bots[bot.id].credential_version,
      rotation_pending: state.bots[bot.id].rotation_pending,
      quarantined: state.bots[bot.id].quarantined,
    })),
    queue: [], // Deprecated diagnostic field; ephemeral FIFO ownership is retired.
  };
}

startMaintenance();


function recordIndexPointer(chatId, pointer = {}) {
  const key = String(chatId || '').trim();
  if (!key) throw new Error('chatId is required for index pointer.');
  const registry = loadVaultRegistry();
  const current = registry.vaults[key] || {};
  registry.vaults[key] = {
    ...current,
    current_index_message_id: Number(pointer.messageId || 0) || null,
    current_index_file_id: String(pointer.fileId || '').trim() || null,
    current_index_updated_at: nowIso(),
  };
  writeJsonAtomic(VAULT_REGISTRY_FILE, registry);
  diag('INDEX_POINTER_COMMIT', { vault: key, message_id: registry.vaults[key].current_index_message_id, has_file_id: Boolean(registry.vaults[key].current_index_file_id) });
  return registry.vaults[key];
}

function recordDiagnostic(event, fields = {}) {
  diag(String(event || 'DIRECT_DIAGNOSTIC'), fields);
}

function getIndexPointer(chatId) {
  const key = String(chatId || '').trim();
  const registry = loadVaultRegistry();
  const row = registry.vaults[key] || {};
  return {
    message_id: Number(row.current_index_message_id || 0),
    file_id: row.current_index_file_id || null,
    updated_at: row.current_index_updated_at || null,
  };
}
module.exports = {
  TOKEN_ROTATION_ENABLED,
  recordDiagnostic,
  recordIndexPointer,
  getIndexPointer,
  enabled,
  startSession,
  activateSession,
  probeSessionMembership,
  heartbeat,
  beginOperation,
  renewOperation,
  endOperation,
  stopSession,
  decommissionVaultMembership,
  verifyMessage,
  commitIndexCopyOnWrite,
  publishIndexBuffer,
  pinExistingIndexMessage,
  restrictBotPinRights,
  downloadMessageBuffer,
  publishProjectFile,
  copyLegacyProjectPart,
  copyLegacyProjectPartFromClient,
  directBotAdminRights,
  verifyLegacyProjectCopy,
  verifyProjectMessage,
  verifyProjectMediaFromClient,
  findProjectFile,
  deleteMessages,
  deleteAndVerifyMessages,
  getPinnedMessage,
  readPinnedIndexBuffer,
  createForumTopic,
  editForumTopic,
  deleteForumTopic,
  poolStatus,
  cleanupExpiredSessions,
  __test: {
    normalizeState,
    stateSnapshot,
    mutateState,
    setMonotonicNow(fn) {
      monotonicNowImpl = typeof fn === 'function' ? fn : () => performance.now();
    },
    leasesForBot,
    activeOpsForBot,
    inviteAndPromote,
    botMembershipError,
    probeRuntimeVaultMembership,
    resolveManagedToken,
    tokenForCredentialVersion,
    transientManagedTokenFetchError,
    setManagerBotFetch(fn) {
      managerBotFetch = typeof fn === 'function' ? fn : (...args) => fetch(...args);
    },
    setManagedTokenFetchRetryPolicy(policy = {}) {
      managedTokenFetchRetryPolicy = {
        attempts: Math.max(1, Math.min(3, Number(policy.attempts || MANAGED_TOKEN_FETCH_RETRY_ATTEMPTS))),
        baseMs: Math.max(0, Math.min(500, Number(policy.baseMs ?? MANAGED_TOKEN_FETCH_RETRY_BASE_MS))),
        maxMs: Math.max(0, Math.min(1_000, Number(policy.maxMs ?? MANAGED_TOKEN_FETCH_RETRY_MAX_MS))),
        timeoutMs: Math.max(1, Math.min(5_000, Number(policy.timeoutMs ?? MANAGED_TOKEN_FETCH_TIMEOUT_MS))),
      };
      if (managedTokenFetchRetryPolicy.maxMs < managedTokenFetchRetryPolicy.baseMs) {
        managedTokenFetchRetryPolicy.maxMs = managedTokenFetchRetryPolicy.baseMs;
      }
    },
    resetManagedTokenFetchTestHooks() {
      managerBotFetch = (...args) => fetch(...args);
      managedTokenFetchRetryPolicy = {
        attempts: MANAGED_TOKEN_FETCH_RETRY_ATTEMPTS,
        baseMs: MANAGED_TOKEN_FETCH_RETRY_BASE_MS,
        maxMs: MANAGED_TOKEN_FETCH_RETRY_MAX_MS,
        timeoutMs: MANAGED_TOKEN_FETCH_TIMEOUT_MS,
      };
    },
  },
};
