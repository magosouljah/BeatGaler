'use strict';
// T11 fase B — dependencias REALES del runner (gramjs 2.26.x + Bot API HTTPS). Solo lo carga `catalog-transport-sandbox.cjs main()`
// tras validar descriptor + aprobación + --execute. Credenciales: archivos locales ignorados de cloud-server (pool de transporte,
// .env.telegram-test, master-session.txt); viven solo en memoria y se exponen a `secrets()` para que el informe se escanee.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CLOUD = path.resolve(__dirname, '..', 'cloud-server');
const gateway = require(path.join(CLOUD, 'catalog', 'transport-gateway.js'));
const TOKEN_RE = /\d{6,12}:[A-Za-z0-9_-]{30,}/;

function readKv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function botApiWith(token, method, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host: 'api.telegram.org', path: `/bot${token}/${method}`, method: 'POST', family: 4, timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(s); } catch { return reject(Object.assign(new Error(`BOTAPI_BAD_JSON ${method}`), { errorMessage: 'BOTAPI_BAD_JSON' })); }
        if (j.ok) return resolve(j.result);
        reject(Object.assign(new Error(`BOTAPI_${j.error_code} ${method}`), { errorMessage: `BOTAPI_${j.error_code}`, description: String(j.description || '').replace(TOKEN_RE, '<redacted>').slice(0, 120) }));
      });
    });
    req.on('error', () => reject(Object.assign(new Error(`BOTAPI_NETWORK ${method}`), { code: 'ECONNRESET' })));
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.end(data);
  });
}

