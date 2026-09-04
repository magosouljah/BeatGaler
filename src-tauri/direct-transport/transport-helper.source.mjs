import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  InputMedia,
  Long,
  MemoryStorage,
  SessionConnection,
  TelegramClient,
  WebCryptoProvider,
  WebSocketTransport,
  tl,
} from "@mtcute/web";
import wasmBytes from "__beatgaler_mtcute_wasm__";
import {
  TlBinaryWriter,
  TlSerializationCounter,
  __tlReaderMap,
  __tlWriterMap,
  longFromBuffer,
  randomLong,
} from "__beatgaler_mtcute_utils__";
import { doAuthorization } from "__beatgaler_mtcute_authorization__";
import { prepareCleanMp3CloudUpload } from "./clean-mp3-cloud.mjs";

const PREFIX = "__BEATGALER_DIRECT_JSON__";
const BOOT = "__BEATGALER_DIRECT_BOOTSTRAP__";
const INDEX_CAPTION = "BEATGALER_LIBRARY_INDEX_V1";
const TEMP_TTL_SECONDS = 10 * 60;
const RENEW_BEFORE_SECONDS = 120;
const TIMEOUT_MS = 60_000;
const PROD_DC_SUBDOMAINS = { 1: "pluto", 2: "venus", 3: "aurora", 4: "vesta", 5: "flora" };
let client = null;
let tempExpiresAt = 0;
let session = null;
let inputIterator = null;

function emit(value) { process.stdout.write(`${PREFIX}${JSON.stringify(value)}\n`); }
function fail(error, extra = {}) { emit({ ok: false, error: String(error?.message || error), ...extra }); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function timeout(promise, label, ms = TIMEOUT_MS) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}
function productionDc(dcId) {
  const subdomain = PROD_DC_SUBDOMAINS[Number(dcId)];
  if (!subdomain) throw new Error(`Unsupported storage DC ${dcId}.`);
  return { id: Number(dcId), ipAddress: `${subdomain}.web.telegram.org`, port: 443, testMode: false, mediaOnly: false, ipv6: false };
}
function emptyManifest() {
  return { schema: "beatgaler.telegram.library", version: 2, updated_at: Math.floor(Date.now() / 1000), beats: [], trash: [], deleted: [], garbage: [] };
}
function longJson(value) { return { low: value.low, high: value.high, unsigned: Boolean(value.unsigned) }; }
function longFromJson(value) { return new Long(value.low, value.high, Boolean(value.unsigned)); }
function fromBase64(value) { return new Uint8Array(Buffer.from(String(value || ""), "base64")); }
function silentLogger(prefix = "") {
  return { prefix, mgr: { level: 0 }, create(child) { return silentLogger(prefix ? `${prefix}:${child}` : child); }, verbose() {}, debug() {}, info() {}, warn() {}, error() {} };
}
class TempSaltManager {
  currentSalt = Long.ZERO;
  isFetching = false;
  setTimeSource(fn) { this.getServerTime = fn; }
  shouldFetchSalts() { return false; }
  setFutureSalts() {}
  destroy() {}
}
class DeferredLike {
  constructor() { this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
}

async function makeManualConnection(provider, dcId) {
  class ManualSessionConnection extends SessionConnection { onConnected() {} }
  const connection = new ManualSessionConnection({
    crypto: provider,
    initConnection: {
      _: "initConnection", apiId: 0, deviceModel: "BeatGaler Desktop temporary data plane",
      systemVersion: `${process.platform} ${process.arch}`, appVersion: "0.8.0-alpha.1",
      systemLangCode: "en", langPack: "", langCode: "en", query: { _: "help.getNearestDc" },
    },
    transport: new WebSocketTransport({ ws: globalThis.WebSocket }),
    dc: productionDc(dcId), testMode: false, reconnectionStrategy: () => 1000,
    layer: tl.LAYER, disableUpdates: true, readerMap: __tlReaderMap, writerMap: __tlWriterMap,
    usePfs: false, isMainConnection: true, isMainDcConnection: true, inactivityTimeout: 120_000,
    salts: new TempSaltManager(), platform: {
      isOnline: () => true, onNetworkChanged: () => () => {},
      getDeviceModel: () => "BeatGaler Desktop temporary data plane", getDefaultLogLevel: () => null,
    }, pingInterval: 60_000,
  }, silentLogger("desktop-temp"));
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Temporary-auth socket open timeout.")), TIMEOUT_MS);
    connection.onUsable.add(() => { clearTimeout(timer); resolve(); });
  });
  connection.connect();
  await opened;
  return connection;
}

