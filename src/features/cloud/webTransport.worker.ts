import { InputMedia, Long, MemoryStorage, MtPeerNotFoundError, SessionConnection, TelegramClient, WebCryptoProvider, type FileDownloadLocation } from "@mtcute/web";
import mtcuteWasmUrl from "@mtcute/wasm/mtcute.wasm?url";
import { Task2PacketLedger, task2DecryptWarningReason, task2Fingerprint, type Task2PacketIdentity } from "./task2PacketLedger";
import { armMtcuteIndexLivenessGuard } from "./mtcuteIndexLivenessGuard";
import { installMtcutePingSocketRecovery } from "./mtcutePingSocketRecovery";
import { installPlaybackGetFileTrace } from "./playbackGetFileTrace";
import { measureMp3PlayablePrefix } from "../audio/mp3PlayablePrefix";
import { playTrace, playTraceSpan } from "../playback/playTrace";
import type { WebVaultPeerRef } from "./webVaultPeerCache";
import {
  STARTUP_PREFIX_BYTES,
  WEB_DIRECT_MAX_FILE_BYTES,
  WEB_PLAYBACK_DATA_LANES,
  WEB_PLAYBACK_FIRST_CHUNK_BYTES,
  WEB_PLAYBACK_FIRST_CHUNK_KB,
  type WebTransportDownloadInput,
  type WebTransportDownloadResult,
  type WebTransportDeleteMessagesInput,
  type WebTransportDeleteMessagesResult,
  type WebTransportErrorCode,
  type WebTransportLibraryIndexResult,
  type WebTransportPrefetchBatchInput,
  type WebTransportPrefetchBatchItemResult,
  type WebTransportPrefetchBatchResult,
  type WebTransportPrefetchInput,
  type WebTransportPrefetchResult,
  type WebTransportPrefetchTerminal,
  type WebTransportReplaceIndexInput,
  type WebTransportReplaceIndexResult,
  type WebTransportStreamInput,
  type WebTransportStreamResult,
  type WebTransportUploadResult,
  type WebTransportWorkerCommand,
  type WebTransportWorkerResponse,
} from "./webTransportWorkerProtocol";

playTrace("WORKER_MODULE_READY");

type WorkerScope = {
  onmessage: ((event: MessageEvent<WebTransportWorkerCommand>) => void) | null;
  postMessage(message: WebTransportWorkerResponse, transfer?: Transferable[]): void;
};
type BoundTempLongJson = { low: number; high: number; unsigned: boolean };
type BoundTempSessionState = {
  seqNo: number;
  lastMessageId: BoundTempLongJson;
  timeOffset: number;
  serverSalt: BoundTempLongJson;
  queuedAcks: BoundTempLongJson[];
  bindMsgId: BoundTempLongJson;
  lastSessionCreatedUid: BoundTempLongJson;
};
type BoundTempSession = {
  initConnectionCalled: boolean;
  _sessionId?: any;
  _seqNo?: number;
  _lastMessageId?: any;
  _timeOffset?: number;
  _salts?: { currentSalt?: any };
  queuedAcks?: any[];
  recentOutgoingMsgIds?: { add(value: any): unknown };
  recentIncomingMsgIds?: { add(value: any): unknown };
  lastSessionCreatedUid?: any;
  lastPingMsgId?: any;
  lastPingTime?: number;
  lastPingRtt?: number;
};
type BoundTempConnection = {
  params?: { isMainConnection?: boolean; isMainDcConnection?: boolean; dc?: { id?: number } };
  _session?: BoundTempSession;
  _salts?: { currentSalt?: any };
};
type BoundTempPool = { _connections?: BoundTempConnection[] };
type BoundTempDcManager = { main?: BoundTempPool };
type BoundTempNetwork = { _dcConnections?: Map<number, BoundTempDcManager> };

class WorkerTransportError extends Error {
  constructor(readonly code: WebTransportErrorCode, message: string) {
    super(message);
    this.name = "WorkerTransportError";
  }
}

type CachedPlaybackMedia = {
  media: FileDownloadLocation;
  totalBytes: number;
  mimeType: string | null;
};
type ResolvedPlaybackMedia = CachedPlaybackMedia & { sourceMime: string | null; cacheHit: boolean };
type PlaybackMediaBatchResolution = {
  resolved: Map<number, ResolvedPlaybackMedia>;
  missing: Map<number, Error>;
};
type PendingPlaybackMedia = {
  generation: number;
  promise: Promise<ResolvedPlaybackMedia>;
  resolve(value: ResolvedPlaybackMedia): void;
  reject(error: unknown): void;
};
type CachedPlaybackRange = { bytes: Uint8Array; lastUsedAt: number };
type SharedPlaybackRange = {
  key: string;
  generation: number;
  messageId: number;
  offsetBytes: number;
  limit: number;
  priority: DataLanePriority;
  controller: AbortController;
  consumers: Set<string>;
  settled: boolean;
  promise: Promise<Uint8Array>;
};

type WarmState = "queued" | "active" | "preempted" | "ready" | "failed";
type BatchPrefetchState = {
  messageId: number;
  requestedMimeType: string | null;
  offsetBytes: number;
  media: FileDownloadLocation | null;
  totalBytes: number;
  mimeType: string;
  chunks: Uint8Array[];
  downloadedBytes: number;
  playableSeconds: number;
  targetMet: boolean;
  done: boolean;
  error: Error | null;
  errorCode: WebTransportErrorCode | null;
  terminalEmitted: boolean;
  warmState: WarmState;
  controller: AbortController | null;
  cancelled: boolean;
};
type PrefetchBatchControl = {
  requestId: string;
  cancelAll: boolean;
  cancelledMessageIds: Set<number>;
  states: BatchPrefetchState[];
  pendingWarm: BatchPrefetchState[];
  maxConcurrency: number;
};
type DataLanePriority = "foreground" | "warm";
type DataLaneWaiter = { resolve(): void; priority: DataLanePriority; messageId: number | null };
type PlaybackSchedulerState = "IDLE" | "PLAY_CRITICAL" | "PLAY_STABLE";
type IndexAbortReason = "play" | "warm" | "cancel";

const scope = globalThis as unknown as WorkerScope;
let stage1TraceContext: { correlation_id: string; account_label: string; task2_passive_ping_trace?: boolean } | null = null;
let detachMtprotoDiagnostics: (() => void) | null = null;
let detachMtprotoSessionDiagnostics: (() => void) | null = null;
let detachMtprotoPassivePingDiagnostics: (() => void) | null = null;
let detachMtprotoPingSocketRecovery: (() => void) | null = null;
let detachMtprotoPassiveIngressDiagnostics: (() => void) | null = null;
let playbackGetFileTrace: ReturnType<typeof installPlaybackGetFileTrace> | null = null;
// Diagnostic identities deliberately live only in the Worker. They do not
// affect a Direct lease, temporary authorization, retry policy, or reconnect.
const workerInstanceId = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `worker-${Date.now()}-${Math.random()}`;
let clientSerial = 0;
let activeClientInstanceId: string | null = null;
let activePrimaryDcId = 0;
let activeMtprotoRpc: { requestId: string; stage: string } | null = null;

function stage1Trace(requestId: string, stage: string, detail: Record<string, unknown> = {}): void {
  const context = stage1TraceContext;
  if (!context) return;
  scope.postMessage({
    requestId,
    event: "stage1-trace",
    trace: { ...context, stage, at_ms: Date.now(), monotonic_ms: performance.now(), detail },
  });
}

function mtprotoConnectionSnapshot(active: TelegramClient): Record<string, unknown> {
  // mtcute's public isConnected reports whether connect() completed. The
  // primary pool snapshot separately reports live socket state, which lets the
  // trace distinguish a stale connected client from a usable connection.
  const base = (active as any)._client || active;
  const network = base?.mt?.network as BoundTempNetwork | undefined;
  const diagnosticNetwork = network as any;
  const dcId = activePrimaryDcId || Number(diagnosticNetwork?.primaryDc?.id || diagnosticNetwork?._primaryDc?.id || 0) || null;
  const pool = dcId ? network?._dcConnections?.get(dcId)?.main : null;
  const connections = Array.isArray((pool as any)?._connections)
    ? (pool as any)._connections
    : [];
  return {
    worker_instance_id: workerInstanceId,
    client_instance_id: activeClientInstanceId,
    client_is_connected: Boolean(base?.isConnected ?? (active as any).isConnected),
    core_connected_flag: Boolean(base?._connected),
    primary_dc_id: dcId,
    primary_pool_is_connected: typeof (pool as any)?.isConnected === "boolean"
      ? Boolean((pool as any).isConnected)
      : null,
    primary_connection_count: connections.length,
    primary_connected_count: connections.filter((connection: any) => connection?.isConnected === true).length,
    rpc_context: activeMtprotoRpc ? { stage: activeMtprotoRpc.stage } : null,
  };
}

function task2PassivePingTraceEnabled(): boolean {
  return stage1TraceContext?.task2_passive_ping_trace === true;
}

type Task2IngressTrace = {
  markPingSend(pingMsgIds: string[]): void;
  clearPingSend(): void;
  bindConnection(connectionId: string): void;
  latestSocketId(): string | null;
  bindOutgoingLedger(ledger: Task2PacketLedger): void;
  bindSessionReader(reader: () => string | null): void;
  claimFramedBytes(length: number): { web_socket_frame_ids: string[]; input_byte_correlation: string };
  detach(): void;
};

/**
 * Passive browser WebSocket boundary trace for Task 2.  The wrapper preserves
 * the native socket and only observes its existing calls and events.  It is
 * installed before TelegramClient creates WebSocketTransport, which captures
 * the current WebSocket constructor during client construction.
 */
export function installTask2PassiveIngressTrace(requestId: string, clientInstanceId: string): Task2IngressTrace | null {
  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket !== "function") return null;

  let socketSerial = 0;
  let currentPingMsgIds: string[] = [];
  let latestSocketId: string | null = null;
  let connectionId: string | null = null;
  let outgoingLedger: Task2PacketLedger | null = null;
  let sessionReader: (() => string | null) | null = null;
  const socketFrames = new Map<string, {
    received: number;
    consumed: number;
    serial: number;
    frames: Array<{ id: string; start: number; end: number }>;
  }>();
  let enabled = true;
  const sockets = new Set<WebSocket>();
  const trace = (stage: string, detail: Record<string, unknown> = {}) => {
    if (!enabled) return;
    try {
      stage1Trace(requestId, stage, {
        client_instance_id: clientInstanceId,
        connection_id: connectionId,
        session_id: sessionReader?.() || null,
        ...detail,
      });
    } catch {
      // Diagnostics must never affect the transport.
    }
  };
  const sizeOf = (value: unknown): number | null => {
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof Blob) return value.size;
    if (typeof value === "string") return value.length;
    return null;
  };

  try {
    class ObservedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        const socket = this as WebSocket;
        const webSocketId = `${clientInstanceId}:ws-${++socketSerial}`;
        let sendSeq = 0;
        socketFrames.set(webSocketId, { received: 0, consumed: 0, serial: 0, frames: [] });
        latestSocketId = webSocketId;
        sockets.add(socket);
        trace("TASK2_INPUT_WEBSOCKET_CREATED", { web_socket_id: webSocketId });

        socket.addEventListener("message", event => {
          const incomingBytes = event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : ArrayBuffer.isView(event.data)
              ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
              : null;
          const stream = socketFrames.get(webSocketId);
          const webSocketFrameId = stream ? `${webSocketId}:frame-${++stream.serial}` : null;
          if (stream && webSocketFrameId && incomingBytes) {
            stream.frames.push({ id: webSocketFrameId, start: stream.received,
              end: stream.received + incomingBytes.byteLength });
            stream.received += incomingBytes.byteLength;
          }
          trace("TASK2_INPUT_WEBSOCKET_MESSAGE", {
            web_socket_id: webSocketId,
            web_socket_frame_id: webSocketFrameId,
            incoming_frame_bytes: sizeOf(event.data),
            incoming_frame_fingerprint: incomingBytes ? task2Fingerprint(incomingBytes) : null,
            incoming_data_kind: event.data instanceof ArrayBuffer
              ? "arraybuffer"
              : event.data instanceof Blob
                ? "blob"
                : typeof event.data,
          });
        });
        socket.addEventListener("error", () => {
          trace("TASK2_INPUT_WEBSOCKET_ERROR", { web_socket_id: webSocketId });
        });
        socket.addEventListener("close", event => {
          trace("TASK2_INPUT_WEBSOCKET_CLOSE", {
            web_socket_id: webSocketId,
            close_code: Number.isFinite(Number(event.code)) ? Number(event.code) : null,
            close_reason: String(event.reason || "").slice(0, 180),
            close_was_clean: Boolean(event.wasClean),
          });
        });

        const nativeSend = socket.send.bind(socket);
        (socket as any).send = (data: unknown) => {
          const currentSendSeq = ++sendSeq;
          const bufferedBefore = Number.isFinite(Number(socket.bufferedAmount))
            ? Number(socket.bufferedAmount)
            : null;
          const legacyPingMsgIds = [...currentPingMsgIds];
          const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
          const correlation = bytes && outgoingLedger ? outgoingLedger.matchSocketSend(bytes) : null;
          const pingMsgIds = correlation?.matched
            ? correlation.packets.flatMap(packet => packet.ping_msg_ids)
            : legacyPingMsgIds;
          trace("TASK2_INPUT_WEBSOCKET_SEND", {
            web_socket_id: webSocketId,
            send_seq: currentSendSeq,
            packet_bytes: sizeOf(data),
            buffered_amount_before: bufferedBefore,
            ping_msg_ids: pingMsgIds,
            encoded_fingerprint: correlation?.fingerprint || null,
            byte_correlation: correlation?.matched === true ? "exact" : "unmatched",
            packet_ids: correlation?.packet_ids || [],
            outgoing_packets: correlation?.packets || [],
          });
          try {
            const result = nativeSend(data as any);
            trace("TASK2_INPUT_WEBSOCKET_SEND_RETURNED", {
              web_socket_id: webSocketId,
              send_seq: currentSendSeq,
              packet_bytes: sizeOf(data),
              buffered_amount_after: Number.isFinite(Number(socket.bufferedAmount))
                ? Number(socket.bufferedAmount)
                : null,
              ping_msg_ids: pingMsgIds,
              encoded_fingerprint: correlation?.fingerprint || null,
              byte_correlation: correlation?.matched === true ? "exact" : "unmatched",
              packet_ids: correlation?.packet_ids || [],
            });
            return result;
          } catch (error) {
            trace("TASK2_INPUT_WEBSOCKET_SEND_THROW", {
              web_socket_id: webSocketId,
              send_seq: currentSendSeq,
              packet_bytes: sizeOf(data),
              ping_msg_ids: pingMsgIds,
              encoded_fingerprint: correlation?.fingerprint || null,
              packet_ids: correlation?.packet_ids || [],
              error_name: error instanceof Error ? error.name : "Error",
            });
            throw error;
          }
        };
      }
    }

    globalThis.WebSocket = ObservedWebSocket as typeof WebSocket;
  } catch {
    return null;
  }

  return {
    markPingSend(pingMsgIds) { currentPingMsgIds = [...pingMsgIds]; },
    clearPingSend() { currentPingMsgIds = []; },
    bindConnection(nextConnectionId) { connectionId = nextConnectionId; },
    latestSocketId: () => latestSocketId,
    bindOutgoingLedger(ledger) { outgoingLedger = ledger; },
    bindSessionReader(reader) { sessionReader = reader; },
    claimFramedBytes(length) {
      const stream = latestSocketId ? socketFrames.get(latestSocketId) : null;
      if (!stream || !Number.isSafeInteger(length) || length <= 0) {
        return { web_socket_frame_ids: [], input_byte_correlation: "unmatched" };
      }
      const start = stream.consumed;
      const end = start + length;
      const ids = stream.frames.filter(frame => frame.start < end && frame.end > start).map(frame => frame.id);
      stream.consumed = end;
      stream.frames = stream.frames.filter(frame => frame.end > end);
      return { web_socket_frame_ids: ids,
        input_byte_correlation: ids.length > 0 && end <= stream.received ? "stream_exact" : "unmatched" };
    },
    detach() {
      enabled = false;
      if (globalThis.WebSocket !== NativeWebSocket) {
        globalThis.WebSocket = NativeWebSocket;
      }
      sockets.clear();
      socketFrames.clear();
    },
  };
}

function primarySessionConnection(active: TelegramClient): any | null {
  const base = (active as any)._client || active;
  return base?.mt?.network?._dcConnections?.get(activePrimaryDcId)?.main?._connections?.[0] || null;
}

function pingTraceSnapshot(active: TelegramClient, connection = primarySessionConnection(active)): Record<string, unknown> {
  const session = connection?._session as BoundTempSession | undefined;
  const lastPingMsgId = session?.lastPingMsgId as any;
  const pending = Boolean(lastPingMsgId && (typeof lastPingMsgId.isZero !== "function" || !lastPingMsgId.isZero()));
  const finite = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    connection_id: connection ? `${activeClientInstanceId || "unknown-client"}:dc-${activePrimaryDcId}:primary-0:uid-${String(connection._uid ?? "unknown")}` : null,
    connection_uid: connection?._uid ?? null,
    session_id: session?._sessionId ? String(session._sessionId) : null,
    last_ping_pending: pending,
    last_ping_msg_id: pending ? String(lastPingMsgId) : null,
    last_ping_time_monotonic_ms: finite(session?.lastPingTime),
    last_ping_rtt_ms: finite(session?.lastPingRtt),
  };
}

/**
 * Task 2 passive instrumentation. The hooks only read mtcute's existing
 * SessionConnection state around methods mtcute invokes itself. They do not
 * schedule work, wait, send RPCs, or alter the connection outcome.
 */
