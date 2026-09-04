#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const dns = require('dns').promises;
const net = require('net');

const OUT = '__BEATGALER_DIRECT_JSON__';
const BOOT = '__BEATGALER_DIRECT_BOOTSTRAP__';
const INDEX_CAPTION = 'BEATGALER_LIBRARY_INDEX_V1';
const sessionFileIds = new Map();

function emit(value) { process.stdout.write(`${OUT}${JSON.stringify(value)}\n`); }
function fail(message, extra = {}) { emit({ ok: false, error: String(message || 'Direct transport failed.'), ...extra }); }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function safeUrl(value) {
  try {
    const u = new URL(String(value || ''));
    // Never expose bot tokens embedded in Bot API paths.
    u.pathname = u.pathname.replace(/\/bot[^/]+/g, '/bot<redacted>');
    u.username = u.username ? '<redacted>' : '';
    u.password = u.password ? '<redacted>' : '';
    return u.toString();
  } catch {
    return '<invalid-url>';
  }
}

function safeProxy(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value));
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '<configured-invalid-url>';
  }
}

function errorDetails(error) {
  const seen = new Set();
  const chain = [];
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push({
      name: String(current?.name || ''),
      message: String(current?.message || current || ''),
      code: current?.code ?? null,
      errno: current?.errno ?? null,
      syscall: current?.syscall ?? null,
      address: current?.address ?? null,
      port: current?.port ?? null,
      hostname: current?.hostname ?? null,
    });
    current = current?.cause;
  }
  return {
    chain,
    stack: String(error?.stack || '').split('\n').slice(0, 12).join(' | '),
  };
}

function runtimeContext(session) {
  let parsed = null;
  try { parsed = new URL(session.botApiBase); } catch (_) {}
  const interfaces = {};
  try {
    for (const [name, rows] of Object.entries(os.networkInterfaces() || {})) {
      interfaces[name] = (rows || []).map(row => ({
        address: row.address,
        family: row.family,
        internal: Boolean(row.internal),
      }));
    }
  } catch (_) {}
  return {
    node_version: process.version,
    node_exec_path: process.execPath,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    cwd: process.cwd(),
    helper_path: __filename,
    bot_api_base: safeUrl(session.botApiBase),
    bot_api_protocol: parsed?.protocol || null,
    bot_api_hostname: parsed?.hostname || null,
    bot_api_port: parsed?.port || (parsed?.protocol === 'https:' ? '443' : parsed?.protocol === 'http:' ? '80' : null),
    proxy: {
      http_proxy: safeProxy(process.env.HTTP_PROXY || process.env.http_proxy),
      https_proxy: safeProxy(process.env.HTTPS_PROXY || process.env.https_proxy),
      all_proxy: safeProxy(process.env.ALL_PROXY || process.env.all_proxy),
      no_proxy_configured: Boolean(process.env.NO_PROXY || process.env.no_proxy),
    },
    network_interfaces: interfaces,
  };
}

async function tcpProbe(hostname, port, timeoutMs = 2500) {
  const result = { hostname, port: Number(port), dns: null, tcp: null };
  if (!hostname || !port) return result;
  try {
    result.dns = await dns.lookup(hostname, { all: true });
  } catch (error) {
    result.dns = { error: errorDetails(error) };
  }
  result.tcp = await new Promise(resolve => {
    const started = Date.now();
    const socket = net.createConnection({ host: hostname, port: Number(port) });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...value, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, timeout: true }));
    socket.once('connect', () => finish({ ok: true, local_address: socket.localAddress, remote_address: socket.remoteAddress }));
    socket.once('error', error => finish({ ok: false, error: errorDetails(error) }));
  });
  return result;
}

async function networkFailureDiagnostics(session, label, targetUrl, error) {
  let parsed = null;
  try { parsed = new URL(targetUrl); } catch (_) {}
  const port = parsed?.port || (parsed?.protocol === 'https:' ? 443 : parsed?.protocol === 'http:' ? 80 : 0);
  const probe = await tcpProbe(parsed?.hostname || '', port);
  const details = errorDetails(error);
  diag('NETWORK_FAILURE_CONTEXT', {
    label,
    target: safeUrl(targetUrl),
    runtime: runtimeContext(session),
    probe,
    error: details,
  });
  return { probe, details };
}

function diagPath() {
  const root = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'BeatGaler', 'diagnostics')
    : path.join(os.tmpdir(), 'BeatGaler', 'diagnostics');
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, 'telegram-direct-client.txt');
}
function diag(event, fields = {}) {
  try {
    const safe = {};
    for (const [k, v] of Object.entries(fields || {})) {
      safe[k] = /token|api_hash|secret|password/i.test(k) ? '<redacted>' : v;
    }
    fs.appendFileSync(diagPath(), `${nowIso()} ${event} ${JSON.stringify(safe)}\n`, 'utf8');
  } catch (_) {}
}