async function prepareTempAuth(dcId) {
  const provider = new WebCryptoProvider({ wasmInput: new Response(wasmBytes, { headers: { "Content-Type": "application/wasm" } }) });
  await provider.initialize();
  const connection = await makeManualConnection(provider, dcId);
  let authKeyBytes = null;
  try {
    const [generatedTempKey, tempServerSalt] = await timeout(doAuthorization(connection, provider, TEMP_TTL_SECONDS), "temporary auth generation");
    authKeyBytes = generatedTempKey;
    connection._session._authKey.setup(provider.randomBytes(256));
    const tempKey = connection._session._authKeyTempSecondary;
    tempKey.setup(authKeyBytes);
    const msgId = connection._session.getMessageId();
    const nonce = randomLong();
    const expiresAt = Math.floor(Date.now() / 1000) + TEMP_TTL_SECONDS;
    const metadata = {
      msgId: longJson(msgId), nonce: longJson(nonce), tempAuthKeyId: longJson(longFromBuffer(tempKey.id)),
      tempSessionId: longJson(connection._session._sessionId), expiresAt,
    };
    return {
      metadata,
      async bind(binding) {
        if (!binding?.perm_auth_key_id || !binding?.encrypted_message) throw new Error("Galer Cloud returned incomplete temporary authorization.");
        const pending = new DeferredLike();
        connection._session.pendingMessages.set(msgId, { _: "bind", promise: pending });
        const bindRequest = {
          _: "auth.bindTempAuthKey", permAuthKeyId: longFromJson(binding.perm_auth_key_id), nonce, expiresAt,
          encryptedMessage: fromBase64(binding.encrypted_message),
        };
        const reqSize = TlSerializationCounter.countNeededBytes(__tlWriterMap, bindRequest);
        const reqWriter = TlBinaryWriter.alloc(__tlWriterMap, reqSize + 16);
        reqWriter.long(connection._registerOutgoingMsgId(msgId));
        reqWriter.uint(connection._session.getSeqNo());
        reqWriter.uint(reqSize);
        reqWriter.object(bindRequest);
        await connection.send(tempKey.encryptMessage(reqWriter.result(), tempServerSalt, connection._session._sessionId));
        const result = await timeout(pending.promise, "auth.bindTempAuthKey response");
        connection._session.pendingMessages.delete(msgId);
        if (typeof result === "object") throw new Error(`Temporary authorization rejected: ${result.errorCode}:${result.errorMessage}`);
        if (result !== true) throw new Error("Temporary authorization was not accepted.");
        if (!authKeyBytes) throw new Error("Temporary authorization disappeared before import.");
        return { authKey: authKeyBytes.slice(), expiresAt };
      },
      async destroy() { authKeyBytes?.fill(0); authKeyBytes = null; await connection.destroy().catch(() => {}); },
    };
  } catch (error) {
    authKeyBytes?.fill(0);
    await connection.destroy().catch(() => {});
    throw error;
  }
}

async function nextControlCommand(expectedOp) {
  const next = await inputIterator.next();
  if (next.done) throw new Error(`Direct transport control channel closed while waiting for ${expectedOp}.`);
  let value;
  try { value = JSON.parse(String(next.value || "")); } catch { throw new Error(`Invalid ${expectedOp} control JSON.`); }
  if (String(value?.op || "").toLowerCase() !== expectedOp) throw new Error(`Direct transport expected ${expectedOp}.`);
  return value;
}

