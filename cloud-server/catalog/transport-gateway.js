'use strict';
// T11 — Adaptador preciso del contrato de envío Telegram para el gateway de medios (NATIVO r2.1 §8.6; CONTRATO C7.3–C7.8 y C10).
// Sin red propia y sin importar el SDK: recibe `sdk = { Api, bigInt }` (gramjs `telegram` 2.26.x + `big-integer`) y un `client`
// con `invoke(request)` / `uploadFile(...)`. Toda credencial vive en el proceso del gateway; ningún cliente nativo la recibe.
// Evidencia: hasta que exista sandbox autorizado (G2), toda regla marcada ASSUMED es una hipótesis fail-closed, no una garantía.
const crypto = require('crypto');

class GatewayError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'GatewayError'; this.code = code; Object.assign(this, extra); }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const RANDOM_ID_RE = /^-?(0|[1-9][0-9]{0,18})$/;
const PART_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CAPTION_PREFIX = 'catalog:v1';
const CAPTION_RE = /^catalog:v1 op=([A-Za-z0-9_-]{1,80}) part=([A-Za-z0-9_-]{1,64})$/;

const SDK_CONTRACT = Object.freeze({
  package: 'telegram',
  versionRange: '2.26.x',
  long: 'big-integer BigInteger: int64 con signo, 8 bytes little-endian en el TL',
  requests: Object.freeze(['messages.SendMedia', 'messages.Search', 'messages.GetMessages', 'channels.GetMessages']),
  caption: `${CAPTION_PREFIX} op=<operationId> part=<partKey>`,
  randomIdVisibility: 'random_id solo aparece en la respuesta del envío (UpdateMessageID); un Message no lo conserva. La reconciliación posterior busca por caption + remitente + tamaño.',
});

// C7.8: reenviar una parte cuyo envío quedó incierto está prohibido hasta que T11 demuestre en sandbox real la deduplicación por
// random_id para esa identidad, SDK y sesión. Un error RPC explícito es la respuesta a esa petición (no hubo efecto): se puede
// repetir con la misma identidad tras la espera (ASSUMED por protocolo; se confirma en sandbox). Una respuesta perdida pudo tener
// efecto: RECONCILE, nunca reenvío.
const RESEND_POLICY = Object.freeze({ uncertain: 'BLOCKED', afterExplicitRejection: 'RETRY_SAME_IDENTITY', evidence: 'NONE_REAL', provenance: 'T11 fase A (fakes); G2 pendiente' });

// Tabla de errores RPC → clase y acción. Patrones sobre `errorMessage` de gramjs (RPCError) o `code`/`message` de errores de red.
const ERROR_TABLE = Object.freeze([
  { re: /^FLOOD_WAIT_(\d+)$/, kind: 'REJECTED', action: 'RETRY_SAME_IDENTITY_AFTER_WAIT' },
  { re: /^SLOWMODE_WAIT_(\d+)$/, kind: 'REJECTED', action: 'RETRY_SAME_IDENTITY_AFTER_WAIT' },
  { re: /^(FILE_REFERENCE_EXPIRED|FILE_PART_\d+_MISSING|FILE_PARTS_INVALID|FILE_PART_INVALID|FILE_PART_SIZE_INVALID|MEDIA_EMPTY|[A-Z_]+_MIGRATE_\d+)$/, kind: 'REJECTED', action: 'RETRY_SAME_IDENTITY_AFTER_REUPLOAD' },
  { re: /^RANDOM_ID_DUPLICATE$/, kind: 'DUPLICATE_IDENTITY', action: 'RECONCILE' },
  { re: /^(CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|CHAT_SEND_MEDIA_FORBIDDEN|CHAT_RESTRICTED|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|CHAT_ID_INVALID|INPUT_USER_DEACTIVATED|MESSAGE_TOO_LONG|MEDIA_INVALID|DOCUMENT_INVALID|MEDIA_CAPTION_TOO_LONG|TOPIC_CLOSED|TOPIC_DELETED|MSG_ID_INVALID|MESSAGE_ID_INVALID|MESSAGE_DELETE_FORBIDDEN)$/, kind: 'PERMANENT', action: 'BLOCK' },
  { re: /^(AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_PERM_EMPTY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|USER_DEACTIVATED_BAN|API_ID_INVALID|ACTIVE_USER_REQUIRED|BOT_INVALID)$/, kind: 'REVOKED', action: 'FENCE_REVOKED' },
]);
const UNCERTAIN_RE = /(ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|TIMEOUT|TIMED ?OUT|NOT CONNECTED|DISCONNECT|RPC_CALL_FAIL|RPC_MCGET_FAIL|INTERNAL|MSG_WAIT_FAILED|WORKER_BUSY|-503)/i;

