const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, 'transport-bots.json');
const STATE_FILE = path.join(__dirname, 'transport-pool-state.json');
const DEFAULT_ROTATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 45 * 60 * 1000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function loadConfig() {
  const parsed = readJson(CONFIG_FILE, { bots: [] });
  return Array.isArray(parsed?.bots) ? parsed.bots.filter(Boolean) : [];
}
function initialState(bots) {
  return { queue: bots.map(b => b.id), active: {}, rotation: {}, updatedAt: Date.now() };
}
function loadState() {
  const bots = loadConfig();
  let state = readJson(STATE_FILE, null) || initialState(bots);
  state.queue = Array.isArray(state.queue) ? state.queue : [];
  state.active = state.active && typeof state.active === 'object' ? state.active : {};
  state.rotation = state.rotation && typeof state.rotation === 'object' ? state.rotation : {};
  const ids = new Set(bots.map(b => b.id));
  state.queue = state.queue.filter(id => ids.has(id) && !Object.values(state.active).some(x => x?.botId === id));
  for (const b of bots) {
    if (!state.queue.includes(b.id) && !Object.values(state.active).some(x => x?.botId === b.id)) state.queue.push(b.id);
  }
  return { bots, state };
}
function saveState(state) { state.updatedAt = Date.now(); writeJsonAtomic(STATE_FILE, state); }

function telegramManagerCall(token, method, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(new Error(`Manager API ${method} returned invalid JSON.`)); }
        if (!parsed.ok) return reject(new Error(parsed.description || `Manager API ${method} failed.`));
        resolve(parsed.result);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getTokenForBot(bot, state) {
  if (!bot?.managed) throw new Error(`${bot?.id || 'Transport'} is not configured as a Managed Bot.`);
  const managerEnv = bot.manager_token_env || 'MANAGER_BOT_TOKEN_1';
  const managerToken = String(process.env[managerEnv] || '').trim();
  if (!managerToken) throw new Error(`Missing ${managerEnv} in backend environment.`);
  const userId = Number(bot.telegram_user_id);
  if (!Number.isFinite(userId) || userId <= 0) throw new Error(`${bot.id} has no valid telegram_user_id.`);

  const rotationMs = Math.max(60_000, Number(process.env.BEATGALER_TRANSPORT_TOKEN_ROTATION_MS || DEFAULT_ROTATION_MS));
  const r = state.rotation[bot.id] || {};
  const last = Number(r.lastRotatedAt || 0);
  if (!last || Date.now() - last >= rotationMs) {
    try {
      await telegramManagerCall(managerToken, 'replaceManagedBotToken', { user_id: userId });
      state.rotation[bot.id] = { lastRotatedAt: Date.now(), lastStatus: 'rotated' };
    } catch (err) {
      // Rotation failure must not expose the token and should not silently poison the pool.
      state.rotation[bot.id] = { lastRotatedAt: last || 0, lastStatus: 'rotation_error', error: String(err?.message || err).slice(0, 300) };
      throw err;
    }
  }
  const token = await telegramManagerCall(managerToken, 'getManagedBotToken', { user_id: userId });
  if (!token || typeof token !== 'string') throw new Error(`Manager returned no token for ${bot.id}.`);
  return token;
}

async function leaseBot({ beatgalerUserId, storageChatId, removeFromStorage }) {
  const { bots, state } = loadState();
  const ttl = Math.max(60_000, Number(process.env.BEATGALER_TRANSPORT_LEASE_TTL_MS || DEFAULT_LEASE_TTL_MS));
  // Reclaim only truly stale leases. Best-effort removal occurs before requeue.
  for (const [leaseId, lease] of Object.entries(state.active)) {
    if (Date.now() - Number(lease.lastSeenAt || lease.createdAt || 0) <= ttl) continue;
    const bot = bots.find(b => b.id === lease.botId);
    if (bot && removeFromStorage) {
      try { await removeFromStorage({ botApiChatId: lease.storageChatId, botUsername: bot.username }); } catch (_) {}
    }
    delete state.active[leaseId];
    if (bot && !state.queue.includes(bot.id)) state.queue.push(bot.id);
  }

  if (!state.queue.length) {
    saveState(state);
    const e = new Error('No transport identity is currently available.');
    e.code = 'POOL_EXHAUSTED';
    throw e;
  }
  const botId = state.queue.shift();
  const bot = bots.find(b => b.id === botId);
  if (!bot) throw new Error('Transport pool configuration is inconsistent.');
  const token = await getTokenForBot(bot, state);
  const leaseId = crypto.randomBytes(18).toString('base64url');
  state.active[leaseId] = {
    leaseId, botId, beatgalerUserId: String(beatgalerUserId), storageChatId: String(storageChatId),
    createdAt: Date.now(), lastSeenAt: Date.now(),
  };
  saveState(state);
  return { leaseId, bot, token };
}

function getLease(leaseId) {
  const { bots, state } = loadState();
  const lease = state.active[String(leaseId || '')];
  if (!lease) return null;
  const bot = bots.find(b => b.id === lease.botId);
  if (!bot) return null;
  return { lease, bot, state };
}
function touchLease(leaseId) {
  const found = getLease(leaseId);
  if (!found) return false;
  found.lease.lastSeenAt = Date.now();
  found.state.active[leaseId] = found.lease;
  saveState(found.state);
  return true;
}
async function releaseLease(leaseId, { removeFromStorage } = {}) {
  const found = getLease(leaseId);
  if (!found) return false;
  if (removeFromStorage) {
    try { await removeFromStorage({ botApiChatId: found.lease.storageChatId, botUsername: found.bot.username }); } catch (err) {
      console.warn('[data-plane] transport cleanup failed:', err?.message || err);
    }
  }
  delete found.state.active[leaseId];
  if (!found.state.queue.includes(found.bot.id)) found.state.queue.push(found.bot.id);
  saveState(found.state);
  return true;
}

module.exports = { loadConfig, loadState, leaseBot, getLease, touchLease, releaseLease };