export function observeMtprotoPassivePing(
  active: TelegramClient,
  requestId: string,
  ingressTrace: Task2IngressTrace | null = null,
): () => void {
  const connection = primarySessionConnection(active);
  const session = connection?._session as any;
  if (!connection || !session) return () => {};

  // This observer is limited to calls mtcute already makes. It does not
  // schedule work, send data, or alter mtcute return values.
  const PING_DELAY_DISCONNECT_ID = 4_081_220_492;
  const messageId = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  const pingFromSerializedBytes = (value: unknown): string | null => {
    if (!ArrayBuffer.isView(value) || value.byteLength < 12) return null;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== PING_DELAY_DISCONNECT_ID) return null;
    return typeof view.getBigInt64 === "function"
      ? String(view.getBigInt64(4, true))
      : Array.from(bytes.slice(4, 12)).reverse()
        .reduce((result, byte) => result * 256n + BigInt(byte), 0n).toString();
  };
  const pingRecords = new Map<string, {
    pingId: string;
    pendingKey: unknown;
    containerId: string | null;
    containerKey: unknown;
  }>();
  const packetLedger = new Task2PacketLedger();
  ingressTrace?.bindOutgoingLedger(packetLedger);
  ingressTrace?.bindSessionReader(() => session?._sessionId ? String(session._sessionId) : null);
  const packetIdentities = new WeakMap<object, Task2PacketIdentity>();
  const innerPackets: Array<{ bytes: Uint8Array; identity: Task2PacketIdentity }> = [];
  const rpcRecords = new Map<string, { logicalId: number; method: string }>();
  const rpcLogicalIds = new WeakMap<object, number>();
  let nextRpcLogicalId = 0;
  let nextPacketId = 0;
  let nextEncodedSeq = 0;
  let flushPingIds: string[] | null = null;
  let flushRpcMsgIds: string[] | null = null;
  let resetOrigin: string | null = null;
  let ackOrigin: string | null = null;
  const trace = (stage: string, detail: Record<string, unknown> = {}) => stage1Trace(requestId, stage, {
    ...pingTraceSnapshot(active, connection),
    ...mtprotoConnectionSnapshot(active),
    web_socket_id: ingressTrace?.latestSocketId() || null,
    ...detail,
  });
  const observedConnectionId = String(pingTraceSnapshot(active, connection).connection_id || "");
  if (observedConnectionId) ingressTrace?.bindConnection(observedConnectionId);
  const tracePingRecords = (ids: string[], detail: Record<string, unknown>) => {
    ids.forEach(pingMsgId => {
      const record = pingRecords.get(pingMsgId);
      const pending = record ? session.pendingMessages?.get?.(record.pendingKey) : null;
      trace("TASK2_PING_BATCH_CONTAINER", {
        ping_msg_id: pingMsgId,
        ping_id: record?.pingId || null,
        container_id: messageId(pending?.containerId) || record?.containerId || pingMsgId,
        pending_message_present: Boolean(pending),
        ...detail,
      });
    });
  };
  const isTrackedPingOrContainer = (id: unknown): string[] => {
    const key = messageId(id);
    if (!key) return [];
    return [...pingRecords.entries()]
      .filter(([pingMsgId, record]) => pingMsgId === key || record.containerId === key)
      .map(([pingMsgId]) => pingMsgId);
  };

  const originalDoFlush = connection._doFlush;
  const originalWriteMessage = session.writeMessage;
  const originalPendingSet = session.pendingMessages?.set;
  const originalSend = connection.send;
  const originalPong = connection._onPong;
  const originalAck = connection._onMessageAcked;
  const originalFailed = connection._onMessageFailed;
  const originalResetLastPing = session.resetLastPing;
  const originalResetState = session.resetState;
  const originalResetSession = connection._resetSession;
  const originalOnMessage = connection.onMessage;
  const originalDecryptMessage = session.decryptMessage;
  const originalHandleRawMessage = connection._handleRawMessage;
  const originalHandleMessage = connection._handleMessage;
  const originalHandleError = connection.handleError;
  const originalCodecDecode = connection._codec?.decode;
  const originalCodecEncode = connection._codec?.encode;
  const originalInnerEncode = connection._codec?._inner?.encode;
  const originalRpcResult = connection._onRpcResult;
  const originalRegisterOutgoing = connection._registerOutgoingMsgId;
  const frameIds = new WeakMap<object, number>();
  let nextFrameId = 0;
  let activeFrameId: number | null = null;
  const encryptorRestores: Array<() => void> = [];
  const observedEncryptors = new WeakSet<object>();
  const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
    left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
  const bindEncryptor = () => {
    const encryptor = connection._codec?._encryptor;
    if (!encryptor || observedEncryptors.has(encryptor) || typeof encryptor.process !== "function") return;
    const originalProcess = encryptor.process;
    const observedProcess = function (this: unknown, plain: Uint8Array, ...args: unknown[]) {
      const cipher = originalProcess.call(this, plain, ...args);
      const index = innerPackets.findIndex(packet => sameBytes(packet.bytes, plain));
      if (index >= 0 && ArrayBuffer.isView(cipher)) {
        const [packet] = innerPackets.splice(index, 1);
        const record = packetLedger.recordEncoded({ ...packet.identity, encode_seq: ++nextEncodedSeq },
          new Uint8Array(cipher.buffer, cipher.byteOffset, cipher.byteLength));
        trace("TASK2_OUTPUT_PACKET_ENCODED", record);
        if (packet.identity.ping_msg_ids.length || packet.identity.rpc_msg_ids.length) {
          trace("TASK2_PING_PACKET_ENCODED", record);
        }
      }
      return cipher;
    };
    try {
      encryptor.process = observedProcess;
    } catch (error) {
      trace("TASK2_PING_ENCRYPTOR_HOOK_FAILED", {
        error_name: error instanceof Error ? error.name : "Error",
      });
      return;
    }
    observedEncryptors.add(encryptor);
    encryptorRestores.push(() => { if (encryptor.process === observedProcess) encryptor.process = originalProcess; });
  };
  bindEncryptor();
  trace("TASK2_PING_OBSERVER_CAPABILITY", {
    websocket_observer: Boolean(ingressTrace),
    inner_encode_hook: typeof originalInnerEncode === "function",
    encryptor_process_hook: Boolean(connection._codec?._encryptor &&
      observedEncryptors.has(connection._codec._encryptor)),
    decrypt_hook: typeof originalDecryptMessage === "function",
    rpc_result_hook: typeof originalRpcResult === "function",
  });
  const onUsable = () => {
    const unmatchedPacketIds = packetLedger.clear();
    innerPackets.length = 0;
    if (unmatchedPacketIds.length) trace("TASK2_PING_UNMATCHED_PACKETS_AT_CONNECT", {
      packet_ids: unmatchedPacketIds,
    });
    bindEncryptor();
    trace("TASK2_PING_SOCKET_CONNECTED");
  };
  if (typeof connection.onUsable?.add === "function") connection.onUsable.add(onUsable);

  if (typeof originalWriteMessage === "function") {
    session.writeMessage = function (this: unknown, writer: unknown, content: unknown, ...args: unknown[]) {
      const pingId = pingFromSerializedBytes(content);
      const result = originalWriteMessage.call(this, writer, content, ...args);
      if (pingId !== null) {
        const pingMsgId = messageId(result);
        if (pingMsgId) {
          pingRecords.set(pingMsgId, {
            pingId,
            pendingKey: result,
            containerId: pingMsgId,
            containerKey: result,
          });
          flushPingIds?.push(pingMsgId);
          trace("TASK2_PING_SERIALIZED_WRITE_MESSAGE", {
            ping_msg_id: pingMsgId,
            ping_id: pingId,
            serialized_byte_length: ArrayBuffer.isView(content) ? content.byteLength : null,
          });
        }
      }
      return result;
    };
  }
  if (typeof originalPendingSet === "function") {
    session.pendingMessages.set = function (this: unknown, key: unknown, value: any) {
      const result = originalPendingSet.call(this, key, value);
      if (value?._ === "ping") {
        const pingMsgId = messageId(key);
        if (pingMsgId) {
          const record = pingRecords.get(pingMsgId);
          if (record) {
            record.pendingKey = key;
            record.containerId = messageId(value.containerId) || pingMsgId;
            record.containerKey = value.containerId || key;
          }
          trace("TASK2_PING_PENDING_MESSAGES_SET", {
            ping_msg_id: pingMsgId,
            ping_id: messageId(value.pingId) || record?.pingId || null,
            container_id: messageId(value.containerId) || pingMsgId,
          });
        }
      }
      if (value?._ === "rpc" && value.rpc?.method === "channels.getMessages") {
        const rpcMsgId = messageId(key);
        if (rpcMsgId) {
          let logicalId = rpcLogicalIds.get(value.rpc);
          if (!logicalId) {
            logicalId = ++nextRpcLogicalId;
            rpcLogicalIds.set(value.rpc, logicalId);
          }
          rpcRecords.set(rpcMsgId, { logicalId, method: value.rpc.method });
          flushRpcMsgIds?.push(rpcMsgId);
          trace("TASK2_PING_RPC_PENDING_SET", {
            rpc_msg_id: rpcMsgId,
            rpc_logical_id: logicalId,
            rpc_method: value.rpc.method,
          });
        }
      }
      if (value?._ === "container") {
        for (const pingMsgId of value.msgIds || []) {
          const keyId = messageId(pingMsgId);
          const record = keyId ? pingRecords.get(keyId) : null;
          if (record) {
            record.containerId = messageId(key) || null;
            record.containerKey = key;
          }
        }
      }
      return result;
    };
  }
  if (typeof originalRegisterOutgoing === "function") {
    connection._registerOutgoingMsgId = function (this: unknown, outgoingMsgId: unknown, ...args: unknown[]) {
      const pending = session.pendingMessages?.get?.(outgoingMsgId);
      if (pending?._ === "rpc" && pending.rpc?.method === "channels.getMessages") {
        const rpcMsgId = messageId(outgoingMsgId);
        if (rpcMsgId) flushRpcMsgIds?.push(rpcMsgId);
      }
      return originalRegisterOutgoing.call(this, outgoingMsgId, ...args);
    };
  }
  if (typeof originalDoFlush === "function") {
    connection._doFlush = function (this: unknown, ...args: unknown[]) {
      const before = pingTraceSnapshot(active, connection);
      const parent = flushPingIds;
      const parentRpc = flushRpcMsgIds;
      flushPingIds = [];
      flushRpcMsgIds = [];
      try {
        const result = originalDoFlush.apply(this, args);
        const after = pingTraceSnapshot(active, connection);
        if (before.last_ping_pending !== true && after.last_ping_pending === true) {
          trace("TASK2_PING_PING_SENT", {
            ping_msg_id: after.last_ping_msg_id,
            ping_sent_at_monotonic_ms: after.last_ping_time_monotonic_ms,
          });
        }
        return result;
      } finally {
        flushPingIds = parent;
        flushRpcMsgIds = parentRpc;
      }
    };
  }
  if (typeof originalSend === "function") {
    connection.send = function (this: unknown, data: unknown, ...args: unknown[]) {
      const ids = [...(flushPingIds || [])];
      const rpcMsgIds = [...new Set(flushRpcMsgIds || [])];
      const containerMsgIds = [...new Set([...ids, ...rpcMsgIds]
        .map(id => {
          const record = pingRecords.get(id);
          const pending = record ? session.pendingMessages?.get?.(record.pendingKey) :
            [...session.pendingMessages.keys()].find((key: unknown) => messageId(key) === id);
          return record
            ? messageId(pending?.containerId) || record.containerId
            : messageId((session.pendingMessages?.get?.(pending) as any)?.rpc?.containerId);
        })
        .filter((id): id is string => Boolean(id)))];
      const packet: Task2PacketIdentity = {
        packet_id: ++nextPacketId,
        ping_msg_ids: ids,
        rpc_msg_ids: rpcMsgIds,
        container_msg_ids: containerMsgIds,
        session_id: session?._sessionId ? String(session._sessionId) : null,
      };
      if (data && typeof data === "object") packetIdentities.set(data as object, packet);
      const persistentWriterPresentAtCall = Boolean(connection._writer);
      if (ids.length) {
        tracePingRecords(ids, {
          phase: "before_send",
          encrypted_byte_length: ArrayBuffer.isView(data) ? data.byteLength : null,
          persistent_writer_present: persistentWriterPresentAtCall,
          queued_before_send: Number(connection._sendOnceConnected?.length || 0),
        });
        trace("TASK2_PING_SEND_CALLED", {
          ping_msg_ids: ids,
          rpc_msg_ids: rpcMsgIds,
          packet_id: packet.packet_id,
          container_msg_ids: containerMsgIds,
          encrypted_byte_length: ArrayBuffer.isView(data) ? data.byteLength : null,
          persistent_writer_present: persistentWriterPresentAtCall,
          queued_before_send: Number(connection._sendOnceConnected?.length || 0),
        });
      }
      if (ids.length) ingressTrace?.markPingSend(ids);
      let result: unknown;
      try {
        result = originalSend.call(this, data, ...args);
      } finally {
        if (ids.length) ingressTrace?.clearPingSend();
      }
      if (ids.length && result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).then(
          () => trace("TASK2_PING_SEND_RESOLVED", {
            ping_msg_ids: ids,
            rpc_msg_ids: rpcMsgIds,
            packet_id: packet.packet_id,
            persistent_writer_present_at_call: persistentWriterPresentAtCall,
            semantics: "PersistentConnection.send resolved",
          }),
          error => trace("TASK2_PING_SEND_REJECTED", {
            ping_msg_ids: ids,
            rpc_msg_ids: rpcMsgIds,
            packet_id: packet.packet_id,
            error_name: error instanceof Error ? error.name : String(error || "Error"),
          }),
        );
      }
      return result;
    };
  }
  if (typeof originalInnerEncode === "function") {
    connection._codec._inner.encode = function (this: unknown, data: Uint8Array, into: any, ...args: unknown[]) {
      const result = originalInnerEncode.call(this, data, into, ...args);
      const identity = packetIdentities.get(data) || {
        packet_id: ++nextPacketId,
        ping_msg_ids: [],
        rpc_msg_ids: [],
        container_msg_ids: [],
        session_id: session?._sessionId ? String(session._sessionId) : null,
      };
      // IntermediatePacketCodec.encode is synchronous in the pinned mtcute 0.31.0.
      // The obfuscation layer awaits it, then passes precisely these bytes to CTR.
      innerPackets.push({ bytes: new Uint8Array(into.result()).slice(), identity });
      return result;
    };
  }
  if (typeof originalCodecEncode === "function") {
    connection._codec.encode = function (this: unknown, ...args: unknown[]) {
      // A reconnect resets the CTR object. Queued writes can flush before
      // onUsable fires, so bind its replacement at the encoding boundary.
      bindEncryptor();
      return originalCodecEncode.apply(this, args);
    };
  }
  if (typeof originalCodecDecode === "function") {
    connection._codec.decode = async function (this: unknown, buffer: any, eof: unknown, ...args: unknown[]) {
      trace("TASK2_INPUT_FRAMED_READER_DECODE_BEGIN", {
        framed_buffer_available: Number.isFinite(Number(buffer?.available)) ? Number(buffer.available) : null,
        framed_eof: Boolean(eof),
      });
      try {
        const frame = await originalCodecDecode.call(this, buffer, eof, ...args);
        if (frame !== null && frame !== undefined) {
          const frameId = ++nextFrameId;
          if (typeof frame === "object") frameIds.set(frame, frameId);
          // IntermediatePacketCodec contributes one four-byte length field to
          // each MTProto frame. AES-CTR obfuscation preserves byte count.
          const inputLink = ArrayBuffer.isView(frame)
            ? ingressTrace?.claimFramedBytes(frame.byteLength + 4) : null;
          trace("TASK2_INPUT_FRAMED_READER_FRAME", {
            frame_id: frameId,
            web_socket_frame_ids: inputLink?.web_socket_frame_ids || [],
            input_byte_correlation: inputLink?.input_byte_correlation || "unmatched",
            frame_fingerprint: ArrayBuffer.isView(frame)
              ? task2Fingerprint(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)) : null,
            framed_frame_bytes: ArrayBuffer.isView(frame) ? frame.byteLength : null,
          });
        }
        return frame;
      } catch (error) {
        trace("TASK2_INPUT_FRAMED_READER_ERROR", {
          error_name: error instanceof Error ? error.name : "Error",
          error_message: diagnosticErrorMessage(error),
        });
        throw error;
      }
    };
  }
  if (typeof originalOnMessage === "function") {
    connection.onMessage = function (this: unknown, data: unknown, ...args: unknown[]) {
      const priorFrameId = activeFrameId;
      activeFrameId = data && typeof data === "object" ? frameIds.get(data) || null : null;
      trace("TASK2_INPUT_SESSION_ON_MESSAGE_ENTER", {
        frame_id: activeFrameId,
        framed_frame_bytes: ArrayBuffer.isView(data) ? data.byteLength : null,
      });
      try {
        const result = originalOnMessage.call(this, data, ...args);
        trace("TASK2_INPUT_SESSION_ON_MESSAGE_EXIT", {
          frame_id: activeFrameId,
          framed_frame_bytes: ArrayBuffer.isView(data) ? data.byteLength : null,
        });
        return result;
      } catch (error) {
        trace("TASK2_INPUT_SESSION_ON_MESSAGE_THROW", {
          frame_id: activeFrameId,
          error_name: error instanceof Error ? error.name : "Error",
          error_message: diagnosticErrorMessage(error),
        });
        throw error;
      } finally {
        activeFrameId = priorFrameId;
      }
    };
  }
  if (typeof originalDecryptMessage === "function") {
    session.decryptMessage = function (this: unknown, data: unknown, callback: (...args: unknown[]) => unknown, ...args: unknown[]) {
      let callbackInvoked = false;
      let rejectionReason: string | null = null;
      const logs = [session.log, session._authKey?.log, session._authKeyTemp?.log, session._authKeyTempSecondary?.log]
        .filter((value: any, index: number, all: any[]) => value && all.indexOf(value) === index);
      const restoreWarnings: Array<() => void> = [];
      for (const log of logs) {
        const originalWarn = log.warn;
        if (typeof originalWarn !== "function") continue;
        const observedWarn = function (this: unknown, format: unknown, ...warnArgs: unknown[]) {
          rejectionReason ||= task2DecryptWarningReason(String(format));
          return originalWarn.apply(this, [format, ...warnArgs]);
        };
        log.warn = observedWarn;
        restoreWarnings.push(() => { if (log.warn === observedWarn) log.warn = originalWarn; });
      }
      trace("TASK2_INPUT_MTPROTO_DECRYPT_BEGIN", {
        frame_id: activeFrameId,
        encrypted_message_bytes: ArrayBuffer.isView(data) ? data.byteLength : null,
      });
      try {
        const result = originalDecryptMessage.call(this, data, (...messageArgs: unknown[]) => {
          callbackInvoked = true;
          trace("TASK2_INPUT_MTPROTO_VALID_CALLBACK", { frame_id: activeFrameId });
          return callback(...messageArgs);
        }, ...args);
        trace("TASK2_INPUT_MTPROTO_DECRYPT_RESULT", {
          frame_id: activeFrameId,
          callback_invoked: callbackInvoked,
          validation_outcome: callbackInvoked ? "accepted" : "discarded",
          validation_reason: callbackInvoked ? null : rejectionReason || "no_callback_unclassified",
          encrypted_message_bytes: ArrayBuffer.isView(data) ? data.byteLength : null,
        });
        return result;
      } catch (error) {
        trace("TASK2_INPUT_MTPROTO_DECRYPT_ERROR", {
          frame_id: activeFrameId,
          error_name: error instanceof Error ? error.name : "Error",
          error_message: diagnosticErrorMessage(error),
        });
        throw error;
      } finally {
        restoreWarnings.forEach(restore => restore());
      }
    };
  }
  if (typeof originalHandleRawMessage === "function") {
    connection._handleRawMessage = function (this: unknown, incomingMsgId: unknown, seqNo: unknown, reader: any, ...args: unknown[]) {
      const originalUint = reader?.uint;
      let uintCalls = 0;
      if (typeof originalUint === "function") {
        reader.uint = function (this: unknown, ...uintArgs: unknown[]) {
          const value = originalUint.apply(this, uintArgs);
          uintCalls += 1;
          if (uintCalls === 1) {
            const objectId = Number(value);
            try { reader.__task2RawObjectId = objectId; } catch {}
            trace("TASK2_INPUT_MT_RAW_OBJECT", {
              incoming_msg_id: messageId(incomingMsgId),
              incoming_seq_no: Number.isFinite(Number(seqNo)) ? Number(seqNo) : null,
              object_id_hex: Number.isFinite(objectId) ? `0x${objectId.toString(16)}` : null,
              raw_kind: objectId === 1_945_237_724 ? "container" : objectId === 812_830_625 ? "gzip_packed" : "object",
            });
          } else if (uintCalls === 2 && Number((reader as any).__task2RawObjectId) === 1_945_237_724) {
            trace("TASK2_INPUT_MT_CONTAINER", {
              incoming_msg_id: messageId(incomingMsgId),
              container_message_count: Number.isFinite(Number(value)) ? Number(value) : null,
            });
          }
          return value;
        };
        // The marker is read only by this wrapper and is removed below.
        try { reader.__task2RawObjectId = undefined; } catch {}
      }
      try {
        return originalHandleRawMessage.call(this, incomingMsgId, seqNo, reader, ...args);
      } finally {
        if (typeof originalUint === "function") {
          try { reader.uint = originalUint; } catch {}
        }
      }
    };
  }
  if (typeof originalHandleMessage === "function") {
    connection._handleMessage = function (this: unknown, incomingMsgId: unknown, message: any, ...args: unknown[]) {
      const stateRequest = message?._ === "mt_msgs_state_info"
        ? session.pendingMessages?.get?.(message.reqMsgId) : null;
      const stateRequestedIds = stateRequest?._ === "state"
        ? stateRequest.msgIds : message?._ === "mt_msgs_state_info"
          ? session.recentStateRequests?.get?.(message.reqMsgId) : null;
      trace("TASK2_INPUT_MT_MESSAGE_DECODED", {
        frame_id: activeFrameId,
        incoming_msg_id: messageId(incomingMsgId),
        mt_message_type: typeof message?._ === "string" ? message._ : "unknown",
        mt_is_pong: message?._ === "mt_pong",
        ack_msg_ids: message?._ === "mt_msgs_ack" && Array.isArray(message.msgIds)
          ? message.msgIds.map(messageId).filter(Boolean) : null,
        state_request_msg_id: messageId(message?.reqMsgId),
        state_requested_msg_ids: Array.isArray(stateRequestedIds)
          ? stateRequestedIds.map(messageId).filter(Boolean) : null,
        state_info_codes: message?._ === "mt_msgs_state_info" && ArrayBuffer.isView(message.info)
          ? Array.from(new Uint8Array(message.info.buffer, message.info.byteOffset, message.info.byteLength)) : null,
      });
      const priorAckOrigin = ackOrigin;
      if (message?._ === "mt_msgs_ack") ackOrigin = "server_mt_msgs_ack";
      try {
        return originalHandleMessage.call(this, incomingMsgId, message, ...args);
      } finally {
        ackOrigin = priorAckOrigin;
      }
    };
  }
  if (typeof originalHandleError === "function") {
    connection.handleError = function (this: unknown, error: unknown, ...args: unknown[]) {
      trace("TASK2_INPUT_TRANSPORT_ERROR", {
        error_name: error instanceof Error ? error.name : "Error",
        error_message: diagnosticErrorMessage(error),
      });
      return originalHandleError.call(this, error, ...args);
    };
  }
  if (typeof originalAck === "function") {
    connection._onMessageAcked = function (this: unknown, ackMsgId: unknown, ...args: unknown[]) {
      const relatedPingMsgIds = isTrackedPingOrContainer(ackMsgId);
      if (relatedPingMsgIds.length) {
        trace("TASK2_PING_ACK_OBSERVED", {
          ack_msg_id: messageId(ackMsgId),
          related_ping_msg_ids: relatedPingMsgIds,
          ack_origin: ackOrigin || "internal",
        });
      }
      const ackId = messageId(ackMsgId);
      const acked = session.pendingMessages?.get?.(ackMsgId);
      const rpcMsgIds = acked?._ === "container"
        ? (acked.msgIds || []).map(messageId).filter((id: string | null): id is string => Boolean(id))
        : ackId ? [ackId] : [];
      for (const rpcMsgId of rpcMsgIds) {
        const rpcRecord = rpcRecords.get(rpcMsgId);
        if (rpcRecord) trace("TASK2_PING_RPC_ACK_OBSERVED", {
          rpc_msg_id: rpcMsgId,
          rpc_logical_id: rpcRecord.logicalId,
          ack_msg_id: ackId,
          ack_origin: ackOrigin || "internal",
        });
      }
      return originalAck.call(this, ackMsgId, ...args);
    };
  }
  if (typeof originalRpcResult === "function") {
    connection._onRpcResult = function (this: unknown, incomingMsgId: unknown, reader: any, ...args: unknown[]) {
      const reqMsgId = reader?.dataView && Number.isInteger(reader.pos) && reader.pos + 8 <= reader.dataView.byteLength
        ? String(reader.dataView.getBigInt64(reader.pos, true)) : null;
      trace("TASK2_INPUT_RPC_RESULT_OBSERVED", {
        frame_id: activeFrameId,
        incoming_msg_id: messageId(incomingMsgId),
        rpc_msg_id: reqMsgId,
        rpc_method: reqMsgId
          ? [...session.pendingMessages.entries()].find(([key]: [unknown, unknown]) => messageId(key) === reqMsgId)?.[1]?.rpc?.method || null
          : null,
      });
      const record = reqMsgId ? rpcRecords.get(reqMsgId) : null;
      if (record) trace("TASK2_PING_RPC_RESULT_ENTER", {
        frame_id: activeFrameId,
        rpc_msg_id: reqMsgId,
        rpc_logical_id: record.logicalId,
        incoming_msg_id: messageId(incomingMsgId),
      });
      const priorAckOrigin = ackOrigin;
      ackOrigin = "rpc_result";
      let result: unknown;
      try {
        result = originalRpcResult.call(this, incomingMsgId, reader, ...args);
      } finally {
        ackOrigin = priorAckOrigin;
      }
      if (record) trace("TASK2_PING_RPC_RESULT_HANDLED", {
        frame_id: activeFrameId,
        rpc_msg_id: reqMsgId,
        rpc_logical_id: record.logicalId,
        pending_after_result: [...session.pendingMessages.keys()]
          .some((key: unknown) => messageId(key) === reqMsgId),
      });
      return result;
    };
  }
  if (typeof originalPong === "function") {
    connection._onPong = function (this: unknown, pong: any, ...args: unknown[]) {
      const before = pingTraceSnapshot(active, connection);
      const pongMsgId = messageId(pong?.msgId);
      const pongPingId = messageId(pong?.pingId);
      const info = pong?.msgId ? session.pendingMessages?.get?.(pong.msgId) : null;
      const expectedPingId = messageId(info?.pingId);
      const lookup = !info ? "unknown" : info._ === "ping" ? "ping" : String(info._);
      trace("TASK2_PING_PONG_OBSERVED", {
        frame_id: activeFrameId,
        pong_msg_id: pongMsgId,
        pong_ping_id: pongPingId,
        pending_lookup: lookup,
        expected_ping_id: expectedPingId,
        ping_id_matches: info?._ === "ping" ? expectedPingId === pongPingId : null,
        current_last_ping_matches: pongMsgId !== null && pongMsgId === messageId(session.lastPingMsgId),
        last_ping_msg_id_before: before.last_ping_msg_id,
      });
      const priorOrigin = resetOrigin;
      const priorAckOrigin = ackOrigin;
      resetOrigin = "on_pong";
      ackOrigin = "pong";
      try {
        const result = originalPong.call(this, pong, ...args);
        const after = pingTraceSnapshot(active, connection);
        if (before.last_ping_pending === true && after.last_ping_pending !== true) {
          trace("TASK2_PING_PONG_RECEIVED", {
            ping_msg_id: before.last_ping_msg_id,
            ping_sent_at_monotonic_ms: before.last_ping_time_monotonic_ms,
            pong_msg_id: pongMsgId,
            pong_ping_id: pongPingId,
          });
        }
        trace("TASK2_PING_PONG_HANDLED", {
          frame_id: activeFrameId,
          pong_msg_id: pongMsgId,
          pong_ping_id: pongPingId,
          pending_lookup: lookup,
          last_ping_msg_id_after: after.last_ping_msg_id,
          outcome: lookup === "unknown"
            ? "unknown"
            : lookup !== "ping"
              ? "not_ping"
              : expectedPingId === pongPingId
                ? "known_match"
                : "known_ping_id_mismatch",
        });
        return result;
      } finally {
        resetOrigin = priorOrigin;
        ackOrigin = priorAckOrigin;
      }
    };
  }
  if (typeof originalFailed === "function") {
    connection._onMessageFailed = function (this: unknown, failedMsgId: unknown, reason: unknown, ...args: unknown[]) {
      const info = session.pendingMessages?.get?.(failedMsgId);
      const relatedPingMsgIds = isTrackedPingOrContainer(failedMsgId);
      if (info?._ === "ping" || relatedPingMsgIds.length) {
        trace("TASK2_PING_MESSAGE_FAILED", {
          failed_msg_id: messageId(failedMsgId),
          failure_reason: String(reason || ""),
          pending_lookup: info?._ || "unknown",
          related_ping_msg_ids: relatedPingMsgIds,
        });
      }
      const rpcMsgId = messageId(failedMsgId);
      const rpcRecord = rpcMsgId ? rpcRecords.get(rpcMsgId) : null;
      if (rpcRecord) trace("TASK2_PING_RPC_MESSAGE_FAILED", {
        rpc_msg_id: rpcMsgId,
        rpc_logical_id: rpcRecord.logicalId,
        failure_reason: String(reason || ""),
      });
      const priorOrigin = resetOrigin;
      resetOrigin = "on_message_failed:" + String(reason || "");
      try {
        const result = originalFailed.call(this, failedMsgId, reason, ...args);
        if (rpcRecord && info?.rpc) trace("TASK2_PING_RPC_REENQUEUE_STATE", {
          rpc_msg_id: rpcMsgId,
          rpc_logical_id: rpcRecord.logicalId,
          rpc_msg_id_after: messageId(info.rpc.msgId),
          queued_after_failure: [...session.queuedRpc].includes(info.rpc),
        });
        return result;
      } finally {
        resetOrigin = priorOrigin;
      }
    };
  }
  if (typeof originalResetState === "function") {
    session.resetState = function (this: unknown, ...args: unknown[]) {
      const priorOrigin = resetOrigin;
      resetOrigin ||= "session_reset_state";
      try {
        return originalResetState.apply(this, args);
      } finally {
        resetOrigin = priorOrigin;
      }
    };
  }
  if (typeof originalResetSession === "function") {
    connection._resetSession = function (this: unknown, reason: unknown, ...args: unknown[]) {
      const priorOrigin = resetOrigin;
      resetOrigin = "reset_session:" + String(reason || "");
      try {
        return originalResetSession.call(this, reason, ...args);
      } finally {
        resetOrigin = priorOrigin;
      }
    };
  }
  if (typeof originalResetLastPing === "function") {
    session.resetLastPing = function (this: unknown, withTime = false, ...args: unknown[]) {
      const previousMsgId = messageId(session.lastPingMsgId);
      const previousTime = session.lastPingTime;
      const activeBefore = Boolean(connection._active);
      const activeNow = typeof connection._isActive === "function"
        ? Boolean(connection._isActive())
        : null;
      const inferredOrigin = resetOrigin ||
        (activeBefore === false && activeNow === true
          ? "inactive_to_active"
          : "other");
      trace("TASK2_PING_RESET_LAST_PING", {
        reset_origin: inferredOrigin,
        reset_with_time: Boolean(withTime),
        previous_last_ping_msg_id: previousMsgId,
        previous_last_ping_time_monotonic_ms: Number.isFinite(Number(previousTime)) ? Number(previousTime) : null,
        active_before: activeBefore,
        active_now: activeNow,
        inactive_to_active: activeBefore === false && activeNow === true,
      });
      return originalResetLastPing.call(this, withTime, ...args);
    };
  }

  return () => {
    if (connection._doFlush !== originalDoFlush) connection._doFlush = originalDoFlush;
    if (connection.send !== originalSend) connection.send = originalSend;
    if (connection._registerOutgoingMsgId !== originalRegisterOutgoing) connection._registerOutgoingMsgId = originalRegisterOutgoing;
    if (connection._onPong !== originalPong) connection._onPong = originalPong;
    if (connection._onRpcResult !== originalRpcResult) connection._onRpcResult = originalRpcResult;
    if (connection._onMessageAcked !== originalAck) connection._onMessageAcked = originalAck;
    if (connection._onMessageFailed !== originalFailed) connection._onMessageFailed = originalFailed;
    if (connection._resetSession !== originalResetSession) connection._resetSession = originalResetSession;
    if (connection.onMessage !== originalOnMessage) connection.onMessage = originalOnMessage;
    if (session.decryptMessage !== originalDecryptMessage) session.decryptMessage = originalDecryptMessage;
    if (connection._handleRawMessage !== originalHandleRawMessage) connection._handleRawMessage = originalHandleRawMessage;
    if (connection._handleMessage !== originalHandleMessage) connection._handleMessage = originalHandleMessage;
    if (connection.handleError !== originalHandleError) connection.handleError = originalHandleError;
    if (connection._codec?.decode !== originalCodecDecode) connection._codec.decode = originalCodecDecode;
    if (connection._codec?.encode !== originalCodecEncode) connection._codec.encode = originalCodecEncode;
    if (connection._codec?._inner?.encode !== originalInnerEncode) connection._codec._inner.encode = originalInnerEncode;
    encryptorRestores.forEach(restore => restore());
    if (session.writeMessage !== originalWriteMessage) session.writeMessage = originalWriteMessage;
    if (session.pendingMessages?.set !== originalPendingSet) session.pendingMessages.set = originalPendingSet;
    if (session.resetLastPing !== originalResetLastPing) session.resetLastPing = originalResetLastPing;
    if (session.resetState !== originalResetState) session.resetState = originalResetState;
    connection.onUsable?.remove?.(onUsable);
  };
}

function diagnosticErrorMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message) return null;
  return message
    .replace(/\b[A-Za-z0-9_+\/-]{32,}={0,2}\b/g, "[REDACTED]")
    .slice(0, 320);
}

function observeMtprotoSessionReset(active: TelegramClient, requestId: string, passivePingTrace = false): () => void {
  const base = (active as any)._client || active;
  const connection = base?.mt?.network?._dcConnections?.get(activePrimaryDcId)?.main?._connections?.[0] as any;
  const originalReset = connection?._resetSession;
  if (typeof originalReset !== "function") return () => {};
  const observedReset = function (this: unknown, reason?: unknown, ...args: unknown[]) {
    const resetReason = typeof reason === "string" ? reason.slice(0, 180) : String(reason || "unknown").slice(0, 180);
    stage1Trace(requestId, "WORKER_MTPROTO_SESSION_RESET", {
      reason: resetReason,
      ...mtprotoConnectionSnapshot(active),
    });
    if (passivePingTrace) {
      stage1Trace(requestId, "TASK2_PING_RESET_SESSION", {
        reason: resetReason,
        ...pingTraceSnapshot(active, connection),
        ...mtprotoConnectionSnapshot(active),
      });
    }
    return originalReset.apply(this, [reason, ...args]);
  };
  connection._resetSession = observedReset;
  return () => {
    if (connection._resetSession === observedReset) connection._resetSession = originalReset;
  };
}

/**
 * Diagnostic-only hooks for the Stage 1 browser trace. They do not configure
 * mtcute retries or reconnects; they only report the state mtcute already
 * publishes while the real client is running.
 */
function observeMtprotoConnection(active: TelegramClient, requestId: string, passivePingTrace = false): () => void {
  let connectionAttempts = 0;
  let previouslyConnected = false;
  let reconnectInFlight = false;
  const traceState = (stage: string, detail: Record<string, unknown> = {}) => {
    stage1Trace(requestId, stage, {
      ...mtprotoConnectionSnapshot(active),
      ...detail,
    });
  };
  const onState = (state: string) => {
    const reconnect = state === "connecting" && previouslyConnected;
    if (state === "connecting") connectionAttempts += 1;
    traceState("WORKER_MTPROTO_CONNECTION_STATE", {
      state,
      connection_attempt: connectionAttempts,
      reconnect,
    });
    if (passivePingTrace && state === "connecting") {
      stage1Trace(requestId, "TASK2_PING_CONNECTING", {
        connection_attempt: connectionAttempts,
        reconnect,
        ...pingTraceSnapshot(active),
        ...mtprotoConnectionSnapshot(active),
      });
    }
    if (state === "offline") {
      traceState("WORKER_MTPROTO_DISCONNECTED", { connection_attempt: connectionAttempts });
    }
    if (reconnect) {
      reconnectInFlight = true;
      traceState("WORKER_MTPROTO_RECONNECT_BEGIN", { connection_attempt: connectionAttempts });
    }
    if (state === "connected") {
      if (passivePingTrace) {
        stage1Trace(requestId, "TASK2_PING_CONNECTED", {
          connection_attempt: connectionAttempts,
          reconnect,
          ...pingTraceSnapshot(active),
          ...mtprotoConnectionSnapshot(active),
        });
      }
      if (reconnectInFlight) {
        traceState("WORKER_MTPROTO_RECONNECT_READY", { connection_attempt: connectionAttempts });
        reconnectInFlight = false;
      }
      previouslyConnected = true;
    }
  };
  const onError = (error: Error) => {
    traceState("WORKER_MTPROTO_CLIENT_ERROR", {
      error_name: error instanceof Error ? error.name : "unknown",
      error_message: diagnosticErrorMessage(error),
    });
  };
  active.onConnectionState.add(onState as never);
  active.onError.add(onError as never);
  return () => {
    active.onConnectionState.remove(onState as never);
    active.onError.remove(onError as never);
  };
}

/**
 * `getChat`/`getFullChat` do a little local peer work before issuing their
 * internal mtcute `call`.  Observing that boundary leaves the elapsed promise
 * as the exact client/RPC interval, while preserving the productive call.
 */