function toInt(v) { if (v == null) return null; const n = Number(typeof v === 'object' ? v.toString() : v); return Number.isSafeInteger(n) ? n : null; }
function longToText(v) { if (v == null) return null; const s = typeof v === 'object' ? v.toString() : String(v); return RANDOM_ID_RE.test(s) ? s : null; }

function randomIdToLong(text, bigInt) {
  if (typeof text !== 'string' || !RANDOM_ID_RE.test(text)) throw new GatewayError('RANDOM_ID_INVALID', 'random_id must be a signed int64 in decimal text', { transient: false });
  const v = BigInt(text);
  if (v < INT64_MIN || v > INT64_MAX) throw new GatewayError('RANDOM_ID_INVALID', 'random_id out of int64 range', { transient: false });
  return bigInt(text);
}
// Identidad de envío nueva (C7.3): int64 con signo uniforme, en texto, para persistir ANTES de cualquier efecto.
function newRandomId() { return crypto.randomBytes(8).readBigInt64BE(0).toString(); }

function captionFor({ operationId, partKey } = {}) {
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) throw new GatewayError('OPERATION_ID_INVALID', 'operationId is required for the caption marker', { transient: false });
  if (typeof partKey !== 'string' || !PART_KEY_RE.test(partKey)) throw new GatewayError('PART_KEY_INVALID', 'partKey is required for the caption marker', { transient: false });
  return `${CAPTION_PREFIX} op=${operationId} part=${partKey}`;
}
function parseCaption(text) { const m = typeof text === 'string' ? CAPTION_RE.exec(text.trim()) : null; return m ? { operationId: m[1], partKey: m[2] } : null; }

