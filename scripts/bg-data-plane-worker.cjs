#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
function loadTelegram(name) {
  try { return require(name); } catch (_) {}
  return require(path.join(ROOT, 'cloud-server', 'node_modules', name));
}
const { TelegramClient } = loadTelegram('telegram');
const { StringSession } = loadTelegram('telegram/sessions');
const { NewMessage } = loadTelegram('telegram/events');
const { CustomFile } = loadTelegram('telegram/client/uploads');
let bigInt;
try { bigInt = require('big-integer'); } catch (_) { bigInt = require(path.join(ROOT, 'cloud-server', 'node_modules', 'big-integer')); }

const HOST = '127.0.0.1';
const PORT = Number(process.env.BEATGALER_DATA_PLANE_PORT || 43991);
const IDLE_MS = Number(process.env.BEATGALER_DATA_PLANE_IDLE_MS || 30 * 60 * 1000);
const PARENT_PID = Number(process.env.BEATGALER_PARENT_PID || 0);

let active = null;
let sessionPromise = null;
let lastActivity = Date.now();
let closing = false;

function log(msg) { console.log(`[data-plane] ${msg}`); }
function touch() { lastActivity = Date.now(); }
function json(res, status, body) {
  const out = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': out.length });
  res.end(out);
}
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function postJson(base, route, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(String(base).replace(/\/$/, '') + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const text = await response.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) throw new Error(parsed.error || `Cloud control request failed (${response.status})`);
    return parsed;
  } finally { clearTimeout(timer); }
}
function waitForHandshake(client, marker, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const builder = new NewMessage({});
    const handler = async event => {
      const text = event?.message?.message || '';
      if (!text.includes(marker) || settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.removeEventHandler(handler, builder); } catch (_) {}
      resolve(event.message);
    };
    client.addEventHandler(handler, builder);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.removeEventHandler(handler, builder); } catch (_) {}
      reject(new Error('Cloud session handshake timed out.'));
    }, timeoutMs);
  });
}
async function closeSession(reason = 'close') {
  const current = active;
  active = null;
  if (!current) return;
  try {
    await postJson(current.backendBase, '/data-plane/session/close', {
      leaseId: current.leaseId, beatgalerUserId: current.userId,
    }, 10000);
  } catch (_) {}
  try { await current.client.disconnect(); } catch (_) {}
  log(`session closed (${reason})`);
}
async function createSession(backendBase, userId) {
  touch();
  if (active && active.backendBase === backendBase && active.userId === userId && active.vault) return active;
  await closeSession('switch');
  const opened = await postJson(backendBase, '/data-plane/session/open', { beatgalerUserId: userId }, 20000);
  const client = new TelegramClient(new StringSession(''), Number(opened.api_id), String(opened.api_hash), {
    connectionRetries: 5, autoReconnect: true, useWSS: false,
  });
  try {
    await client.start({ botAuthToken: String(opened.transport_token) });
    // Drop the token reference as soon as authorization completes.
    opened.transport_token = undefined;
    const marker = `BG_${crypto.randomBytes(12).toString('hex')}`;
    const wait = waitForHandshake(client, marker);
    await postJson(backendBase, '/data-plane/session/handshake', {
      leaseId: opened.lease_id, beatgalerUserId: userId, marker,
    });
    const msg = await wait;
    const vault = await client.getEntity(msg.peerId || Number(opened.channel_id));
    active = {
      backendBase, userId, leaseId: String(opened.lease_id), client, vault,
      botId: String(opened.transport_bot_id || ''), botUserId: String(opened.transport_bot_user_id || ''),
      botUsername: String(opened.transport_bot_username || ''),
    };
    log(`session ready bot=${active.botId}`);
    return active;
  } catch (e) {
    try {
      await postJson(backendBase, '/data-plane/session/close', {
        leaseId: opened.lease_id, beatgalerUserId: userId,
      }, 10000);
    } catch (_) {}
    try { await client.disconnect(); } catch (_) {}
    throw e;
  }
}
async function ensureSession(backendBase, userId) {
  touch();
  if (active && active.backendBase === backendBase && active.userId === userId && active.vault) return active;
  if (sessionPromise) return sessionPromise;
  sessionPromise = createSession(backendBase, userId).finally(() => { sessionPromise = null; });
  return sessionPromise;
}

