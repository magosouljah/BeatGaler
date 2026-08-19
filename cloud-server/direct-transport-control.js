'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');

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
const CLIENT_LOCAL_BOT_API_BASE = 'http://127.0.0.1:8081';
const INDEX_OPERATION_TTL_MS = Math.max(60_000, Number(process.env.DIRECT_INDEX_OPERATION_TTL_MS || 5 * 60_000));
const DATA_OPERATION_TTL_MS = Math.max(15 * 60_000, Number(process.env.DIRECT_DATA_OPERATION_TTL_MS || 4 * 60 * 60_000));
const DIAG_DIR = backendPath(process.env.DIRECT_DIAGNOSTICS_DIR, 'diagnostics');
const DIAG_FILE = path.join(DIAG_DIR, 'telegram-direct-control.txt');

// Runtime-only material. Tokens never go to the JSON state file.
const runtimeSessions = new Map(); // session_id -> hydrated session + current token
const botRotationLocks = new Map();
const leaseCleanupLocks = new Map();
let resolverBootstrapPromise = null;
let maintenanceStarted = false;

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
    queue: Array.isArray(raw.queue) ? raw.queue.filter(id => ids.includes(id)) : [],
    bots: raw.bots && typeof raw.bots === 'object' ? raw.bots : {},
    leases: raw.leases && typeof raw.leases === 'object' ? raw.leases : {},
    operations: raw.operations && typeof raw.operations === 'object' ? raw.operations : {},
    metrics: raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {},
    rotation: raw.rotation && typeof raw.rotation === 'object' ? raw.rotation : {},
  };

  // One-release migration from the old one-vault-per-bot state. Keep these
  // leases until the normal 5-minute stale cleanup removes the bot from that
  // vault safely; never silently put it back into service.
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
    if (!state.queue.includes(id)) state.queue.push(id);
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

  state.queue = state.queue.filter((id, index, arr) => ids.includes(id) && arr.indexOf(id) === index);
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
    const startedAt = parseTime(op?.started_at);
    const isIndexOp = op?.kind === 'get_index' || op?.kind === 'replace_index';
    const operationTtlMs = isIndexOp ? INDEX_OPERATION_TTL_MS : DATA_OPERATION_TTL_MS;
    const stale = !startedAt || Date.now() - startedAt >= operationTtlMs;
    if (!op || !state.leases[String(op.session_id || '')] || stale) {
      if (op && stale) diag('STALE_OPERATION_REAPED', { operation_id: opId, session_id: op.session_id || null, kind: op.kind || null });
      delete state.operations[opId];
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
  return withPoolLock(() => {
    const state = normalizeState(pool);
    writeJsonAtomic(STATE_FILE, state);
    return state;
  });
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

// Fair load-level FIFO:
//   all bots get 1 vault before any bot gets 2;
//   all bots get 2 before any bot gets 3; ...
// Within the minimum-load tier, the queue decides who goes next. The selected
// bot always moves to the back, exactly matching the requested round-robin.
function leaseNextBot(pool, metadata) {
  return mutateState(pool, state => {
    const eligible = pool.filter(bot => !state.bots[bot.id].quarantined && !state.bots[bot.id].rotation_pending);
    if (!eligible.length) {
      const error = new Error('Every transport bot is temporarily unavailable while token rotation drains or recovery is required.');
      error.code = 'NO_ASSIGNABLE_TRANSPORT';
      throw error;
    }
    const loads = new Map(eligible.map(bot => [bot.id, leasesForBot(state, bot.id).length]));
    const minLoad = Math.min(...loads.values());
    const nextId = state.queue.find(id => loads.has(id) && loads.get(id) === minLoad);
    if (!nextId) throw new Error('Transport pool queue is corrupt.');
    const bot = pool.find(item => item.id === nextId);
    const botState = state.bots[nextId];
    botState.generation += 1;
    botState.last_assigned_at = nowIso();
    const sessionId = `dts_${crypto.randomBytes(16).toString('hex')}`;
    const lease = {
      session_id: sessionId,
      bot_id: nextId,
      installation_id: String(metadata.installation_id),
      chat_id: String(metadata.chat_id),
      generation: botState.generation,
      credential_version: botState.credential_version,
      status: 'ASSIGNING',
      started_at: nowIso(),
      last_heartbeat_at: nowIso(),
      owner_instance: PROCESS_INSTANCE_ID,
    };
    state.leases[sessionId] = lease;
    state.queue = state.queue.filter(id => id !== nextId);
    state.queue.push(nextId);
    return { bot, lease, loadBefore: minLoad, loadAfter: minLoad + 1 };
  });
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
      if (op.session_id === sessionId) delete state.operations[opId];
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

async function managerBotApiCall(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || `${method} failed (${response.status}).`);
  return body.result;
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
  const token = await managerBotApiCall(managerToken, 'getManagedBotToken', { user_id: Number(botConfig.telegram_user_id) });
  if (!token) throw new Error(`${botConfig.id}: Telegram returned no managed token.`);
  return String(token);
}

async function rotateManagedToken(botConfig) {
  if (!botConfig.managed) throw new Error(`${botConfig.id}: automatic token rotation requires managed=true.`);
  const managerToken = String(process.env[botConfig.manager_token_env] || '').trim();
  if (!managerToken) throw new Error(`${botConfig.id}: missing ${botConfig.manager_token_env}.`);
  const replacement = await managerBotApiCall(managerToken, 'replaceManagedBotToken', { user_id: Number(botConfig.telegram_user_id) });
  if (!replacement) throw new Error(`${botConfig.id}: Telegram returned no replacement token.`);
  return String(replacement);
}


async function inviteAndPromote(master, vault, botEntity) {
  try {
    await master.invoke(new Api.channels.InviteToChannel({ channel: vault, users: [botEntity] }));
  } catch (error) {
    const msg = String(error?.errorMessage || error?.message || error);
    if (!/USER_ALREADY_PARTICIPANT/i.test(msg)) throw error;
  }
  // Data-plane rights only: write media as a member, plus delete/pin so the
  // transport bot can maintain the single index and delete replaced media.
  await master.invoke(new Api.channels.EditAdmin({
    channel: vault,
    userId: botEntity,
    adminRights: new Api.ChatAdminRights({
      deleteMessages: true,
      pinMessages: true,
      other: true,
    }),
    rank: 'BeatGaler',
  }));
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
        masterInfo = await masterForVault(existingId);
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

async function runtimeForLease(lease, { freshMarker = false } = {}) {
  const pool = loadPool();
  const bot = pool.find(item => item.id === lease.bot_id);
  if (!bot) throw new Error(`Unknown transport bot ${lease.bot_id}.`);
  const state = stateSnapshot(pool);
  const botState = state.bots[bot.id];
  let runtime = runtimeSessions.get(lease.session_id);
  if (!runtime || runtime.credentialVersion !== botState.credential_version) {
    const token = await resolveManagedToken(bot);
    // Bot API Local is the client-side data plane. Do NOT authenticate this bot
    // through GramJS/MTProto here: that was the source of auth.ImportBotAuthorization
    // FLOOD_WAIT storms. MASTER already knows the configured bot id/username.
    let username = bot.telegram_username || runtime?.bot?.telegram_username || null;
    let userId = bot.telegram_user_id || runtime?.bot?.telegram_user_id || null;
    if (!username || !userId) {
      const identity = await resolveBotIdentityViaHttp(token);
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
  if (!runtime.resolverChatId) runtime.resolverChatId = await ensureBotApiResolverChat();
  return runtime;
}

function sessionPublic(runtime) {
  return {
    ok: true,
    mode: 'telegram-direct-botapi-local',
    session_id: runtime.id,
    transport_id: runtime.bot.id,
    transport_user_id: runtime.bot.telegram_user_id || null,
    transport_username: runtime.bot.telegram_username || null,
    chat_id: String(runtime.chatId),
    bot_token: runtime.token,
    // The Bot API server is part of the Desktop data plane. Every client talks
    // to its OWN loopback server; BeatGaler Cloud never proxies media bytes.
    bot_api_base: CLIENT_LOCAL_BOT_API_BASE,
    telegram_api_id: apiCredentials().apiId,
    telegram_api_hash: apiCredentials().apiHash,
    resolver_chat_id: runtime.resolverChatId || String(process.env.DIRECT_BOTAPI_RESOLVER_CHAT_ID || '').trim() || null,
    generation: runtime.generation,
    credential_version: runtime.credentialVersion,
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
    token_rotation_enabled: TOKEN_ROTATION_ENABLED,
    started_at: runtime.startedAt,
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

async function waitForAssignableTransport(pool, timeoutMs = 120_000) {
  const started = Date.now();
  while (true) {
    let snapshot = stateSnapshot(pool);
    for (const bot of pool) {
      const bs = snapshot.bots[bot.id];
      if (bs?.rotation_pending && !bs.quarantined && activeOpsForBot(snapshot, bot.id).length === 0) {
        await maybeRotatePendingBot(bot.id);
      }
    }
    snapshot = stateSnapshot(pool);
    if (pool.some(bot => !snapshot.bots[bot.id].quarantined && !snapshot.bots[bot.id].rotation_pending)) {
      return;
    }
    const recoverable = pool.some(bot => !snapshot.bots[bot.id].quarantined);
    if (!recoverable) throw new Error('Every transport bot is quarantined and requires recovery.');
    if (Date.now() - started >= timeoutMs) {
      throw new Error('Transport pool is waiting for in-flight transfers to finish before token rotation.');
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function startSession({ installationId, chatId }) {
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
      const runtime = await runtimeForLease(existing);
      mutateState(pool, state => {
        if (state.leases[existing.session_id]) {
          // The desktop helper will call /activate only after its raw Telegram
          // membership listener is running. ACTIVE is preserved for an already
          // leased vault; ASSIGNING is finalized by activateSession.
          state.leases[existing.session_id].last_heartbeat_at = nowIso();
        }
      });
      return sessionPublic(runtime);
    }
    await cleanupLeaseSingleflight(existing, { reason: 'replaced_session' });
  }

  // A bot waiting to rotate is temporarily skipped. If every bot is draining,
  // a new login waits rather than receiving a credential that is about to be
  // revoked. Once rotation completes, normal load-level FIFO resumes.
  await waitForAssignableTransport(pool);
  const { bot, lease, loadBefore, loadAfter } = leaseNextBot(pool, {
    installation_id: installation,
    chat_id: vaultId,
  });
  try {
    const runtime = await runtimeForLease(lease);
    console.log(`[direct] SESSION_RESERVED installation=${installation.slice(0, 8)}… transport=${bot.id} load=${loadBefore}->${loadAfter}`);
    diag('SESSION_RESERVED', { installation: installation.slice(0, 8), session_id: lease.session_id, transport_id: bot.id, vault: vaultId, load_before: loadBefore, load_after: loadAfter, mode: 'botapi-local' });
    return sessionPublic(runtime);
  } catch (error) {
    deleteLease(lease.session_id);
    runtimeSessions.delete(lease.session_id);
    throw error;
  }
}

async function activateSession({ installationId, sessionId, generation }) {
  const checked = getLeaseChecked({ installationId, sessionId, generation });
  if (!checked) throw new Error('Direct transport session is not active.');
  const runtime = await runtimeForLease(checked.lease);
  const masterInfo = await masterForVault(checked.lease.chat_id);
  try {
    const botEntity = runtime.bot.telegram_username
      ? await masterInfo.client.getEntity(`@${runtime.bot.telegram_username}`)
      : await masterInfo.client.getEntity(runtime.bot.telegram_user_id);

    // IMPORTANT: no Telegram handshake message is sent. The desktop BOT client
    // starts a raw-update listener first; only then MASTER adds/promotes the bot.
    // Telegram's participant/service update contains the Channel entity as seen
    // by THIS bot account, including its own access_hash.
    await inviteAndPromote(masterInfo.client, masterInfo.vault, botEntity);

    // Do not tell Desktop that activation is complete until MASTER can read the
    // bot back as a real participant of this exact vault. Telegram may still
    // need a short propagation window before Bot API getChat sees membership,
    // so Desktop has a second same-bot retry barrier after this confirmation.
    letConfirmed: {
      const started = Date.now();
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          const participant = await masterInfo.client.invoke(new Api.channels.GetParticipant({
            channel: masterInfo.vault,
            participant: botEntity,
          }));
          if (participant?.participant) {
            diag('SESSION_MEMBERSHIP_CONFIRMED', { session_id: checked.lease.session_id, transport_id: runtime.bot.id, vault: checked.lease.chat_id, attempt, ms: Date.now() - started });
            break letConfirmed;
          }
        } catch (error) {
          const message = String(error?.errorMessage || error?.message || error);
          if (!/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|CHANNEL_PRIVATE/i.test(message) || Date.now() - started >= 15_000) throw error;
          diag('SESSION_MEMBERSHIP_WAIT', { session_id: checked.lease.session_id, transport_id: runtime.bot.id, vault: checked.lease.chat_id, attempt, ms: Date.now() - started, error: message });
        }
        if (Date.now() - started >= 15_000) throw new Error('MASTER could not confirm transport bot membership in the vault within 15 seconds.');
        await new Promise(resolve => setTimeout(resolve, Math.min(1500, 250 * attempt)));
      }
    }

    await cleanupLegacyVisibleHandshakes(masterInfo.client, masterInfo.vault);
    runtime.masterId = masterInfo.config?.id || 'Master01';
    const finalized = finalizeLease(checked.lease.session_id);
    console.log(`[direct] SESSION_READY installation=${String(installationId).slice(0, 8)}… transport=${runtime.bot.id} master=${runtime.masterId}`);
    diag('SESSION_READY', { installation: String(installationId).slice(0, 8), session_id: checked.lease.session_id, transport_id: runtime.bot.id, vault: checked.lease.chat_id, master: runtime.masterId });
    return { ok: true, activated: true, status: finalized?.status || 'ACTIVE' };
  } finally {
    try { await masterInfo.client.disconnect(); } catch (_) {}
  }
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

async function beginOperation({ installationId, sessionId, generation, credentialVersion, kind }) {
  const checked = getLeaseChecked({ installationId, sessionId, generation });
  if (!checked) return { ok: false, expired: true };
  const { pool, lease } = checked;
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
      return { ok: false, wait: true, retry_after_ms: 250, reason: 'rotation_pending' };
    }
  }

  if (Number(credentialVersion || 0) !== Number(botState.credential_version)) {
    const runtime = await runtimeForLease(snapshot.leases[lease.session_id], { freshMarker: true });
    return { ok: false, refresh_required: true, credential_refresh: sessionPublic(runtime) };
  }

  const normalizedKind = String(kind || 'data');
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
      started_at: nowIso(),
    };
    return true;
  });
  if (!admitted) {
    return { ok: false, wait: true, retry_after_ms: 200, reason: 'index_busy' };
  }
  return { ok: true, operation_id: opId, credential_version: botState.credential_version };
}

async function endOperation({ installationId, sessionId, generation, operationId }) {
  const pool = loadPool();
  let botId = null;
  mutateState(pool, state => {
    const lease = state.leases[String(sessionId || '')];
    if (lease && lease.installation_id === String(installationId || '') && Number(lease.generation) === Number(generation)) {
      lease.last_heartbeat_at = nowIso();
      botId = lease.bot_id;
    }
    const op = state.operations[String(operationId || '')];
    if (op && op.session_id === String(sessionId || '')) {
      botId = botId || op.bot_id;
      delete state.operations[String(operationId)];
    }
  });
  if (botId) await maybeRotatePendingBot(botId);
  return { ok: true };
}

async function cleanupLease(leaseInput, { reason = 'session_end' } = {}) {
  const pool = loadPool();
  const snapshot = stateSnapshot(pool);
  const lease = snapshot.leases[String(leaseInput?.session_id || leaseInput || '')];
  if (!lease) return { ok: true, released: false };
  mutateState(pool, state => {
    const current = state.leases[lease.session_id];
    if (current) current.status = 'STOPPING';
  });

  const bot = pool.find(item => item.id === lease.bot_id);
  let masterInfo = null;
  let removed = false;
  try {
    const runtime = await runtimeForLease(lease);
    masterInfo = await masterForVault(lease.chat_id);
    const botEntity = runtime.bot.telegram_username
      ? await masterInfo.client.getEntity(`@${runtime.bot.telegram_username}`)
      : await masterInfo.client.getEntity(runtime.bot.telegram_user_id);
    await kickAndUnban(masterInfo.client, masterInfo.vault, botEntity);
    removed = true;
  } catch (error) {
    mutateState(pool, state => {
      state.bots[lease.bot_id].quarantined = true;
      state.bots[lease.bot_id].quarantine_reason = `vault removal failed: ${error?.message || error}`;
      if (state.leases[lease.session_id]) state.leases[lease.session_id].status = 'QUARANTINED';
    });
    throw new Error(`Transport cleanup could not be confirmed; bot retained for recovery: ${error?.message || error}`);
  } finally {
    try { if (masterInfo?.client) await masterInfo.client.disconnect(); } catch (_) {}
  }

  if (!removed) throw new Error('Transport cleanup could not be confirmed.');
  deleteLease(lease.session_id);
  runtimeSessions.delete(lease.session_id);
  mutateState(pool, state => {
    state.bots[lease.bot_id].rotation_pending = TOKEN_ROTATION_ENABLED;
  });
  const rotation = TOKEN_ROTATION_ENABLED
    ? await maybeRotatePendingBot(lease.bot_id)
    : { rotated: false, pending: false, disabled: true };
  if (!TOKEN_ROTATION_ENABLED) diag('SESSION_RELEASE_NO_TOKEN_REVOKE', { session_id: lease.session_id, transport_id: lease.bot_id, reason });
  const activeCount = leasesForBot(stateSnapshot(pool), lease.bot_id).length;
  console.log(`[direct] SESSION_RELEASED installation=${lease.installation_id.slice(0, 8)}… transport=${lease.bot_id} reason=${reason} remaining_vaults=${activeCount} rotation_pending=${Boolean(rotation?.pending)}`);
  return { ok: true, released: true, rotation_pending: Boolean(rotation?.pending), transport_id: bot?.id || lease.bot_id };
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
      active_vaults: leasesForBot(state, bot.id).length,
      active_operations: activeOpsForBot(state, bot.id).length,
      credential_version: state.bots[bot.id].credential_version,
      rotation_pending: state.bots[bot.id].rotation_pending,
      quarantined: state.bots[bot.id].quarantined,
    })),
    queue: [...state.queue],
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
  LOCAL_BOT_API_BASE: CLIENT_LOCAL_BOT_API_BASE,
  recordIndexPointer,
  getIndexPointer,
  enabled,
  startSession,
  activateSession,
  heartbeat,
  beginOperation,
  endOperation,
  stopSession,
  verifyMessage,
  commitIndexCopyOnWrite,
  downloadMessageBuffer,
  deleteMessages,
  getPinnedMessage,
  createForumTopic,
  editForumTopic,
  deleteForumTopic,
  poolStatus,
  cleanupExpiredSessions,
  __test: {
    normalizeState,
    leaseNextBot,
    stateSnapshot,
    mutateState,
    leasesForBot,
    activeOpsForBot,
  },
};