// ---------- Peticiones TL exactas (gramjs 2.26.x) ----------
function buildSendMedia(sdk, { peer, inputFile, mimeType, fileName, caption, randomId, silent = true } = {}) {
  const { Api, bigInt } = sdk;
  if (!peer || !inputFile) throw new GatewayError('SEND_INPUT_INVALID', 'peer and inputFile are required', { transient: false });
  if (typeof fileName !== 'string' || !fileName) throw new GatewayError('SEND_INPUT_INVALID', 'fileName is required', { transient: false });
  if (!parseCaption(caption)) throw new GatewayError('CAPTION_INVALID', 'caption must be the catalog:v1 marker', { transient: false });
  return new Api.messages.SendMedia({
    peer,
    media: new Api.InputMediaUploadedDocument({ file: inputFile, mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream', attributes: [new Api.DocumentAttributeFilename({ fileName })], forceFile: true }),
    message: caption,
    randomId: randomIdToLong(randomId, bigInt),
    silent: Boolean(silent),
  });
}
function buildSearch(sdk, { peer, fromId, caption, limit = 20, minDate = 0, maxDate = 0 } = {}) {
  const { Api, bigInt } = sdk;
  if (!peer) throw new GatewayError('SEARCH_INPUT_INVALID', 'peer is required', { transient: false });
  if (!parseCaption(caption)) throw new GatewayError('CAPTION_INVALID', 'caption must be the catalog:v1 marker', { transient: false });
  const lim = Math.min(Math.max(1, Number(limit) | 0), 100);
  return new Api.messages.Search({ peer, q: caption, fromId: fromId || undefined, filter: new Api.InputMessagesFilterDocument(), minDate: Number(minDate) | 0, maxDate: Number(maxDate) | 0, offsetId: 0, addOffset: 0, limit: lim, maxId: 0, minId: 0, hash: bigInt(0) });
}
function buildGetMessages(sdk, { peer, messageId, channel = false } = {}) {
  const { Api } = sdk;
  const id = toInt(messageId);
  if (!id || id <= 0) throw new GatewayError('MESSAGE_ID_INVALID', 'messageId must be a positive integer', { transient: false });
  const ids = [new Api.InputMessageID({ id })];
  if (channel) { if (!peer) throw new GatewayError('GET_INPUT_INVALID', 'channel peer is required', { transient: false }); return new Api.channels.GetMessages({ channel: peer, id: ids }); }
  return new Api.messages.GetMessages({ id: ids });
}

// ---------- Clasificación de errores ----------
// gramjs materializa los errores conocidos como subclases (`FloodWaitError` con `seconds`, `FileMigrateError` con `newDc`,
// `ChatWriteForbiddenError`…) cuyo `errorMessage` es la base ('FLOOD'); el nombre de clase se vuelve a convertir al código TL.
function classNameToCode(error) {
  const name = error && error.constructor && typeof error.constructor.name === 'string' ? error.constructor.name : '';
  if (!/^[A-Z][A-Za-z0-9]+Error$/.test(name) || name === 'RPCError' || name === 'Error' || name === 'TypeError') return null;
  const base = name.slice(0, -'Error'.length).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toUpperCase();
  if (Number.isFinite(error.seconds) && /_WAIT$/.test(base)) return `${base}_${Math.max(0, Math.floor(error.seconds))}`;
  if (Number.isFinite(error.newDc) && /_MIGRATE$/.test(base)) return `${base}_${error.newDc}`;
  return base;
}
function classifyError(error) {
  const candidates = [classNameToCode(error), error && error.errorMessage, error && error.code, error && error.message].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  for (const c of candidates) {
    for (const row of ERROR_TABLE) {
      const m = row.re.exec(c);
      if (!m) continue;
      const seconds = m[1] != null && /^\d+$/.test(m[1]) ? Number(m[1]) : (Number.isFinite(error?.seconds) ? Number(error.seconds) : 0);
      const transient = row.kind === 'REJECTED' || row.kind === 'DUPLICATE_IDENTITY';
      return { kind: row.kind, action: row.action, code: c, retryAfterMs: row.action === 'RETRY_SAME_IDENTITY_AFTER_WAIT' ? Math.max(1000, seconds * 1000) : 0, effectPossible: row.kind === 'DUPLICATE_IDENTITY', transient, evidence: 'ASSUMED' };
    }
  }
  const text = candidates.join(' ');
  const uncertain = UNCERTAIN_RE.test(text) || candidates.length === 0;
  // Fail-closed: cualquier error no clasificado se trata como respuesta perdida (el efecto pudo ocurrir).
  return { kind: 'UNCERTAIN', action: 'RECONCILE', code: candidates[0] || 'UNKNOWN', retryAfterMs: 60_000, effectPossible: true, transient: true, evidence: uncertain ? 'ASSUMED' : 'UNCLASSIFIED' };
}

// ---------- Lectura de mensajes del proveedor ----------
function describeMessage(m) {
  if (!m || m.className === 'MessageEmpty' || m.className === 'MessageService') return null;
  const doc = m.media && m.media.document;
  if (!doc || doc.className === 'DocumentEmpty') return null;
  const from = m.fromId && (m.fromId.userId != null ? m.fromId.userId : m.fromId.channelId);
  const fileName = Array.isArray(doc.attributes) ? (doc.attributes.find((a) => a && a.className === 'DocumentAttributeFilename') || {}).fileName ?? null : null;
  return { messageId: toInt(m.id), documentId: longToText(doc.id), size: toInt(doc.size), out: m.out === true, senderId: from != null ? String(from) : null, caption: typeof m.message === 'string' ? m.message : '', date: toInt(m.date), fileName };
}
// Candidatos para reconciliar (C7.7): mismo marcador op/part, mismo remitente (o propio), mismo tamaño declarado.
function matchCandidates(messages, { operationId, partKey, senderId, declaredSize } = {}) {
  const want = captionFor({ operationId, partKey });
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const d = describeMessage(m);
    if (!d || d.caption.trim() !== want) continue;
    if (senderId != null && d.senderId != null && d.senderId !== String(senderId)) continue;
    if (senderId != null && d.senderId == null && !d.out) continue;
    if (Number.isSafeInteger(declaredSize) && d.size !== declaredSize) continue;
    out.push(d);
  }
  return out;
}
// 0 → UNCERTAIN (no demuestra que no se envió); 1 → ADOPT; >1 → AMBIGUOUS (BLOCKED: no elegir ni borrar por intuición).
function reconcileDecision(candidates) { const n = Array.isArray(candidates) ? candidates.length : 0; return n === 0 ? 'UNCERTAIN' : n === 1 ? 'ADOPT' : 'AMBIGUOUS'; }

function receiptFromUpdates(result, { randomId } = {}) {
  if (!result) return null;
  if (result.className === 'UpdateShortSentMessage') { const d = result.media && result.media.document ? describeMessage({ className: 'Message', id: result.id, out: true, media: result.media }) : null; const id = toInt(result.id); return id ? { messageId: id, documentId: d?.documentId ?? null, size: d?.size ?? null, randomId, complete: Boolean(d) } : null; }
  const updates = Array.isArray(result.updates) ? result.updates : (typeof result.className === 'string' && /^Update/.test(result.className) ? [result] : []);
  const idUpd = updates.find((u) => u && u.className === 'UpdateMessageID' && longToText(u.randomId) === randomId);
  const messageId = idUpd ? toInt(idUpd.id) : null;
  const msgUpd = updates.find((u) => u && (u.className === 'UpdateNewMessage' || u.className === 'UpdateNewChannelMessage' || u.className === 'UpdateNewScheduledMessage') && u.message && (messageId == null || toInt(u.message.id) === messageId));
  const d = msgUpd ? describeMessage(msgUpd.message) : null;
  if (messageId == null && !d) return null;
  return { messageId: messageId ?? d.messageId, documentId: d ? d.documentId : null, size: d ? d.size : null, randomId, complete: Boolean(d) };
}

// ---------- Gateway: implementa la interfaz de transporte del worker (T10) ----------
function createTelegramGateway({ client, sdk, senderId, resolvePeer, resolveSenderPeer = null, log = null } = {}) {
  if (!client || typeof client.invoke !== 'function') throw new GatewayError('CLIENT_INVALID', 'client.invoke is required', { transient: false });
  if (!sdk || !sdk.Api || typeof sdk.bigInt !== 'function') throw new GatewayError('SDK_INVALID', 'sdk { Api, bigInt } is required', { transient: false });
  if (typeof resolvePeer !== 'function') throw new GatewayError('PEER_RESOLVER_INVALID', 'resolvePeer(chatId) is required', { transient: false });
  if (senderId == null || !/^[0-9]{1,20}$/.test(String(senderId))) throw new GatewayError('SENDER_INVALID', 'senderId must be the numeric Telegram id of the gateway bot', { transient: false });
  const sid = String(senderId);
  const metrics = { sends: 0, uncertain: 0, rejected: 0, permanent: 0, revoked: 0, verifies: 0, searches: 0 };

  function failFromProvider(error, stage) {
    const c = classifyError(error);
    if (c.kind === 'REVOKED') metrics.revoked++; else if (c.kind === 'PERMANENT') metrics.permanent++; else if (c.kind === 'REJECTED') metrics.rejected++; else metrics.uncertain++;
    const code = c.kind === 'REVOKED' ? 'CREDENTIAL_REVOKED' : c.kind === 'PERMANENT' ? `${stage}_REJECTED_PERMANENT` : c.kind === 'REJECTED' ? `${stage}_REJECTED` : `${stage}_UNCERTAIN`;
    if (log && typeof log.warn === 'function') log.warn('catalog-gateway', { stage, code, kind: c.kind, rpc: c.code });
    return new GatewayError(code, `${stage}: ${c.code}`, { classification: c, transient: c.transient, retryAfterMs: c.retryAfterMs, status: c.kind === 'PERMANENT' || c.kind === 'REVOKED' ? 403 : undefined, resend: false });
  }

  // Envío C7.3–C7.4: identidad persistida ANTES por el llamador (operations.createOperation/markDispatched); aquí solo se ejecuta.
  async function sendPart({ operationId, partKey, randomId, chatId, file, mimeType, fileName } = {}) {
    const caption = captionFor({ operationId, partKey });
    randomIdToLong(randomId, sdk.bigInt);
    const { peer } = await resolvePeer(chatId);
    let inputFile;
    try { inputFile = await client.uploadFile({ file, workers: 1 }); } catch (error) {
      // La subida de partes no crea mensajes: fallar aquí nunca es incierto respecto al envío.
      const c = classifyError(error);
      throw new GatewayError(c.kind === 'REVOKED' ? 'CREDENTIAL_REVOKED' : 'UPLOAD_FAILED', `upload: ${c.code}`, { classification: { ...c, effectPossible: false }, transient: c.kind !== 'REVOKED' && c.kind !== 'PERMANENT', retryAfterMs: c.retryAfterMs, resend: false });
    }
    const request = buildSendMedia(sdk, { peer, inputFile, mimeType, fileName, caption, randomId });
    metrics.sends++;
    let result;
    try { result = await client.invoke(request); } catch (error) { throw failFromProvider(error, 'SEND'); }
    const receipt = receiptFromUpdates(result, { randomId });
    if (!receipt) { metrics.uncertain++; throw new GatewayError('SEND_UNCERTAIN', 'send response carried no message id for this random_id', { classification: { kind: 'UNCERTAIN', action: 'RECONCILE', code: 'NO_MESSAGE_ID', retryAfterMs: 60_000, effectPossible: true, transient: true, evidence: 'ASSUMED' }, transient: true, retryAfterMs: 60_000, resend: false }); }
    return { messageId: receipt.messageId, documentId: receipt.documentId, size: receipt.size, senderId: sid, chatId: String(chatId), randomId, complete: receipt.complete };
  }

  // Verificación del proveedor independiente del recibo (C7.4–C7.5). sha256 remoto no se calcula aquí (bytes no descargados).
  async function verifyMessage({ chatId, messageId, senderId: expectedSender = sid } = {}) {
    const { peer, channel } = await resolvePeer(chatId);
    metrics.verifies++;
    let res;
    try { res = await client.invoke(buildGetMessages(sdk, { peer, messageId, channel: Boolean(channel) })); } catch (error) { throw failFromProvider(error, 'VERIFY'); }
    const id = toInt(messageId);
    const d = (Array.isArray(res && res.messages) ? res.messages : []).map(describeMessage).find((x) => x && x.messageId === id);
    if (!d) throw new GatewayError('PROVIDER_MESSAGE_NOT_FOUND', 'the provider has no document message with that id', { transient: false, status: 404 });
    if (expectedSender != null && d.senderId != null && d.senderId !== String(expectedSender)) throw new GatewayError('PROVIDER_SENDER_MISMATCH', 'the message was not sent by the expected bot', { transient: false, status: 409 });
    return { size: d.size, sha256: null, provider: 'telegram', messageId: d.messageId, documentId: d.documentId, fileName: d.fileName };
  }

  // Reconciliación (C7.7): búsqueda por marcador caption + remitente + tamaño. random_id no es consultable a posteriori (SDK_CONTRACT).
  async function searchByRandomId({ chatId, senderId: expectedSender = sid, declaredSize, operationId, partKey } = {}) {
    if (!operationId || !partKey) throw new GatewayError('RECONCILE_IDENTITY_INCOMPLETE', 'operationId and partKey are required to reconcile', { transient: false });
    const caption = captionFor({ operationId, partKey });
    const { peer } = await resolvePeer(chatId);
    const fromId = typeof resolveSenderPeer === 'function' ? await resolveSenderPeer(expectedSender) : undefined;
    metrics.searches++;
    let res;
    try { res = await client.invoke(buildSearch(sdk, { peer, fromId, caption, limit: 20 })); } catch (error) { throw failFromProvider(error, 'SEARCH'); }
    const size = Number.isSafeInteger(declaredSize) ? declaredSize : Number(declaredSize);
    return matchCandidates(res && res.messages, { operationId, partKey, senderId: expectedSender, declaredSize: Number.isSafeInteger(size) ? size : undefined }).map((c) => ({ messageId: c.messageId, documentId: c.documentId, size: c.size, sha256: null }));
  }

  return Object.freeze({ sendPart, verifyMessage, searchByRandomId, metrics, senderId: sid, SDK_CONTRACT, RESEND_POLICY });
}

module.exports = Object.freeze({
  GatewayError, SDK_CONTRACT, RESEND_POLICY, ERROR_TABLE, CAPTION_PREFIX,
  newRandomId, randomIdToLong, longToText, toInt, captionFor, parseCaption,
  buildSendMedia, buildSearch, buildGetMessages, classifyError,
  describeMessage, matchCandidates, reconcileDecision, receiptFromUpdates,
  createTelegramGateway,
});
