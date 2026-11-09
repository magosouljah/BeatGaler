'use strict';
// T11 — Servidor Telegram fake con la forma de gramjs (`client.invoke(request)`, `client.uploadFile`). Modela SOLO lo que el
// contrato de envío necesita y deja como PARÁMETRO (dedupWindowMs, legacyCanDelete) lo que el sandbox real debe demostrar.
// Sin red. Varias "sesiones" comparten el estado del servidor; la revocación de un bot cierra todas sus sesiones (hipótesis a probar).
const crypto = require('crypto');
const fs = require('fs');

function rpcError(errorMessage, code, extra = {}) { const e = new Error(errorMessage); e.errorMessage = errorMessage; e.code = code; return Object.assign(e, extra); }
function netError(message, code) { return Object.assign(new Error(message), { code }); }
const peerKey = (peer) => peer?.className === 'InputPeerChannel' ? `channel:${String(peer.channelId)}` : peer?.className === 'InputPeerUser' ? `user:${String(peer.userId)}` : 'self';

function createFakeTelegramServer({ dedupWindowMs = null, legacyCanDelete = true, clock = () => Date.now() } = {}) {
  const state = { messages: [], nextId: 1000, nextDocId: 5000, uploads: new Map(), revokedBots: new Set(), counters: { sends: 0, searches: 0, gets: 0, deletes: 0, uploads: 0, effects: 0 } };

  function mkMessage({ peer, request, upload, selfId }) {
    const id = state.nextId++;
    const m = { className: 'Message', id, out: true, fromId: { className: 'PeerUser', userId: selfId }, peer: peerKey(peer), message: request.message, date: Math.floor(clock() / 1000), media: { className: 'MessageMediaDocument', document: { className: 'Document', id: String(state.nextDocId++), size: upload.size, sha256: upload.sha256, attributes: [{ className: 'DocumentAttributeFilename', fileName: upload.name }] } }, randomId: request.randomId.toString(), deleted: false };
    state.messages.push(m); state.counters.effects++;
    return m;
  }

  function session({ selfId = '20' } = {}) {
    const scripts = [];
    const nextFault = () => scripts.shift();
    const self = String(selfId);
    const client = {
      selfId: self,
      script(fault) { scripts.push(fault); return client; },
      async uploadFile({ file } = {}) {
        if (state.revokedBots.has(self)) throw rpcError('AUTH_KEY_UNREGISTERED', 401);
        const bytes = Buffer.isBuffer(file?.buffer) ? file.buffer : typeof file?.path === 'string' ? fs.readFileSync(file.path) : Buffer.from(file?.buffer || '');
        const id = String(state.uploads.size + 1); state.counters.uploads++;
        state.uploads.set(id, { name: String(file?.name || 'file.bin'), size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        return { className: 'InputFile', id: { toString: () => id }, parts: 1, name: String(file?.name || 'file.bin'), md5Checksum: '' };
      },
      async invoke(request) {
        if (state.revokedBots.has(self)) throw rpcError('AUTH_KEY_UNREGISTERED', 401);
        const cls = request && request.className;
        if (cls === 'messages.SendMedia') {
          state.counters.sends++;
          const f = nextFault();
          if (f?.type === 'flood') throw rpcError(`FLOOD_WAIT_${f.seconds}`, 420, { seconds: f.seconds });
          if (f?.type === 'forbidden') throw rpcError('CHAT_WRITE_FORBIDDEN', 403);
          if (f?.type === 'disconnectBeforeEffect') throw netError('Not connected', 'ECONNRESET');
          const upload = state.uploads.get(request.media?.file?.id?.toString());
          if (!upload) throw rpcError('FILE_PART_0_MISSING', 400);
          const rid = request.randomId.toString();
          let m = null;
          if (dedupWindowMs != null) m = state.messages.find((x) => x.randomId === rid && !x.deleted && x.fromId.userId === self && clock() - x.date * 1000 <= dedupWindowMs) || null;
          if (!m) m = mkMessage({ peer: request.peer, request, upload, selfId: self });
          if (f?.type === 'loseResponse') throw netError('Timeout', 'ETIMEDOUT');
          if (f?.type === 'pause') await f.gate;
          return { className: 'Updates', updates: [{ className: 'UpdateMessageID', id: m.id, randomId: request.randomId }, { className: 'UpdateNewChannelMessage', message: m }] };
        }
        if (cls === 'messages.Search') {
          state.counters.searches++;
          const pk = peerKey(request.peer);
          const from = request.fromId?.userId != null ? String(request.fromId.userId) : null;
          const ms = state.messages.filter((m) => m.peer === pk && !m.deleted && typeof m.message === 'string' && m.message.includes(request.q) && (!from || m.fromId.userId === from));
          return { className: 'messages.ChannelMessages', messages: ms.slice(0, request.limit || 20), count: ms.length };
        }
        if (cls === 'messages.GetMessages' || cls === 'channels.GetMessages') {
          state.counters.gets++;
          const ids = (request.id || []).map((x) => Number(x.id));
          return { className: 'messages.ChannelMessages', messages: state.messages.filter((m) => ids.includes(m.id) && !m.deleted) };
        }
        if (cls === 'messages.DeleteMessages' || cls === 'channels.DeleteMessages') {
          state.counters.deletes++;
          if (!legacyCanDelete) throw rpcError('MESSAGE_DELETE_FORBIDDEN', 403);
          const ids = (request.id || []).map(Number); let n = 0;
          for (const m of state.messages) if (ids.includes(m.id) && !m.deleted) { m.deleted = true; n++; }
          return { className: 'messages.AffectedMessages', ptsCount: n };
        }
        throw rpcError('METHOD_NOT_SUPPORTED_BY_FAKE', 400);
      },
    };
    return client;
  }

  return Object.freeze({
    session,
    revokeBot(selfId) { state.revokedBots.add(String(selfId)); },
    messages() { return state.messages.filter((m) => !m.deleted).map((m) => ({ id: m.id, peer: m.peer, randomId: m.randomId, caption: m.message, size: m.media.document.size, fileName: m.media.document.attributes[0].fileName, sender: m.fromId.userId })); },
    counters() { return { ...state.counters }; },
    dedupWindowMs,
  });
}

module.exports = { createFakeTelegramServer, rpcError, netError };