async function observeMtprotoRpc<T>(
  active: TelegramClient,
  requestId: string,
  stagePrefix: string,
  expectedMethods: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  if (!stage1TraceContext) return operation();
  const previousRpc = activeMtprotoRpc;
  activeMtprotoRpc = { requestId, stage: stagePrefix };
  const core = (active as unknown as { _client?: { call?: (...args: any[]) => Promise<unknown> } })._client;
  if (typeof core?.call !== "function") {
    stage1Trace(requestId, `${stagePrefix}_RPC_INVOKED`, {
      boundary: "high_level_method",
      ...mtprotoConnectionSnapshot(active),
    });
    try {
      const result = await operation();
      stage1Trace(requestId, `${stagePrefix}_RPC_RESPONSE_RECEIVED`, {
        boundary: "high_level_method",
        ...mtprotoConnectionSnapshot(active),
      });
      return result;
    } catch (error) {
      stage1Trace(requestId, `${stagePrefix}_RPC_ERROR`, {
        error_name: error instanceof Error ? error.name : "unknown",
        error_message: diagnosticErrorMessage(error),
        ...mtprotoConnectionSnapshot(active),
      });
      throw error;
    } finally {
      activeMtprotoRpc = previousRpc;
    }
  }

  const originalCall = core.call;
  let observed = false;
  core.call = function stage1ObservedCall(this: unknown, request: { _?: unknown }, ...args: any[]): Promise<unknown> {
    const method = typeof request?._ === "string" ? request._ : "unknown";
    if (!expectedMethods.includes(method)) return originalCall.apply(this, [request, ...args]);
    observed = true;
    stage1Trace(requestId, `${stagePrefix}_RPC_SENT`, {
      rpc_method: method,
      ...mtprotoConnectionSnapshot(active),
    });
    return originalCall.apply(this, [request, ...args]).then(
      result => {
        stage1Trace(requestId, `${stagePrefix}_RPC_RESPONSE_RECEIVED`, {
          rpc_method: method,
          ...mtprotoConnectionSnapshot(active),
        });
        return result;
      },
      error => {
        stage1Trace(requestId, `${stagePrefix}_RPC_ERROR`, {
          rpc_method: method,
          error_name: error instanceof Error ? error.name : "unknown",
          error_message: diagnosticErrorMessage(error),
          ...mtprotoConnectionSnapshot(active),
        });
        throw error;
      },
    );
  };

  try {
    stage1Trace(requestId, `${stagePrefix}_RPC_INVOKED`, { boundary: "high_level_method" });
    return await operation();
  } finally {
    core.call = originalCall;
    if (!observed) stage1Trace(requestId, `${stagePrefix}_RPC_NOT_OBSERVED`, mtprotoConnectionSnapshot(active));
    activeMtprotoRpc = previousRpc;
  }
}
let client: TelegramClient | null = null;
let chatId = 0;
let expectedBotId = "";
let authenticatedBotId = "";
let vaultVerified = false;
let vaultPeerHint: WebVaultPeerRef | null = null;
let startupMediaMessageIds: number[] = [];
let transportStorage: MemoryStorage | null = null;
let transportStorageBotId = "";
let knownIndexPointer: { messageId: number | null; revision: number | null } = { messageId: null, revision: null };
const activeStreams = new Map<string, { controller: AbortController; acknowledge: (() => void) | null }>();
const activePrefetchBatches = new Map<string, PrefetchBatchControl>();
const activeWarmTransfers = new Map<number, Set<AbortController>>();
const playbackMediaCache = new Map<number, CachedPlaybackMedia>();
const playbackMediaMissingCache = new Map<number, WorkerTransportError>();
const pendingPlaybackMedia = new Map<number, PendingPlaybackMedia>();
const pendingPlaybackRanges = new Map<string, SharedPlaybackRange>();
const playbackRangeCache = new Map<string, CachedPlaybackRange>();
const MAX_PLAYBACK_MEDIA_CACHE_ENTRIES = 256;
const MAX_PLAYBACK_RANGE_CACHE_ENTRIES = 128;
const LIBRARY_INDEX_CAPTION = "BEATGALER_LIBRARY_INDEX_V1";
const MAX_CONFIGURABLE_DATA_LANES = 16;
const STARTUP_MEDIA_BATCH_RETRY_DELAY_MS = 70;

let activeDataLanes = 0;
let dataLaneLimit = WEB_PLAYBACK_DATA_LANES;
const foregroundLaneWaiters: DataLaneWaiter[] = [];
const warmLaneWaiters: DataLaneWaiter[] = [];
let playbackResourceGeneration = 0;
let playbackSchedulerState: PlaybackSchedulerState = "IDLE";
let playbackMessageId: number | null = null;
let playbackIntentId: number | null = null;
let activeIndexAbortController: AbortController | null = null;
let activeIndexRequestId: string | null = null;
let activeIndexAbortReason: IndexAbortReason | null = null;
const cancelledIndexRequests = new Set<string>();
let schedulerEpoch = 0;
const schedulerWaiters = new Set<() => void>();

function notifyScheduler(): void {
  schedulerEpoch += 1;
  const waiters = Array.from(schedulerWaiters);
  schedulerWaiters.clear();
  for (const resolve of waiters) resolve();
}

function waitForSchedulerChange(epoch: number): Promise<void> {
  if (epoch !== schedulerEpoch) return Promise.resolve();
  return new Promise(resolve => schedulerWaiters.add(resolve));
}

function configureDataLaneLimit(value: unknown): number {
  const next = Math.max(1, Math.min(MAX_CONFIGURABLE_DATA_LANES, Math.trunc(Number(value) || WEB_PLAYBACK_DATA_LANES)));
  dataLaneLimit = next;
  return next;
}

function wakeNextDataLane(): void {
  const next = foregroundLaneWaiters.shift() || warmLaneWaiters.shift();
  next?.resolve();
}

function promoteDataLaneWaiters(messageId: number): void {
  for (let index = warmLaneWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = warmLaneWaiters[index];
    if (waiter.messageId !== messageId) continue;
    warmLaneWaiters.splice(index, 1);
    waiter.priority = "foreground";
    foregroundLaneWaiters.unshift(waiter);
  }
}

type PlaybackFetchTrace = { requestId?: string; messageId?: number; traceIntentId?: number; source: "foreground_prefetch" | "warm_batch" | "stream" | "startup_media" };

function playbackTraceFields(trace: PlaybackFetchTrace): Record<string, unknown> {
  return {
    request_id: trace.requestId ?? null,
    message_id: trace.messageId ?? null,
    intent_id: trace.traceIntentId ?? (trace.messageId === playbackMessageId ? playbackIntentId : null),
    source: trace.source,
  };
}

function playbackConnectionSnapshot(active: TelegramClient): Record<string, unknown> {
  try { return mtprotoConnectionSnapshot(active); }
  catch { return { snapshot_unavailable: true }; }
}

function focusedBatchTraceFields(messageIds: readonly number[]): Record<string, unknown> {
  const focused = playbackMessageId !== null && messageIds.includes(playbackMessageId);
  return { focused_message_id: focused ? playbackMessageId : null, focused_intent_id: focused ? playbackIntentId : null };
}

async function withDataLane<T>(operation: () => Promise<T>, priority: DataLanePriority = "foreground", trace?: PlaybackFetchTrace): Promise<T> {
  const started = performance.now();
  const generation = playbackResourceGeneration;
  if (activeDataLanes >= dataLaneLimit) {
    if (trace) playTrace("WORKER_DATA_LANE_WAIT_BEGIN", { ...playbackTraceFields(trace), priority, active_lanes: activeDataLanes, lane_limit: dataLaneLimit });
    await new Promise<void>(resolve => {
      (priority === "foreground" ? foregroundLaneWaiters : warmLaneWaiters).push({
        resolve,
        priority,
        messageId: trace?.messageId ?? null,
      });
    });
  }
  if (generation !== playbackResourceGeneration) {
    throw new WorkerTransportError("SESSION_INVALID", "Galer Cloud playback session changed.");
  }
  activeDataLanes += 1;
  const acquiredAt = performance.now();
  if (trace) playTrace("WORKER_DATA_LANE_ACQUIRED", { ...playbackTraceFields(trace), priority, wait_ms: Math.round((performance.now() - started) * 10) / 10, active_lanes: activeDataLanes, lane_limit: dataLaneLimit });
  try {
    return await operation();
  } finally {
    if (generation === playbackResourceGeneration) {
      activeDataLanes = Math.max(0, activeDataLanes - 1);
      if (trace) playTrace("WORKER_DATA_LANE_RELEASED", { ...playbackTraceFields(trace), priority, held_ms: Math.round((performance.now() - acquiredAt) * 10) / 10, active_lanes: activeDataLanes });
      wakeNextDataLane();
    }
  }
}

function schedulerYield(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    /abort/i.test(String((error as any)?.message || ""));
}

function isBoundTempLongJson(value: unknown): value is BoundTempLongJson {
  const row = value as Partial<BoundTempLongJson> | null;
  return Boolean(row && Number.isInteger(row.low) && Number.isInteger(row.high) && typeof row.unsigned === "boolean");
}

function isBoundTempSessionState(value: unknown): value is BoundTempSessionState {
  const row = value as Partial<BoundTempSessionState> | null;
  return Boolean(
    row && Number.isInteger(row.seqNo) && Number(row.seqNo) >= 0 && Number.isFinite(row.timeOffset) &&
    isBoundTempLongJson(row.lastMessageId) && isBoundTempLongJson(row.serverSalt) &&
    Array.isArray(row.queuedAcks) && row.queuedAcks.every(isBoundTempLongJson) &&
    isBoundTempLongJson(row.bindMsgId) && isBoundTempLongJson(row.lastSessionCreatedUid)
  );
}

function restoreLong(LongCtor: any, value: BoundTempLongJson): any {
  return new LongCtor(value.low, value.high, value.unsigned);
}

function applyBoundTempSessionState(
  connection: BoundTempConnection | undefined,
  sessionId: BoundTempLongJson,
  state: BoundTempSessionState,
): void {
  const session = connection?._session;
  const LongCtor = session?._sessionId?.constructor;
  if (!connection || !session || typeof LongCtor !== "function") {
    throw new Error("Galer Cloud Web transport could not restore its temporary session.");
  }
  session._sessionId = restoreLong(LongCtor, sessionId);
  session._seqNo = state.seqNo;
  session._lastMessageId = restoreLong(LongCtor, state.lastMessageId);
  session._timeOffset = state.timeOffset;
  const salts = connection._salts || session._salts;
  if (!salts) throw new Error("Galer Cloud Web transport could not restore its temporary server salt.");
  salts.currentSalt = restoreLong(LongCtor, state.serverSalt);
  session.queuedAcks = state.queuedAcks.map(value => restoreLong(LongCtor, value));
  session.recentOutgoingMsgIds?.add(restoreLong(LongCtor, state.bindMsgId));
  for (const value of state.queuedAcks) session.recentIncomingMsgIds?.add(restoreLong(LongCtor, value));
  session.lastSessionCreatedUid = restoreLong(LongCtor, state.lastSessionCreatedUid);
  session.initConnectionCalled = false;
}

function installBoundTempConnectHook(
  sessionId: BoundTempLongJson,
  state: BoundTempSessionState,
  dcId: number,
): () => void {
  const prototype = SessionConnection.prototype as any;
  const originalConnect = prototype.connect;
  if (typeof originalConnect !== "function") throw new Error("Galer Cloud Web transport could not prepare its temporary session.");
  const wrappedConnect = function (this: BoundTempConnection, ...args: any[]) {
    if (this?.params?.isMainConnection === true && this?.params?.isMainDcConnection === true && Number(this?.params?.dc?.id || 0) === dcId) {
      applyBoundTempSessionState(this, sessionId, state);
    }
    return originalConnect.apply(this, args);
  };
  prototype.connect = wrappedConnect;
  return () => { if (prototype.connect === wrappedConnect) prototype.connect = originalConnect; };
}

function assertBoundTempPrimarySession(next: TelegramClient, sessionId: BoundTempLongJson, dcId: number): void {
  const base = (next as any)._client || next;
  const network = base?.mt?.network as BoundTempNetwork | undefined;
  const connection = network?._dcConnections?.get(dcId)?.main?._connections?.[0];
  const current = connection?._session?._sessionId;
  if (!current || current.low !== sessionId.low || current.high !== sessionId.high || Boolean(current.unsigned) !== sessionId.unsigned) {
    throw new Error("Galer Cloud Web transport did not retain the bound temporary session.");
  }
}

async function closeClient(reason = "shutdown", requestId = ""): Promise<void> {
  playbackResourceGeneration += 1;
  const invalidated = new WorkerTransportError("SESSION_INVALID", "Galer Cloud playback session changed.");
  for (const pending of pendingPlaybackMedia.values()) pending.reject(invalidated);
  pendingPlaybackMedia.clear();
  for (const range of pendingPlaybackRanges.values()) range.controller.abort();
  pendingPlaybackRanges.clear();
  playbackRangeCache.clear();
  playbackGetFileTrace?.detach();
  playbackGetFileTrace = null;
  detachMtprotoPingSocketRecovery?.();
  detachMtprotoPingSocketRecovery = null;
  detachMtprotoPassiveIngressDiagnostics?.();
  detachMtprotoPassiveIngressDiagnostics = null;
  detachMtprotoPassivePingDiagnostics?.();
  detachMtprotoPassivePingDiagnostics = null;
  detachMtprotoSessionDiagnostics?.();
  detachMtprotoSessionDiagnostics = null;
  const currentAtClose = client;
  if (currentAtClose && requestId) {
    stage1Trace(requestId, "WORKER_MTPROTO_CLIENT_CLOSE_BEGIN", {
      reason,
      ...mtprotoConnectionSnapshot(currentAtClose),
    });
  }
  detachMtprotoDiagnostics?.();
  detachMtprotoDiagnostics = null;
  for (const stream of activeStreams.values()) {
    stream.controller.abort();
    stream.acknowledge?.();
  }
  activeStreams.clear();
  for (const control of activePrefetchBatches.values()) {
    control.cancelAll = true;
    for (const state of control.states) state.controller?.abort();
  }
  activePrefetchBatches.clear();
  activeWarmTransfers.clear();
  activeIndexAbortReason = "cancel";
  activeIndexAbortController?.abort();
  activeIndexAbortController = null;
  activeIndexRequestId = null;
  cancelledIndexRequests.clear();
  playbackMediaCache.clear();
  playbackMediaMissingCache.clear();
  foregroundLaneWaiters.splice(0).forEach(waiter => waiter.resolve());
  warmLaneWaiters.splice(0).forEach(waiter => waiter.resolve());
  activeDataLanes = 0;
  dataLaneLimit = WEB_PLAYBACK_DATA_LANES;
  playbackSchedulerState = "IDLE";
  playbackMessageId = null;
  playbackIntentId = null;
  notifyScheduler();
  const current = client;
  const closingClientInstanceId = activeClientInstanceId;
  client = null;
  chatId = 0;
  expectedBotId = "";
  authenticatedBotId = "";
  vaultVerified = false;
  startupMediaMessageIds = [];
  knownIndexPointer = { messageId: null, revision: null };
  activeMtprotoRpc = null;
  activeClientInstanceId = null;
  activePrimaryDcId = 0;
  if (current) await current.destroy().catch(() => {});
  if (currentAtClose && requestId) {
    stage1Trace(requestId, "WORKER_MTPROTO_CLIENT_CLOSE_DONE", {
      reason,
      worker_instance_id: workerInstanceId,
      client_instance_id: closingClientInstanceId,
    });
  }
}

function downloadableMedia(message: Awaited<ReturnType<TelegramClient["getMessages"]>>[number]): FileDownloadLocation {
  const media = message?.media;
  if (!media || !["document", "audio", "video", "voice", "photo", "sticker"].includes(media.type)) {
    throw new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud stored object is not downloadable.");
  }
  return media as FileDownloadLocation;
}

function touchPlaybackMedia(messageId: number, value: CachedPlaybackMedia): void {
  playbackMediaMissingCache.delete(messageId);
  playbackMediaCache.delete(messageId);
  playbackMediaCache.set(messageId, value);
  while (playbackMediaCache.size > MAX_PLAYBACK_MEDIA_CACHE_ENTRIES) {
    const oldest = playbackMediaCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    playbackMediaCache.delete(oldest);
  }
}

function cachedPlaybackMedia(messageId: number): ResolvedPlaybackMedia | null {
  const cached = playbackMediaCache.get(messageId);
  if (!cached) return null;
  touchPlaybackMedia(messageId, cached);
  return { media: cached.media, totalBytes: cached.totalBytes, mimeType: cached.mimeType, sourceMime: cached.mimeType, cacheHit: true };
}

function cachedMissingPlaybackMedia(messageId: number): WorkerTransportError | null {
  return playbackMediaMissingCache.get(messageId) || null;
}

function resolvedMediaFromMessage(message: Awaited<ReturnType<TelegramClient["getMessages"]>>[number]): ResolvedPlaybackMedia {
  const media = downloadableMedia(message);
  const totalBytes = Math.max(0, Number((media as { fileSize?: number }).fileSize || 0));
  const sourceMime = String((media as { mimeType?: string }).mimeType || "").trim() || null;
  return { media, totalBytes, mimeType: sourceMime, sourceMime, cacheHit: false };
}

function nonRetryableMediaResolutionError(error: unknown): boolean {
  const message = String((error as any)?.message || error || "");
  return /AUTH_KEY|SESSION_REVOKED|CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|PEER_ID_INVALID|FORBIDDEN|not a member|USER_DEACTIVATED/i.test(message);
}

async function getMessagesBatchWithRetry(
  active: TelegramClient,
  targetChatId: number,
  messageIds: number[],
  trace?: PlaybackFetchTrace,
): Promise<Awaited<ReturnType<TelegramClient["getMessages"]>>> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      playTrace("WORKER_PLAYBACK_MEDIA_BATCH_RPC", { count: messageIds.length, attempt });
      const started = performance.now();
      playTrace("WORKER_MEDIA_GET_MESSAGES_BEGIN", { ...(trace ? playbackTraceFields(trace) : {}), ...focusedBatchTraceFields(messageIds), message_ids: messageIds, attempt, connection: playbackConnectionSnapshot(active) });
      try {
        const messages = await active.getMessages(targetChatId, messageIds);
        playTrace("WORKER_MEDIA_GET_MESSAGES_DONE", { ...(trace ? playbackTraceFields(trace) : {}), ...focusedBatchTraceFields(messageIds), message_ids: messageIds, attempt, elapsed_ms: Math.round((performance.now() - started) * 10) / 10, returned: messages.length, connection: playbackConnectionSnapshot(active) });
        return messages;
      } catch (error) {
        playTrace("WORKER_MEDIA_GET_MESSAGES_ERROR", { ...(trace ? playbackTraceFields(trace) : {}), ...focusedBatchTraceFields(messageIds), message_ids: messageIds, attempt, elapsed_ms: Math.round((performance.now() - started) * 10) / 10, error_name: error instanceof Error ? error.name : "unknown", connection: playbackConnectionSnapshot(active) });
        throw error;
      }
    } catch (error) {
      lastError = error;
      playTrace("WORKER_PLAYBACK_MEDIA_BATCH_RETRY", { count: messageIds.length, attempt, error_name: error instanceof Error ? error.name : "unknown" });
      if (attempt >= 2 || nonRetryableMediaResolutionError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, STARTUP_MEDIA_BATCH_RETRY_DELAY_MS));
    }
  }
  throw lastError || new Error("Galer Cloud could not resolve playback media.");
}

function createPendingPlaybackMedia(generation: number): PendingPlaybackMedia {
  let resolve!: (value: ResolvedPlaybackMedia) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ResolvedPlaybackMedia>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  // A session replacement can invalidate the entry before a joining caller
  // observes it. Keep that rejection owned by the coordinator as well.
  void promise.catch(() => {});
  return { generation, promise, resolve, reject };
}

