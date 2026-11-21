'use strict';
// E77 — Lectura y envío de BYTES de archivos en Telegram. FUERA del Cloud: este módulo no lo carga server.js, server-core.js,
// catalog-worker.js ni ningún módulo de cloud-server/catalog (lo comprueba catalog-contract.test.cjs). El Cloud solo coordina metadatos; los
// archivos viajan navegador ↔ Telegram por Direct B. Consumidores legítimos:
//   - herramienta local de operador que verifica por hash los bytes de un backup/restore (scripts/backup/verify-bytes.cjs → catalog/backup.js);
//   - el doble de «navegador Direct B» de las pruebas de integración y del LAB (el navegador real usa mtcute en su Worker);
//   - el runner de sandbox T11 (experimentos de identidad de envío con el proveedor).
// Misma clasificación fail-closed y mismas peticiones TL que usaba el gateway (gramjs 2.26.x); el SDK y el cliente se inyectan.
const g = require('../catalog/transport-gateway');
const { GatewayError } = g;

function buildSendMedia(sdk, { peer, inputFile, mimeType, fileName, caption, randomId, silent = true } = {}) {
  const { Api, bigInt } = sdk;
  if (!peer || !inputFile) throw new GatewayError('SEND_INPUT_INVALID', 'peer and inputFile are required', { transient: false });
  if (typeof fileName !== 'string' || !fileName) throw new GatewayError('SEND_INPUT_INVALID', 'fileName is required', { transient: false });
  if (!g.parseCaption(caption) && !g.PACK_CAPTION_RE.test(String(caption))) throw new GatewayError('CAPTION_INVALID', 'caption must be a catalog:v1 marker', { transient: false });
  return new Api.messages.SendMedia({
    peer,
    media: new Api.InputMediaUploadedDocument({ file: inputFile, mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream', attributes: [new Api.DocumentAttributeFilename({ fileName })], forceFile: true }),
    message: caption,
    randomId: g.randomIdToLong(randomId, bigInt),
    silent: Boolean(silent),
  });
}

function createTelegramFileIo({ client, sdk, senderId, resolvePeer } = {}) {
  if (!client || typeof client.invoke !== 'function') throw new GatewayError('CLIENT_INVALID', 'client.invoke is required', { transient: false });
  if (!sdk || !sdk.Api || typeof sdk.bigInt !== 'function') throw new GatewayError('SDK_INVALID', 'sdk { Api, bigInt } is required', { transient: false });
  if (typeof resolvePeer !== 'function') throw new GatewayError('PEER_RESOLVER_INVALID', 'resolvePeer(chatId) is required', { transient: false });
  if (senderId == null || !/^[0-9]{1,20}$/.test(String(senderId))) throw new GatewayError('SENDER_INVALID', 'senderId must be the numeric Telegram id of the sending bot', { transient: false });
  const sid = String(senderId);
  const metrics = { sends: 0, downloads: 0, uncertain: 0 };
  const failFromProvider = (error, stage) => {
    const c = g.classifyError(error);
    const code = c.kind === 'REVOKED' ? 'CREDENTIAL_REVOKED' : c.kind === 'PERMANENT' ? `${stage}_REJECTED_PERMANENT` : c.kind === 'REJECTED' ? `${stage}_REJECTED` : `${stage}_UNCERTAIN`;
    if (code === `${stage}_UNCERTAIN`) metrics.uncertain++;
    return new GatewayError(code, `${stage}: ${c.code}`, { classification: c, transient: c.transient, retryAfterMs: c.retryAfterMs, status: c.kind === 'PERMANENT' || c.kind === 'REVOKED' ? 403 : undefined, resend: false });
  };

  // Envío de un documento con una identidad (random_id + marcador) que el llamador persistió ANTES. Nunca reenvía por iniciativa propia.
  async function sendDocument({ caption, randomId, chatId, file, mimeType, fileName } = {}) {
    g.randomIdToLong(randomId, sdk.bigInt);
    const { peer } = await resolvePeer(chatId);
    let inputFile;
    const upload = sdk.CustomFile && file && typeof file === 'object' && typeof file.path === 'string' && !(file instanceof sdk.CustomFile) ? new sdk.CustomFile(file.name, file.size, file.path) : file;
    try { inputFile = await client.uploadFile({ file: upload, workers: 1 }); } catch (error) {
      // La subida de partes no crea mensajes: fallar aquí nunca es incierto respecto al envío.
      const c = g.classifyError(error);
      throw new GatewayError(c.kind === 'REVOKED' ? 'CREDENTIAL_REVOKED' : 'UPLOAD_FAILED', `upload: ${c.code}`, { classification: { ...c, effectPossible: false }, transient: c.kind !== 'REVOKED' && c.kind !== 'PERMANENT', retryAfterMs: c.retryAfterMs, resend: false });
    }
    const request = buildSendMedia(sdk, { peer, inputFile, mimeType, fileName, caption, randomId });
    metrics.sends++;
    let result;
    try { result = await client.invoke(request); } catch (error) { throw failFromProvider(error, 'SEND'); }
    const receipt = g.receiptFromUpdates(result, { randomId });
    if (!receipt) { metrics.uncertain++; throw new GatewayError('SEND_UNCERTAIN', 'send response carried no message id for this random_id', { classification: { kind: 'UNCERTAIN', action: 'RECONCILE', code: 'NO_MESSAGE_ID', retryAfterMs: 60_000, effectPossible: true, transient: true, evidence: 'ASSUMED' }, transient: true, retryAfterMs: 60_000, resend: false }); }
    return { messageId: receipt.messageId, documentId: receipt.documentId, size: receipt.size, senderId: sid, chatId: String(chatId), randomId, complete: receipt.complete };
  }
  /** Parte de una operación C7 (marcador `catalog:v1 op=… part=…`). */
  const sendPart = ({ operationId, partKey, ...rest } = {}) => sendDocument({ ...rest, caption: g.captionFor({ operationId, partKey }) });

  // Bytes de un mensaje por rangos: devuelve un iterable de trozos del SDK. "No encontrado" no prueba borrado (C9).
  async function downloadPart({ chatId, messageId, offset = 0, limit = null, requestSize = 512 * 1024 } = {}) {
    if (typeof client.iterDownload !== 'function') throw new GatewayError('DOWNLOAD_UNSUPPORTED', 'client.iterDownload is required', { transient: false });
    const { peer, channel } = await resolvePeer(chatId);
    let res;
    try { res = await client.invoke(g.buildGetMessages(sdk, { peer, messageId, channel: Boolean(channel) })); } catch (error) { throw failFromProvider(error, 'DOWNLOAD'); }
    const id = g.toInt(messageId);
    const msg = (Array.isArray(res && res.messages) ? res.messages : []).find((m) => m && g.toInt(m.id) === id && m.media && m.media.document);
    if (!msg) throw new GatewayError('PROVIDER_MESSAGE_NOT_FOUND', 'the provider has no document message with that id', { transient: false, status: 404 });
    metrics.downloads++;
    // gramjs (iterDownload real): `offset` es un BigInteger y `limit` cuenta TROZOS (peticiones de requestSize), no bytes; el iterador multi-trozo
    // de gramjs 2.26 repetía el primer trozo (hallazgo de la prueba integrada real, 2026-11-17). Se pide UN trozo alineado por iterador, se
    // recorta el primero al `offset` solicitado y se detiene al cubrir `limit` bytes.
    const reqSize = Number(requestSize) > 0 ? Math.floor(Number(requestSize) / 4096) * 4096 || 4096 : 512 * 1024;
    const startAt = Math.max(0, Math.trunc(Number(offset) || 0));
    const wanted = limit == null ? Infinity : Math.max(1, Math.trunc(Number(limit)));
    const toBig = (n) => sdk.bigInt(String(n));
    async function* chunks() {
      let aligned = Math.floor(startAt / reqSize) * reqSize; let skip = startAt - aligned; let delivered = 0;
      while (delivered < wanted) {
        let got = null;
        for await (const piece of client.iterDownload({ file: msg.media, offset: toBig(aligned), limit: 1, requestSize: reqSize })) { got = piece; break; }
        if (!got || !got.length) return;
        const body = skip ? got.subarray(skip) : got; const short = got.length < reqSize;
        const out = delivered + body.length > wanted ? body.subarray(0, wanted - delivered) : body;
        if (out.length) { delivered += out.length; yield out; }
        if (short) return;
        aligned += reqSize; skip = 0;
      }
    }
    return chunks();
  }
  return Object.freeze({ sendDocument, sendPart, downloadPart, metrics, senderId: sid });
}


// Cliente completo para herramientas de operador, sandbox T11 y dobles de prueba: los RPC de metadatos del gateway MÁS la lectura/envío de bytes
// sobre la misma sesión. Nunca se monta en el Cloud (que solo usa createTelegramGateway).
function createOperatorTelegram(options = {}) {
  const gateway = g.createTelegramGateway(options); const io = createTelegramFileIo(options);
  return Object.freeze({ ...gateway, sendDocument: io.sendDocument, sendPart: io.sendPart, downloadPart: io.downloadPart, ioMetrics: io.metrics });
}
module.exports = Object.freeze({ buildSendMedia, createTelegramFileIo, createOperatorTelegram });
