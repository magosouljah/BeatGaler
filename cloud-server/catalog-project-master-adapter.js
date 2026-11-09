'use strict';
// T12 — Adaptador MASTER para PROJECT del catálogo nativo (CONTRATO C7 §PROJECT; NATIVO r2.1 §8.6). Glue entre catalog/transport.js
// (que solo conoce la interfaz { resolveSenderId, publishProjectFile }) y el transporte MASTER existente (direct-transport-control).
// No cambia transporte ni permisos de PROJECT: la ruta legacy /transport/project/upload sigue intacta. El caption es el marcador
// catalog:v1 para que la reconciliación del gateway (bot) pueda encontrar el mensaje por op/part + remitente + tamaño.
// Fail-closed: cualquier error tras invocar la publicación se trata como incierto (sin `effectPossible=false`) salvo que el transporte
// lo marque explícitamente; el transporte del catálogo encola entonces TRANSFER_RECONCILE y nunca reenvía.
// Este adaptador no está probado contra el proveedor real en T12 (pendiente de integración real: sandbox T11 fase B / T16).

function createMasterProjectAdapter({ control = null } = {}) {
  const c = control || require('./direct-transport-control');
  if (typeof c.publishProjectFile !== 'function' || typeof c.masterSenderId !== 'function') throw new Error('MASTER control with publishProjectFile and masterSenderId is required');
  return Object.freeze({
    async resolveSenderId({ chatId }) {
      try { return await c.masterSenderId(chatId); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { effectPossible: false }); }
    },
    async publishProjectFile({ chatId, filePath, filename, caption, sizeBytes, sha256, beatId }) {
      const sent = await c.publishProjectFile({ chatId, filePath, filename, beatId, sha256, sizeBytes, caption });
      return { messageId: Number(sent?.messageId), documentId: sent?.documentId != null ? String(sent.documentId) : null, senderId: sent?.senderId != null ? String(sent.senderId) : null, sizeBytes: Number.isSafeInteger(sent?.sizeBytes) ? sent.sizeBytes : null };
    },
  });
}

module.exports = { createMasterProjectAdapter };
