import { createHash } from 'node:crypto';
import { FramedWriter } from '@fuman/io';

// Test-only probes installed in the isolated Test A worker. Never imported by
// production. The sole routing mutation is kind:'download' for message 101 in
// the separate-connection experiment; no mtcute package file is changed.
export function installTestD(TelegramClient, SessionConnection, emit, {
  route101 = 'main', order = null, offsetMs = 0, testEWriter = 'shared',
  captureBytes = null, observeIncoming = false,
} = {}) {
  const documentIds = new Map();
  const mediaByMessage = new Map();
  const pendingMeta = new WeakMap();
  const connMeta = new WeakMap();
  const socketIds = new WeakMap();
  const packetMeta = new WeakMap();
  const encoded = [];
  const cipherUnits = [];
  const writerSlots = new WeakMap();
  const patchedEncryptors = new WeakSet();
  const connectionsByUid = new Map();
  let client = null, context = null, nextConnId = 0, nextSocketId = 0;
  let nextRpcId = 0, nextPacketId = 0, nextWsSendId = 0, gate = null;
  let activeWriterMode = testEWriter;
  const now = () => performance.timeOrigin + performance.now();
  const id = value => value == null ? null : String(value);
  const trace = (stage, fields = {}) => { try { emit({ stage, ...fields }); } catch {} };
  const bytes = value => value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  const same = (a, b) => a?.byteLength === b?.byteLength && a.every((value, index) => value === b[index]);
  const shortHash = value => value == null ? null : createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
  const poolOf = connection => {
    const network = client?._client?.mt?.network;
    for (const dc of network?._dcConnections?.values?.() || []) {
      for (const kind of ['main', 'download', 'downloadSmall', 'upload']) {
        const index = dc[kind]?._connections?.indexOf(connection) ?? -1;
        if (index >= 0) return { dc_id: dc.dcId, pool_kind: kind, pool_index: index,
          pool_size: dc[kind]._connections.length };
      }
    }
    return { dc_id: network?._primaryDc?.dcId ?? null, pool_kind: null, pool_index: null, pool_size: null };
  };
  const socketOf = connection => {
    const socket = connection._fuman?.connection?.socket;
    if (!socket) return { socket: null, socket_id: null };
    let socketId = socketIds.get(socket);
    if (!socketId) {
      socketId = ++nextSocketId;
      socketIds.set(socket, socketId);
      trace('D_SOCKET_SEEN', { ...identity(connection), socket_id: socketId,
        ready_state: socket.readyState ?? null });
    }
    return { socket, socket_id: socketId };
  };
  const identity = connection => {
    let state = connMeta.get(connection);
    if (!state) {
      state = { id: ++nextConnId, attachedSocket: null, attached: false,
        sentRpcIds: new Map(), sentStateIds: new Set() };
      connMeta.set(connection, state);
      connectionsByUid.set(connection._uid, connection);
    }
    return { connection_probe_id: state.id, connection_uid: connection._uid ?? null,
      ...poolOf(connection), is_main_connection: Boolean(connection.params?.isMainConnection),
      session_tag: shortHash(connection._session?._sessionId?.toString?.()) };
  };
  const attachSocket = connection => {
    const state = connMeta.get(connection);
    const { socket, socket_id } = socketOf(connection);
    if (!socket || typeof socket.send !== 'function') return;
    if (connection._writer && writerSlots.get(connection)?.socket !== socket) {
      const shared = connection._writer;
      const transport = connection._fuman.connection;
      const fresh = { write(frame) {
        return new FramedWriter(transport, connection._codec).write(frame);
      } };
      writerSlots.set(connection, { socket, shared, fresh });
      trace('E_WRITER_SLOTS_READY', { ...identity(connection), socket_id });
    }
    const slot = writerSlots.get(connection);
    if (slot?.socket === socket && connection._writer !== slot[activeWriterMode]) {
      connection._writer = slot[activeWriterMode];
      trace('E_WRITER_MODE_APPLIED', { ...identity(connection), socket_id, mode: activeWriterMode });
    }
    if (state.attachedSocket === socket) return;
    state.attachedSocket = socket;
    const encryptor = connection._codec?._encryptor;
    if (captureBytes && encryptor && !patchedEncryptors.has(encryptor)) {
      patchedEncryptors.add(encryptor);
      const process = encryptor.process;
      encryptor.process = function (value, ...args) {
        const output = process.call(this, value, ...args);
        const unit = bytes(output)?.slice();
        if (unit) {
          cipherUnits.push(unit);
          if (cipherUnits.length > 32) cipherUnits.shift();
          trace('E_CIPHER_UNIT', { ...identity(connection), socket_id,
            unit_bytes: unit.byteLength, sha256: createHash('sha256').update(unit).digest('hex') });
        }
        return output;
      };
    }
    const original = socket.send;
    if (observeIncoming) socket.addEventListener('message', event => {
      const view = bytes(event.data);
      trace('E_WS_MESSAGE_RECEIVED', { ...identity(connection), socket_id,
        message_bytes: view?.byteLength ?? null, buffered_amount: socket.bufferedAmount ?? null });
    });
    socket.send = function (data) {
      const view = bytes(data);
      // FramedWriter has a shared buffer: concurrent encode calls can finish
      // with the same aggregate bytes, followed by one physical write.
      const matches = view ? encoded.filter(item => same(item.bytes, view)) : [];
      if (matches.length) for (const item of matches) encoded.splice(encoded.indexOf(item), 1);
      if (!matches.length) trace('D_SOCKET_SEND_UNMATCHED', { ...identity(connection), socket_id,
        sent_bytes: view?.byteLength ?? null, pending_packets: encoded.map(item =>
          ({ packet_id: item.packet_id, bytes: item.bytes.byteLength })) });
      if (matches.length) {
        const fields = { ...identity(connection), socket_id, ws_send_id: ++nextWsSendId,
          buffered_amount_before: socket.bufferedAmount ?? null };
        trace('D_WEBSOCKET_SEND', { ...fields, packet_ids: matches.map(item => item.packet_id),
          sent_bytes: view.byteLength, coalesced_packets: matches.length,
          buffered_amount_after: socket.bufferedAmount ?? null });
        if (captureBytes && matches.some(item => item.rpcs.length) && view) {
          let pair = [];
          for (let count = 1; count <= Math.min(8, cipherUnits.length); count++) {
            for (let start = Math.max(0, cipherUnits.length - 12); start + count <= cipherUnits.length; start++) {
              const candidate = cipherUnits.slice(start, start + count);
              const joined = Buffer.concat(candidate.map(value => Buffer.from(value)));
              if (joined.length === view.byteLength && same(joined, view)) { pair = candidate; break; }
            }
            if (pair.length) break;
          }
          const exactConcat = pair.length === matches.length;
          trace('E_BYTE_BOUNDARY', { ...fields, packet_ids: matches.map(item => item.packet_id),
            sent_bytes: view.byteLength, sha256: createHash('sha256').update(view).digest('hex'),
            unit_lengths: pair.map(item => item.byteLength), exact_cipher_concat: exactConcat,
            boundary_offset: pair.length > 1 ? pair[0].byteLength : null });
          captureBytes({ ...fields, packet_ids: matches.map(item => item.packet_id),
            exact_cipher_concat: exactConcat }, view.slice(), pair);
        }
        for (const match of matches) {
          const packetFields = { ...fields, packet_id: match.packet_id };
          trace('D_PACKET_WEBSOCKET_SEND', { ...packetFields,
            rpc_msg_ids: match.rpcs.map(item => item.msg_id),
            state_msg_ids: match.states.map(item => item.state_msg_id),
            coalesced_packets: matches.length });
          for (const rpc of match.rpcs) trace('D_RPC_WEBSOCKET_SEND', { ...packetFields, ...rpc,
            coalesced_packets: matches.length });
          for (const req of match.states) trace('D_STATE_REQ_WEBSOCKET_SEND', { ...packetFields, ...req });
        }
      }
      return original.call(this, data);
    };
    trace('D_SOCKET_ATTACHED', { ...identity(connection), socket_id });
  };
  const attachConnection = connection => {
    identity(connection);
    const state = connMeta.get(connection);
    if (state.attached) { attachSocket(connection); return; }
    state.attached = true;
    const codec = connection._codec;
    if (typeof codec?.encode === 'function') {
      const original = codec.encode;
      codec.encode = async function (packet, into, ...args) {
        const result = await original.call(this, packet, into, ...args);
        const meta = packet && typeof packet === 'object' ? packetMeta.get(packet) : null;
        const view = meta ? bytes(into?.result?.()) : null;
        if (view) {
          encoded.push({ bytes: view.slice(), ...meta });
          trace('D_PACKET_ENCODED', { ...identity(connection), packet_id: meta.packet_id,
            bytes: view.byteLength });
          if (encoded.length > 128) encoded.shift();
        }
        return result;
      };
    }
    const fuman = connection._fuman;
    if (typeof fuman?.params?.onOpen === 'function') {
      const original = fuman.params.onOpen;
      fuman.params.onOpen = function (...args) {
        const result = original.apply(this, args);
        try { attachSocket(connection); } catch {}
        return result;
      };
    }
    try { attachSocket(connection); } catch {}
    if (typeof connection._handleGetStateTimeout === 'function') {
      const original = connection._handleGetStateTimeout;
      connection._handleGetStateTimeout = function (stateMsgId) {
        const info = connection._session.pendingMessages.get(stateMsgId);
        const rpcMsgIds = (info?.msgIds || []).map(id);
        const messages = rpcMsgIds.map(value => state.sentRpcIds.get(value)?.message_id).filter(Boolean);
        if (messages.length) trace('D_STATE_REQ_TIMEOUT', { ...identity(connection),
          state_msg_id: id(stateMsgId), queried_msg_ids: rpcMsgIds, message_ids: messages });
        return original.call(this, stateMsgId);
      };
    }
  };
  const proto = SessionConnection.prototype;
  const sendRpc = proto.sendRpc;
  proto.sendRpc = function (request, ...args) {
    if (request?._ !== 'upload.getFile') return sendRpc.call(this, request, ...args);
    attachConnection(this);
    const messageId = [...documentIds].find(([, doc]) => doc === id(request.location?.id))?.[0] ?? null;
    const previous = context;
    context = messageId ? { message_id: messageId, key: ++nextRpcId } : null;
    if (context) trace('D_RPC_CONNECTION_BEGIN', { ...identity(this), ...context,
      offset_bytes: request.offset, limit_bytes: request.limit,
      queued_before: this._session?.queuedRpc?.length ?? null });
    try { return sendRpc.call(this, request, ...args); }
    finally { context = previous; }
  };
  const enqueue = proto._enqueueRpc;
  proto._enqueueRpc = function (pending, ...args) {
    if (context && pending?.method === 'upload.getFile' && !pendingMeta.has(pending))
      pendingMeta.set(pending, { ...context });
    const meta = pendingMeta.get(pending);
    if (meta) trace('D_RPC_ENQUEUE', { ...identity(this), ...meta,
      previous_msg_id: id(pending.msgId), queued_before: this._session?.queuedRpc?.length ?? null,
      retry: !context });
    return enqueue.call(this, pending, ...args);
  };
  const connectionSend = proto.send;
  proto.send = function (packet, ...args) {
    const state = connMeta.get(this);
    if (!state) return connectionSend.call(this, packet, ...args);
    const rpcs = [], states = [];
    for (const [msgId, info] of this._session.pendingMessages.entries()) {
      const msg = id(msgId);
      if (info?._ === 'rpc' && !state.sentRpcIds.has(msg)) {
        const meta = pendingMeta.get(info.rpc);
        if (!meta) continue;
        const rpc = { ...meta, msg_id: msg, container_id: id(info.rpc.containerId),
          seq_no: info.rpc.seqNo ?? null };
        state.sentRpcIds.set(msg, rpc);
        rpcs.push(rpc);
      } else if (info?._ === 'state' && !state.sentStateIds.has(msg)) {
        state.sentStateIds.add(msg);
        const queried = (info.msgIds || []).map(id);
        states.push({ state_msg_id: msg, queried_msg_ids: queried,
          target_msg_ids: queried.filter(value => state.sentRpcIds.has(value)) });
      }
    }
    if (rpcs.length || states.length) {
      const meta = { packet_id: ++nextPacketId, rpcs, states };
      if (packet && typeof packet === 'object') packetMeta.set(packet, meta);
      trace('D_PACKET_CONNECTION_SEND', { ...identity(this), packet_id: meta.packet_id,
        rpc_msg_ids: rpcs.map(item => item.msg_id), state_msg_ids: states.map(item => item.state_msg_id),
        rpcs, states });
      for (const rpc of rpcs) trace('D_RPC_FLUSH', { ...identity(this), packet_id: meta.packet_id, ...rpc });
      for (const req of states) trace('D_STATE_REQ_CONNECTION_SEND', { ...identity(this), packet_id: meta.packet_id, ...req });
    }
    return connectionSend.call(this, packet, ...args);
  };
  const flush = proto._doFlush;
  proto._doFlush = function (...args) {
    const result = flush.apply(this, args);
    const state = connMeta.get(this);
    if (state) for (const [msgId, info] of this._session.pendingMessages.entries()) {
      if (info?._ !== 'rpc') continue;
      const meta = pendingMeta.get(info.rpc);
      if (!meta || meta.lastMsgId === id(msgId)) continue;
      meta.lastMsgId = id(msgId);
      trace('D_RPC_MSG_ID_ASSIGNED', { ...identity(this), ...meta,
        msg_id: id(msgId), container_id: id(info.rpc.containerId),
        get_state_deadline_ts_ms: info.rpc.getState == null ? null : performance.timeOrigin + info.rpc.getState });
    }
    return result;
  };
  const handle = proto._handleMessage;
  proto._handleMessage = function (serverMsgId, message) {
    const state = connMeta.get(this);
    if (state && message?._ === 'mt_msgs_ack') {
      const ids = (message.msgIds || []).map(id);
      const targets = [...state.sentRpcIds.values()].filter(item => ids.includes(item.msg_id));
      for (const item of targets) trace('D_SERVER_ACK', { ...identity(this), ...item,
        server_msg_id: id(serverMsgId) });
    } else if (state && message?._ === 'mt_msgs_state_info') {
      const info = this._session.pendingMessages.get(message.reqMsgId);
      const queried = (info?.msgIds || this._session.recentStateRequests?.get?.(message.reqMsgId) || []).map(id);
      const statuses = [...(message.info || [])].map(Number);
      for (let i = 0; i < queried.length; i++) {
        const item = state.sentRpcIds.get(queried[i]);
        if (item) trace('D_STATE_INFO_RECEIVED', { ...identity(this), ...item,
          state_msg_id: id(message.reqMsgId), server_msg_id: id(serverMsgId), status: statuses[i] ?? null });
      }
    } else if (state && (message?._ === 'mt_msg_detailed_info' || message?._ === 'mt_msg_new_detailed_info')) {
      trace('D_DETAILED_INFO', { ...identity(this), kind: message._,
        msg_id: id(message.msgId), answer_msg_id: id(message.answerMsgId), status: message.status ?? null });
    } else if (state && message?._ === 'mt_msg_resend_req') {
      trace('D_SERVER_RESEND_REQ', { ...identity(this), requested_msg_ids: (message.msgIds || []).map(id) });
    }
    return handle.call(this, serverMsgId, message);
  };
  const info = proto._onMessageInfo;
  proto._onMessageInfo = function (msgId, status, answerMsgId) {
    const item = connMeta.get(this)?.sentRpcIds.get(id(msgId));
    if (item) trace('D_MESSAGE_INFO_APPLIED', { ...identity(this), ...item,
      status, answer_msg_id: id(answerMsgId) });
    return info.call(this, msgId, status, answerMsgId);
  };
  const failed = proto._onMessageFailed;
  proto._onMessageFailed = function (msgId, reason, ...args) {
    const item = connMeta.get(this)?.sentRpcIds.get(id(msgId));
    if (item) trace('D_RPC_FAILED', { ...identity(this), ...item, reason: String(reason).slice(0, 80) });
    const result = failed.call(this, msgId, reason, ...args);
    if (item) trace('D_RPC_REQUEUED', { ...identity(this), ...item });
    return result;
  };
  const rpcResult = proto._onRpcResult;
  proto._onRpcResult = function (serverMsgId, reader, ...args) {
    const readable = reader?.dataView && Number.isInteger(reader.pos) && reader.pos + 8 <= reader.dataView.byteLength;
    const reqId = readable ? String(reader.dataView.getBigInt64(reader.pos, true)) : null;
    const item = connMeta.get(this)?.sentRpcIds.get(reqId);
    if (item) trace('D_RPC_RESULT', { ...identity(this), ...item, server_msg_id: id(serverMsgId) });
    return rpcResult.call(this, serverMsgId, reader, ...args);
  };
  const connect = TelegramClient.prototype.connect;
  TelegramClient.prototype.connect = async function (...args) {
    client = this;
    const result = await connect.apply(this, args);
    if (route101 === 'download') {
      trace('D_SEPARATE_POOL_PREPARE_BEGIN');
      await this._client.call({ _: 'help.getConfig' }, { kind: 'download' });
      const dc = this._client.mt.network._primaryDc;
      trace('D_SEPARATE_POOL_PREPARE_DONE', { dc_id: dc?.dcId ?? null,
        main_connected: dc?.main?.isConnected ?? false,
        download_connected: dc?.download?.isConnected ?? false });
    }
    return result;
  };
  const gateCall = (messageId, invoke) => new Promise((resolve, reject) => {
    if (!gate) gate = { waiting: new Map(), timer: null };
    const item = { messageId, invoke, resolve, reject };
    gate.waiting.set(messageId, item);
    const release = (entry, delay) => setTimeout(() => {
      trace('D_ORDER_RELEASE', { message_id: entry.messageId, requested_offset_ms: delay });
      Promise.resolve().then(entry.invoke).then(entry.resolve, entry.reject);
    }, delay);
    if (gate.waiting.size === 2) {
      clearTimeout(gate.timer);
      const first = gate.waiting.get(Number(order));
      const second = gate.waiting.get(Number(order) === 96 ? 101 : 96);
      trace('D_ORDER_PAIR_READY', { first_message_id: first.messageId,
        second_message_id: second.messageId, offset_ms: offsetMs });
      gate = null;
      release(first, 0);
      release(second, offsetMs);
    } else {
      const current = gate;
      current.timer = setTimeout(() => {
        if (gate !== current) return;
        gate = null;
        trace('D_ORDER_UNPAIRED_RELEASE', { message_id: item.messageId });
        release(item, 0);
      }, 300);
    }
  });
  return {
    async reconnectMainSocket() {
      const connection = [...connectionsByUid.values()].find(item => poolOf(item).pool_kind === 'main');
      if (!connection || !client) throw new Error('No prepared main connection for Test E reconnect');
      const before = socketOf(connection).socket_id;
      trace('E_RECONNECT_BEGIN', { connection_uid: connection._uid, socket_id_before: before });
      connection.reconnect();
      await client._client.call({ _: 'help.getConfig' });
      const after = socketOf(connection).socket_id;
      trace('E_RECONNECT_READY', { connection_uid: connection._uid,
        socket_id_before: before, socket_id_after: after,
        session_tag: shortHash(connection._session?._sessionId?.toString?.()) });
      if (after === before) throw new Error('Test E reconnect did not replace socket');
      return { socket_id_before: before, socket_id_after: after };
    },
    setWriterMode(mode) {
      if (!['shared','fresh'].includes(mode)) throw new Error('Invalid Test E writer mode');
      activeWriterMode = mode;
      for (const connection of connectionsByUid.values()) attachSocket(connection);
      trace('E_WRITER_MODE', { mode });
    },
    observeMessage(message) {
      if ((message?.id === 96 || message?.id === 101) && message.media?.raw?.id != null) {
        documentIds.set(message.id, id(message.media.raw.id));
        mediaByMessage.set(message.id, message.media);
        trace('D_DOCUMENT_IDENTIFIED', { message_id: message.id,
          document_id_recorded: true, total_bytes: message.media?.fileSize ?? null });
      }
    },
    async runRawPair({ include101 = true, firstMessageId = 96, offsetMs: rawOffsetMs = 0,
      sequential = false, timing = 'same', messageIds = null, writerMode = null } = {}) {
      if (!client || !mediaByMessage.has(96) || (include101 && !mediaByMessage.has(101)))
        throw new Error('Test D media was not prepared by real getMessages');
      if (!Number.isFinite(rawOffsetMs) || rawOffsetMs < 0 || rawOffsetMs > 500)
        throw new Error('Invalid Test D offset');
      if (writerMode) this.setWriterMode(writerMode);
      const ids = messageIds || (include101 ? [firstMessageId, firstMessageId === 96 ? 101 : 96] : [96]);
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 7 || ids.some(id => ![96,101].includes(id)))
        throw new Error('Invalid Test E message IDs');
      const fetch = async (messageId, slot) => {
        const offset = messageId === 101 ? ids.slice(0, slot).filter(id => id === 101).length * 65536 : 0;
        trace('D_RAW_CALL_BEGIN', { message_id: messageId, slot, offset_bytes: offset });
        try {
          const chunk = await client.downloadChunk({ location: mediaByMessage.get(messageId),
            offset, limit: 65536 });
          const count = chunk?.byteLength ?? chunk?.length ?? 0;
          trace('D_RAW_CALL_DONE', { message_id: messageId, slot, bytes: count });
          return { message_id: messageId, slot, bytes: count };
        } catch (error) {
          trace('D_RAW_CALL_ERROR', { message_id: messageId,
            error_name: error?.name ?? 'Error', rpc_error_code: error?.code ?? null });
          throw error;
        }
      };
      const first = fetch(ids[0], 0);
      if (ids.length === 1) return [await first];
      if (sequential) {
        const one = await first;
        trace('D_SEQUENTIAL_FIRST_DONE', { message_id: ids[0] });
        return [one, await fetch(ids[1], 1)];
      }
      if (timing === 'microtask') await Promise.resolve();
      else if (timing === 'immediate') await new Promise(resolve => setImmediate(resolve));
      else if (rawOffsetMs) await new Promise(resolve => setTimeout(resolve, rawOffsetMs));
      const rest = ids.slice(1).map((id, index) => fetch(id, index + 1));
      return Promise.all([first, ...rest]);
    },
    invoke(request, rest, callOriginal) {
      if (request?._ !== 'upload.getFile') return callOriginal(rest);
      const messageId = [...documentIds].find(([, doc]) => doc === id(request.location?.id))?.[0];
      if (!messageId) return callOriginal(rest);
      const params = rest[0] || {};
      const changed = messageId === 101 && route101 === 'download'
        ? [{ ...params, kind: 'download' }, ...rest.slice(1)] : rest;
      if (changed !== rest) trace('D_ROUTING_OVERRIDE', { message_id: 101, kind: 'download' });
      const invoke = () => callOriginal(changed);
      if (order === '96' || order === '101') return gateCall(messageId, invoke);
      return invoke();
    },
    enrichTrace(event) {
      if (event?.stage !== 'WORKER_GET_FILE_WEBSOCKET_SEND_CALLED' && event?.stage !== 'WORKER_GET_FILE_RPC_RESULT_ENTER') return event;
      const connection = connectionsByUid.get(event.connection_uid);
      if (!connection) return event;
      const { socket_id } = socketOf(connection);
      return { ...event, ...identity(connection), socket_id };
    },
  };
}