async function createRealDeps(d, { outDir, runId }) {
  const telegram = require(path.join(CLOUD, 'node_modules', 'telegram'));
  const { StringSession } = require(path.join(CLOUD, 'node_modules', 'telegram', 'sessions'));
  const { CustomFile } = require(path.join(CLOUD, 'node_modules', 'telegram', 'client', 'uploads'));
  const bigInt = require(path.join(CLOUD, 'node_modules', 'big-integer'));
  const { Api, TelegramClient } = telegram;
  const sdk = { Api, bigInt, CustomFile };

  const tg = readKv(path.join(CLOUD, '.env.telegram-test'));
  const apiId = Number(tg.TELEGRAM_API_ID); const apiHash = tg.TELEGRAM_API_HASH;
  if (!Number.isSafeInteger(apiId) || !/^[a-f0-9]{32}$/i.test(apiHash || '')) throw new Error('credenciales API de prueba incompletas');
  if (String(tg.BEATGALER_TEST_MASTER_USERNAME || '').toLowerCase() !== d.master.username.toLowerCase()) throw new Error('MASTER local distinto del descriptor');
  const poolFile = path.join(CLOUD, 'transport-bots.local.json');
  const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
  const botCfg = pool.bots.find((b) => b.id === d.bot.id);
  if (pool.bots.length !== 1 || !botCfg || String(botCfg.telegram_user_id) !== String(d.bot.telegramUserId) || !TOKEN_RE.test(botCfg.token || '')) throw new Error('pool local no contiene exactamente el bot del descriptor');
  let token = botCfg.token;
  const masterSession = fs.readFileSync(path.join(CLOUD, 'master-session.txt'), 'utf8').trim();
  const secretList = [apiHash, masterSession, token];
  const clients = [];
  const filesDir = path.join(outDir, 'files'); fs.mkdirSync(filesDir, { recursive: true });

  const newClient = (s) => { const c = new TelegramClient(new StringSession(s), apiId, apiHash, { connectionRetries: 2, autoReconnect: false }); c.setLogLevel?.('none'); clients.push(c); return c; };
  const peerCache = new WeakMap();
  async function resolvePeer(client, chatId) {
    let m = peerCache.get(client); if (!m) { m = new Map(); peerCache.set(client, m); }
    if (m.has(chatId)) return m.get(chatId);
    let peer; try { peer = await client.getInputEntity(chatId); } catch (_) { peer = new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt(0) }); }
    const r = { peer, channel: true }; m.set(chatId, r); return r;
  }
  async function openBot() {
    const c = newClient('');
    await c.connect();
    await c.start({ botAuthToken: token });
    const me = await c.getMe();
    if (String(me.id) !== String(d.bot.telegramUserId)) throw new Error('sesión MTProto de bot con identidad inesperada');
    const saved = c.session.save(); secretList.push(saved);
    return { client: c, saveSession: () => { const s = c.session.save(); secretList.push(s); return s; } };
  }
  async function restoreBot(saved) { const c = newClient(saved); await c.connect(); return c; }
  const getMe = (c) => c.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));

  const master = newClient(masterSession);
  await master.connect();
  const describe = (m) => ({ messageId: Number(m.id), caption: typeof m.message === 'string' ? m.message : '', senderId: m.senderId != null ? String(m.senderId) : (m.fromId && m.fromId.userId != null ? String(m.fromId.userId) : null), present: m.className !== 'MessageEmpty' });
  const masterApi = {
    client: master,
    getMe: () => master.getMe(),
    async chatMembers(chatId) {
      const { peer } = await resolvePeer(master, chatId);
      const r = await master.invoke(new Api.channels.GetParticipants({ channel: peer, filter: new Api.ChannelParticipantsRecent(), offset: 0, limit: 50, hash: bigInt(0) }));
      return r.participants.map((p) => ({ id: String(p.userId), role: p.className.replace('ChannelParticipant', '') || 'Member' }));
    },
    async history(chatId, limit) { const { peer } = await resolvePeer(master, chatId); return (await master.getMessages(peer, { limit })).filter(Boolean).map(describe); },
    async getMessages(chatId, ids) { if (!ids.length) return []; const { peer } = await resolvePeer(master, chatId); const r = await master.invoke(new Api.channels.GetMessages({ channel: peer, id: ids.map((id) => new Api.InputMessageID({ id })) })); return r.messages.map(describe); },
    async deleteMessages(chatId, ids) { const { peer } = await resolvePeer(master, chatId); for (let i = 0; i < ids.length; i += 100) await master.invoke(new Api.channels.DeleteMessages({ channel: peer, id: ids.slice(i, i + 100) })); },
    async senderPeer(senderId) { return String(senderId) === String(d.bot.telegramUserId) ? master.getInputEntity(d.bot.username) : master.getInputEntity('me'); },
    async reconnect() { const c = newClient(masterSession); await c.connect(); return c; },
  };

  function dropResponses(client) {
    return {
      uploadFile: (...a) => client.uploadFile(...a),
      async invoke(req) {
        const r = await client.invoke(req);
        if (req && req.className === 'messages.SendMedia') throw Object.assign(new Error('Timeout: response dropped by the T11 runner after the provider answered'), { code: 'ETIMEDOUT' });
        return r;
      },
    };
  }
  async function probeRecent(client, chatId, { senderId, operationId, partKey, declaredSize }) {
    const top = (await masterApi.history(chatId, 1))[0];
    const hi = top ? top.messageId : 1; const ids = []; for (let id = Math.max(1, hi - 19); id <= hi; id++) ids.push(id);
    const { peer } = await resolvePeer(client, chatId);
    const r = await client.invoke(new Api.channels.GetMessages({ channel: peer, id: ids.map((id) => new Api.InputMessageID({ id })) }));
    return gateway.matchCandidates(r.messages, { operationId, partKey, senderId, declaredSize });
  }
  async function editCaption(client, chatId, messageId, caption) { const { peer } = await resolvePeer(client, chatId); return client.invoke(new Api.messages.EditMessage({ peer, id: messageId, message: `${caption} e` })); }
  async function pin(client, chatId, messageId) { const { peer } = await resolvePeer(client, chatId); return client.invoke(new Api.messages.UpdatePinnedMessage({ peer, id: messageId, silent: true })); }
  async function botRights(chatId) { const r = await botApiWith(token, 'getChatMember', { chat_id: chatId, user_id: Number(d.bot.telegramUserId) }); return { status: r.status, can_delete_messages: r.can_delete_messages ?? null, can_pin_messages: r.can_pin_messages ?? null }; }
  function makeFile(name, size, seed) {
    const p = path.join(filesDir, `${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}.bin`);
    const chunks = []; let n = 0; let i = 0;
    while (n < size) { const b = crypto.createHash('sha256').update(`${seed}:${i++}`).digest(); chunks.push(b); n += b.length; }
    fs.writeFileSync(p, Buffer.concat(chunks).subarray(0, size));
    return { name, size, path: p };
  }

  // Rotación por BotFather desde la cuenta propietaria (MASTER). Nunca imprime el token; lo verifica con getMe y lo persiste atómicamente.
  async function rotateToken() {
    const bf = await master.getInputEntity('BotFather');
    const lastId = async () => { const [m] = await master.getMessages(bf, { limit: 1 }); return m ? Number(m.id) : 0; };
    const waitReply = async (after, re, ms = 30000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { await sleep(2000); const ms2 = await master.getMessages(bf, { limit: 5 }); const hit = ms2.find((m) => Number(m.id) > after && !m.out && re.test(String(m.message || ''))); if (hit) return String(hit.message); }
      return null;
    };
    let mark = await lastId();
    await master.sendMessage(bf, { message: '/revoke' });
    const ask = await waitReply(mark, /./);
    if (!ask) throw Object.assign(new Error('BotFather no respondió a /revoke'), { code: 'STOP-ROTATION' });
    mark = await lastId();
    await master.sendMessage(bf, { message: `@${d.bot.username}` });
    const reply = await waitReply(mark, new RegExp(`${d.bot.telegramUserId}:[A-Za-z0-9_-]{30,}`));
    if (!reply) throw Object.assign(new Error('BotFather no entregó token nuevo para el bot del descriptor (estado de revocación desconocido: verificar a mano)'), { code: 'STOP-ROTATION' });
    const fresh = reply.match(new RegExp(`${d.bot.telegramUserId}:[A-Za-z0-9_-]{30,}`))[0];
    secretList.push(fresh);
    const me = await botApiWith(fresh, 'getMe');
    if (String(me.id) !== String(d.bot.telegramUserId)) throw Object.assign(new Error('token nuevo con identidad inesperada'), { code: 'STOP-ROTATION' });
    const oldToken = token; token = fresh;
    const next = { ...pool, bots: pool.bots.map((b) => (b.id === d.bot.id ? { ...b, token: fresh } : b)) };
    const tmp = `${poolFile}.tmp-${runId}`; fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, poolFile);
    return { method: 'botfather', verified: true, oldToken };
  }

  let version = null; try { version = require(path.join(CLOUD, 'node_modules', 'telegram', 'package.json')).version; } catch (_) { /* noop */ }
  return {
    runId, sdk, sdkVersion: version, sleep,
    botApi: (m, b) => botApiWith(token, m, b), botApiWith,
    master: masterApi, openBot, restoreBot, getMe, resolvePeer, dropResponses, probeRecent, editCaption, pin, botRights, makeFile, rotateToken,
    secrets: () => secretList.slice(),
    async close() { for (const c of clients) { try { await c.disconnect(); } catch (_) { /* noop */ } } },
  };
}

module.exports = { createRealDeps, botApiWith };