async function upload(body) {
  const s = await ensureSession(body.backendBase, body.beatgalerUserId);
  const filePath = path.resolve(String(body.filePath || ''));
  const st = fs.statSync(filePath);
  if (!st.isFile() || !st.size) throw new Error('Cloud upload source is unavailable.');
  const prep = await postJson(s.backendBase, '/data-plane/upload/prepare', {
    leaseId: s.leaseId, beatgalerUserId: s.userId,
    beatId: String(body.beatId), beatName: String(body.beatName || body.beatId),
  });
  const file = new CustomFile(path.basename(filePath), st.size, filePath);
  const message = await s.client.sendFile(s.vault, {
    file, forceDocument: true, workers: Number(process.env.BEATGALER_DATA_PLANE_WORKERS || 4),
    replyTo: Number(prep.topic_id) || undefined,
    caption: '',
  });
  const commit = await postJson(s.backendBase, '/data-plane/upload/commit', {
    leaseId: s.leaseId, beatgalerUserId: s.userId,
    beatId: String(body.beatId), beatName: String(body.beatName || body.beatId),
    filename: path.basename(filePath), messageId: Number(message.id),
    existingMessageId: Number(body.existingMessageId || 0) || undefined,
    kind: String(body.kind || 'master'),
  }, 20000);
  touch();
  return { ...commit, bytes: st.size };
}
async function streamMedia(req, res, urlObj) {
  const backendBase = String(urlObj.searchParams.get('backendBase') || '');
  const userId = String(urlObj.searchParams.get('beatgalerUserId') || '');
  const messageId = Number(urlObj.searchParams.get('messageId'));
  if (!backendBase || !userId || !Number.isInteger(messageId) || messageId <= 0) {
    res.writeHead(400); return res.end();
  }
  const s = await ensureSession(backendBase, userId);
  const messages = await s.client.getMessages(s.vault, { ids: [messageId] });
  const message = messages?.[0];
  if (!message?.media) { res.writeHead(404); return res.end(); }
  const rawSize = message?.media?.document?.size ?? message?.media?.photo?.size ?? 0;
  const total = Number(rawSize?.toString ? rawSize.toString() : rawSize);
  if (!Number.isFinite(total) || total <= 0) { res.writeHead(404); return res.end(); }

  const range = String(req.headers.range || '');
  let start = 0, end = total - 1, partial = false;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (m) {
    partial = true;
    if (!m[1] && m[2]) {
      const suffix = Math.max(0, Number(m[2]));
      start = Math.max(0, total - suffix);
    } else {
      start = Math.max(0, Number(m[1] || 0));
      if (m[2]) end = Math.min(total - 1, Number(m[2]));
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end();
  }
  const wanted = end - start + 1;
  const headers = {
    'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes',
    'Content-Length': String(wanted), 'Cache-Control': 'private, max-age=60',
    'Access-Control-Allow-Origin': '*',
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();

  let remaining = wanted;
  const requestSize = 128 * 1024;
  try {
    for await (const chunk of s.client.iterDownload({
      file: message.media,
      offset: bigInt(start),
      requestSize,
      chunkSize: requestSize,
      fileSize: bigInt(total),
      msgData: [s.vault, messageId],
    })) {
      if (remaining <= 0 || res.destroyed) break;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const take = Math.min(remaining, buf.length);
      if (take > 0) res.write(buf.subarray(0, take));
      remaining -= take;
      if (remaining <= 0) break;
    }
  } catch (e) {
    if (!res.headersSent) res.writeHead(502);
    try { res.destroy(e); } catch (_) {}
    return;
  }
  touch();
  res.end();
}

async function download(body) {
  const s = await ensureSession(body.backendBase, body.beatgalerUserId);
  const messageId = Number(body.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error('Cloud message reference is invalid.');
  const messages = await s.client.getMessages(s.vault, { ids: [messageId] });
  const message = messages?.[0];
  if (!message?.media) throw new Error('Cloud file is unavailable.');
  const destination = path.resolve(String(body.destination || ''));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = destination + `.bgpart-${process.pid}-${Date.now()}`;
  try {
    await s.client.downloadMedia(message.media, {
      outputFile: tmp, workers: Number(process.env.BEATGALER_DATA_PLANE_WORKERS || 4),
    });
    const st = fs.statSync(tmp);
    if (!st.size) throw new Error('Cloud download returned an empty file.');
    try { fs.rmSync(destination, { force: true }); } catch (_) {}
    fs.renameSync(tmp, destination);
    touch();
    return { ok: true, bytes: st.size, destination };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && parsedUrl.pathname === '/health') return json(res, 200, { ok: true, session: !!active });
    if ((req.method === 'GET' || req.method === 'HEAD') && parsedUrl.pathname === '/stream') return await streamMedia(req, res, parsedUrl);
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
    const body = await readJson(req);
    if (req.url === '/session/ensure') {
      const s = await ensureSession(String(body.backendBase), String(body.beatgalerUserId));
      return json(res, 200, { ok: true, bot_id: s.botId });
    }
    if (req.url === '/upload') return json(res, 200, await upload(body));
    if (req.url === '/download') return json(res, 200, await download(body));
    if (req.url === '/session/close') { await closeSession('requested'); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e || 'Cloud transfer failed') });
  }
});
server.listen(PORT, HOST, () => log(`worker ready on ${HOST}:${PORT}`));

setInterval(() => {
  if (active && Date.now() - lastActivity > IDLE_MS) closeSession('idle').catch(() => {});
}, Math.min(60_000, Math.max(10_000, Math.floor(IDLE_MS / 4)))).unref();

if (PARENT_PID > 0) {
  setInterval(() => {
    try { process.kill(PARENT_PID, 0); }
    catch (_) { shutdown(); }
  }, 3000).unref();
}

async function shutdown() {
  if (closing) return;
  closing = true;
  try { await closeSession('shutdown'); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', err => { console.error('[data-plane] fatal:', err?.message || err); shutdown(); });
process.on('unhandledRejection', err => { console.error('[data-plane] rejected:', err?.message || err); });
