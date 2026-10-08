// Test-only mtcute probes. Installed inside Test A's isolated worker process.
// Normal mode only reads state; experimental modes alter only the target RPC's
// getStateSchedule entry. No installed package or application source is edited.
export function installTestC(SessionConnection, emit, { mode = 'observe', earlyMs = 100 } = {}) {
  const targetDocument = { id: null };
  const connections = new WeakMap();
  const pendingMeta = new WeakMap();
  const packetServices = new WeakMap();
  const encoded = [];
  let context = null;
  let serial = 0;
  const at = () => performance.timeOrigin + performance.now();
  const id = value => value == null ? null : String(value);
  const same = (a, b) => a?.byteLength === b?.byteLength && a.every((value, index) => value === b[index]);
  const bytes = value => value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  const trace = (stage, fields = {}) => { try { emit({ stage, ...fields }); } catch {} };
  const stateOf = connection => {
    let state = connections.get(connection);
    if (!state) {
      state = { pending: new Set(), targetIds: new Set(), seenStates: new Set(), seenResends: new Set(), socket: null, attached: false };
      connections.set(connection, state);
    }
    return state;
  };
  const targetPending = (connection, msgId) => {
    const entry = connection._session?.pendingMessages?.get?.(msgId);
    return entry?._ === 'rpc' && pendingMeta.get(entry.rpc)?.target ? entry.rpc : null;
  };
  const fields = (connection, pending, extra = {}) => ({
    connection_uid: connection._uid ?? null, is_main_connection: Boolean(connection.params?.isMainConnection),
    dc_id: connection.params?.dcId ?? null, rpc_key: pendingMeta.get(pending)?.key ?? null,
    msg_id: id(pending?.msgId), container_id: id(pending?.containerId), ...extra,
  });
  const attachSocket = connection => {
    const state = stateOf(connection);
    const socket = connection._fuman?.connection?.socket;
    if (!socket || state.socket === socket || typeof socket.send !== 'function') return;
    state.socket = socket;
    const original = socket.send;
    socket.send = function (data) {
      const view = bytes(data);
      const index = view ? encoded.findIndex(item => same(item.bytes, view)) : -1;
      const match = index < 0 ? null : encoded.splice(index, 1)[0];
      for (const item of match?.services || []) {
        if (item.kind === 'state') trace('C_STATE_REQ_WEBSOCKET_SEND', {
          connection_uid: connection._uid ?? null, state_msg_id: item.msgId,
          queried_msg_ids: item.queried, target_msg_ids: item.targetIds,
          buffered_amount_before: socket.bufferedAmount ?? null,
        });
        else trace('C_RESEND_REQ_WEBSOCKET_SEND', {
          connection_uid: connection._uid ?? null, resend_msg_id: item.msgId,
          queried_msg_ids: item.queried, buffered_amount_before: socket.bufferedAmount ?? null,
        });
      }
      return original.call(this, data);
    };
    trace('C_SOCKET_PROBE_ATTACHED', { connection_uid: connection._uid ?? null });
  };
  const attach = connection => {
    const state = stateOf(connection);
    if (state.attached) return;
    state.attached = true;
    const codec = connection._codec;
    if (typeof codec?.encode === 'function') {
      const original = codec.encode;
      codec.encode = async function (packet, into, ...args) {
        const result = await original.call(this, packet, into, ...args);
        const matching = packet && typeof packet === 'object' ? packetServices.get(packet) : null;
        const view = matching?.length ? bytes(into?.result?.()) : null;
        if (view) {
          encoded.push({ bytes: view.slice(), services: matching });
          if (encoded.length > 64) encoded.shift();
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
    // Arrow field on the instance, not a prototype method.
    if (typeof connection._handleGetStateTimeout === 'function') {
      const original = connection._handleGetStateTimeout;
      connection._handleGetStateTimeout = function (stateMsgId) {
        const info = connection._session?.pendingMessages?.get?.(stateMsgId);
        const targetIds = (info?.msgIds || []).map(id).filter(value => state.targetIds.has(value));
        if (targetIds.length) trace('C_STATE_REQ_TIMEOUT', {
          connection_uid: connection._uid ?? null, state_msg_id: id(stateMsgId), target_msg_ids: targetIds,
        });
        return original.call(this, stateMsgId);
      };
    }
  };
  const prototype = SessionConnection.prototype;
  const enqueue = prototype._enqueueRpc;
  prototype._enqueueRpc = function (pending, ...args) {
    if (context?.target && pending?.method === 'upload.getFile') {
      const meta = { key: ++serial, target: true };
      pendingMeta.set(pending, meta);
      stateOf(this).pending.add(pending);
      trace('C_RPC_CREATED', fields(this, pending, { offset_bytes: context.offset, limit_bytes: context.limit }));
    }
    const meta = pendingMeta.get(pending);
    if (meta?.target) trace('C_RPC_ENQUEUE', fields(this, pending, { retry: !context }));
    return enqueue.call(this, pending, ...args);
  };
  const sendRpc = prototype.sendRpc;
  prototype.sendRpc = function (request, ...args) {
    if (request?._ !== 'upload.getFile') return sendRpc.call(this, request, ...args);
    attach(this);
    const locationId = id(request.location?.id);
    const target = Boolean(targetDocument.id && locationId === targetDocument.id);
    if (!target) return sendRpc.call(this, request, ...args);
    const previous = context;
    context = { target, offset: request.offset, limit: request.limit };
    try { return sendRpc.call(this, request, ...args); }
    finally { context = previous; }
  };
  const send = prototype.send;
  prototype.send = function (packet, ...args) {
    const state = stateOf(this);
    const pendingStates = [...(this._session?.pendingMessages?.entries?.() || [])]
      .filter(([msgId, info]) => info?._ === 'state' && !state.seenStates.has(id(msgId)))
      .map(([msgId, info]) => {
        state.seenStates.add(id(msgId));
        return { kind: 'state', msgId: id(msgId), queried: info.msgIds.map(id),
          targetIds: info.msgIds.map(id).filter(value => state.targetIds.has(value)) };
      });
    const pendingResends = [...(this._session?.pendingMessages?.entries?.() || [])]
      .filter(([msgId, info]) => info?._ === 'resend' && !state.seenResends.has(id(msgId)))
      .map(([msgId, info]) => {
        state.seenResends.add(id(msgId));
        return { kind: 'resend', msgId: id(msgId), queried: info.msgIds.map(id) };
      });
    if (pendingStates.length) {
      for (const item of pendingStates) trace('C_STATE_REQ_CONNECTION_SEND', {
        connection_uid: this._uid ?? null, state_msg_id: item.msgId,
        queried_msg_ids: item.queried, target_msg_ids: item.targetIds,
      });
    }
    for (const item of pendingResends) trace('C_RESEND_REQ_CONNECTION_SEND', {
      connection_uid: this._uid ?? null, resend_msg_id: item.msgId, queried_msg_ids: item.queried,
    });
    if (packet && typeof packet === 'object' && (pendingStates.length || pendingResends.length))
      packetServices.set(packet, [...pendingStates, ...pendingResends]);
    return send.call(this, packet, ...args);
  };
  const flush = prototype._doFlush;
  prototype._doFlush = function (...args) {
    const result = flush.apply(this, args);
    const state = stateOf(this);
    for (const pending of state.pending) {
      if (!pending.msgId || pending.done || pending.cancelled
        || this._session.pendingMessages.get(pending.msgId)?.rpc !== pending) continue;
      const currentId = id(pending.msgId);
      const meta = pendingMeta.get(pending);
      if (meta.lastId !== currentId) {
        const previousId = meta.lastId ?? null;
        meta.lastId = currentId;
        state.targetIds.add(currentId);
        trace('C_RPC_MSG_ID_ASSIGNED', fields(this, pending, { previous_msg_id: previousId,
          seq_no: pending.seqNo ?? null, get_state_deadline_ts_ms: pending.getState == null ? null : performance.timeOrigin + pending.getState }));
      }
      if (pending.getState != null && meta.scheduledAt !== pending.getState) {
        meta.scheduledAt = pending.getState;
        trace('C_GET_STATE_SCHEDULED', fields(this, pending, {
          deadline_ts_ms: performance.timeOrigin + pending.getState,
          interval_ms: Math.round(pending.getState - performance.now()), mode,
        }));
      }
      if (mode === 'suppress' && Number.isFinite(pending.getState) && meta.suppressedForId !== currentId) {
        this._session.getStateSchedule.remove(pending);
        pending.getState = performance.now() + 3600000;
        this._session.getStateSchedule.insert(pending);
        meta.suppressedForId = currentId;
        trace('C_EXPERIMENT_SUPPRESS_STATE', fields(this, pending));
      } else if (mode === 'early' && Number.isFinite(pending.getState) && meta.earlyForId !== currentId) {
        this._session.getStateSchedule.remove(pending);
        pending.getState = performance.now() + earlyMs;
        this._session.getStateSchedule.insert(pending);
        meta.earlyForId = currentId;
        this._flushTimer.emitBefore(pending.getState);
        trace('C_EXPERIMENT_EARLY_STATE', fields(this, pending, {
          deadline_ts_ms: performance.timeOrigin + pending.getState, early_ms: earlyMs,
        }));
      }
    }
    return result;
  };
  const handle = prototype._handleMessage;
  prototype._handleMessage = function (messageId, message) {
    const state = stateOf(this);
    if (message?._ === 'mt_msgs_ack') {
      const ids = (message.msgIds || []).map(id);
      const targets = ids.filter(value => state.targetIds.has(value));
      if (targets.length) trace('C_SERVER_ACK', { connection_uid: this._uid ?? null,
        server_msg_id: id(messageId), target_msg_ids: targets, acked_msg_ids: ids });
    } else if (message?._ === 'mt_msgs_state_info') {
      const info = this._session?.pendingMessages?.get?.(message.reqMsgId);
      const queried = (info?.msgIds || this._session?.recentStateRequests?.get?.(message.reqMsgId) || []).map(id);
      const statuses = [...(message.info || [])].map(Number);
      const targetStatuses = queried.map((value, index) => ({ msg_id: value, status: statuses[index] }))
        .filter(item => state.targetIds.has(item.msg_id));
      if (targetStatuses.length) trace('C_STATE_INFO_RECEIVED', { connection_uid: this._uid ?? null,
        state_msg_id: id(message.reqMsgId), server_msg_id: id(messageId),
        queried_msg_ids: queried, statuses, target_statuses: targetStatuses });
    } else if (message?._ === 'mt_msg_detailed_info' || message?._ === 'mt_msg_new_detailed_info') {
      if (!message.msgId || state.targetIds.has(id(message.msgId))) trace('C_DETAILED_INFO', {
        connection_uid: this._uid ?? null, kind: message._, msg_id: id(message.msgId),
        answer_msg_id: id(message.answerMsgId), status: message.status ?? null,
      });
    } else if (message?._ === 'mt_msg_resend_req') {
      const ids = (message.msgIds || []).map(id);
      trace('C_SERVER_RESEND_REQ', { connection_uid: this._uid ?? null,
        requested_msg_ids: ids, target_msg_ids: ids.filter(value => state.targetIds.has(value)) });
    }
    return handle.call(this, messageId, message);
  };
  const ack = prototype._onMessageAcked;
  prototype._onMessageAcked = function (msgId, ...args) {
    const pending = targetPending(this, msgId);
    if (pending) trace('C_ACK_APPLIED', fields(this, pending));
    return ack.call(this, msgId, ...args);
  };
  const onInfo = prototype._onMessageInfo;
  prototype._onMessageInfo = function (msgId, status, answerMsgId) {
    const pending = targetPending(this, msgId);
    if (pending) trace('C_MESSAGE_INFO_APPLIED', fields(this, pending, {
      status, low_bits: status & 7, processed: Boolean(status & 32), response_generated: Boolean(status & 64),
      server_knows_received: Boolean(status & 128), answer_msg_id: id(answerMsgId),
    }));
    return onInfo.call(this, msgId, status, answerMsgId);
  };
  const failed = prototype._onMessageFailed;
  prototype._onMessageFailed = function (msgId, reason, ...args) {
    const pending = targetPending(this, msgId);
    if (pending) trace('C_MESSAGE_FAILED', fields(this, pending, { reason: String(reason).slice(0, 80) }));
    const result = failed.call(this, msgId, reason, ...args);
    if (pending) trace('C_RPC_REQUEUED', fields(this, pending, { old_msg_id: id(msgId) }));
    return result;
  };
  const result = prototype._onRpcResult;
  prototype._onRpcResult = function (messageId, reader, ...args) {
    const readable = reader?.dataView && Number.isInteger(reader.pos) && reader.pos + 8 <= reader.dataView.byteLength;
    const reqId = readable ? String(reader.dataView.getBigInt64(reader.pos, true)) : null;
    if (reqId && stateOf(this).targetIds.has(reqId)) trace('C_RPC_RESULT', {
      connection_uid: this._uid ?? null, msg_id: reqId, server_msg_id: id(messageId),
    });
    return result.call(this, messageId, reader, ...args);
  };
  return {
    observeMessage(message) {
      if (message?.media?.raw?.id != null) {
        targetDocument.id = id(message.media.raw.id);
        trace('C_TARGET_DOCUMENT_IDENTIFIED', { message_id: message.id, document_id_recorded: true });
      }
    },
  };
}