function loadSession(encodedInput) {
  const encoded = String(encodedInput || '').trim();
  if (!encoded) throw new Error('Direct transport session is missing.');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new Error('Direct transport session payload is invalid.'); }
  const token = String(parsed.bot_token || '');
  const chatId = String(parsed.chat_id || '');
  const botApiBase = String(parsed.bot_api_base || '').trim().replace(/\/$/, '');
  if (!token || !chatId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(botApiBase)) {
    throw new Error('Direct transport session is incomplete.');
  }
  return {
    ...parsed,
    token,
    chatId,
    botApiBase,
    resolverChatId: String(parsed.resolver_chat_id || '').trim() || null,
  };
}

function emptyManifest() {
  return {
    schema: 'beatgaler.telegram.library',
    version: 2,
    updated_at: Math.floor(Date.now() / 1000),
    beats: [],
    trash: [],
    deleted: [],
    garbage: [],
  };
}

function normalizeDeletedTombstones(manifest) {
  const byId = new Map();
  for (const row of manifest?.deleted || []) {
    const id = String(row?.beat_id || row?.id || '').trim();
    if (!id) continue;
    const at = Number(row?.deleted_at || row?.at || 0) || Math.floor(Date.now() / 1000);
    const current = byId.get(id);
    if (!current || at > current.deleted_at) byId.set(id, { beat_id: id, deleted_at: at });
  }
  return [...byId.values()];
}
function mergeDeletedTombstones(previousManifest, nextManifest) {
  const byId = new Map();
  for (const row of [...normalizeDeletedTombstones(previousManifest), ...normalizeDeletedTombstones(nextManifest)]) {
    const current = byId.get(row.beat_id);
    if (!current || row.deleted_at > current.deleted_at) byId.set(row.beat_id, row);
  }
  nextManifest.deleted = [...byId.values()];
  const ids = new Set(nextManifest.deleted.map(row => row.beat_id));
  if (ids.size) {
    nextManifest.beats = (nextManifest.beats || []).filter(beat => !ids.has(String(beat?.id || '')));
    nextManifest.trash = (nextManifest.trash || []).filter(item => !ids.has(String(item?.beat?.id || '')));
  }
}
function collectMediaMessageIds(manifest) {
  const out = new Set();
  const add = value => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) out.add(n);
  };
  const addBeat = beat => {
    if (!beat || typeof beat !== 'object') return;
    add(beat.telegram_message_id);
    add(beat.master?.telegram_message_id);
    add(beat.artwork?.telegram_message_id);
    add(beat.metadata_message_id);
    for (const file of beat.files || []) {
      add(file?.telegram_message_id);
      for (const part of file?.manifest?.parts || file?.parts || []) add(part?.telegram_message_id);
    }
    const project = beat.project?.manifest || beat.project;
    add(project?.telegram_message_id);
    for (const part of project?.parts || []) add(part?.telegram_message_id);
  };
  for (const beat of manifest?.beats || []) addBeat(beat);
  for (const item of manifest?.trash || []) addBeat(item?.beat);
  return out;
}

function collectBeatIdentityIds(manifest) {
  const out = new Set();
  for (const beat of manifest?.beats || []) {
    const id = String(beat?.id || '').trim();
    if (id) out.add(id);
  }
  for (const item of manifest?.trash || []) {
    const id = String(item?.beat?.id || item?.id || '').trim();
    if (id) out.add(id);
  }
  return out;
}

function isSafeNonDestructiveLibraryTransition(previousManifest, nextManifest) {
  const previousIds = collectBeatIdentityIds(previousManifest);
  const nextIds = collectBeatIdentityIds(nextManifest);
  if (previousIds.size === 0) return true;
  for (const id of previousIds) {
    if (!nextIds.has(id)) return false;
  }
  return true;
}

