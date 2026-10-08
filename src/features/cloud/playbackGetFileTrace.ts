import { playTrace } from "../playback/playTrace";
import { traceClock } from "../perf/traceClock";

type TraceOperation = { fields: () => Record<string, unknown>; rpcSequence: number; kind: "file" | "messages" };
type TraceRpc = { operation: TraceOperation; rpcSequence: number; sentCount: number; pending?: any; physicalOrdinal?: number };
type AnyFunction = (...args: any[]) => any;
type SocketIngress = { firstAtMs: number | null; lastAtMs: number | null; messageCount: number; frameDecodedAtMs: number; frameBytes: number };

function byteView(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function isGetMessages(request: { _?: string }): boolean {
  return request?._ === "channels.getMessages" || request?._ === "messages.getMessages";
}

function safeMsgId(value: unknown): string | null {
  return typeof value === "bigint" || typeof value === "number" ? String(value) : null;
}

/**
 * Read-only probes for mtcute's upload.getFile path and opt-in getMessages batches.
 * The AbortSignal passed to downloadChunk is also passed to core.call and
 * SessionConnection.sendRpc, so concurrent downloads can be attributed without
 * guessing by offset or file id. Metadata batches use the original request object.
 * No location, auth material, request body or response body is logged.
 */
export function installPlaybackGetFileTrace(active: unknown, options?: { focusedMessageId?: () => number | null }): {
  run<T>(signal: AbortSignal, fields: () => Record<string, unknown>, operation: () => Promise<T>): Promise<T>;
  detach(): void;
} {
  const operations = new WeakMap<AbortSignal, TraceOperation>();
  const messagesByRequest = new WeakMap<object, TraceOperation>();
  const rpcByPending = new WeakMap<object, TraceRpc>();
  const restores: Array<() => void> = [];
  const observedConnections = new WeakSet<object>();
  const client = active as { _client?: { call?: AnyFunction; mt?: { network?: any } } };
  const core = client._client;
  const network = core?.mt?.network;
  let enabled = true;
  let hookedConnections = 0;
  let activeOperations = 0;
  let nextMessagesBatchId = 0;
  let nextSocketOrdinal = 0;

  const messagesOperation = (request: { _?: string; id?: Array<{ id?: number }> }): TraceOperation | null => {
    if (!options?.focusedMessageId) return null;
    const existing = messagesByRequest.get(request);
    if (existing) return existing;
    const ids = Array.isArray(request.id) ? request.id.map(value => Number(value?.id)).filter(Number.isSafeInteger) : [];
    const focused = options?.focusedMessageId?.();
    if (typeof focused !== "number" || !Number.isSafeInteger(focused) || !ids.includes(focused)) return null;
    const batchId = ++nextMessagesBatchId;
    const operation: TraceOperation = { kind: "messages", rpcSequence: 0,
      fields: () => ({ batch_id: batchId, rpc_method: request._, message_ids: ids, message_id: ids.length === 1 ? ids[0] : null }) };
    messagesByRequest.set(request, operation);
    return operation;
  };

  const emit = (stage: string, rpc: TraceRpc | TraceOperation, extra: Record<string, unknown> = {}) => {
    if (!enabled) return;
    try {
      const operation = "operation" in rpc ? rpc.operation : rpc;
      playTrace(operation.kind === "messages" ? stage.replace(/^WORKER_GET_FILE_/, "WORKER_GET_MESSAGES_") : stage,
        { ...operation.fields(), rpc_seq: "operation" in rpc ? rpc.rpcSequence : null, ...extra });
    } catch { /* Observation must not affect playback. */ }
  };
  const observeConnection = (connection: any) => {
    if (!connection || typeof connection !== "object" || observedConnections.has(connection)) return;
    if (typeof connection.sendRpc !== "function" || typeof connection._enqueueRpc !== "function") return;
    observedConnections.add(connection);
    hookedConnections += 1;
    const originalSendRpc: AnyFunction = connection.sendRpc;
    const originalEnqueue: AnyFunction = connection._enqueueRpc;
    const originalFlush: AnyFunction | undefined = connection._doFlush;
    const originalSend: AnyFunction | undefined = connection.send;
    const originalResult: AnyFunction | undefined = connection._onRpcResult;
    const originalFailed: AnyFunction | undefined = connection._onMessageFailed;
    let enqueueContext: TraceRpc | null = null;
    let flushRpcs: TraceRpc[] | null = null;
    let frameReceivedAtMs: number | null = null;
    let frameSocketIngress: SocketIngress | null = null;
    const packetRpcs = new WeakMap<object, TraceRpc[]>();
    const ingressByFrame = new WeakMap<object, SocketIngress>();
    const encodedPackets: Array<{ bytes: Uint8Array; rpcs: Array<{ rpc: TraceRpc; sendCount: number }> }> = [];
    let socketReceivedBytes = 0;
    let framedBytes = 0;
    let incomingSegments: Array<{ start: number; end: number; atMs: number }> = [];
    let currentSocket: object | null = null;
    let currentSocketId: string | null = null;
    let physicalOrdinal = 0;
    let previousPhysicalRpcAt = 0;
    let rawMessageCount = 0;

    const observeSocket = (transport: any) => {
      const socket: WebSocket | undefined = transport?.socket;
      if (!socket || currentSocket === socket) return;
      currentSocket = socket;
      currentSocketId = `${String(connection._uid ?? "connection")}:socket-${++nextSocketOrdinal}`;
      if (options?.focusedMessageId) playTrace("WORKER_TRANSPORT_SOCKET_OBSERVED", { connection_uid: connection._uid ?? null, socket_id: currentSocketId });
      socketReceivedBytes = 0;
      framedBytes = 0;
      incomingSegments = [];
      rawMessageCount = 0;
      const recordMessage = (event: MessageEvent) => {
        if (currentSocket !== socket) return;
        rawMessageCount += 1;
        const bytes = byteView(event.data);
        if (!bytes) return;
        const receivedAtMs = traceClock().ts_ms;
        const start = socketReceivedBytes;
        socketReceivedBytes += bytes.byteLength;
        incomingSegments.push({ start, end: socketReceivedBytes, atMs: receivedAtMs });
        if (activeOperations) playTrace("WORKER_GET_FILE_WEBSOCKET_MESSAGE", {
          connection_uid: connection._uid ?? null, socket_id: currentSocketId,
          message_seq: rawMessageCount,
          received_bytes: bytes.byteLength,
          received_total_bytes: socketReceivedBytes,
        });
      };
      if (typeof transport.onMessage === "function") {
        // fuman's existing WebSocket listener calls this method. Observe before
        // it wakes FramedReader; a second listener can run after decode.
        const originalTransportMessage: AnyFunction = transport.onMessage;
        transport.onMessage = function (this: unknown, event: MessageEvent) {
          try { recordMessage(event); } catch { /* Diagnostics are optional. */ }
          return originalTransportMessage.call(this, event);
        };
        restores.push(() => { transport.onMessage = originalTransportMessage; });
      } else {
        socket.addEventListener("message", recordMessage);
        restores.push(() => socket.removeEventListener("message", recordMessage));
      }
      const originalSocketSend = socket.send;
      socket.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const bytes = byteView(data);
        const index = bytes ? encodedPackets.findIndex(packet => sameBytes(packet.bytes, bytes)) : -1;
        const matched = index < 0 ? null : encodedPackets.splice(index, 1)[0];
        const bufferedBefore = socket.bufferedAmount;
        for (const { rpc, sendCount } of matched?.rpcs || []) emit("WORKER_GET_FILE_WEBSOCKET_SEND_CALLED", rpc, {
          send_count: sendCount, connection_uid: connection._uid ?? null, socket_id: currentSocketId,
          buffered_amount_before: bufferedBefore, encoded_bytes: bytes?.byteLength ?? null,
        });
        try {
          const result = originalSocketSend.call(this, data);
          for (const { rpc, sendCount } of matched?.rpcs || []) emit("WORKER_GET_FILE_WEBSOCKET_SEND_RETURNED", rpc, {
            send_count: sendCount, connection_uid: connection._uid ?? null, socket_id: currentSocketId,
            buffered_amount_after: socket.bufferedAmount,
          });
          return result;
        } catch (error) {
          for (const { rpc, sendCount } of matched?.rpcs || []) emit("WORKER_GET_FILE_WEBSOCKET_SEND_ERROR", rpc, {
            send_count: sendCount, error_name: error instanceof Error ? error.name : "unknown",
          });
          throw error;
        }
      };
      restores.push(() => { socket.send = originalSocketSend; });
    };
    const fuman = connection._fuman;
    if (typeof fuman?.params?.onOpen === "function") {
      const originalOnOpen: AnyFunction = fuman.params.onOpen;
      fuman.params.onOpen = function (this: unknown, transport: unknown, ...args: unknown[]) {
        try { observeSocket(transport); } catch { /* Socket observation is optional. */ }
        return originalOnOpen.call(this, transport, ...args);
      };
      restores.push(() => { fuman.params.onOpen = originalOnOpen; });
    }
    try { observeSocket(fuman?.connection); } catch { /* The socket may connect later. */ }
    const originalEncode: AnyFunction | undefined = connection._codec?.encode;
    if (typeof originalEncode === "function") {
      connection._codec.encode = async function (this: unknown, packet: object, into: any, ...args: unknown[]) {
        const result = await originalEncode.call(this, packet, into, ...args);
        const rpcs = packet && typeof packet === "object" ? packetRpcs.get(packet) : undefined;
        const bytes = rpcs?.length ? byteView(into?.result?.()) : null;
        if (bytes && rpcs) {
          encodedPackets.push({ bytes: bytes.slice(), rpcs: rpcs.map(rpc => ({ rpc, sendCount: rpc.sentCount })) });
          if (encodedPackets.length > 64) encodedPackets.shift();
        }
        return result;
      };
      restores.push(() => { connection._codec.encode = originalEncode; });
    }
    const originalDecode: AnyFunction | undefined = connection._codec?.decode;
    if (typeof originalDecode === "function") {
      connection._codec.decode = async function (this: unknown, ...args: unknown[]) {
        const frame = await originalDecode.apply(this, args);
        if (frame && typeof frame === "object" && Number.isFinite(frame.byteLength)) {
          // IntermediatePacketCodec contributes a four-byte length prefix.
          const end = framedBytes + frame.byteLength + 4;
          const segments = incomingSegments.filter(segment => segment.start < end && segment.end > framedBytes);
          const ingress: SocketIngress = {
            firstAtMs: segments[0]?.atMs ?? null,
            lastAtMs: segments.at(-1)?.atMs ?? null,
            messageCount: segments.length,
            frameDecodedAtMs: traceClock().ts_ms,
            frameBytes: frame.byteLength + 4,
          };
          ingressByFrame.set(frame, ingress);
          framedBytes = end;
          incomingSegments = incomingSegments.filter(segment => segment.end > end);
        }
        return frame;
      };
      restores.push(() => { connection._codec.decode = originalDecode; });
    }

    connection._enqueueRpc = function (this: unknown, pending: object, ...args: unknown[]) {
      if (enqueueContext && pending && typeof pending === "object") {
        rpcByPending.set(pending, enqueueContext);
        enqueueContext.pending = pending;
      }
      const result = originalEnqueue.call(this, pending, ...args);
      const rpc = pending && typeof pending === "object" ? rpcByPending.get(pending) : undefined;
      if (rpc) emit("WORKER_GET_FILE_RPC_QUEUED", rpc, {
        queued_after: Number(connection._session?.queuedRpc?.length || 0),
        rpc_msg_id: safeMsgId((pending as { msgId?: unknown })?.msgId),
        retry: !enqueueContext,
      });
      return result;
    };
    connection.sendRpc = function (this: unknown, request: { _?: string }, timeout: unknown, signal: AbortSignal | undefined, ...args: unknown[]) {
      const operation = request?._ === "upload.getFile" ? signal && operations.get(signal)
        : isGetMessages(request) ? messagesOperation(request) : undefined;
      if (!operation) return originalSendRpc.call(this, request, timeout, signal, ...args);
      const rpc: TraceRpc = { operation, rpcSequence: ++operation.rpcSequence, sentCount: 0 };
      emit("WORKER_GET_FILE_CONNECTION_RPC_BEGIN", rpc, {
        queued_before: Number(connection._session?.queuedRpc?.length || 0),
        in_flight_before: Number(connection._session?.pendingMessages?.size || 0),
        connection_usable: Boolean(connection._usable),
        connection_uid: connection._uid ?? null,
        dc_id: network?._primaryDc?.dcId ?? null,
      });
      const previous = enqueueContext;
      enqueueContext = rpc;
      let result: Promise<unknown>;
      try { result = originalSendRpc.call(this, request, timeout, signal, ...args); }
      finally { enqueueContext = previous; }
      void Promise.resolve(result).then(
        () => emit("WORKER_GET_FILE_RPC_SETTLED", rpc),
        error => emit("WORKER_GET_FILE_RPC_REJECTED", rpc, { error_name: error instanceof Error ? error.name : "unknown" }),
      );
      return result;
    };
    restores.push(() => {
      if (connection._enqueueRpc !== originalEnqueue) connection._enqueueRpc = originalEnqueue;
      if (connection.sendRpc !== originalSendRpc) connection.sendRpc = originalSendRpc;
    });

    if (typeof originalFlush === "function") {
      connection._doFlush = function (this: unknown, ...args: unknown[]) {
        const queued = connection._session?.queuedRpc;
        const originalPop: AnyFunction | undefined = queued?.popFront;
        const selected: TraceRpc[] = [];
        let popObserved = false;
        if (typeof originalPop === "function") try {
          queued.popFront = function (this: unknown, ...popArgs: unknown[]) {
            const pending = originalPop.apply(this, popArgs);
            const rpc = pending && typeof pending === "object" ? rpcByPending.get(pending) : undefined;
            if (rpc && !pending.cancelled) selected.push(rpc);
            return pending;
          };
          popObserved = true;
        } catch { /* Keep mtcute's original queue operation. */ }
        const previous = flushRpcs;
        flushRpcs = selected;
        try { return originalFlush.apply(this, args); }
        finally {
          flushRpcs = previous;
          if (popObserved) try { queued.popFront = originalPop; } catch { /* Connection is closing. */ }
        }
      };
      restores.push(() => { connection._doFlush = originalFlush; });
    }
    // send() resolves after the framed writer completes, or immediately when
    // mtcute queues the packet for reconnect. queued_packets_after distinguishes
    // those paths. Neither event proves that Telegram received the packet.
    if (typeof originalSend === "function") {
      connection.send = function (this: unknown, data: unknown, ...args: unknown[]) {
        const selected = flushRpcs?.slice() || [];
        if (selected.length && data && typeof data === "object") packetRpcs.set(data, selected);
        for (const rpc of selected) {
          const now = performance.now();
          rpc.physicalOrdinal = ++physicalOrdinal;
          emit("WORKER_GET_FILE_MT_PROTO_FLUSH", rpc, {
            physical_rpc_ordinal: rpc.physicalOrdinal,
            rpc_msg_id: safeMsgId(rpc.pending?.msgId),
            in_flight_rpc_count: Number(connection._session?.pendingMessages?.size || 0),
            since_previous_physical_rpc_ms: previousPhysicalRpcAt ? Math.round((now - previousPhysicalRpcAt) * 10) / 10 : null,
            connection_uid: connection._uid ?? null,
            socket_id: currentSocketId,
          });
          previousPhysicalRpcAt = now;
          rpc.sentCount += 1;
          emit("WORKER_GET_FILE_SOCKET_SEND_CALLED", rpc, {
            send_count: rpc.sentCount,
            physical_rpc_ordinal: rpc.physicalOrdinal,
            rpc_msg_id: safeMsgId(rpc.pending?.msgId),
            socket_id: currentSocketId,
            writer_present: Boolean(connection._writer),
            queued_packets_before: Number(connection._sendOnceConnected?.length || 0),
          });
        }
        const result = originalSend.call(this, data, ...args);
        if (selected.length) void Promise.resolve(result).then(
          () => selected.forEach(rpc => emit("WORKER_GET_FILE_SOCKET_SEND_SETTLED", rpc, { send_count: rpc.sentCount, queued_packets_after: Number(connection._sendOnceConnected?.length || 0) })),
          error => selected.forEach(rpc => emit("WORKER_GET_FILE_SOCKET_SEND_ERROR", rpc, { error_name: error instanceof Error ? error.name : "unknown" })),
        );
        return result;
      };
      restores.push(() => { connection.send = originalSend; });
    }
    const queuedPackets = connection._sendOnceConnected;
    if (queuedPackets && typeof queuedPackets.shift === "function") {
      const originalShift: AnyFunction = queuedPackets.shift;
      queuedPackets.shift = function (this: unknown, ...args: unknown[]) {
        const packet = originalShift.apply(this, args);
        const related = packet && typeof packet === "object" ? packetRpcs.get(packet) : undefined;
        for (const rpc of related || []) emit("WORKER_GET_FILE_SOCKET_QUEUE_DRAIN_BEGIN", rpc, { writer_present: Boolean(connection._writer) });
        return packet;
      };
      restores.push(() => { queuedPackets.shift = originalShift; });
    }
    // The enclosing onMessage timestamp is when the framed reader hands mtcute
    // a packet; this hook is after decryption but before parsing upload.file.
    if (typeof originalResult === "function") {
      connection._onRpcResult = function (this: unknown, incomingId: unknown, reader: any, ...args: unknown[]) {
        try {
          const readable = reader?.dataView && Number.isInteger(reader.pos) && reader.pos + 12 <= reader.dataView.byteLength;
          const reqId = readable ? String(reader.dataView.getBigInt64(reader.pos, true)) : null;
          const pending = reqId ? [...(connection._session?.pendingMessages?.entries?.() || [])]
            .find(([id]: [unknown, unknown]) => String(id) === reqId)?.[1] : null;
          const rpc = pending?.rpc && rpcByPending.get(pending.rpc);
          if (rpc) emit("WORKER_GET_FILE_RPC_RESULT_ENTER", rpc, {
            send_count: rpc.sentCount,
            physical_rpc_ordinal: rpc.physicalOrdinal ?? null,
            rpc_msg_id: reqId,
            acked: pending?.acked ?? null,
            response_frame_ts_ms: frameReceivedAtMs,
            frame_decode_ms: frameReceivedAtMs === null ? null : Math.round((traceClock().ts_ms - frameReceivedAtMs) * 10) / 10,
            websocket_message_ts_ms: frameSocketIngress?.lastAtMs ?? null,
            websocket_first_message_ts_ms: frameSocketIngress?.firstAtMs ?? null,
            websocket_message_count: frameSocketIngress?.messageCount ?? 0,
            framed_decode_ts_ms: frameSocketIngress?.frameDecodedAtMs ?? null,
            response_frame_bytes: frameSocketIngress?.frameBytes ?? null,
            connection_uid: connection._uid ?? null,
            socket_id: currentSocketId,
            rpc_error: reader.dataView.getUint32(reader.pos + 8, true) === 558156313,
          });
        } catch { /* A diagnostic lookup must not interrupt result handling. */ }
        return originalResult.call(this, incomingId, reader, ...args);
      };
      restores.push(() => { connection._onRpcResult = originalResult; });
    }
    if (typeof connection.onMessage === "function") {
      const originalOnMessage: AnyFunction = connection.onMessage;
      connection.onMessage = function (this: unknown, ...args: unknown[]) {
        if (!activeOperations) return originalOnMessage.apply(this, args);
        const previous = frameReceivedAtMs;
        const previousIngress = frameSocketIngress;
        try { frameReceivedAtMs = traceClock().ts_ms; } catch { frameReceivedAtMs = null; }
        frameSocketIngress = args[0] && typeof args[0] === "object" ? ingressByFrame.get(args[0]) || null : null;
        try { return originalOnMessage.apply(this, args); }
        finally { frameReceivedAtMs = previous; frameSocketIngress = previousIngress; }
      };
      restores.push(() => { connection.onMessage = originalOnMessage; });
    }
    if (typeof originalFailed === "function") {
      connection._onMessageFailed = function (this: unknown, messageId: unknown, reason: unknown, ...args: unknown[]) {
        try {
          const pending = connection._session?.pendingMessages?.get?.(messageId);
          const rpc = pending?.rpc && rpcByPending.get(pending.rpc);
          if (rpc) emit("WORKER_GET_FILE_RPC_RETRY", rpc, { reason: typeof reason === "string" && /^[a-zA-Z0-9_= -]{1,60}$/.test(reason) ? reason : "other", send_count: rpc.sentCount });
        } catch { /* Diagnostic lookup is optional. */ }
        return originalFailed.call(this, messageId, reason, ...args);
      };
      restores.push(() => { connection._onMessageFailed = originalFailed; });
    }
  };
  const refreshConnections = () => {
    try {
      const dcs = network?._dcConnections;
      if (!dcs || typeof dcs.values !== "function") return;
      for (const dc of dcs.values()) for (const kind of ["main", "download", "downloadSmall", "upload"]) {
        for (const connection of dc?.[kind]?._connections || []) observeConnection(connection);
      }
    } catch { /* Some mtcute versions may hide these internals. */ }
  };
  if (typeof core?.call === "function") {
    const original: AnyFunction = core.call;
    core.call = function (this: unknown, request: { _?: string; offset?: number; limit?: number; id?: Array<{ id?: number }> }, params?: { abortSignal?: AbortSignal }, ...args: unknown[]) {
      const operation = request?._ === "upload.getFile" ? params?.abortSignal && operations.get(params.abortSignal)
        : isGetMessages(request) ? messagesOperation(request) : undefined;
      if (!operation) return original.call(this, request, params, ...args);
      if (operation.kind === "messages") activeOperations += 1;
      emit("WORKER_GET_FILE_CALL_ENTER", operation, { offset_bytes: request.offset, limit_bytes: request.limit });
      const started = performance.now();
      let result: Promise<unknown>;
      try { result = original.call(this, request, params, ...args); }
      catch (error) {
        emit("WORKER_GET_FILE_CALL_ERROR", operation, { elapsed_ms: Math.round((performance.now() - started) * 10) / 10, error_name: error instanceof Error ? error.name : "unknown" });
        if (operation.kind === "messages") activeOperations -= 1;
        throw error;
      }
      return Promise.resolve(result).then(
        value => { emit("WORKER_GET_FILE_CALL_DONE", operation, { elapsed_ms: Math.round((performance.now() - started) * 10) / 10 }); if (operation.kind === "messages") activeOperations -= 1; return value; },
        error => { emit("WORKER_GET_FILE_CALL_ERROR", operation, { elapsed_ms: Math.round((performance.now() - started) * 10) / 10, error_name: error instanceof Error ? error.name : "unknown" }); if (operation.kind === "messages") activeOperations -= 1; throw error; },
      );
    };
    restores.push(() => { core.call = original; });
  }
  if (typeof network?._call === "function") {
    const original: AnyFunction = network._call;
    network._call = function (this: unknown, request: { _?: string; id?: Array<{ id?: number }> }, params?: { abortSignal?: AbortSignal; dcId?: number }, ...args: unknown[]) {
      const operation = request?._ === "upload.getFile" ? params?.abortSignal && operations.get(params.abortSignal)
        : isGetMessages(request) ? messagesOperation(request) : undefined;
      if (operation) {
        refreshConnections();
        emit("WORKER_GET_FILE_MIDDLEWARE_PASSED", operation, {
          target_dc_known: !params?.dcId || network._dcConnections?.has?.(params.dcId) === true,
          target_dc_differs: Boolean(params?.dcId && params.dcId !== network._primaryDc?.dcId),
        });
      }
      return original.call(this, request, params, ...args);
    };
    restores.push(() => { network._call = original; });
  }
  if (typeof network?._getOtherDc === "function") {
    const original: AnyFunction = network._getOtherDc;
    network._getOtherDc = async function (this: unknown, ...args: unknown[]) {
      const dc = await original.apply(this, args);
      refreshConnections();
      return dc;
    };
    restores.push(() => { network._getOtherDc = original; });
  }
  refreshConnections();
  playTrace("WORKER_GET_FILE_TRACE_CAPABILITY", {
    core_call: typeof core?.call === "function",
    network_call: typeof network?._call === "function",
    connection_count: [...(network?._dcConnections?.values?.() || [])].reduce((count: number, dc: any) => count + ["main", "download", "downloadSmall", "upload"].reduce((n, kind) => n + (dc?.[kind]?._connections?.length || 0), 0), 0),
    hooked_connections: hookedConnections,
  });
  if (options?.focusedMessageId) playTrace("WORKER_GET_MESSAGES_TRACE_CAPABILITY", { focused_only: true });
  return {
    async run<T>(signal: AbortSignal, fields: () => Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
      const trace: TraceOperation = { fields, rpcSequence: 0, kind: "file" };
      operations.set(signal, trace);
      activeOperations += 1;
      try { return await operation(); }
      finally { operations.delete(signal); activeOperations -= 1; }
    },
    detach() {
      enabled = false;
      for (const restore of restores.reverse()) restore();
    },
  };
}
