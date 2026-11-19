'use strict';
// E77 — Doble del NAVEGADOR para sembrar archivos en las pruebas de integración: el único transporte de archivos es Direct B
// (ticket del servidor → envío del navegador a Telegram → recibo). El «navegador» es un cliente de operador sobre el Telegram fake; el Cloud
// (módulos reales) nunca ve los bytes. Conserva la forma en dos pasos que usaban las pruebas (`issueUploadCapability` + `uploadPart`): el primero
// pide el ticket y el segundo hace el envío directo y entrega el recibo.
const crypto = require('crypto');
const { createCatalogDirect } = require('../../catalog/direct.js');

function createDirectSeeder({ pool, authority, operations, browser, resolveProjectAccess = async () => ({ maxBytes: 2_000_000_000 }) } = {}) {
  if (!browser || typeof browser.sendPart !== 'function') throw new Error('createDirectSeeder requires a browser double with sendPart');
  const direct = createCatalogDirect({ pool, authority, operations, resolveProjectAccess });
  const tickets = new Map();
  const readAll = async (stream) => { const chunks = []; for await (const c of stream) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };

  async function issueUploadCapability({ userId, era, epoch, operationId, partKey } = {}) {
    const t = await direct.issueSendTicket({ userId, era, epoch, operationId, partKey });
    const token = crypto.randomBytes(32).toString('base64url');
    tickets.set(token, t);
    return { token, operationId, partKey, attempt: t.attempt, declaredSize: String(t.size), declaredSha256: t.declaredSha256, singleUse: true };
  }
  async function uploadPart({ userId, era, epoch, token, stream } = {}) {
    const t = tickets.get(token); if (!t) throw Object.assign(new Error('unknown ticket'), { code: 'CAPABILITY_INVALID', status: 403 });
    tickets.delete(token);
    const hdr = { userId, era, epoch }; const bytes = await readAll(stream);
    if (bytes.length !== t.size) { // el navegador comprueba el tamaño ANTES de enviar: sin efecto, se informa y no se reenvía con otros bytes
      await direct.reportSend({ ...hdr, operationId: t.operationId, partKey: t.partKey, attempt: t.attempt, outcome: 'UPLOAD_FAILED', code: 'BYTES_MISMATCH' });
      throw Object.assign(new Error('declared size mismatch'), { code: 'PART_BYTES_MISMATCH', status: 409, detail: { declared: String(t.size), received: bytes.length } });
    }
    const sent = await browser.sendPart({ operationId: t.operationId, partKey: t.partKey, randomId: t.randomId, chatId: t.chatId, file: { name: t.filename, size: bytes.length, buffer: bytes }, mimeType: t.mime, fileName: t.filename });
    const body = await direct.submitReceipt({ ...hdr, operationId: t.operationId, partKey: t.partKey, attempt: t.attempt, receipt: { messageId: sent.messageId, documentId: sent.documentId ?? null, size: sent.size, senderId: sent.senderId, chatId: sent.chatId } });
    return { status: 200, body, sent };
  }
  return Object.freeze({ direct, issueUploadCapability, uploadPart, listAttempts: (a) => direct.listAttempts(a) });
}

module.exports = { createDirectSeeder };