async function botApi(session, method, payload = {}, timeoutMs = 30000) {
  // Telegram can rate-limit pin/send bursts. Critical Direct operations should
  // honor retry_after instead of surfacing a false permanent failure while the
  // previous INDEX is still safely pinned. Keep this bounded and transparent in
  // diagnostics; ordinary non-429 errors still fail immediately.
  const maxRateLimitRetries = 2;
  for (let attempt = 0; attempt <= maxRateLimitRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const url = `${session.botApiBase}/bot${session.token}/${method}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        const description = body?.description || `${method} failed (${response.status})`;
        const retryAfter = Number(body?.parameters?.retry_after || 0);
        if (response.status === 429 && retryAfter > 0 && attempt < maxRateLimitRetries) {
          diag('BOT_API_RATE_LIMIT_WAIT', { method, retry_after: retryAfter, attempt: attempt + 1 });
          clearTimeout(timer);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 250));
          continue;
        }
        diag('BOT_API_ERROR', { method, status: response.status, ms: Date.now() - started, description });
        throw new Error(description);
      }
      diag('BOT_API_OK', { method, ms: Date.now() - started, attempt: attempt + 1 });
      return body.result;
    } catch (error) {
      const message = error?.name === 'AbortError' ? `${method} timed out` : String(error?.message || error);
      const url = `${session.botApiBase}/bot${session.token}/${method}`;
      const network = await networkFailureDiagnostics(session, `botApi:${method}`, url, error).catch(diagError => ({
        details: errorDetails(error),
        diagnostic_error: errorDetails(diagError),
      }));
      const cause = network?.details?.chain?.[1] || network?.details?.chain?.[0] || {};
      const code = cause.code || cause.errno || '';
      const suffix = [code, cause.syscall, cause.address, cause.port].filter(v => v !== null && v !== undefined && String(v) !== '').join(' ');
      diag('BOT_API_CALL_FAILED', {
        method,
        target: safeUrl(url),
        ms: Date.now() - started,
        error: message,
        cause: network?.details || null,
        probe: network?.probe || null,
      });
      throw new Error(`${message}${suffix ? ` (${suffix})` : ''}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${method} failed after rate-limit retries`);
}

function indexFromChat(chat) {
  const message = chat?.pinned_message;
  if (!message?.document) return null;
  const caption = String(message.caption || message.text || '');
  if (!caption.startsWith(INDEX_CAPTION)) return null;
  return message;
}

async function getFileLocalPath(session, fileId) {
  const result = await botApi(session, 'getFile', { file_id: String(fileId) }, 60000);
  const filePath = String(result?.file_path || '');
  if (!filePath) throw new Error('Bot API getFile returned no file_path.');
  if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
    return { path: filePath, size: Number(result?.file_size || 0) || fs.statSync(filePath).size };
  }

  // Fallback for a Bot API server not returning absolute local paths. This is
  // still Desktop -> local Bot API -> Telegram; no BeatGaler cloud relay.
  const cacheDir = path.join(os.tmpdir(), 'beatgaler-botapi-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${crypto.createHash('sha256').update(String(fileId)).digest('hex')}.bin`);
  if (!fs.existsSync(cachePath) || fs.statSync(cachePath).size <= 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const fileUrl = `${session.botApiBase}/file/bot${session.token}/${filePath}`;
    try {
      const response = await fetch(fileUrl, { signal: controller.signal });
      if (!response.ok) {
        diag('BOT_API_FILE_HTTP_ERROR', {
          target: safeUrl(fileUrl),
          status: response.status,
          status_text: response.statusText,
          headers: Object.fromEntries([...response.headers.entries()].filter(([k]) => !/authorization|cookie|set-cookie/i.test(k))),
        });
        throw new Error(`Bot API file download failed (${response.status}).`);
      }
      const data = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(cachePath, data);
    } catch (error) {
      await networkFailureDiagnostics(session, 'botApi:fileDownload', fileUrl, error).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
  }
  return { path: cachePath, size: fs.statSync(cachePath).size };
}

async function readManifestFromPinned(session, message) {
  if (!message?.document?.file_id) return null;
  const local = await getFileLocalPath(session, message.document.file_id);
  const parsed = JSON.parse(fs.readFileSync(local.path, 'utf8'));
  if (parsed?.schema !== 'beatgaler.telegram.library') throw new Error('Pinned document is not a BeatGaler library index.');
  return parsed;
}

async function getCurrentIndex(session) {
  // The control plane serializes INDEX operations per vault, but Telegram can
  // still take a few milliseconds to propagate a new pin/file locally. Retry
  // the SAME vault instead of surfacing a false source-of-truth failure.
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const chat = await botApi(session, 'getChat', { chat_id: session.chatId });
    const message = indexFromChat(chat);
    if (!message) return null;
    try {
      const manifest = await readManifestFromPinned(session, message);
      return { message, manifest };
    } catch (error) {
      lastError = error;
      const confirm = await botApi(session, 'getChat', { chat_id: session.chatId });
      const current = indexFromChat(confirm);
      const oldId = Number(message?.message_id || 0);
      const currentId = Number(current?.message_id || 0);
      diag('INDEX_READ_RETRY', {
        attempt,
        old_message_id: oldId,
        current_message_id: currentId,
        reason: String(error?.message || error),
      });
      if (attempt < 5) await sleep(Math.min(1000, 80 * (2 ** (attempt - 1))));
    }
  }
  throw lastError || new Error('Could not read the pinned BeatGaler library index.');
}

function mediaFileFromMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const candidates = [
    ['document', message.document],
    ['audio', message.audio],
    ['video', message.video],
    ['voice', message.voice],
    ['animation', message.animation],
    ['video_note', message.video_note],
  ];
  for (const [kind, media] of candidates) {
    const fileId = String(media?.file_id || '').trim();
    if (fileId) return { kind, file_id: fileId, file_unique_id: String(media?.file_unique_id || '') };
  }
  return null;
}

async function sendDocumentLocal(session, { filePath, filename, caption, threadId }) {
  const payload = {
    chat_id: session.chatId,
    // Local Bot API expects a local file URI. A raw Windows path such as
    // C:\\Beats\\x.wav is parsed as an HTTP URL and fails with
    // 'Wrong port number specified in the URL'. pathToFileURL generates the
    // correct file:///C:/Beats/x.wav form on Windows.
    document: pathToFileURL(path.resolve(filePath)).href,
    caption: caption || undefined,
    disable_notification: true,
  };
  if (Number(threadId) > 0) payload.message_thread_id = Number(threadId);
  const message = await botApi(session, 'sendDocument', payload, 10 * 60 * 1000);
  const media = mediaFileFromMessage(message);
  if (!message?.message_id || !media?.file_id) {
    diag('SEND_DOCUMENT_UNEXPECTED_RESULT', {
      message_id: Number(message?.message_id || 0),
      result_keys: message && typeof message === 'object' ? Object.keys(message) : [],
    });
    throw new Error('Bot API sendDocument returned a Message without a usable media file_id.');
  }
  // telegram-bot-api/TDLib can classify an MP3 sent through sendDocument as
  // Message.audio. BeatGaler only needs the stable file_id + message_id, so
  // normalize every supported media shape to `.document` for the rest of the
  // Direct helper instead of falsely treating a successful upload as failure.
  if (!message.document?.file_id) message.document = { file_id: media.file_id, file_unique_id: media.file_unique_id };
  diag('SEND_DOCUMENT_RESULT', { message_id: Number(message.message_id), media_kind: media.kind });
  return message;
}