async function resolveNewPlaybackMedia(
  active: TelegramClient,
  targetChatId: number,
  messageIds: number[],
  entries: Map<number, PendingPlaybackMedia>,
  generation: number,
  trace?: PlaybackFetchTrace,
): Promise<void> {
  try {
    const messages = await getMessagesBatchWithRetry(active, targetChatId, messageIds, trace);
    if (generation !== playbackResourceGeneration || client !== active || chatId !== targetChatId) {
      throw new WorkerTransportError("SESSION_INVALID", "Galer Cloud playback session changed.");
    }
    const byId = new Map<number, Awaited<ReturnType<TelegramClient["getMessages"]>>[number]>();
    for (const message of messages) {
      const id = Number(message?.id || 0);
      if (Number.isSafeInteger(id) && id > 0) byId.set(id, message);
    }
    for (const messageId of messageIds) {
      const pending = entries.get(messageId)!;
      const message = byId.get(messageId);
      if (!message) {
        const error = new WorkerTransportError("ROUTE_MISSING", "Galer Cloud object no longer exists.");
        playbackMediaMissingCache.set(messageId, error);
        pending.reject(error);
        continue;
      }
      try {
        const value = resolvedMediaFromMessage(message);
        playbackMediaMissingCache.delete(messageId);
        touchPlaybackMedia(messageId, { media: value.media, totalBytes: value.totalBytes, mimeType: value.sourceMime });
        pending.resolve(value);
      } catch (error) {
        const failure = error instanceof WorkerTransportError
          ? error
          : new WorkerTransportError("MEDIA_UNAVAILABLE", error instanceof Error ? error.message : String(error));
        playbackMediaMissingCache.set(messageId, failure);
        pending.reject(failure);
      }
    }
  } catch (error) {
    for (const pending of entries.values()) pending.reject(error);
  } finally {
    for (const [messageId, pending] of entries) {
      if (pendingPlaybackMedia.get(messageId) === pending) pendingPlaybackMedia.delete(messageId);
    }
  }
}

