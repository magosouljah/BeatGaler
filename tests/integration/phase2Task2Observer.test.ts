import { afterEach, describe, expect, it, vi } from "vitest";
import { Bytes, FramedWriter } from "@fuman/io";
import { Long } from "@mtcute/web";

type Trace = { stage: string; detail: Record<string, any> };

describe("Task 2 opt-in observer through its actual Worker hooks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ties ping and getMessages msg_ids to exact WebSocket bytes, then classifies valid, old and discarded inbound frames", async () => {
    const posted: Array<{ event?: string; trace?: Trace }> = [];
    vi.stubGlobal("postMessage", (message: any) => { posted.push(message); });
    class FakeSocket {
      static instances: FakeSocket[] = [];
      listeners = new Map<string, Array<(event: any) => void>>();
      sent: Uint8Array[] = [];
      bufferedAmount = 0;
      failSend = false;
      url: string;
      constructor(url: string) { this.url = url; FakeSocket.instances.push(this); }
      addEventListener(name: string, handler: (event: any) => void) {
        this.listeners.set(name, [...(this.listeners.get(name) || []), handler]);
      }
      send(bytes: Uint8Array) {
        if (this.failSend) throw new Error("socket failed");
        this.sent.push(bytes.slice()); this.bufferedAmount += bytes.byteLength;
      }
      emit(name: string, event: any) { for (const handler of this.listeners.get(name) || []) handler(event); }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const worker = await import("../../src/features/cloud/webTransport.worker");
    (globalThis as any).onmessage({ data: {
      op: "cancel", requestId: "set-trace", targetRequestId: "none",
      stage1TraceContext: { correlation_id: "test", account_label: "01", task2_passive_ping_trace: true },
    } });
    const ingress = worker.installTask2PassiveIngressTrace("diag", "test-client");
    expect(ingress).not.toBeNull();
    const socket = new (globalThis.WebSocket as any)("wss://test") as FakeSocket;
    const pingMsgId = Long.fromNumber(100);
    const pingId = Long.fromNumber(900);
    const rpcMsgId = Long.fromNumber(108);
    const containerId = Long.fromNumber(112);
    const queued: Promise<void>[] = [];
    let acceptDecrypt = false;
    let flushSerial = 0;
    let writtenPingMsgId = pingMsgId;
    const session: any = {
      _sessionId: Long.fromNumber(42),
      lastPingMsgId: Long.ZERO,
      lastPingTime: 1,
      lastPingRtt: Number.NaN,
      pendingMessages: new Map(),
      queuedRpc: [],
      log: { warn: vi.fn() },
      _authKey: { log: { warn: vi.fn() } },
      _authKeyTemp: { log: { warn: vi.fn() } },
      _authKeyTempSecondary: { log: { warn: vi.fn() } },
      writeMessage() { return writtenPingMsgId; },
      resetLastPing() { this.pendingMessages.delete(this.lastPingMsgId); this.lastPingMsgId = Long.ZERO; },
      resetState() {},
      decryptMessage(_data: Uint8Array, callback: (...args: any[]) => void) {
        if (acceptDecrypt) callback();
        else this.log.warn("ignoring message with invalid sessionId = %h");
      },
    };
    const codec: any = {
      _inner: {
        encode(packet: Uint8Array, into: Bytes) {
          into.writeSync(1 + packet.length).set(Uint8Array.of(packet.length, ...packet));
        },
      },
      _encryptor: { process(plain: Uint8Array) { return Uint8Array.from(plain, byte => byte ^ 0x55); } },
      async encode(packet: Uint8Array, into: Bytes) {
        const temp = Bytes.alloc();
        await this._inner.encode(packet, temp);
        const encrypted = this._encryptor.process(temp.result());
        into.writeSync(encrypted.length).set(encrypted);
      },
      async decode() { return Uint8Array.of(4, 5, 6); },
    };
    const connection: any = {
      _uid: 1,
      _active: true,
      _session: session,
      _codec: codec,
      _writer: new FramedWriter({ write: async (bytes: Uint8Array) => socket.send(bytes) } as any, codec),
      _sendOnceConnected: [],
      _registerOutgoingMsgId(value: Long) { return value; },
      onUsable: { add: vi.fn(), remove: vi.fn() },
      _isActive: () => true,
      _flush() { return this._doFlush(); },
      _doFlush() {
        const sequence = flushSerial++;
        const currentPingMsgId = Long.fromNumber(100 + sequence * 20);
        const currentPingId = Long.fromNumber(900 + sequence * 20);
        const currentRpcMsgId = Long.fromNumber(108 + sequence * 20);
        const currentContainerId = Long.fromNumber(112 + sequence * 20);
        writtenPingMsgId = currentPingMsgId;
        const pingBytes = new Uint8Array(12);
        const view = new DataView(pingBytes.buffer);
        view.setUint32(0, 4_081_220_492, true);
        view.setBigInt64(4, BigInt(900 + sequence * 20), true);
        session.writeMessage(null, pingBytes);
        session.lastPingMsgId = currentPingMsgId;
        session.pendingMessages.set(currentPingMsgId, { _: "ping", pingId: currentPingId, containerId: currentContainerId });
        const rpc = { method: "channels.getMessages", msgId: currentRpcMsgId, containerId: currentContainerId, sent: true };
        session.pendingMessages.set(currentRpcMsgId, { _: "rpc", rpc });
        this._registerOutgoingMsgId(currentRpcMsgId);
        session.pendingMessages.set(currentContainerId, { _: "container", msgIds: [currentPingMsgId, currentRpcMsgId] });
        queued.push(this.send(Uint8Array.of(7, 8, 9, sequence)));
      },
      async send(data: Uint8Array) { await this._writer.write(data); },
      _onPong(pong: any) {
        const info = session.pendingMessages.get(pong.msgId);
        if (info?._ === "ping") session.resetLastPing();
      },
      _onMessageAcked() {},
      _onMessageFailed(failedId: Long) {
        const info = session.pendingMessages.get(failedId);
        if (info?._ === "rpc") {
          session.pendingMessages.delete(failedId);
          info.rpc.msgId = undefined;
          session.queuedRpc.push(info.rpc);
        }
      },
      _onRpcResult(_incoming: Long, reader: any) {
        const req = reader.dataView.getBigInt64(reader.pos, true).toString();
        for (const key of session.pendingMessages.keys()) {
          if (String(key) === req) session.pendingMessages.delete(key);
        }
      },
      _resetSession() {},
      onMessage(data: Uint8Array) {
        session.decryptMessage(data, () => this._handleMessage(Long.fromNumber(501), {
          _: "mt_pong", msgId: session.lastPingMsgId, pingId: Long.fromNumber(920),
        }));
      },
      _handleRawMessage() {},
      _handleMessage(_incoming: Long, object: any) {
        if (object._ === "mt_pong") this._onPong(object);
        if (object._ === "mt_msgs_ack") object.msgIds.forEach((value: Long) => this._onMessageAcked(value));
      },
      handleError() {},
    };
    const active: any = {
      _client: { mt: { network: { _dcConnections: new Map([[0, { main: { _connections: [connection] } }]]) } } },
    };
    const detach = worker.observeMtprotoPassivePing(active, "diag", ingress);
    connection._doFlush();
    connection._doFlush();
    await Promise.all(queued);
    expect(socket.sent).toHaveLength(1);
    const traces = () => posted.flatMap(message => message.trace ? [message.trace] : []);
    const sent = traces().find(trace => trace.stage === "TASK2_INPUT_WEBSOCKET_SEND" && trace.detail.byte_correlation === "exact");
    expect(sent?.detail.ping_msg_ids).toEqual(["100", "120"]);
    expect(sent?.detail.outgoing_packets).toHaveLength(2);
    expect(sent?.detail.outgoing_packets[0].rpc_msg_ids).toEqual(["108"]);
    expect(sent?.detail.outgoing_packets[0].container_msg_ids).toEqual(["112"]);
    expect(sent?.detail.outgoing_packets[1].rpc_msg_ids).toEqual(["128"]);
    expect(sent?.detail.outgoing_packets[1].container_msg_ids).toEqual(["132"]);
    expect(sent?.detail.encoded_fingerprint).toBeTruthy();
    const rpcSet = traces().find(trace => trace.stage === "TASK2_PING_RPC_PENDING_SET");
    expect(rpcSet?.detail.rpc_msg_id).toBe("108");
    const firstContainerKey = [...session.pendingMessages.keys()].find(key => String(key) === String(containerId));
    connection._handleMessage(Long.fromNumber(500), { _: "mt_msgs_ack", msgIds: [firstContainerKey] });
    expect(traces().find(trace => trace.stage === "TASK2_INPUT_MT_MESSAGE_DECODED")?.detail.ack_msg_ids).toEqual(["112"]);
    expect(traces().find(trace => trace.stage === "TASK2_PING_ACK_OBSERVED")?.detail.ack_origin).toBe("server_mt_msgs_ack");
    expect(traces().find(trace => trace.stage === "TASK2_PING_RPC_ACK_OBSERVED")?.detail).toMatchObject({
      rpc_msg_id: "108", ack_msg_id: "112", ack_origin: "server_mt_msgs_ack",
    });

    const resultBuffer = new ArrayBuffer(8);
    new DataView(resultBuffer).setBigInt64(0, 108n, true);
    connection._onRpcResult(Long.fromNumber(502), { dataView: new DataView(resultBuffer), pos: 0 });
    expect(traces().find(trace => trace.stage === "TASK2_INPUT_RPC_RESULT_OBSERVED")?.detail)
      .toMatchObject({ rpc_msg_id: "108", rpc_method: "channels.getMessages" });
    expect(traces().find(trace => trace.stage === "TASK2_PING_RPC_RESULT_HANDLED")?.detail.pending_after_result).toBe(false);
    const secondRpcKey = [...session.pendingMessages.keys()].find(key =>
      String(key) === "128" && session.pendingMessages.get(key)?._ === "rpc");
    connection._onMessageFailed(secondRpcKey, "ping timeout");
    expect(traces().find(trace => trace.stage === "TASK2_PING_RPC_REENQUEUE_STATE")?.detail.queued_after_failure).toBe(true);

    socket.emit("message", { data: Uint8Array.of(4, 5, 6).buffer });
    socket.emit("message", { data: Uint8Array.of(7, 8, 9, 10).buffer });
    const dropped = await codec.decode();
    connection.onMessage(dropped);
    const receivedFrames = traces().filter(trace => trace.stage === "TASK2_INPUT_WEBSOCKET_MESSAGE");
    const framed = traces().find(trace => trace.stage === "TASK2_INPUT_FRAMED_READER_FRAME");
    expect(framed?.detail.input_byte_correlation).toBe("stream_exact");
    expect(framed?.detail.web_socket_frame_ids).toEqual(receivedFrames.map(trace => trace.detail.web_socket_frame_id));
    expect(traces().find(trace => trace.stage === "TASK2_INPUT_MTPROTO_DECRYPT_RESULT")?.detail).toMatchObject({
      callback_invoked: false, validation_outcome: "discarded", validation_reason: "invalid_session_id",
    });

    acceptDecrypt = true;
    const valid = await codec.decode();
    connection.onMessage(valid);
    expect(traces().filter(trace => trace.stage === "TASK2_INPUT_MTPROTO_DECRYPT_RESULT").at(-1)?.detail.callback_invoked).toBe(true);
    expect(traces().find(trace => trace.stage === "TASK2_PING_PONG_HANDLED")?.detail).toMatchObject({
      pong_msg_id: "120", pending_lookup: "ping", outcome: "known_match", last_ping_msg_id_after: null,
    });
    session.pendingMessages.delete(pingMsgId);
    session.lastPingMsgId = Long.fromNumber(200);
    session.pendingMessages.set(session.lastPingMsgId, { _: "ping", pingId: Long.fromNumber(904), containerId: session.lastPingMsgId });
    connection._onPong({ msgId: pingMsgId, pingId });
    expect(traces().filter(trace => trace.stage === "TASK2_PING_PONG_HANDLED").at(-1)?.detail.outcome).toBe("unknown");
    expect(session.lastPingMsgId.toString()).toBe("200");
    codec._encryptor = { process(plain: Uint8Array) { return Uint8Array.from(plain, byte => byte ^ 0x33); } };
    connection._doFlush();
    await queued.at(-1);
    expect(socket.sent).toHaveLength(2);
    expect(traces().filter(trace => trace.stage === "TASK2_INPUT_WEBSOCKET_SEND").at(-1)?.detail)
      .toMatchObject({ byte_correlation: "exact", ping_msg_ids: ["140"] });
    socket.failSend = true;
    connection._doFlush();
    await expect(queued.at(-1)).rejects.toThrow("socket failed");
    expect(traces().find(trace => trace.stage === "TASK2_INPUT_WEBSOCKET_SEND_THROW")?.detail.packet_ids).toHaveLength(1);
    detach();
    ingress?.detach();
  });
});