async function bindFreshTemporarySession(reason) {
  const bootstrap = session?.temp_auth;
  if (!bootstrap?.dc_id || !bootstrap?.expected_bot_id) throw new Error("Direct session has no temporary-auth bootstrap.");
  const prepared = await prepareTempAuth(Number(bootstrap.dc_id));
  try {
    emit({
      ok: true, op: "temp_auth_metadata", reason,
      session_id: session.session_id, generation: session.generation, credential_version: session.credential_version,
      temp_auth_metadata: prepared.metadata,
    });
    const response = await nextControlCommand("temp_auth_binding");
    const bound = response?.session;
    if (!bound || bound.mode !== "galer-direct-temp-mtproto" || bound.session_id !== session.session_id || Number(bound.generation) !== Number(session.generation)) {
      throw new Error("Galer Cloud returned a mismatched temporary-auth lease.");
    }
    const binding = bound?.temp_auth?.binding;
    if (!binding || Number(bound?.temp_auth?.expires_at) !== Number(prepared.metadata.expiresAt)) {
      throw new Error("Galer Cloud returned incomplete temporary-auth binding.");
    }
    const imported = await prepared.bind(binding);
    const next = new TelegramClient({
      apiId: 0, apiHash: "", storage: new MemoryStorage(),
      crypto: new WebCryptoProvider({ wasmInput: new Response(wasmBytes, { headers: { "Content-Type": "application/wasm" } }) }),
      disableUpdates: true,
    });
    try {
      await next.importSession({
        primaryDcs: { main: productionDc(Number(bound.temp_auth.dc_id)), media: productionDc(Number(bound.temp_auth.dc_id)) },
        self: { userId: Number(bound.temp_auth.expected_bot_id), isBot: true, isPremium: false, usernames: [] },
        authKey: imported.authKey,
      }, true);
      imported.authKey.fill(0);
      const self = await next.getMe();
      if (!self?.isBot || String(self.id) !== String(bound.temp_auth.expected_bot_id)) throw new Error("Temporary authorization resolved to the wrong transport identity.");
      await next.getChat(Number(session.chat_id));
    } catch (error) {
      await next.destroy().catch(() => {});
      throw error;
    }
    const previous = client;
    client = next;
    tempExpiresAt = imported.expiresAt;
    session = { ...session, ...bound, temp_auth: bound.temp_auth };
    await previous?.destroy().catch(() => {});
  } finally {
    await prepared.destroy().catch(() => {});
  }
}

async function ensureFreshTemporarySession(reason = "proactive") {
  if (!client || Math.floor(Date.now() / 1000) >= tempExpiresAt - RENEW_BEFORE_SECONDS) await bindFreshTemporarySession(reason);
  return client;
}