async function resolvePlaybackMediaBatch(
  active: TelegramClient,
  targetChatId: number,
  rawMessageIds: readonly number[],
  trace?: PlaybackFetchTrace,
): Promise<PlaybackMediaBatchResolution> {
  const resolveStarted = performance.now();
  const messageIds = Array.from(new Set(rawMessageIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
  const resolved = new Map<number, ResolvedPlaybackMedia>();
  const missing = new Map<number, Error>();
  const waits = new Map<number, Promise<ResolvedPlaybackMedia>>();
  const fresh = new Map<number, PendingPlaybackMedia>();
  const generation = playbackResourceGeneration;
  for (const messageId of messageIds) {
    const cached = cachedPlaybackMedia(messageId);
    if (cached) {
      resolved.set(messageId, cached);
      playTrace("WORKER_PLAYBACK_MEDIA_CACHE_HIT", { message_id: messageId });
      continue;
    }
    const negative = cachedMissingPlaybackMedia(messageId);
    if (negative) {
      missing.set(messageId, negative);
      playTrace("WORKER_PLAYBACK_MEDIA_NEGATIVE_CACHE_HIT", { message_id: messageId, code: negative.code });
      continue;
    }
    const existing = pendingPlaybackMedia.get(messageId);
    if (existing?.generation === generation) {
      waits.set(messageId, existing.promise);
      playTrace("WORKER_PLAYBACK_MEDIA_PENDING_JOIN", { message_id: messageId, ...(trace ? playbackTraceFields({ ...trace, messageId }) : {}) });
      continue;
    }
    const pending = createPendingPlaybackMedia(generation);
    pendingPlaybackMedia.set(messageId, pending);
    fresh.set(messageId, pending);
    waits.set(messageId, pending.promise);
    if (trace?.source === "warm_batch") playTrace("WORKER_PLAYBACK_MEDIA_CACHE_MISS", { ...playbackTraceFields({ ...trace, messageId }), message_id: messageId });
  }
  if (trace) playTrace("WORKER_MEDIA_RESOLVE_CACHE", { ...playbackTraceFields(trace), ...focusedBatchTraceFields(messageIds), message_ids: messageIds, hits: resolved.size, negative_hits: missing.size, misses: waits.size, joined: waits.size - fresh.size });
  if (waits.size === 0) {
    if (trace) playTrace("WORKER_MEDIA_RESOLVE_DONE", { ...playbackTraceFields(trace), ...focusedBatchTraceFields(messageIds), message_ids: messageIds, resolved: resolved.size, missing: missing.size, elapsed_ms: Math.round((performance.now() - resolveStarted) * 10) / 10 });
    return { resolved, missing };
  }
  if (fresh.size > 0) void resolveNewPlaybackMedia(active, targetChatId, [...fresh.keys()], fresh, generation, trace);
  const settled = await Promise.all([...waits].map(async ([messageId, promise]): Promise<
    { messageId: number; value: ResolvedPlaybackMedia } | { messageId: number; error: Error }
  > => {
    try { return { messageId, value: await promise }; }
    catch (error) { return { messageId, error: error instanceof Error ? error : new Error(String(error)) }; }
  }));
  for (const result of settled) {
    if ("value" in result) resolved.set(result.messageId, result.value);
    else missing.set(result.messageId, result.error);
  }
  if (trace) playTrace("WORKER_MEDIA_RESOLVE_DONE", { ...playbackTraceFields(trace), ...focusedBatchTraceFields(messageIds), message_ids: messageIds, resolved: resolved.size, missing: missing.size, elapsed_ms: Math.round((performance.now() - resolveStarted) * 10) / 10 });
  return { resolved, missing };
}

async function resolvePlaybackMedia(active: TelegramClient, messageId: number, trace?: PlaybackFetchTrace): Promise<ResolvedPlaybackMedia> {
  const cached = cachedPlaybackMedia(messageId);
  if (cached) { if (trace) playTrace("WORKER_MEDIA_RESOLVE_CACHE", { ...playbackTraceFields(trace), hits: 1, misses: 0 }); return cached; }
  const negative = cachedMissingPlaybackMedia(messageId);
  if (negative) throw negative;
  playTrace("WORKER_PLAYBACK_MEDIA_CACHE_MISS", { message_id: messageId, ...(trace ? playbackTraceFields(trace) : {}) });
  const batch = await resolvePlaybackMediaBatch(active, chatId, [messageId], trace);
  const resolved = batch.resolved.get(messageId);
  if (resolved) return resolved;
  throw batch.missing.get(messageId) || new WorkerTransportError("ROUTE_MISSING", "Galer Cloud object no longer exists.");
}

async function initialize(command: Extract<WebTransportWorkerCommand, { op: "initialize" }>): Promise<void> {
  const started = Date.now();
  playTrace("WORKER_INITIALIZE_BEGIN");
  stage1Trace(command.requestId, "WORKER_MTPROTO_CLIENT_INITIALIZE", {
    worker_instance_id: workerInstanceId,
    prior_client_instance_id: activeClientInstanceId,
    prior_client_present: Boolean(client),
  });
  await closeClient("initialize_replacement", command.requestId);
  const {
    chat_id,
    user_id,
    transport_id,
    expected_bot_id,
    lease_state,
    temp_api_id,
    temp_auth_key,
    temp_session_id,
    temp_session_state,
    temp_primary_dcs,
    index_pointer,
  } = command.session;
  const startupMessageIds = Array.from(new Set(
    (command.startupMessageIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0),
  )).slice(0, 14);
  const primaryDcId = Number((temp_primary_dcs as any)?.main?.id || 0);
  const numericChatId = Number(chat_id);
  if (!chat_id || !Number.isSafeInteger(numericChatId) || numericChatId === 0 || !expected_bot_id ||
      !Number.isInteger(temp_api_id) || temp_api_id <= 0 || !(temp_auth_key instanceof Uint8Array) ||
      temp_auth_key.byteLength !== 256 || !isBoundTempLongJson(temp_session_id) ||
      !isBoundTempSessionState(temp_session_state) || !Number.isInteger(primaryDcId) || primaryDcId < 1 ||
      primaryDcId > 5 || !temp_primary_dcs) {
    throw new WorkerTransportError("SESSION_INVALID", "Galer Cloud returned incomplete temporary transport authorization.");
  }

  activePrimaryDcId = primaryDcId;
  const passivePingTrace = task2PassivePingTraceEnabled();
  activeClientInstanceId = `${workerInstanceId}:client-${++clientSerial}`;
  const ingressTrace = passivePingTrace
    ? installTask2PassiveIngressTrace(command.requestId, activeClientInstanceId)
    : null;
  // Keep mtcute's learned peer across temporary-auth replacements in this Worker.
  // A new Worker receives the verified peer hint from the renderer cache.
  if (!transportStorage || transportStorageBotId !== String(expected_bot_id)) {
    transportStorage = new MemoryStorage();
    transportStorageBotId = String(expected_bot_id);
  }
  const next = new TelegramClient({
    apiId: temp_api_id,
    apiHash: "",
    storage: transportStorage,
    crypto: new WebCryptoProvider({ wasmInput: mtcuteWasmUrl }),
    disableUpdates: false,
  });
  stage1Trace(command.requestId, "WORKER_MTPROTO_CLIENT_CREATED", {
    worker_instance_id: workerInstanceId,
    client_instance_id: activeClientInstanceId,
    ...mtprotoConnectionSnapshot(next),
  });
  if (passivePingTrace) {
    stage1Trace(command.requestId, "TASK2_PING_CLIENT_CREATED", {
      ...pingTraceSnapshot(next),
      ...mtprotoConnectionSnapshot(next),
    });
  }
  const detachDiagnostics = observeMtprotoConnection(next, command.requestId, passivePingTrace);
  let detachSessionDiagnostics: (() => void) | null = null;
  let detachPassivePingDiagnostics: (() => void) | null = null;
  let detachPingSocketRecovery: (() => void) | null = null;
  let nextPlaybackGetFileTrace: ReturnType<typeof installPlaybackGetFileTrace> | null = null;
  try {
    await next.importSession({
      primaryDcs: temp_primary_dcs as any,
      self: { userId: Number(expected_bot_id), isBot: true, isPremium: false, usernames: [] } as any,
      authKey: temp_auth_key.slice(),
    }, true);
    const restoreConnect = installBoundTempConnectHook(temp_session_id, temp_session_state, primaryDcId);
    const endConnectTrace = playTraceSpan("WORKER_MTPROTO_CONNECT");
    try {
      stage1Trace(command.requestId, "WORKER_MTPROTO_CONNECT_BEGIN", mtprotoConnectionSnapshot(next));
      await next.connect();
      await next.startUpdatesLoop();
      detachSessionDiagnostics = observeMtprotoSessionReset(next, command.requestId, passivePingTrace);
      if (passivePingTrace) detachPassivePingDiagnostics = observeMtprotoPassivePing(next, command.requestId, ingressTrace);
      detachPingSocketRecovery = installMtcutePingSocketRecovery(primarySessionConnection(next), detail => {
        stage1Trace(command.requestId, "WORKER_MTPROTO_PING_SOCKET_RECOVERY", {
          ping_msg_id: detail.pingMsgId,
          elapsed_ms: detail.elapsedMs,
          ...mtprotoConnectionSnapshot(next),
        });
      });
      nextPlaybackGetFileTrace = installPlaybackGetFileTrace(next, {
        focusedMessageId: import.meta.env.VITE_PLAYBACK_TEST_G_CAPTURE === "1"
          ? () => Number(import.meta.env.VITE_PLAYBACK_TEST_G_MESSAGE_ID) || playbackMessageId : undefined,
      });
      endConnectTrace();
      stage1Trace(command.requestId, "WORKER_MTPROTO_CONNECT_END", mtprotoConnectionSnapshot(next));
      playTrace("DIRECT_MTPROTO_READY", { elapsed_ms: Date.now() - started });
    } catch (error) {
      endConnectTrace("error");
      stage1Trace(command.requestId, "WORKER_MTPROTO_CONNECT_ERROR", {
        error_name: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    } finally {
      restoreConnect();
    }
    assertBoundTempPrimarySession(next, temp_session_id, primaryDcId);
    client = next;
    detachMtprotoDiagnostics = detachDiagnostics;
    detachMtprotoSessionDiagnostics = detachSessionDiagnostics;
    detachMtprotoPassivePingDiagnostics = detachPassivePingDiagnostics;
    detachMtprotoPingSocketRecovery = detachPingSocketRecovery;
    playbackGetFileTrace = nextPlaybackGetFileTrace;
    detachMtprotoPassiveIngressDiagnostics = ingressTrace?.detach || null;
    chatId = numericChatId;
    vaultPeerHint = command.session.vault_peer?.channelId === -(numericChatId + 1_000_000_000_000)
      ? command.session.vault_peer : null;
    expectedBotId = String(expected_bot_id);
    authenticatedBotId = "";
    vaultVerified = false;
    startupMediaMessageIds = startupMessageIds;
    knownIndexPointer = {
      messageId: Number.isSafeInteger(Number(index_pointer?.message_id)) && Number(index_pointer?.message_id) > 0 ? Number(index_pointer?.message_id) : null,
      revision: Number.isSafeInteger(Number(index_pointer?.revision)) && Number(index_pointer?.revision) > 0 ? Number(index_pointer?.revision) : null,
    };
    stage1Trace(command.requestId, "WORKER_MTPROTO_CLIENT_READY", {
      user_id: user_id || null,
      vault_chat_id: String(chat_id),
      channel_id: String(vaultChannelId()),
      transport_id: transport_id || null,
      expected_bot_id: String(expected_bot_id),
      lease_state: lease_state || null,
      ...mtprotoConnectionSnapshot(next),
    });

  } catch (error) {
    nextPlaybackGetFileTrace?.detach();
    if (playbackGetFileTrace === nextPlaybackGetFileTrace) playbackGetFileTrace = null;
    detachPingSocketRecovery?.();
    detachPassivePingDiagnostics?.();
    detachSessionDiagnostics?.();
    detachDiagnostics();
    ingressTrace?.detach();
    if (detachMtprotoDiagnostics === detachDiagnostics) detachMtprotoDiagnostics = null;
    if (client === next) {
      client = null;
      chatId = 0;
      vaultPeerHint = null;
      expectedBotId = "";
    }
    stage1Trace(command.requestId, "WORKER_MTPROTO_CLIENT_INIT_FAILED", {
      error_name: error instanceof Error ? error.name : "unknown",
      error_message: diagnosticErrorMessage(error),
      ...mtprotoConnectionSnapshot(next),
    });
    activeClientInstanceId = null;
    activePrimaryDcId = 0;
    await next.destroy().catch(() => {});
    throw error;
  } finally {
    temp_auth_key.fill(0);
  }
  playTrace("WORKER_INITIALIZE_DONE", { elapsed_ms: Date.now() - started });
}

function requireConnected(): TelegramClient {
  if (!client || !chatId) throw new WorkerTransportError("SESSION_INVALID", "Galer Cloud Web transport is not initialized.");
  return client;
}

function requireReady(): TelegramClient {
  const active = requireConnected();
  if (!vaultVerified) throw new WorkerTransportError("PEER_NOT_RESOLVED", "Galer Cloud vault peer is not ready.");
  return active;
}

async function warmStartupPlaybackMedia(active: TelegramClient, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    // Foreground playback keeps priority over this speculative vector.
    await waitUntilIndexPriorityAllowed();
    if (client !== active || !vaultVerified) return;
    const mediaResult = await resolvePlaybackMediaBatch(active, chatId, ids, { source: "startup_media" });
    if (client !== active || !vaultVerified) return;
    for (const [messageId, value] of mediaResult.resolved) {
      touchPlaybackMedia(messageId, { media: value.media, totalBytes: value.totalBytes, mimeType: value.sourceMime });
    }
    playTrace("WORKER_STARTUP_MEDIA_BATCH_READY", {
      requested: ids.length,
      resolved: mediaResult.resolved.size,
      missing: mediaResult.missing.size,
    });
  } catch (error) {
    playTrace("WORKER_STARTUP_MEDIA_BATCH_DEFERRED", {
      requested: ids.length,
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }
}

async function verifyIdentity(requestId: string): Promise<void> {
  const active = requireConnected();
  try {
    const self = await active.getMe();
    authenticatedBotId = String(self?.id || "");
    stage1Trace(requestId, "WORKER_GET_ME_IDENTITY", {
      expected_bot_id: expectedBotId,
      actual_bot_id: authenticatedBotId || null,
      vault_chat_id: String(chatId),
      channel_id: String(vaultChannelId()),
      is_bot: Boolean(self?.isBot),
    });
    if (!self?.isBot || String(self.id) !== expectedBotId) {
      throw new WorkerTransportError("SESSION_INVALID", "Temporary authorization resolved to the wrong transport identity.");
    }
    playTrace("DIRECT_BACKGROUND_GET_ME_OK");
  } catch (error) {
    playTrace("DIRECT_BACKGROUND_GET_ME_FAILED", { error_name: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

function vaultChannelId(): number {
  return -(chatId + 1_000_000_000_000);
}

async function acquireVaultPeerForBot(
  active: TelegramClient,
  requestId: string,
  attempt: number,
  membership: import("./webTransportSession").WebTransportMembershipProof | null,
): Promise<WebVaultPeerRef> {
  const channelId = vaultChannelId();
  const diagnostic = {
    attempt,
    vault_chat_id: String(chatId),
    channel_id: channelId,
    expected_bot_id: expectedBotId,
    actual_bot_id: authenticatedBotId || null,
    membership_state: membership?.state || null,
    membership_source: membership?.source || null,
  };
  stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_ZERO_HASH_BEGIN", diagnostic);
  // Telegram explicitly allows bots to use a zero access hash when they only
  // know a channel ID.  Calling the raw method avoids getChat's circular local
  // cache lookup, and Telegram's response seeds mtcute's peer storage.
  const response = await observeMtprotoRpc(
    active,
    requestId,
    "WORKER_VERIFY_GET_CHAT",
    ["channels.getChannels"],
    () => active.call({
      _: "channels.getChannels",
      id: [{ _: "inputChannel", channelId, accessHash: new Long(0, 0) }],
    }),
  );
  const raw = response.chats.find(candidate => candidate._ === "channel" && Number(candidate.id) === channelId);
  if (!raw || raw._ !== "channel" || !raw.accessHash) {
    throw new WorkerTransportError("PEER_NOT_RESOLVED", "Telegram did not return a usable vault peer.");
  }
  const stored = await active.resolvePeer(chatId);
  if (stored._ !== "inputPeerChannel" || !stored.accessHash || stored.channelId !== channelId) {
    throw new WorkerTransportError("PEER_NOT_RESOLVED", "Telegram did not persist the acquired vault peer.");
  }
  const resolved: WebVaultPeerRef = {
    channelId,
    accessHash: { low: stored.accessHash.low, high: stored.accessHash.high },
  };
  stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_PEER_STORED", diagnostic);
  stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_RESOLVE_PEER_READY", diagnostic);
  stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_ZERO_HASH_READY", diagnostic);
  return resolved;
}

async function verifyReady(
  requestId: string,
  membership: import("./webTransportSession").WebTransportMembershipProof | null = null,
): Promise<WebVaultPeerRef> {
  const active = requireConnected();
  const started = Date.now();
  const deadline = started + 25_000;
  try {
    stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_BEGIN", { cached_hint: Boolean(vaultPeerHint) });
    stage1Trace(requestId, "WORKER_VERIFY_GET_CHAT_BEGIN");
    let resolved: WebVaultPeerRef | null = null;
    // A real mtcute client always exposes call(). With no persisted hint, use
    // Telegram's bot zero-hash rule immediately instead of depending on the
    // timing or contents of a membership update. Minimal test doubles without
    // call() retain the cached getChat path.
    let forceZeroHashDiscovery = !vaultPeerHint && typeof active.call === "function";
    if (vaultPeerHint) {
      try {
        const hinted = await observeMtprotoRpc(active, requestId, "WORKER_VERIFY_GET_CHAT",
          ["channels.getChannels", "messages.getChats"], () => active.getChat({
            _: "inputPeerChannel",
            channelId: vaultPeerHint!.channelId,
            accessHash: new Long(vaultPeerHint!.accessHash.low, vaultPeerHint!.accessHash.high),
          }));
        if (Number(hinted.id) !== chatId) throw new WorkerTransportError("SESSION_INVALID", "Cached vault peer belongs to another chat.");
        resolved = vaultPeerHint;
      } catch (error) {
        if (error instanceof WorkerTransportError) throw error;
        // A stale access hash is a peer bootstrap miss. Reacquire from the
        // membership update instead of treating it as a dead MTProto session.
        if (!(error instanceof MtPeerNotFoundError) && !/CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID/i.test(String(error))) throw error;
        vaultPeerHint = null;
        forceZeroHashDiscovery = true;
      }
    }
    let attempt = 0;
    while (!resolved) {
      attempt += 1;
      try {
        if (forceZeroHashDiscovery) {
          resolved = await acquireVaultPeerForBot(active, requestId, attempt, membership);
          continue;
        }
        const chat = await observeMtprotoRpc(active, requestId, "WORKER_VERIFY_GET_CHAT",
          ["channels.getChannels", "messages.getChats"], () => active.getChat(chatId));
        if (Number(chat.id) !== chatId) {
          throw new WorkerTransportError("SESSION_INVALID", "Vault verification resolved to another chat.");
        }
        const peer = await active.resolvePeer(chatId);
        if (peer._ !== "inputPeerChannel" || !peer.accessHash || peer.channelId !== vaultChannelId()) {
          throw new WorkerTransportError("PEER_NOT_RESOLVED", "Vault peer has no usable channel access hash.");
        }
        resolved = {
          channelId: peer.channelId,
          accessHash: { low: peer.accessHash.low, high: peer.accessHash.high },
        };
      } catch (error) {
        stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_ZERO_HASH_ERROR", {
          attempt,
          vault_chat_id: String(chatId),
          channel_id: vaultChannelId(),
          expected_bot_id: expectedBotId,
          actual_bot_id: authenticatedBotId || null,
          membership_state: membership?.state || null,
          membership_source: membership?.source || null,
          error_name: error instanceof Error ? error.name : "unknown",
          error_message: diagnosticErrorMessage(error),
        });
        const retryable = error instanceof MtPeerNotFoundError ||
          (error instanceof WorkerTransportError && error.code === "PEER_NOT_RESOLVED") ||
          /CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID/i.test(String(error));
        if (!retryable) throw error;
        // A cached peer can itself be stale. Do not spend the whole retry
        // window replaying it; the bot zero-hash path is authoritative here.
        const switchingToZeroHash = !forceZeroHashDiscovery;
        forceZeroHashDiscovery = true;
        if (switchingToZeroHash) continue;
        if (Date.now() >= deadline) {
          stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_UNRESOLVED", { elapsed_ms: Date.now() - started, attempt });
          throw new WorkerTransportError("PEER_NOT_RESOLVED", error instanceof Error ? error.message : String(error));
        }
        const delayMs = Math.min(1_500, 200 * (2 ** Math.min(attempt - 1, 3)), deadline - Date.now());
        stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_RETRY", { attempt, delay_ms: delayMs });
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    stage1Trace(requestId, "WORKER_VERIFY_GET_CHAT_LOCAL_DONE");
    vaultPeerHint = resolved;
    vaultVerified = true;
    stage1Trace(requestId, "WORKER_PEER_BOOTSTRAP_READY", { elapsed_ms: Date.now() - started });
    const startupIds = startupMediaMessageIds;
    startupMediaMessageIds = [];
    void warmStartupPlaybackMedia(active, startupIds);
    stage1Trace(requestId, "WORKER_VERIFY_GET_CHAT_END");
    playTrace("DIRECT_BACKGROUND_GET_CHAT_OK");
    return resolved;
  } catch (error) {
    stage1Trace(requestId, "WORKER_VERIFY_GET_CHAT_ERROR", {
      error_name: error instanceof Error ? error.name : "unknown",
    });
    playTrace("DIRECT_BACKGROUND_GET_CHAT_FAILED", { error_name: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

function indexPriorityAllowed(): boolean {
  return playbackSchedulerState !== "PLAY_CRITICAL";
}

async function waitUntilIndexPriorityAllowed(): Promise<void> {
  while (!indexPriorityAllowed()) {
    const epoch = schedulerEpoch;
    if (indexPriorityAllowed()) return;
    await waitForSchedulerChange(epoch);
  }
}

function postIndexState(requestId: string | null, state: "active" | "paused"): void {
  if (!requestId) return;
  scope.postMessage({ requestId, event: "index-state", state });
}

function preemptActiveIndex(reason: "play" | "warm"): void {
  if (!activeIndexRequestId && !activeIndexAbortController) return;
  activeIndexAbortReason = reason;
  postIndexState(activeIndexRequestId, "paused");
  const controller = activeIndexAbortController;
  if (controller && !controller.signal.aborted) controller.abort();
  playTrace(reason === "play" ? "INDEX_PREEMPTED_PLAY" : "INDEX_PREEMPTED_WARM", {
    request_id: activeIndexRequestId,
  });
}

function cancelIndex(targetRequestId: string): { cancelled: boolean } {
  const requestId = String(targetRequestId || "");
  if (!requestId) return { cancelled: false };
  cancelledIndexRequests.add(requestId);
  if (activeIndexRequestId === requestId) {
    activeIndexAbortReason = "cancel";
    activeIndexAbortController?.abort();
  }
  notifyScheduler();
  return { cancelled: true };
}

function preemptWarmTransfersForIndex(): void {
  let batches = 0;
  for (const control of Array.from(activePrefetchBatches.values())) {
    batches += 1;
    cancelPrefetchBatch(control.requestId);
  }
  let aborted = 0;
  for (const controllers of activeWarmTransfers.values()) {
    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort();
        aborted += 1;
      }
    }
  }
  if (batches || aborted) {
    playTrace("INDEX_WARM_PREEMPT_ALL", { batches, aborted });
  }
}

function assertIndexNotCancelled(requestId: string | null): void {
  if (requestId && cancelledIndexRequests.has(requestId)) {
    throw new WorkerTransportError("CANCELLED", "Galer Cloud INDEX read was cancelled.");
  }
}

async function getLibraryIndex(requestId: string | null = null, allowMissing = false): Promise<WebTransportLibraryIndexResult> {
  const active = requireReady();
  const started = Date.now();
  // Startup warming is speculative. A library read is the authoritative
  // boundary for an import/edit, so it must never wait behind concurrent
  // prefix downloads on the same MTProto client.
  preemptWarmTransfersForIndex();
  let failures = 0;
  let resumed = false;
  try {
    while (failures < 5) {
      assertIndexNotCancelled(requestId);
      if (requestId) stage1Trace(requestId, "WORKER_INDEX_PRIORITY_WAIT_BEGIN");
      await waitUntilIndexPriorityAllowed();
      if (requestId) stage1Trace(requestId, "WORKER_INDEX_PRIORITY_WAIT_DONE");
      assertIndexNotCancelled(requestId);
      activeIndexRequestId = requestId;
      activeIndexAbortReason = null;
      postIndexState(requestId, "active");
      if (requestId) stage1Trace(requestId, "WORKER_INDEX_BEGIN", { resumed });
      playTrace(resumed ? "INDEX_RESUMED" : "INDEX_BEGIN", { request_id: requestId });
      let controller: AbortController | null = null;
      try {
        const readCandidate = async (messageId: number): Promise<{ manifest: unknown; bytes: number } | null> => {
          const lookupStartedAt = Date.now();
          if (requestId) {
            stage1Trace(requestId, "WORKER_INDEX_POINTER_LOOKUP_BEGIN", { message_id: messageId });
            stage1Trace(requestId, "WORKER_INDEX_POINTER_GET_MESSAGES_BEGIN", {
              message_id: messageId,
              ...mtprotoConnectionSnapshot(active),
            });
            if (task2PassivePingTraceEnabled()) {
              stage1Trace(requestId, "TASK2_PING_GET_MESSAGES_BEGIN", {
                message_id: messageId,
                ...pingTraceSnapshot(active),
                ...mtprotoConnectionSnapshot(active),
              });
            }
          }
          let message: Awaited<ReturnType<TelegramClient["getMessages"]>>[number] | undefined;
          const disarmIndexLiveness = armMtcuteIndexLivenessGuard(
            primarySessionConnection(active),
            () => requestId === null || activeIndexRequestId === requestId,
            detail => {
              if (requestId) stage1Trace(requestId, "TASK2_PING_INDEX_LIVENESS_RECOVERY", {
                rpc_msg_id: detail.rpcMsgId,
                ping_msg_id: detail.pingMsgId,
                delay_ms: detail.delayMs,
                ...mtprotoConnectionSnapshot(active),
              });
              playTrace("INDEX_LIVENESS_RECOVERY", { delay_ms: detail.delayMs });
            },
          );
          try {
            const messages = requestId
              ? await observeMtprotoRpc(
                active,
                requestId,
                "WORKER_INDEX_POINTER_GET_MESSAGES",
                ["channels.getMessages", "messages.getMessages"],
                () => active.getMessages(chatId, [messageId]),
              )
              : await active.getMessages(chatId, [messageId]);
            [message] = messages;
          } finally {
            disarmIndexLiveness();
            if (requestId) {
              stage1Trace(requestId, "WORKER_INDEX_POINTER_GET_MESSAGES_END", {
                message_id: messageId,
                found: Boolean(message),
                elapsed_ms: Date.now() - lookupStartedAt,
                ...mtprotoConnectionSnapshot(active),
              });
              if (task2PassivePingTraceEnabled()) {
                stage1Trace(requestId, "TASK2_PING_GET_MESSAGES_END", {
                  message_id: messageId,
                  found: Boolean(message),
                  elapsed_ms: Date.now() - lookupStartedAt,
                  ...pingTraceSnapshot(active),
                  ...mtprotoConnectionSnapshot(active),
                });
              }
            }
          }
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_POINTER_LOOKUP_DONE", { found: Boolean(message) });
          // Telegram scopes this lookup to chatId, so a pointer from another
          // vault cannot be read even if numeric message ids overlap.
          if (!message || !String(message.text || "").startsWith(LIBRARY_INDEX_CAPTION)) return null;
          controller = new AbortController();
          activeIndexAbortController = controller;
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_DOWNLOAD_BEGIN");
          const bytes = await active.downloadAsBuffer(downloadableMedia(message), { abortSignal: controller.signal, stallTimeout: 20_000 });
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_DOWNLOAD_DONE", { bytes: bytes.byteLength });
          assertIndexNotCancelled(requestId);
          if (controller.signal.aborted || !indexPriorityAllowed() || bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) return null;
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_DECODE_BEGIN");
          const decoded = new TextDecoder().decode(bytes);
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_DECODE_DONE");
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_PARSE_BEGIN");
          const manifest = JSON.parse(decoded) as Record<string, unknown>;
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_PARSE_DONE");
          if (manifest?.schema !== "beatgaler.telegram.library" || Number(manifest?.version) !== 2) return null;
          return { manifest, bytes: bytes.byteLength };
        };
        const finish = (messageId: number, loaded: { manifest: unknown; bytes: number }, pointerRepair?: WebTransportLibraryIndexResult["pointerRepair"]) => {
          knownIndexPointer = { messageId, revision: knownIndexPointer.revision };
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_DONE", { bytes: loaded.bytes, message_id: messageId, pointer_repair: Boolean(pointerRepair) });
          playTrace("INDEX_DONE", { elapsed_ms: Date.now() - started, bytes: loaded.bytes, request_id: requestId, message_id: messageId });
          return { manifest: loaded.manifest, messageId, ...(pointerRepair ? { pointerRepair } : {}) };
        };

        const pointerId = knownIndexPointer.messageId;
        if (pointerId) {
          const loaded = await readCandidate(pointerId);
          assertIndexNotCancelled(requestId);
          if (loaded) return finish(pointerId, loaded);
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_POINTER_INVALID", { message_id: pointerId });
        }

        // Pin lookup is recovery only. It repairs a missing/stale PostgreSQL
        // shortcut without treating a failed shortcut as an empty library.
        if (requestId) stage1Trace(requestId, "WORKER_INDEX_GET_FULL_CHAT_BEGIN");
        const fullChat = requestId
          ? await observeMtprotoRpc(active, requestId, "WORKER_INDEX_GET_FULL_CHAT", ["channels.getFullChannel", "messages.getFullChat"], () => active.getFullChat(chatId))
          : await active.getFullChat(chatId);
        assertIndexNotCancelled(requestId);
        if (!indexPriorityAllowed()) { resumed = true; continue; }
        const pinnedId = Number(fullChat.pinnedMsgId || 0);
        if (requestId) {
          stage1Trace(requestId, "WORKER_INDEX_GET_FULL_CHAT_LOCAL_DONE", { pinned_message_present: pinnedId > 0 });
          stage1Trace(requestId, "WORKER_INDEX_GET_FULL_CHAT_END");
        }
        if (Number.isSafeInteger(pinnedId) && pinnedId > 0) {
          const loaded = await readCandidate(pinnedId);
          if (loaded) return finish(pinnedId, loaded, { expectedMessageId: pointerId || null, source: "pin_recovery" });
        }

        // A bad pin is not proof of absence. Exhaust the vault history only in
        // recovery, validate candidates, and only then allow initial creation.
        if (requestId) stage1Trace(requestId, "WORKER_INDEX_HISTORY_RECOVERY_BEGIN");
        let recovered: { messageId: number; loaded: { manifest: unknown; bytes: number } } | null = null;
        for await (const candidate of (active as any).iterHistory(chatId, { limit: Infinity })) {
          const candidateId = Number(candidate?.id || 0);
          if (!Number.isSafeInteger(candidateId) || candidateId <= 0 || !String(candidate?.text || "").startsWith(LIBRARY_INDEX_CAPTION)) continue;
          const loaded = await readCandidate(candidateId);
          if (loaded) { recovered = { messageId: candidateId, loaded }; break; }
        }
        if (recovered) return finish(recovered.messageId, recovered.loaded, { expectedMessageId: pointerId || null, source: "history_recovery" });
        if (requestId) stage1Trace(requestId, "WORKER_INDEX_HISTORY_RECOVERY_EMPTY");
        if (allowMissing) return { messageId: 0, manifest: { schema: "beatgaler.telegram.library", version: 2, beats: [], trash: [], deleted: [] } };
        throw new Error("Galer Cloud library index is still synchronizing.");
      } catch (error) {
        const preemptReason = activeIndexAbortReason;
        if (preemptReason === "cancel" || (requestId && cancelledIndexRequests.has(requestId))) {
          throw error instanceof WorkerTransportError
            ? error
            : new WorkerTransportError("CANCELLED", "Galer Cloud INDEX read was cancelled.");
        }
        if ((preemptReason === "play" || preemptReason === "warm") && (activeIndexAbortController?.signal.aborted || isAbortError(error) || !indexPriorityAllowed())) {
          resumed = true;
          continue;
        }
        const failedAttempt = failures + 1;
        if (requestId) stage1Trace(requestId, "WORKER_INDEX_ATTEMPT_FAILED", {
          attempt: failedAttempt,
          error_name: error instanceof Error ? error.name : "unknown",
        });
        failures += 1;
        playTrace("WORKER_GET_INDEX_RETRY", { attempt: failures, error_name: error instanceof Error ? error.name : "unknown" });
        if (failures < 5) {
          const delayMs = Math.min(1000, 80 * (2 ** (failures - 1)));
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_RETRY_BACKOFF_BEGIN", { attempt: failures, delay_ms: delayMs });
          await new Promise(resolve => setTimeout(resolve, delayMs));
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_RETRY_BACKOFF_END", { attempt: failures });
        } else {
          if (requestId) stage1Trace(requestId, "WORKER_INDEX_RETRY_EXHAUSTED", { attempt: failures });
          throw error;
        }
      } finally {
        if (activeIndexAbortController === controller) activeIndexAbortController = null;
        if (activeIndexRequestId === requestId) activeIndexRequestId = null;
        activeIndexAbortReason = null;
      }
    }
    throw new Error("Galer Cloud library index could not be read.");
  } finally {
    if (requestId) cancelledIndexRequests.delete(requestId);
  }
}

function libraryIdentityIds(manifest: unknown): Set<string> {
  const root = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest as Record<string, unknown> : {};
  const ids = new Set<string>();
  for (const value of Array.isArray(root.beats) ? root.beats : []) {
    const id = String((value as Record<string, unknown>)?.id || "").trim();
    if (id) ids.add(id);
  }
  for (const value of Array.isArray(root.trash) ? root.trash : []) {
    const row = value as Record<string, unknown>;
    const beat = row?.beat && typeof row.beat === "object" ? row.beat as Record<string, unknown> : row;
    const id = String(beat?.id || "").trim();
    if (id) ids.add(id);
  }
  for (const value of Array.isArray(root.deleted) ? root.deleted : []) {
    const row = value as Record<string, unknown>;
    const id = String(row?.beat_id || row?.id || "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

async function replaceLibraryIndex(input: WebTransportReplaceIndexInput): Promise<WebTransportReplaceIndexResult> {
  const active = requireReady();
  const root = input.manifest && typeof input.manifest === "object" && !Array.isArray(input.manifest)
    ? input.manifest as Record<string, unknown> : null;
  if (!root || root.schema !== "beatgaler.telegram.library" || Number(root.version) !== 2) throw new Error("Galer Cloud refused an invalid library update.");
  // Only an explicit empty-vault bootstrap may start without an INDEX. Network,
  // corrupt-document and foreign-pin errors still fail closed.
  playTrace("WORKER_REPLACE_INDEX_BEGIN", { expected_message_id: input.expectedMessageId || 0 });
  const current = await getLibraryIndex(null, input.expectedMessageId === 0);
  if (current.messageId !== input.expectedMessageId) throw new Error("Your library changed on another device. Retry Save to use the latest version.");
  const candidateIds = libraryIdentityIds(root);
  const missing = Array.from(libraryIdentityIds(current.manifest)).filter(id => !candidateIds.has(id));
  if (missing.length > 0) throw new Error("Galer Cloud blocked a stale library update.");
  const bytes = new TextEncoder().encode(JSON.stringify(root));
  if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) throw new Error("Galer Cloud library update has an invalid size.");
  const file = new File([bytes], `beatgaler-library-${Date.now()}.json`, { type: "application/json" });
  const sent = await active.sendMedia(chatId, InputMedia.document(file, {
    fileName: file.name, fileMime: file.type, fileSize: file.size, caption: LIBRARY_INDEX_CAPTION,
  }), { silent: true });
  const messageId = Number(sent?.id || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud returned incomplete library information.");
  try {
    await active.pinMessage({ chatId, message: messageId, notify: false });
    let pinned = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const full = await active.getFullChat(chatId);
      if (Number(full.pinnedMsgId || 0) === messageId) { pinned = true; break; }
      await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
    }
    if (!pinned) throw new Error("Galer Cloud could not verify the library update.");
  } catch (error) {
    await active.deleteMessagesById(chatId, [messageId]).catch(() => {});
    throw error;
  }
  if (current.messageId && current.messageId !== messageId) await active.deleteMessagesById(chatId, [current.messageId]).catch(() => {});
  const result = { messageId, previousMessageId: current.messageId, beatCount: Array.isArray(root.beats) ? root.beats.length : 0 };
  // A later read in this live Worker must use the newly pinned document even
  // before the asynchronous Cloud pointer acknowledgement returns.
  knownIndexPointer = { messageId, revision: knownIndexPointer.revision };
  playTrace("WORKER_REPLACE_INDEX_DONE", { message_id: result.messageId, previous_message_id: result.previousMessageId, beat_count: result.beatCount });
  return result;
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && new TextDecoder().decode(bytes.subarray(0, 6)).startsWith("GIF8")) return "image/gif";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return "image/png";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

async function download(input: WebTransportDownloadInput): Promise<WebTransportDownloadResult> {
  const active = requireReady();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud object reference is invalid.");
  const [message] = await active.getMessages(chatId, [messageId]);
  if (!message) throw new WorkerTransportError("ROUTE_MISSING", "Galer Cloud object no longer exists.");
  const bytes = await active.downloadAsBuffer(downloadableMedia(message), { stallTimeout: 20_000 });
  if (bytes.byteLength <= 0) throw new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud returned an empty object.");
  const declaredMime = String(input.mimeType || "").trim().toLowerCase();
  const mimeType = /^image\/(?:png|jpe?g|gif|webp|bmp|avif)$/.test(declaredMime) ? declaredMime : sniffImageMime(bytes);
  return { messageId, dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}` };
}

async function deleteMessages(input: WebTransportDeleteMessagesInput): Promise<WebTransportDeleteMessagesResult> {
  const active = requireReady();
  const ids = Array.from(new Set(input.messageIds.map(Number).filter(id => Number.isInteger(id) && id > 0)));
  let deleted = 0;
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    await active.deleteMessagesById(chatId, batch);
    deleted += batch.length;
  }
  return { deleted };
}

function downloadMime(value: unknown): string {
  const mime = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mime) ? mime : "application/octet-stream";
}

function playbackChunkLimit(desiredBytes: number): number {
  const desired = Math.max(1, Math.floor(Number(desiredBytes) || 0));
  return Math.ceil(desired / 4096) * 4096;
}

function playbackRangeKey(messageId: number, offsetBytes: number, limit: number): string {
  return `${messageId}:${offsetBytes}:${limit}`;
}

function cachedPlaybackRange(key: string): Uint8Array | null {
  const cached = playbackRangeCache.get(key);
  if (!cached) return null;
  playbackRangeCache.delete(key);
  return cached.bytes.slice();
}

function storePlaybackRange(key: string, bytes: Uint8Array): void {
  playbackRangeCache.delete(key);
  playbackRangeCache.set(key, { bytes: bytes.slice(), lastUsedAt: Date.now() });
  while (playbackRangeCache.size > MAX_PLAYBACK_RANGE_CACHE_ENTRIES) {
    const oldest = playbackRangeCache.keys().next().value as string | undefined;
    if (!oldest) break;
    playbackRangeCache.delete(oldest);
  }
}

function abortUnownedPlaybackRanges(messageId?: number): void {
  for (const range of pendingPlaybackRanges.values()) {
    if (messageId !== undefined && range.messageId !== messageId) continue;
    if (range.consumers.size === 0 && playbackMessageId !== range.messageId) range.controller.abort();
  }
}

function promotePlaybackRanges(messageId: number): void {
  promoteDataLaneWaiters(messageId);
  for (const range of pendingPlaybackRanges.values()) {
    if (range.messageId !== messageId || range.priority === "foreground") continue;
    range.priority = "foreground";
    playTrace("WORKER_PLAYBACK_RANGE_PROMOTED", {
      message_id: messageId,
      offset_bytes: range.offsetBytes,
      limit_bytes: range.limit,
      intent_id: playbackIntentId,
    });
  }
}

function startSharedPlaybackRange(
  active: TelegramClient,
  resolved: ResolvedPlaybackMedia,
  messageId: number,
  offsetBytes: number,
  limit: number,
  priority: DataLanePriority,
  trace: PlaybackFetchTrace,
): SharedPlaybackRange {
  const generation = playbackResourceGeneration;
  const key = playbackRangeKey(messageId, offsetBytes, limit);
  const operation: SharedPlaybackRange = {
    key,
    generation,
    messageId,
    offsetBytes,
    limit,
    priority,
    controller: new AbortController(),
    consumers: new Set<string>(),
    settled: false,
    promise: Promise.resolve(new Uint8Array()),
  };
  pendingPlaybackRanges.set(key, operation);
  operation.promise = withDataLane(async () => {
    const downloadStarted = performance.now();
    playTrace("WORKER_PREFIX_DOWNLOAD_BEGIN", { ...playbackTraceFields(trace), offset_bytes: offsetBytes, limit_bytes: limit, shared: true, connection: playbackConnectionSnapshot(active) });
    try {
      const result = await (playbackGetFileTrace?.run(operation.controller.signal, () => playbackTraceFields(trace),
        () => active.downloadChunk({ location: resolved.media, offset: offsetBytes, limit, abortSignal: operation.controller.signal }))
        ?? active.downloadChunk({ location: resolved.media, offset: offsetBytes, limit, abortSignal: operation.controller.signal }));
      if (generation !== playbackResourceGeneration || client !== active) {
        throw new WorkerTransportError("SESSION_INVALID", "Galer Cloud playback session changed.");
      }
      if (result.byteLength <= 0) throw new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud returned an empty playback range.");
      const stored = result.slice();
      storePlaybackRange(key, stored);
      playTrace("WORKER_PREFIX_DOWNLOAD_DONE", { ...playbackTraceFields(trace), offset_bytes: offsetBytes, bytes: stored.byteLength, shared: true, elapsed_ms: Math.round((performance.now() - downloadStarted) * 10) / 10, connection: playbackConnectionSnapshot(active) });
      return stored;
    } catch (error) {
      playTrace("WORKER_PREFIX_DOWNLOAD_ERROR", { ...playbackTraceFields(trace), offset_bytes: offsetBytes, shared: true, elapsed_ms: Math.round((performance.now() - downloadStarted) * 10) / 10, aborted: operation.controller.signal.aborted, error_name: error instanceof Error ? error.name : "unknown", connection: playbackConnectionSnapshot(active) });
      throw error;
    }
  }, priority, trace).finally(() => {
    operation.settled = true;
    if (pendingPlaybackRanges.get(key) === operation) pendingPlaybackRanges.delete(key);
  });
  void operation.promise.catch(() => {});
  return operation;
}

async function consumeSharedPlaybackRange(
  active: TelegramClient,
  resolved: ResolvedPlaybackMedia,
  messageId: number,
  offsetBytes: number,
  limit: number,
  priority: DataLanePriority,
  trace: PlaybackFetchTrace,
  consumerId: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const key = playbackRangeKey(messageId, offsetBytes, limit);
  const cached = cachedPlaybackRange(key);
  if (cached) {
    playTrace("WORKER_PLAYBACK_RANGE_CACHE_HIT", { ...playbackTraceFields(trace), offset_bytes: offsetBytes, limit_bytes: limit, bytes: cached.byteLength });
    return cached;
  }
  let operation = pendingPlaybackRanges.get(key);
  if (!operation || operation.generation !== playbackResourceGeneration) {
    operation = startSharedPlaybackRange(active, resolved, messageId, offsetBytes, limit, priority, trace);
  } else {
    playTrace("WORKER_PLAYBACK_RANGE_PENDING_JOIN", { ...playbackTraceFields(trace), offset_bytes: offsetBytes, limit_bytes: limit, owner_count: operation.consumers.size });
  }
  operation.consumers.add(consumerId);
  if (priority === "foreground" && operation.priority !== "foreground") {
    operation.priority = "foreground";
    promoteDataLaneWaiters(messageId);
  }
  if (signal?.aborted) {
    operation.consumers.delete(consumerId);
    abortUnownedPlaybackRanges(messageId);
    throw new DOMException("Playback range consumer cancelled.", "AbortError");
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    let finished = false;
    const detach = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      operation!.consumers.delete(consumerId);
      abortUnownedPlaybackRanges(messageId);
    };
    const onAbort = () => {
      detach();
      reject(new DOMException("Playback range consumer cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    operation!.promise.then(
      bytes => { if (!finished) { detach(); resolve(bytes.slice()); } },
      error => { if (!finished) { detach(); reject(error); } },
    );
  });
}

async function prefetch(requestId: string, input: WebTransportPrefetchInput): Promise<WebTransportPrefetchResult> {
  const started = Date.now();
  const active = requireReady();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud object reference is invalid.");
  const trace: PlaybackFetchTrace = { requestId, messageId, traceIntentId: input.traceIntentId, source: "foreground_prefetch" };
  playTrace("WORKER_PREFETCH_ENTER", playbackTraceFields(trace));
  const resolved = await resolvePlaybackMedia(active, messageId, trace);
  playTrace("WORKER_MEDIA_RESOLVE_READY", { ...playbackTraceFields(trace), media_cache_hit: resolved.cacheHit, elapsed_ms: Date.now() - started });
  const offsetBytes = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));
  if (offsetBytes % 4096 !== 0) throw new WorkerTransportError("TRANSFER_FAILED", "Galer Cloud playback offset must be aligned to 4 KiB.");
  const remaining = resolved.totalBytes > 0 ? Math.max(0, resolved.totalBytes - offsetBytes) : WEB_PLAYBACK_FIRST_CHUNK_BYTES;
  const desired = Math.min(WEB_PLAYBACK_FIRST_CHUNK_BYTES, remaining || WEB_PLAYBACK_FIRST_CHUNK_BYTES);
  const limit = playbackChunkLimit(desired);
  const bytes = await consumeSharedPlaybackRange(active, resolved, messageId, offsetBytes, limit, "foreground", trace, `prefetch:${requestId}`);
  if (bytes.byteLength <= 0) throw new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud returned an empty playback prefix.");
  const prefix = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const mimeType = downloadMime(input.mimeType || resolved.sourceMime);
  const measurement = offsetBytes === 0 ? measureMp3PlayablePrefix(prefix) : null;
  playTrace("WORKER_PREFETCH_READY", { ...playbackTraceFields(trace), bytes: prefix.byteLength, elapsed_ms: Date.now() - started, media_cache_hit: resolved.cacheHit, playable_seconds: measurement?.playableSeconds ?? null });
  return { messageId, totalBytes: resolved.totalBytes || offsetBytes + prefix.byteLength, mimeType, prefix, playableSeconds: measurement?.playableSeconds || 0, targetMet: true };
}

function normalizeBatchState(input: WebTransportPrefetchInput): BatchPrefetchState {
  const messageId = Number(input.messageId || 0);
  const offsetBytes = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));
  return {
    messageId,
    requestedMimeType: String(input.mimeType || "").trim() || null,
    offsetBytes,
    media: null,
    totalBytes: 0,
    mimeType: downloadMime(input.mimeType),
    chunks: [],
    downloadedBytes: 0,
    playableSeconds: 0,
    targetMet: false,
    done: false,
    error: null,
    errorCode: null,
    terminalEmitted: false,
    warmState: "queued",
    controller: null,
    cancelled: false,
  };
}

function codeForError(error: unknown, fallback: WebTransportErrorCode): WebTransportErrorCode {
  return error instanceof WorkerTransportError ? error.code : fallback;
}

function postPrefetchTerminal(
  requestId: string,
  state: BatchPrefetchState,
  status: WebTransportPrefetchTerminal["status"],
  code?: WebTransportErrorCode,
  error?: string,
): void {
  if (state.terminalEmitted) return;
  state.terminalEmitted = true;
  const terminal: WebTransportPrefetchTerminal = {
    messageId: state.messageId,
    status,
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
  };
  scope.postMessage({ requestId, event: "prefetch-terminal", terminal });
  playTrace("WORKER_PREFETCH_TERMINAL", { ...playbackTraceFields({ requestId, messageId: state.messageId, source: "warm_batch" }), status, code: code || null });
}

async function resolveBatchStates(requestId: string, active: TelegramClient, states: BatchPrefetchState[]): Promise<void> {
  const valid: BatchPrefetchState[] = [];
  for (const state of states) {
    if (!Number.isInteger(state.messageId) || state.messageId <= 0) {
      state.error = new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud object reference is invalid.");
      state.errorCode = "MEDIA_UNAVAILABLE";
      state.done = true;
      state.warmState = "failed";
      postPrefetchTerminal(requestId, state, "FAILED", state.errorCode, state.error.message);
      continue;
    }
    if (state.offsetBytes % 4096 !== 0) {
      state.error = new WorkerTransportError("TRANSFER_FAILED", "Galer Cloud playback offset must be aligned to 4 KiB.");
      state.errorCode = "TRANSFER_FAILED";
      state.done = true;
      state.warmState = "failed";
      postPrefetchTerminal(requestId, state, "FAILED", state.errorCode, state.error.message);
      continue;
    }
    valid.push(state);
  }
  if (valid.length === 0) return;
  let batch: PlaybackMediaBatchResolution;
  try {
    batch = await resolvePlaybackMediaBatch(active, chatId, valid.map(state => state.messageId), { requestId, source: "warm_batch" });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const state of valid) {
      state.error = failure;
      state.errorCode = codeForError(failure, "TRANSFER_FAILED");
      state.done = true;
      state.warmState = "failed";
      postPrefetchTerminal(requestId, state, "FAILED", state.errorCode, failure.message);
    }
    return;
  }
  for (const state of valid) {
    const resolved = batch.resolved.get(state.messageId);
    if (!resolved) {
      state.error = batch.missing.get(state.messageId) || new WorkerTransportError("ROUTE_MISSING", "Galer Cloud object no longer exists.");
      state.errorCode = codeForError(state.error, "ROUTE_MISSING");
      state.done = true;
      state.warmState = "failed";
      postPrefetchTerminal(requestId, state, "FAILED", state.errorCode, state.error.message);
      continue;
    }
    state.media = resolved.media;
    state.totalBytes = resolved.totalBytes;
    state.mimeType = downloadMime(state.requestedMimeType || resolved.sourceMime);
    playTrace("WORKER_WARM_MEDIA_READY", { ...playbackTraceFields({ requestId, messageId: state.messageId, source: "warm_batch" }), media_cache_hit: resolved.cacheHit, total_bytes: state.totalBytes });
    if (state.totalBytes > 0 && state.offsetBytes >= state.totalBytes) {
      state.done = true;
      state.targetMet = true;
      state.warmState = "ready";
      postPrefetchTerminal(requestId, state, "READY");
    }
  }
}

function warmConcurrencyLimit(): number {
  const limit = playbackSchedulerState === "PLAY_CRITICAL" ? 0
    : playbackSchedulerState === "PLAY_STABLE" ? 6 : dataLaneLimit;
  return Math.max(0, Math.min(dataLaneLimit, limit));
}

function moveFocusedTargetToFront(control: PrefetchBatchControl, messageId: number): void {
  const index = control.pendingWarm.findIndex(state => state.messageId === messageId && !state.done && !state.cancelled);
  if (index <= 0) return;
  const [target] = control.pendingWarm.splice(index, 1);
  control.pendingWarm.unshift(target);
}

function takeNextWarm(control: PrefetchBatchControl): BatchPrefetchState | null {
  control.pendingWarm = control.pendingWarm.filter(state => !state.done && !state.cancelled && !state.error);
  if (control.pendingWarm.length === 0) return null;
  if (playbackSchedulerState === "PLAY_CRITICAL") {
    if (!playbackMessageId) return null;
    moveFocusedTargetToFront(control, playbackMessageId);
    const target = control.pendingWarm[0];
    if (target?.messageId !== playbackMessageId) return null;
    control.pendingWarm.shift();
    return target;
  }
  if (activeWarmTransfers.size >= warmConcurrencyLimit()) return null;
  return control.pendingWarm.shift() || null;
}

function batchTerminal(control: PrefetchBatchControl): boolean {
  return control.states.every(state => state.done || state.cancelled || state.error);
}

async function downloadStartupPrefix(requestId: string, state: BatchPrefetchState, control: PrefetchBatchControl): Promise<void> {
  if (state.done || state.error || state.cancelled || !state.media) return;
  const trace: PlaybackFetchTrace = { requestId, messageId: state.messageId, source: "warm_batch" };
  const absoluteOffset = state.offsetBytes;
  const remainingFile = state.totalBytes > 0 ? Math.max(0, state.totalBytes - absoluteOffset) : STARTUP_PREFIX_BYTES;
  const desired = Math.min(STARTUP_PREFIX_BYTES, remainingFile || STARTUP_PREFIX_BYTES);
  const limit = playbackChunkLimit(desired);
  if (desired <= 0) {
    state.done = true;
    state.targetMet = true;
    state.warmState = "ready";
    postPrefetchTerminal(requestId, state, "READY");
    return;
  }

  const controller = new AbortController();
  state.controller = controller;
  state.warmState = "active";
  const warmControllers = activeWarmTransfers.get(state.messageId) || new Set<AbortController>();
  warmControllers.add(controller);
  activeWarmTransfers.set(state.messageId, warmControllers);
  const promoted = playbackSchedulerState === "PLAY_CRITICAL" && playbackMessageId === state.messageId;
  try {
    const active = requireConnected();
    const bytes = await consumeSharedPlaybackRange(
      active,
      { media: state.media!, totalBytes: state.totalBytes, mimeType: state.mimeType, sourceMime: state.mimeType, cacheHit: true },
      state.messageId,
      absoluteOffset,
      limit,
      promoted ? "foreground" : "warm",
      trace,
      `warm:${requestId}:${state.messageId}`,
      controller.signal,
    );
    if (bytes.byteLength <= 0) throw new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud returned an empty playback prefix.");
    const stored = bytes.slice();
    state.chunks = [stored];
    state.downloadedBytes = stored.byteLength;
    state.targetMet = true;
    state.done = true;
    state.warmState = "ready";
    const downloadedAbsolute = absoluteOffset + stored.byteLength;
    const transferable = stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength) as ArrayBuffer;
    playTrace("WORKER_PREFIX_POST_BEGIN", { ...playbackTraceFields(trace), offset_bytes: absoluteOffset, bytes: transferable.byteLength });
    scope.postMessage({ requestId, event: "prefetch-chunk", progress: {
      messageId: state.messageId,
      totalBytes: state.totalBytes || downloadedAbsolute,
      mimeType: state.mimeType,
      offsetBytes: absoluteOffset,
      chunk: transferable,
      downloadedBytes: downloadedAbsolute,
      playableSeconds: 0,
      targetMet: true,
    } }, [transferable]);
    postPrefetchTerminal(requestId, state, "READY");
    playTrace("WARM_PREFIX_READY", { ...playbackTraceFields(trace), bytes: stored.byteLength, offset_bytes: absoluteOffset });
  } catch (error) {
    const cancelled = control.cancelAll || control.cancelledMessageIds.has(state.messageId) || state.cancelled;
    if (controller.signal.aborted && !cancelled) {
      state.warmState = "preempted";
      state.done = false;
      state.error = null;
      state.errorCode = null;
      if (!control.pendingWarm.includes(state)) control.pendingWarm.push(state);
      playTrace("WORKER_WARM_PREEMPTED", { ...playbackTraceFields(trace), offset_bytes: absoluteOffset });
    } else if (cancelled && isAbortError(error)) {
      state.cancelled = true;
      state.done = true;
      state.errorCode = "CANCELLED";
      postPrefetchTerminal(requestId, state, "FAILED", "CANCELLED", "Cancelled.");
    } else {
      state.error = error instanceof Error ? error : new Error(String(error));
      state.errorCode = codeForError(state.error, "TRANSFER_FAILED");
      state.done = true;
      state.warmState = "failed";
      postPrefetchTerminal(requestId, state, "FAILED", state.errorCode, state.error.message);
    }
  } finally {
    const controllers = activeWarmTransfers.get(state.messageId);
    controllers?.delete(controller);
    if (controllers?.size === 0) activeWarmTransfers.delete(state.messageId);
    if (state.controller === controller) state.controller = null;
    notifyScheduler();
  }
}

async function prefetchBatch(requestId: string, input: WebTransportPrefetchBatchInput): Promise<WebTransportPrefetchBatchResult> {
  const started = Date.now();
  const active = requireReady();
  const deduped = new Map<number, WebTransportPrefetchInput>();
  for (const candidate of Array.isArray(input.inputs) ? input.inputs : []) {
    const messageId = Number(candidate?.messageId || 0);
    if (!deduped.has(messageId)) deduped.set(messageId, candidate);
  }
  const states = Array.from(deduped.values(), normalizeBatchState);
  const maxConcurrency = configureDataLaneLimit(input.maxConcurrency);
  const control: PrefetchBatchControl = {
    requestId,
    cancelAll: false,
    cancelledMessageIds: new Set(),
    states,
    pendingWarm: [],
    maxConcurrency,
  };
  activePrefetchBatches.set(requestId, control);
  playTrace("WARM_BATCH_BEGIN", { request_id: requestId, count: states.length, prefix_bytes: STARTUP_PREFIX_BYTES, lanes: maxConcurrency });
  try {
    await resolveBatchStates(requestId, active, states);
    control.pendingWarm = states.filter(state => !state.done && !state.error && !state.cancelled);
    for (const state of control.pendingWarm) playTrace("WORKER_WARM_QUEUE_ENTER", { ...playbackTraceFields({ requestId, messageId: state.messageId, source: "warm_batch" }), scheduler: playbackSchedulerState });
    if (playbackMessageId) moveFocusedTargetToFront(control, playbackMessageId);
    notifyScheduler();

    const laneLoop = async (lane: number) => {
      while (!control.cancelAll) {
        if (batchTerminal(control)) return;
        const epoch = schedulerEpoch;
        const state = takeNextWarm(control);
        if (!state) {
          if (batchTerminal(control)) return;
          await waitForSchedulerChange(epoch);
          continue;
        }
        playTrace("WORKER_PREFETCH_LANE_TAKE", { ...playbackTraceFields({ requestId, messageId: state.messageId, source: "warm_batch" }), lane, scheduler: playbackSchedulerState });
        await downloadStartupPrefix(requestId, state, control);
        await schedulerYield();
      }
    };
    const laneCount = Math.min(maxConcurrency, Math.max(1, states.length));
    await Promise.all(Array.from({ length: laneCount }, (_, index) => laneLoop(index + 1)));

    const results: WebTransportPrefetchBatchItemResult[] = states.map(state => {
      if (state.error) return { ok: false as const, messageId: state.messageId, error: state.error.message, code: state.errorCode || undefined };
      if (state.cancelled) return { ok: false as const, messageId: state.messageId, error: "Cancelled.", code: "CANCELLED" as const };
      const prefixBytes = concatBytes(state.chunks);
      const prefix = prefixBytes.buffer.slice(prefixBytes.byteOffset, prefixBytes.byteOffset + prefixBytes.byteLength) as ArrayBuffer;
      return { ok: true as const, result: {
        messageId: state.messageId,
        totalBytes: state.totalBytes || state.offsetBytes + state.downloadedBytes,
        mimeType: state.mimeType,
        prefix,
        playableSeconds: 0,
        targetMet: state.targetMet,
      } };
    });
    playTrace("WORKER_PREFETCH_BATCH_DONE", { count: states.length, elapsed_ms: Date.now() - started, failures: results.filter(result => !result.ok).length });
    return { results };
  } finally {
    activePrefetchBatches.delete(requestId);
    notifyScheduler();
  }
}

function cancelPrefetchBatch(targetRequestId: string, messageId?: number): { cancelled: boolean } {
  const control = activePrefetchBatches.get(String(targetRequestId || ""));
  if (!control) return { cancelled: false };
  if (Number.isInteger(messageId) && Number(messageId) > 0) {
    const id = Number(messageId);
    control.cancelledMessageIds.add(id);
    const state = control.states.find(candidate => candidate.messageId === id);
    if (state) {
      state.cancelled = true;
      state.done = true;
      state.errorCode = "CANCELLED";
      state.controller?.abort();
      postPrefetchTerminal(control.requestId, state, "FAILED", "CANCELLED", "Cancelled.");
    }
    control.pendingWarm = control.pendingWarm.filter(candidate => candidate.messageId !== id);
  } else {
    control.cancelAll = true;
    for (const state of control.states) {
      if (!state.done) {
        state.cancelled = true;
        state.done = true;
        state.errorCode = "CANCELLED";
        state.controller?.abort();
        postPrefetchTerminal(control.requestId, state, "FAILED", "CANCELLED", "Cancelled.");
      }
    }
    control.pendingWarm.length = 0;
  }
  notifyScheduler();
  return { cancelled: true };
}

function playbackFocus(messageId: number, traceIntentId?: number): { focused: boolean } {
  const id = Number(messageId || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return { focused: false };
  const previousMessageId = playbackMessageId;
  playbackIntentId = Number.isSafeInteger(traceIntentId) && Number(traceIntentId) > 0 ? Number(traceIntentId) : (playbackMessageId === id ? playbackIntentId : null);
  playbackSchedulerState = "PLAY_CRITICAL";
  playbackMessageId = id;
  playTrace("WORKER_PLAYBACK_FOCUS", { message_id: id, intent_id: playbackIntentId });
  preemptActiveIndex("play");
  let aborted = 0;
  for (const [activeId, controllers] of activeWarmTransfers) {
    if (activeId === id) continue;
    for (const controller of controllers) {
      controller.abort();
      aborted += 1;
    }
  }
  for (const control of activePrefetchBatches.values()) moveFocusedTargetToFront(control, id);
  promotePlaybackRanges(id);
  if (previousMessageId !== null && previousMessageId !== id) abortUnownedPlaybackRanges(previousMessageId);
  playTrace("PLAY_WARM_PREEMPT_ALL", { message_id: id, aborted });
  notifyScheduler();
  return { focused: true };
}

function playbackStable(messageId: number, traceIntentId?: number): { stable: boolean } {
  const id = Number(messageId || 0);
  if (playbackMessageId !== id) return { stable: false };
  if (Number.isSafeInteger(traceIntentId) && Number(traceIntentId) > 0 && playbackIntentId !== Number(traceIntentId)) {
    playTrace("WORKER_PLAYBACK_STALE_STABLE_IGNORED", { message_id: id, intent_id: traceIntentId, current_intent_id: playbackIntentId });
    return { stable: false };
  }
  playbackSchedulerState = "PLAY_STABLE";
  playTrace("WARM_RESUME", { lanes: 6, message_id: id });
  notifyScheduler();
  return { stable: true };
}

function playbackRelease(messageId: number, traceIntentId?: number): { released: boolean } {
  const id = Number(messageId || 0);
  if (playbackMessageId !== id) return { released: false };
  if (Number.isSafeInteger(traceIntentId) && Number(traceIntentId) > 0 && playbackIntentId !== Number(traceIntentId)) {
    playTrace("WORKER_PLAYBACK_STALE_RELEASE_IGNORED", { message_id: id, intent_id: traceIntentId, current_intent_id: playbackIntentId });
    return { released: false };
  }
  playbackMessageId = null;
  playbackIntentId = null;
  playbackSchedulerState = "IDLE";
  abortUnownedPlaybackRanges(id);
  playTrace("WARM_RESUME", { lanes: dataLaneLimit });
  notifyScheduler();
  return { released: true };
}

async function stream(requestId: string, input: WebTransportStreamInput): Promise<WebTransportStreamResult> {
  const started = Date.now();
  const active = requireReady();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud object reference is invalid.");
  const trace: PlaybackFetchTrace = { requestId, messageId, traceIntentId: input.traceIntentId, source: "stream" };
  playTrace("WORKER_STREAM_ENTER", { ...playbackTraceFields(trace), offset_bytes: input.offsetBytes ?? 0 });
  const resolved = await resolvePlaybackMedia(active, messageId, trace);
  playTrace("WORKER_MEDIA_RESOLVE_READY", { ...playbackTraceFields(trace), media_cache_hit: resolved.cacheHit, elapsed_ms: Date.now() - started });
  const media = resolved.media;
  const totalBytes = resolved.totalBytes;
  const mimeType = downloadMime(input.mimeType || resolved.sourceMime);
  const offsetBytes = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));
  if (offsetBytes % 4096 !== 0) throw new WorkerTransportError("TRANSFER_FAILED", "Galer Cloud playback offset must be aligned to 4 KiB.");
  if (totalBytes > 0 && offsetBytes >= totalBytes) return { messageId, totalBytes, mimeType };
  const controller = new AbortController();
  const state = { controller, acknowledge: null as (() => void) | null };
  activeStreams.set(requestId, state);
  let downloadedBytes = offsetBytes;
  let transferredBytes = 0;
  let iterator: AsyncIterator<Uint8Array> | null = null;
  playTrace("PLAY_STREAM_BEGIN", { ...playbackTraceFields(trace), offset_bytes: offsetBytes });
  try {
    const firstRemaining = totalBytes > 0 ? Math.max(0, totalBytes - downloadedBytes) : WEB_PLAYBACK_FIRST_CHUNK_BYTES;
    const firstDesired = Math.min(WEB_PLAYBACK_FIRST_CHUNK_BYTES, firstRemaining || WEB_PLAYBACK_FIRST_CHUNK_BYTES);
    if (firstDesired > 0) {
      const limit = playbackChunkLimit(firstDesired);
      playTrace("WORKER_STREAM_FIRST_READ_BEGIN", { ...playbackTraceFields(trace), offset_bytes: downloadedBytes, connection: playbackConnectionSnapshot(active) });
      const readStarted = performance.now();
      const chunk = await consumeSharedPlaybackRange(
        active,
        resolved,
        messageId,
        downloadedBytes,
        limit,
        "foreground",
        trace,
        `stream:${requestId}`,
        controller.signal,
      );
      playTrace("WORKER_STREAM_FIRST_READ_DONE", { ...playbackTraceFields(trace), offset_bytes: offsetBytes, bytes: chunk.byteLength, elapsed_ms: Math.round((performance.now() - readStarted) * 10) / 10, connection: playbackConnectionSnapshot(active) });
      downloadedBytes += chunk.byteLength;
      transferredBytes += chunk.byteLength;
      playTrace("PLAY_STREAM_FIRST_CHUNK", { ...playbackTraceFields(trace), elapsed_ms: Date.now() - started, bytes: chunk.byteLength, offset_bytes: offsetBytes });
      const transferable = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      playTrace("WORKER_STREAM_FIRST_POST_BEGIN", { ...playbackTraceFields(trace), offset_bytes: offsetBytes, bytes: transferable.byteLength });
      scope.postMessage({ requestId, event: "download-chunk", chunk: transferable, downloadedBytes, totalBytes: totalBytes || downloadedBytes }, [transferable]);
      await new Promise<void>(resolve => { state.acknowledge = resolve; });
      state.acknowledge = null;
    }
    if (totalBytes > 0 && downloadedBytes >= totalBytes) return { messageId, totalBytes, mimeType };
    iterator = active.downloadAsIterable(media, {
      abortSignal: controller.signal,
      stallTimeout: 20_000,
      partSize: WEB_PLAYBACK_FIRST_CHUNK_KB,
      offset: downloadedBytes,
    })[Symbol.asyncIterator]();
    while (true) {
      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");
      const next = await withDataLane(async () => {
        return await iterator!.next();
      }, "foreground");
      if (next.done) break;
      const chunk = next.value;
      downloadedBytes += chunk.byteLength;
      transferredBytes += chunk.byteLength;
      const transferable = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      scope.postMessage({ requestId, event: "download-chunk", chunk: transferable, downloadedBytes, totalBytes: totalBytes || downloadedBytes }, [transferable]);
      await new Promise<void>(resolve => { state.acknowledge = resolve; });
      state.acknowledge = null;
    }
    if (transferredBytes <= 0 && !(totalBytes > 0 && offsetBytes >= totalBytes)) throw new WorkerTransportError("MEDIA_UNAVAILABLE", "Galer Cloud returned an empty object.");
    return { messageId, totalBytes: totalBytes || downloadedBytes, mimeType };
  } finally {
    activeStreams.delete(requestId);
    if (typeof iterator?.return === "function") await iterator.return().catch(() => {});
  }
}

function cancelStream(targetRequestId: string): { cancelled: boolean } {
  const stream = activeStreams.get(String(targetRequestId || ""));
  stream?.controller.abort();
  stream?.acknowledge?.();
  return { cancelled: Boolean(stream) };
}

function acknowledgeStream(targetRequestId: string): { acknowledged: boolean } {
  const stream = activeStreams.get(String(targetRequestId || ""));
  stream?.acknowledge?.();
  return { acknowledged: Boolean(stream) };
}

function validateFile(file: File): void {
  if (!(file instanceof File) || file.size <= 0) throw new Error("Upload source is missing or empty.");
  if (file.size > WEB_DIRECT_MAX_FILE_BYTES) throw new Error("This file exceeds the 1.9 GB Galer Cloud Web limit.");
}

async function upload(requestId: string, input: Extract<WebTransportWorkerCommand, { op: "upload" }>["input"]): Promise<WebTransportUploadResult> {
  const active = requireReady();
  validateFile(input.file);
  playTrace("WORKER_UPLOAD_BEGIN", { kind: input.kind, bytes: input.file.size });
  const message = await active.sendMedia(chatId, InputMedia.document(input.file, {
    fileName: input.filename,
    fileMime: input.file.type || "application/octet-stream",
    fileSize: input.file.size,
    caption: `BEATGALER_MEDIA_V1 kind=${input.kind} beat=${input.beatId}`,
  }), {
    silent: true,
    replyTo: input.threadId,
    threadId: input.threadId,
    progressCallback: uploadedBytes => scope.postMessage({
      requestId,
      event: "progress",
      progress: { uploadedBytes: Math.min(input.file.size, Math.round(uploadedBytes)), totalBytes: input.file.size },
    }),
  });
  const messageId = Number(message?.id || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud returned incomplete uploaded file information.");
  const stored = { telegram_file_id: `direct:${messageId}`, telegram_message_id: messageId, index: 0, size: input.file.size, filename: input.filename };
  playTrace("WORKER_UPLOAD_DONE", { kind: input.kind, bytes: input.file.size, message_id: messageId });
  return { telegram_file_id: stored.telegram_file_id, telegram_message_id: messageId, filename: input.filename, original_size: input.file.size, parts: [stored], transport: "direct-web" };
}

async function handle(command: WebTransportWorkerCommand): Promise<unknown> {
  switch (command.op) {
    case "initialize": await initialize(command); return { ready: true };
    case "verify_identity": await verifyIdentity(command.requestId); return { verified: true };
    case "verify": return verifyReady(command.requestId, command.membership || null);
    case "get_index": return getLibraryIndex(command.requestId);
    case "cancel_index": return cancelIndex(command.targetRequestId);
    case "replace_index": return replaceLibraryIndex(command.input);
    case "delete_messages": return deleteMessages(command.input);
    case "download": return download(command.input);
    case "prefetch": return prefetch(command.requestId, command.input);
    case "prefetch_batch": return prefetchBatch(command.requestId, command.input);
    case "prefetch_batch_cancel": return cancelPrefetchBatch(command.targetRequestId, command.messageId);
    case "playback_focus": return playbackFocus(command.messageId, command.traceIntentId);
    case "playback_stable": return playbackStable(command.messageId, command.traceIntentId);
    case "playback_release": return playbackRelease(command.messageId, command.traceIntentId);
    case "stream": return stream(command.requestId, command.input);
    case "stream_ack": return acknowledgeStream(command.targetRequestId);
    case "cancel": return cancelStream(command.targetRequestId);
    case "upload": return upload(command.requestId, command.input);
    case "shutdown": await closeClient("shutdown", command.requestId); return { closed: true };
  }
}

scope.onmessage = event => {
  const command = event.data;
  stage1TraceContext = command.stage1TraceContext || null;
  if (command.op === "prefetch" || command.op === "prefetch_batch" || command.op === "stream" || command.op === "playback_focus") {
    playTrace("WORKER_PLAYBACK_REQUEST_RECEIVED", { request_id: command.requestId, operation: command.op, message_id: command.op === "playback_focus" ? command.messageId : command.op === "prefetch_batch" ? null : command.input.messageId, intent_id: command.op === "playback_focus" ? command.traceIntentId ?? null : command.op === "prefetch_batch" ? null : command.input.traceIntentId ?? null, message_ids: command.op === "prefetch_batch" ? command.input.inputs.map(input => input.messageId) : undefined });
  }
  if (command.op === "get_index") stage1Trace(command.requestId, "WORKER_INDEX_DISPATCH_RECEIVED");
  if (command.op === "initialize" || command.op === "verify" || command.op === "verify_identity") {
    playTrace("WORKER_REQUEST_RECEIVED", { request_id: command.requestId, operation: command.op });
  }
  void handle(command).then(
    result => {
      if (command.op === "get_index") stage1Trace(command.requestId, "WORKER_INDEX_RESPONSE");
      if (command.op === "prefetch") {
        const prefix = result as WebTransportPrefetchResult;
        playTrace("WORKER_PREFIX_RESPONSE_POST_BEGIN", { request_id: command.requestId, message_id: command.input.messageId, intent_id: command.input.traceIntentId ?? null, bytes: prefix.prefix.byteLength });
      }
      scope.postMessage({ requestId: command.requestId, ok: true, result });
    },
    error => scope.postMessage({
      requestId: command.requestId,
      ok: false,
      error: String((error as any)?.message || error),
      ...(error instanceof WorkerTransportError ? { code: error.code } : {}),
    }),
  );
};