async function ensureIndex(session) {
  let current = await getCurrentIndex(session);
  if (current) return current;
  const temp = path.join(os.tmpdir(), `beatgaler-empty-index-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(temp, JSON.stringify(emptyManifest(), null, 2));
  try {
    const message = await sendDocumentLocal(session, { filePath: temp, filename: 'beatgaler-library.json', caption: INDEX_CAPTION });
    await botApi(session, 'pinChatMessage', { chat_id: session.chatId, message_id: message.message_id, disable_notification: true });
    diag('INDEX_CREATED_EMPTY', { vault: session.chatId, message_id: message.message_id });
    return { message, manifest: emptyManifest() };
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
}

function id3v2PrefixLength(header, fileSize) {
  if (header.length < 10 || header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return 0;
  const major = header[3];
  if (major < 2 || major > 4) return 0;
  const sizeBytes = [header[6], header[7], header[8], header[9]];
  if (sizeBytes.some(value => value >= 0x80)) return 0;
  const bodySize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
  const footerSize = major === 4 && (header[5] & 0x10) !== 0 ? 10 : 0;
  const total = 10 + bodySize + footerSize;
  return total > 0 && total < fileSize ? total : 0;
}

function copyFileRange(sourcePath, destinationPath, start, endExclusive) {
  const input = fs.openSync(sourcePath, 'r');
  const output = fs.openSync(destinationPath, 'wx', 0o600);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = start;
  try {
    while (offset < endExclusive) {
      const wanted = Math.min(buffer.byteLength, endExclusive - offset);
      const read = fs.readSync(input, buffer, 0, wanted, offset);
      if (read <= 0) throw new Error('Unexpected end of MP3 while creating clean Cloud payload.');
      let written = 0;
      while (written < read) written += fs.writeSync(output, buffer, written, read - written);
      offset += read;
    }
  } finally {
    fs.closeSync(output);
    fs.closeSync(input);
  }
}

function prepareCleanMp3Upload(filePath, filename) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || !/\.mp3$/i.test(String(filename || filePath))) {
    return { path: filePath, bytes: stat.size, removedBytes: 0, cleanup() {} };
  }
  const fd = fs.openSync(filePath, 'r');
  let prefix = 0;
  let suffix = 0;
  try {
    const head = Buffer.alloc(10);
    const headRead = fs.readSync(fd, head, 0, head.length, 0);
    prefix = id3v2PrefixLength(head.subarray(0, headRead), stat.size);
    if (stat.size - prefix > 128) {
      const tail = Buffer.alloc(128);
      const tailRead = fs.readSync(fd, tail, 0, tail.length, stat.size - 128);
      if (tailRead === 128 && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) suffix = 128;
    }
  } finally {
    fs.closeSync(fd);
  }
  const end = stat.size - suffix;
  if ((prefix === 0 && suffix === 0) || prefix >= end) {
    return { path: filePath, bytes: stat.size, removedBytes: 0, cleanup() {} };
  }
  const tempPath = path.join(os.tmpdir(), `beatgaler-clean-mp3-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  try {
    copyFileRange(filePath, tempPath, prefix, end);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
  return {
    path: tempPath,
    bytes: end - prefix,
    removedBytes: stat.size - (end - prefix),
    cleanup() { try { fs.unlinkSync(tempPath); } catch (_) {} },
  };
}

async function upload(session, command) {
  const filePath = path.resolve(String(command.path || ''));
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Upload source is missing or empty.');
  const filename = String(command.filename || path.basename(filePath));
  const clean = prepareCleanMp3Upload(filePath, filename);
  diag('UPLOAD_BEGIN', {
    vault: session.chatId,
    path: filePath,
    bytes: clean.bytes,
    source_bytes: stat.size,
    stripped_id3_bytes: clean.removedBytes,
    thread_id: Number(command.reply_to || 0),
  });
  try {
    const sent = await sendDocumentLocal(session, {
      filePath: clean.path,
      filename,
      caption: String(command.caption || ''),
      threadId: Number(command.reply_to || 0),
    });
    sessionFileIds.set(Number(sent.message_id), String(sent.document.file_id));
    diag('UPLOAD_OK', { vault: session.chatId, message_id: sent.message_id, bytes: clean.bytes, stripped_id3_bytes: clean.removedBytes });
    return {
      ok: true,
      op: 'upload',
      message_id: Number(sent.message_id),
      telegram_file_id: String(sent.document.file_id),
      file_id: String(sent.document.file_id),
      filename,
      bytes: clean.bytes,
      source_bytes: stat.size,
      stripped_id3_bytes: clean.removedBytes,
    };
  } finally {
    clean.cleanup();
  }
}

async function resolveMediaFileId(session, command) {
  const messageId = Number(command.message_id || 0);
  const cached = sessionFileIds.get(messageId);
  if (cached) return cached;
  const supplied = String(command.file_id || '').trim();
  if (supplied) {
    try {
      await botApi(session, 'getFile', { file_id: supplied }, 30000);
      return supplied;
    } catch (error) {
      diag('FILE_ID_NOT_VALID_FOR_ASSIGNED_BOT', { message_id: Number(command.message_id || 0), error: error?.message || error });
    }
  }
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error('Download requires a valid message_id.');
  if (!session.resolverChatId) {
    throw new Error('This file was uploaded by another transport bot. DIRECT_BOTAPI_RESOLVER_CHAT_ID is required for cross-bot historical media resolution.');
  }

  // Bot API cannot fetch an arbitrary historical Message by id. Forwarding it
  // server-side inside Telegram to the private resolver channel returns a fresh
  // Message object with a file_id valid for THIS bot. The temporary resolver
  // message is immediately deleted and is never posted in the user vault.
  diag('RESOLVE_FILE_BEGIN', { source_vault: session.chatId, message_id: messageId, resolver_chat: session.resolverChatId });
  const forwarded = await botApi(session, 'forwardMessage', {
    chat_id: session.resolverChatId,
    from_chat_id: session.chatId,
    message_id: messageId,
    disable_notification: true,
  }, 60000);
  try {
    const fileId = String(forwarded?.document?.file_id || forwarded?.audio?.file_id || forwarded?.video?.file_id || '');
    if (!fileId) throw new Error('Resolver forward returned no downloadable file_id.');
    sessionFileIds.set(messageId, fileId);
    diag('RESOLVE_FILE_OK', { message_id: messageId, resolver_message_id: Number(forwarded.message_id || 0) });
    return fileId;
  } finally {
    if (Number(forwarded?.message_id) > 0) {
      try { await botApi(session, 'deleteMessage', { chat_id: session.resolverChatId, message_id: Number(forwarded.message_id) }); }
      catch (error) { diag('RESOLVER_CLEANUP_FAILED', { resolver_message_id: Number(forwarded.message_id), error: error?.message || error }); }
    }
  }
}

async function download(session, command) {
  const output = path.resolve(String(command.output || ''));
  if (!output) throw new Error('Download output path is required.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fileId = await resolveMediaFileId(session, command);
  const local = await getFileLocalPath(session, fileId);
  const temp = `${output}.beatgaler-botapi-${process.pid}.part`;
  fs.copyFileSync(local.path, temp);
  try { fs.unlinkSync(output); } catch (_) {}
  fs.renameSync(temp, output);
  const size = fs.statSync(output).size;
  diag('DOWNLOAD_OK', { message_id: Number(command.message_id || 0), output, bytes: size });
  return { ok: true, op: 'download', bytes: size, total: local.size };
}

async function downloadRange(session, command) {
  const output = path.resolve(String(command.output || ''));
  const start = Math.max(0, Number(command.start || 0));
  const length = Math.max(1, Number(command.length || 512 * 1024));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) throw new Error('Invalid range request.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fileId = await resolveMediaFileId(session, command);
  const local = await getFileLocalPath(session, fileId);
  const total = local.size;
  const wanted = Math.max(0, Math.min(length, total - start));
  const fd = fs.openSync(local.path, 'r');
  try {
    const buffer = Buffer.alloc(wanted);
    const bytes = wanted ? fs.readSync(fd, buffer, 0, wanted, start) : 0;
    fs.writeFileSync(output, buffer.subarray(0, bytes));
    diag('DOWNLOAD_RANGE_OK', { message_id: Number(command.message_id || 0), start, requested: length, bytes, total });
    return { ok: true, op: 'download_range', bytes, total };
  } finally { fs.closeSync(fd); }
}

async function probeMedia(session, command) {
  const messageId = Number(command.message_id || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error('Probe requires a valid message_id.');
  if (!session.resolverChatId) throw new Error('DIRECT_BOTAPI_RESOLVER_CHAT_ID is required for media integrity probes.');

  // Do NOT use sessionFileIds here: a cached file_id can remain downloadable even
  // after the original vault message was deleted. Integrity repair must prove the
  // SOURCE message still exists, so always ask Telegram to forward that exact
  // message to the private resolver channel. A deleted source produces the
  // definitive "message to forward not found" response.
  const forwarded = await botApi(session, 'forwardMessage', {
    chat_id: session.resolverChatId,
    from_chat_id: session.chatId,
    message_id: messageId,
    disable_notification: true,
  }, 60000);
  try {
    return { ok: true, op: 'probe_media', message_id: messageId, exists: true };
  } finally {
    if (Number(forwarded?.message_id) > 0) {
      try { await botApi(session, 'deleteMessage', { chat_id: session.resolverChatId, message_id: Number(forwarded.message_id) }); }
      catch (error) { diag('PROBE_RESOLVER_CLEANUP_FAILED', { resolver_message_id: Number(forwarded.message_id), error: error?.message || error }); }
    }
  }
}

async function getIndex(session) {
  const current = await ensureIndex(session);
  return {
    ok: true,
    op: 'get_index',
    message_id: Number(current.message?.message_id || 0),
    file_id: String(current.message?.document?.file_id || ''),
    manifest: current.manifest || emptyManifest(),
  };
}

async function replaceIndex(session, command) {
  const filePath = path.resolve(String(command.path || ''));
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) throw new Error('Library index source is missing or empty.');
  const nextManifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (nextManifest?.schema !== 'beatgaler.telegram.library') throw new Error('Library index has an unexpected schema.');

  const previous = await getCurrentIndex(session);
  const previousIdentityIds = collectBeatIdentityIds(previous?.manifest || null);
  const nextIdentityIds = collectBeatIdentityIds(nextManifest);
  const allowDestructive = command.allow_destructive === true;

  // Catastrophic-loss barrier. A refresh/restore/stale UI snapshot must never
  // turn a populated vault into an empty (or smaller) authoritative library.
  // Permanent deletion uses an explicit allow_destructive transaction.
  if (!allowDestructive && previousIdentityIds.size > 0) {
    const missing = [...previousIdentityIds].filter(id => !nextIdentityIds.has(id));
    if (missing.length > 0) {
      diag('INDEX_REPLACE_BLOCKED_DESTRUCTIVE', {
        previous_total: previousIdentityIds.size,
        next_total: nextIdentityIds.size,
        missing_count: missing.length,
        empty_candidate: nextIdentityIds.size === 0,
      });
      throw new Error(`Safety barrier blocked destructive INDEX replacement (${previousIdentityIds.size} -> ${nextIdentityIds.size} beats).`);
    }
  }
  mergeDeletedTombstones(previous?.manifest || null, nextManifest);
  fs.writeFileSync(filePath, JSON.stringify(nextManifest, null, 2));
  const previousRefs = collectMediaMessageIds(previous?.manifest || null);
  const nextRefs = collectMediaMessageIds(nextManifest);

  // Idempotency guard: duplicate observers may request the exact same index.
  // Never create/pin/delete another Telegram document when authoritative data
  // did not change. This also protects against UI event storms.
  if (previous?.manifest && JSON.stringify(previous.manifest) === JSON.stringify(nextManifest)) {
    const existingMessageId = Number(previous?.message?.message_id || 0);
    const existingFileId = String(previous?.message?.document?.file_id || '');
    diag('INDEX_REPLACE_SKIPPED_IDENTICAL', { message_id: existingMessageId, beat_count: (nextManifest.beats || []).length });
    return {
      ok: true,
      op: 'replace_index',
      message_id: existingMessageId,
      file_id: existingFileId,
      telegram_file_id: existingFileId,
      previous_message_id: existingMessageId,
      deleted_indexes: 0,
      deleted_media: 0,
      cleanup_errors: [],
      updated: false,
    };
  }

  diag('INDEX_REPLACE_BEGIN', { previous_message_id: Number(previous?.message?.message_id || 0), beat_count: (nextManifest.beats || []).length });
  const sent = await sendDocumentLocal(session, { filePath, filename: 'beatgaler-library.json', caption: INDEX_CAPTION });
  await botApi(session, 'pinChatMessage', { chat_id: session.chatId, message_id: sent.message_id, disable_notification: true });

  const oldId = Number(previous?.message?.message_id || 0);
  if (oldId > 0 && oldId !== Number(sent.message_id)) {
    try { await botApi(session, 'deleteMessage', { chat_id: session.chatId, message_id: oldId }); }
    catch (error) { diag('OLD_INDEX_DELETE_FAILED', { message_id: oldId, error: error?.message || error }); }
  }

  let deletedMedia = 0;
  // Automatic media cleanup is safe only when no beat identity disappeared
  // from the library (active + trash). This still removes replaced artwork,
  // project/audio versions, etc. Permanent beat deletion is explicit below.
  const safeMediaCleanup = isSafeNonDestructiveLibraryTransition(previous?.manifest || null, nextManifest);
  if (safeMediaCleanup) {
    for (const id of previousRefs) {
      if (nextRefs.has(id)) continue;
      try {
        await botApi(session, 'deleteMessage', { chat_id: session.chatId, message_id: id });
        deletedMedia += 1;
      } catch (error) {
        diag('OBSOLETE_MEDIA_DELETE_FAILED', { message_id: id, error: error?.message || error });
      }
    }
  } else {
    const obsoleteCount = [...previousRefs].filter(id => !nextRefs.has(id)).length;
    if (obsoleteCount > 0) diag('MEDIA_CLEANUP_SKIPPED_DESTRUCTIVE_DIFF', { obsolete_count: obsoleteCount });
  }
  diag('INDEX_REPLACE_OK', { message_id: sent.message_id, previous_message_id: oldId, beat_count: (nextManifest.beats || []).length, deleted_media: deletedMedia });
  return {
    ok: true,
    op: 'replace_index',
    message_id: Number(sent.message_id),
    file_id: String(sent.document.file_id),
    telegram_file_id: String(sent.document.file_id),
    previous_message_id: oldId,
    deleted_indexes: oldId > 0 ? 1 : 0,
    deleted_media: deletedMedia,
    cleanup_errors: [],
  };
}

async function deleteMessages(session, ids) {
  let deleted = 0;
  const errors = [];
  for (const id of [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))]) {
    try { await botApi(session, 'deleteMessage', { chat_id: session.chatId, message_id: id }); deleted += 1; }
    catch (error) { errors.push(String(error?.message || error)); }
  }
  return { deleted, errors };
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const iterator = rl[Symbol.asyncIterator]();
  const bootstrapLine = await iterator.next();
  if (bootstrapLine.done) throw new Error('Direct transport bootstrap channel closed before initialization.');
  const rawBootstrap = String(bootstrapLine.value || '').trim();
  if (!rawBootstrap.startsWith(BOOT)) throw new Error('Direct transport bootstrap payload is missing.');
  const session = loadSession(rawBootstrap.slice(BOOT.length));

  diag('HELPER_START', {
    session_id: session.session_id,
    transport_id: session.transport_id,
    vault: session.chatId,
    bot_api_base: safeUrl(session.botApiBase),
    resolver_configured: Boolean(session.resolverChatId),
    token_rotation_enabled: Boolean(session.token_rotation_enabled),
    runtime: runtimeContext(session),
    diagnostics_file: diagPath(),
  });

  // No auth.ImportBotAuthorization. The helper first announces that its stdin
  // control channel is ready, then PAUSES. Rust asks MASTER to add/promote and
  // confirm the assigned bot in the vault. Only after Rust sends
  // `activate_ready` may this helper touch the vault through Bot API. This
  // removes the race where getChat ran before Telegram had applied membership.
  emit({ ok: true, op: 'listening', session_id: session.session_id, transport_id: session.transport_id });

  const activationLine = await iterator.next();
  if (activationLine.done) throw new Error('Direct transport activation channel closed before vault membership was confirmed.');
  let activation;
  try { activation = JSON.parse(String(activationLine.value || '')); }
  catch { throw new Error('Direct transport activation command was invalid.'); }
  if (String(activation?.op || '').toLowerCase() !== 'activate_ready') {
    throw new Error('Direct transport expected activate_ready after MASTER membership confirmation.');
  }
  diag('MASTER_MEMBERSHIP_CONFIRMED', { session_id: session.session_id, transport_id: session.transport_id, vault: session.chatId });

  const me = await botApi(session, 'getMe', {});

  // Telegram can acknowledge InviteToChannel/EditAdmin to MASTER a fraction of
  // a second before that membership is visible through the bot's own Bot API
  // session. Retry THIS SAME bot instead of killing the lease and cycling the
  // pool. A 403 here is propagation delay, not a reason to reserve another bot.
  const accessStarted = Date.now();
  let attempt = 0;
  let chat;
  while (!chat) {
    attempt += 1;
    try {
      chat = await botApi(session, 'getChat', { chat_id: session.chatId });
    } catch (error) {
      const message = String(error?.message || error);
      const propagation = /not a member|forbidden|chat not found/i.test(message);
      const elapsed = Date.now() - accessStarted;
      if (!propagation || elapsed >= 30_000) throw error;
      const waitMs = Math.min(2000, 250 * Math.pow(2, Math.min(attempt - 1, 3)));
      diag('VAULT_ACCESS_WAIT', { transport_id: session.transport_id, vault: session.chatId, attempt, elapsed_ms: elapsed, retry_ms: waitMs, error: message });
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  diag('VAULT_ACCESS_OK', { transport_id: session.transport_id, bot_user_id: me?.id, vault: session.chatId, chat_type: chat?.type, attempts: attempt });
  const current = await ensureIndex(session);

  emit({
    ok: true,
    op: 'ready',
    session_id: session.session_id,
    transport_id: session.transport_id,
    generation: session.generation,
    credential_version: session.credential_version,
    index_message_id: Number(current?.message?.message_id || 0),
    beat_count: Array.isArray(current?.manifest?.beats) ? current.manifest.beats.length : 0,
    mode: 'botapi-local',
  });

  let closing = false;
  while (!closing) {
    const next = await iterator.next();
    if (next.done) break;
    const line = String(next.value || '');
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); }
    catch { fail('Invalid direct transport command JSON.'); continue; }
    const requestId = command.request_id || null;
    const op = String(command.op || '').toLowerCase();
    diag('OP_BEGIN', { op, request_id: requestId, message_id: Number(command.message_id || 0) });
    try {
      let result;
      switch (op) {
        case 'upload': result = await upload(session, command); break;
        case 'download': result = await download(session, command); break;
        case 'download_range': result = await downloadRange(session, command); break;
        case 'probe_media': result = await probeMedia(session, command); break;
        case 'get_index': result = await getIndex(session); break;
        case 'replace_index': result = await replaceIndex(session, command); break;
        case 'delete_messages': result = { ok: true, op: 'delete_messages', ...(await deleteMessages(session, command.message_ids || [])) }; break;
        case 'ping': result = { ok: true, op: 'pong' }; break;
        case 'shutdown': result = { ok: true, op: 'shutdown' }; closing = true; break;
        default: throw new Error(`Unsupported Direct operation: ${command.op}`);
      }
      diag('OP_OK', { op, request_id: requestId, message_id: Number(result?.message_id || 0), bytes: Number(result?.bytes || 0) });
      emit({ ...result, request_id: requestId });
    } catch (error) {
      diag('OP_FAILED', { op, request_id: requestId, error: error?.message || error });
      fail(error?.message || error, { request_id: requestId });
    }
  }
  rl.close();
  diag('HELPER_STOP', { session_id: session.session_id, transport_id: session.transport_id });
}

main().catch(error => {
  const details = errorDetails(error);
  diag('HELPER_FATAL', { error: error?.message || error, details, diagnostics_file: diagPath() });
  const cause = details.chain?.[1] || details.chain?.[0] || {};
  const code = cause.code || cause.errno || '';
  const suffix = [code, cause.syscall, cause.address, cause.port].filter(v => v !== null && v !== undefined && String(v) !== '').join(' ');
  fail(`${error?.message || error}${suffix && !String(error?.message || error).includes(String(code)) ? ` (${suffix})` : ''}`, {
    fatal: true,
    diagnostic_file: diagPath(),
  });
  process.exitCode = 1;
});