function mediaFromMessage(message) {
  const media = message?.media;
  if (!media || !["document", "audio", "video", "voice", "photo", "sticker"].includes(media.type)) throw new Error("Stored object is not downloadable.");
  return media;
}
async function getMessage(messageId) {
  const active = await ensureFreshTemporarySession();
  const [message] = await active.getMessages(Number(session.chat_id), [Number(messageId)]);
  if (!message) throw new Error(`Stored message ${messageId} does not exist.`);
  return message;
}
async function getCurrentIndex() {
  const active = await ensureFreshTemporarySession();
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const full = await active.getFullChat(Number(session.chat_id));
      const pinnedId = Number(full.pinnedMsgId || 0);
      if (!Number.isInteger(pinnedId) || pinnedId <= 0) return null;
      const message = await getMessage(pinnedId);
      if (!String(message.text || "").startsWith(INDEX_CAPTION)) throw new Error("Pinned object is not the library index.");
      const bytes = await active.downloadAsBuffer(mediaFromMessage(message), { stallTimeout: 20_000 });
      return { message, manifest: JSON.parse(Buffer.from(bytes).toString("utf8")) };
    } catch (error) { lastError = error; if (attempt < 4) await sleep(Math.min(1000, 80 * (2 ** attempt))); }
  }
  throw lastError || new Error("Could not read library index.");
}
async function sendDocument(filePath, filename, caption, threadId = 0) {
  const active = await ensureFreshTemporarySession();
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  const sent = await active.sendMedia(Number(session.chat_id), InputMedia.document(stream, {
    fileName: filename, fileMime: "application/octet-stream", fileSize: stat.size, caption: caption || undefined,
  }), { silent: true, ...(Number(threadId) > 0 ? { replyTo: Number(threadId), threadId: Number(threadId) } : {}) });
  if (!sent?.id) throw new Error("Direct upload returned no message id.");
  return sent;
}
async function ensureIndex() {
  const current = await getCurrentIndex();
  if (current) return current;
  const temp = path.join(os.tmpdir(), `beatgaler-empty-index-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(temp, JSON.stringify(emptyManifest(), null, 2));
  try {
    const sent = await sendDocument(temp, "beatgaler-library.json", INDEX_CAPTION);
    await (await ensureFreshTemporarySession()).pinMessage({ chatId: Number(session.chat_id), message: Number(sent.id), notify: false });
    return { message: sent, manifest: emptyManifest() };
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function collectBeatIdentityIds(manifest) {
  const out = new Set();
  for (const beat of manifest?.beats || []) { const id = String(beat?.id || "").trim(); if (id) out.add(id); }
  for (const item of manifest?.trash || []) { const id = String(item?.beat?.id || item?.id || "").trim(); if (id) out.add(id); }
  return out;
}
function normalizeDeleted(manifest) {
  const byId = new Map();
  for (const row of manifest?.deleted || []) {
    const id = String(row?.beat_id || row?.id || "").trim(); if (!id) continue;
    const deleted_at = Number(row?.deleted_at || row?.at || 0) || Math.floor(Date.now() / 1000);
    if (!byId.has(id) || deleted_at > byId.get(id).deleted_at) byId.set(id, { beat_id: id, deleted_at });
  }
  return [...byId.values()];
}
function mergeDeleted(previous, next) {
  const byId = new Map();
  for (const row of [...normalizeDeleted(previous), ...normalizeDeleted(next)]) if (!byId.has(row.beat_id) || row.deleted_at > byId.get(row.beat_id).deleted_at) byId.set(row.beat_id, row);
  next.deleted = [...byId.values()];
  const ids = new Set(next.deleted.map(row => row.beat_id));
  next.beats = (next.beats || []).filter(beat => !ids.has(String(beat?.id || "")));
  next.trash = (next.trash || []).filter(item => !ids.has(String(item?.beat?.id || item?.id || "")));
}
function collectMediaIds(manifest) {
  const out = new Set(); const add = value => { const n = Number(value); if (Number.isInteger(n) && n > 0) out.add(n); };
  const beat = b => { if (!b) return; add(b.telegram_message_id); add(b.master?.telegram_message_id); add(b.artwork?.telegram_message_id); add(b.metadata_message_id); for (const f of b.files || []) { add(f?.telegram_message_id); for (const p of f?.manifest?.parts || f?.parts || []) add(p?.telegram_message_id); } const p = b.project?.manifest || b.project; add(p?.telegram_message_id); for (const x of p?.parts || []) add(x?.telegram_message_id); };
  for (const b of manifest?.beats || []) beat(b); for (const t of manifest?.trash || []) beat(t?.beat); return out;
}
async function upload(command) {
  const filePath = path.resolve(String(command.path || ""));
  const stat = fs.statSync(filePath); if (!stat.isFile() || stat.size <= 0) throw new Error("Upload source is missing or empty.");
  const filename = String(command.filename || path.basename(filePath));
  const clean = prepareCleanMp3CloudUpload(filePath, filename);
  try {
    const sent = await sendDocument(clean.path, filename, String(command.caption || ""), Number(command.reply_to || 0));
    const message = await getMessage(Number(sent.id));
    const fileId = String(message?.media?.fileId || `direct:${sent.id}`);
    return {
      ok: true,
      op: "upload",
      message_id: Number(sent.id),
      telegram_file_id: fileId,
      file_id: fileId,
      filename,
      bytes: clean.bytes,
      source_bytes: stat.size,
      stripped_id3_bytes: clean.removedBytes,
    };
  } finally {
    clean.cleanup();
  }
}
async function downloadToPath(messageId, output) {
  const active = await ensureFreshTemporarySession();
  const message = await getMessage(messageId); const media = mediaFromMessage(message);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.beatgaler-temp-${process.pid}.part`;
  const fd = fs.openSync(temp, "w"); let bytes = 0;
  try { for await (const chunk of active.downloadAsIterable(media, { stallTimeout: 20_000 })) { fs.writeSync(fd, chunk); bytes += chunk.byteLength; } } finally { fs.closeSync(fd); }
  try { fs.unlinkSync(output); } catch {} fs.renameSync(temp, output);
  return bytes;
}
async function download(command) {
  const output = path.resolve(String(command.output || "")); if (!output) throw new Error("Download output path is required.");
  const bytes = await downloadToPath(Number(command.message_id || 0), output);
  return { ok: true, op: "download", bytes, total: bytes };
}
async function downloadRange(command) {
  const output = path.resolve(String(command.output || ""));
  const start = Math.max(0, Number(command.start || 0)); const length = Math.max(1, Number(command.length || 512 * 1024));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) throw new Error("Invalid range request.");
  const active = await ensureFreshTemporarySession(); const message = await getMessage(Number(command.message_id || 0)); const media = mediaFromMessage(message);
  const aligned = start - (start % 4096); const skip = start - aligned; const controller = new AbortController(); let collected = Buffer.alloc(0);
  try {
    for await (const chunk of active.downloadAsIterable(media, { offset: aligned, abortSignal: controller.signal, stallTimeout: 20_000 })) {
      collected = Buffer.concat([collected, Buffer.from(chunk)]);
      if (collected.length >= skip + length) { controller.abort(); break; }
    }
  } catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) throw error; }
  const out = collected.subarray(skip, Math.min(collected.length, skip + length)); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, out);
  return { ok: true, op: "download_range", bytes: out.length, total: Number(media.fileSize || start + out.length) };
}
async function probeMedia(command) { await getMessage(Number(command.message_id || 0)); return { ok: true, op: "probe_media", message_id: Number(command.message_id), exists: true }; }
async function getIndex() { const current = await ensureIndex(); return { ok: true, op: "get_index", message_id: Number(current.message?.id || 0), file_id: String(current.message?.media?.fileId || ""), manifest: current.manifest || emptyManifest() }; }
async function replaceIndex(command) {
  const filePath = path.resolve(String(command.path || "")); const next = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (next?.schema !== "beatgaler.telegram.library" || Number(next.version) !== 2) throw new Error("Library index has an unexpected schema.");
  const previous = await getCurrentIndex(); const oldIds = collectBeatIdentityIds(previous?.manifest); const newIds = collectBeatIdentityIds(next);
  if (command.allow_destructive !== true) { const missing = [...oldIds].filter(id => !newIds.has(id)); if (missing.length) throw new Error(`Safety barrier blocked destructive INDEX replacement (${oldIds.size} -> ${newIds.size} beats).`); }
  mergeDeleted(previous?.manifest, next); fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  if (previous?.manifest && JSON.stringify(previous.manifest) === JSON.stringify(next)) return { ok: true, op: "replace_index", message_id: Number(previous.message.id), previous_message_id: Number(previous.message.id), deleted_indexes: 0, deleted_media: 0, cleanup_errors: [], updated: false };
  const sent = await sendDocument(filePath, "beatgaler-library.json", INDEX_CAPTION); const active = await ensureFreshTemporarySession();
  await active.pinMessage({ chatId: Number(session.chat_id), message: Number(sent.id), notify: false });
  const full = await active.getFullChat(Number(session.chat_id)); if (Number(full.pinnedMsgId || 0) !== Number(sent.id)) throw new Error("Could not verify authoritative INDEX pin.");
  const oldId = Number(previous?.message?.id || 0); if (oldId > 0 && oldId !== Number(sent.id)) await active.deleteMessagesById(Number(session.chat_id), [oldId]).catch(() => {});
  let deletedMedia = 0; const previousRefs = collectMediaIds(previous?.manifest); const nextRefs = collectMediaIds(next); const safe = [...oldIds].every(id => newIds.has(id));
  if (safe) for (const id of previousRefs) if (!nextRefs.has(id)) { try { await active.deleteMessagesById(Number(session.chat_id), [id]); deletedMedia += 1; } catch {} }
  const fresh = await getMessage(Number(sent.id)); const fileId = String(fresh?.media?.fileId || `direct:${sent.id}`);
  return { ok: true, op: "replace_index", message_id: Number(sent.id), file_id: fileId, telegram_file_id: fileId, previous_message_id: oldId, deleted_indexes: oldId > 0 ? 1 : 0, deleted_media: deletedMedia, cleanup_errors: [] };
}
async function deleteMessages(ids) {
  const active = await ensureFreshTemporarySession(); const unique = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))]; let deleted = 0; const errors = [];
  for (let offset = 0; offset < unique.length; offset += 100) { const batch = unique.slice(offset, offset + 100); try { await active.deleteMessagesById(Number(session.chat_id), batch); deleted += batch.length; } catch (e) { errors.push(String(e?.message || e)); } }
  return { deleted, errors };
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false }); inputIterator = rl[Symbol.asyncIterator]();
  const bootstrapLine = await inputIterator.next(); if (bootstrapLine.done) throw new Error("Direct transport bootstrap channel closed.");
  const raw = String(bootstrapLine.value || "").trim(); if (!raw.startsWith(BOOT)) throw new Error("Direct transport bootstrap payload is missing.");
  session = JSON.parse(Buffer.from(raw.slice(BOOT.length), "base64").toString("utf8"));
  for (const forbidden of ["bot_token", "telegram_api_id", "telegram_api_hash", "credential_envelope", "bot_api_base"]) if (JSON.stringify(session).includes(`\"${forbidden}\"`)) throw new Error("Permanent transport credentials reached the Desktop helper.");
  if (session.mode !== "galer-direct-temp-mtproto") throw new Error("Desktop Direct requires temporary MTProto authorization.");

  await bindFreshTemporarySession("initial");
  emit({ ok: true, op: "listening", session_id: session.session_id, transport_id: session.transport_id });
  await nextControlCommand("activate_ready");
  let access = null; const started = Date.now(); let attempt = 0;
  while (!access) { attempt += 1; try { access = await (await ensureFreshTemporarySession()).getChat(Number(session.chat_id)); } catch (error) { if (Date.now() - started >= 30_000) throw error; await sleep(Math.min(2000, 250 * (2 ** Math.min(attempt - 1, 3)))); } }
  const current = await ensureIndex();
  emit({ ok: true, op: "ready", session_id: session.session_id, transport_id: session.transport_id, generation: session.generation, credential_version: session.credential_version, index_message_id: Number(current?.message?.id || 0), beat_count: Array.isArray(current?.manifest?.beats) ? current.manifest.beats.length : 0, mode: "temp-mtproto" });

  let closing = false;
  while (!closing) {
    const next = await inputIterator.next(); if (next.done) break; const line = String(next.value || ""); if (!line.trim()) continue;
    let command; try { command = JSON.parse(line); } catch { fail("Invalid direct transport command JSON."); continue; }
    const requestId = command.request_id || null; const op = String(command.op || "").toLowerCase();
    try {
      let result;
      switch (op) {
        case "upload": result = await upload(command); break;
        case "download": result = await download(command); break;
        case "download_range": result = await downloadRange(command); break;
        case "probe_media": result = await probeMedia(command); break;
        case "get_index": result = await getIndex(); break;
        case "replace_index": result = await replaceIndex(command); break;
        case "delete_messages": result = { ok: true, op, ...(await deleteMessages(command.message_ids || [])) }; break;
        case "ping": await ensureFreshTemporarySession(); result = { ok: true, op: "pong", temp_expires_at: tempExpiresAt }; break;
        case "shutdown": result = { ok: true, op: "shutdown" }; closing = true; break;
        default: throw new Error(`Unsupported Direct operation: ${command.op}`);
      }
      emit({ ...result, request_id: requestId });
    } catch (error) { fail(error, { request_id: requestId }); }
  }
  rl.close(); await client?.destroy().catch(() => {});
}

main().catch(error => { fail(error); process.exitCode = 1; });
