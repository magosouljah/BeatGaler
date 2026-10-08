import { afterEach, describe, expect, it, vi } from "vitest";
import { installPlaybackGetFileTrace } from "../../src/features/cloud/playbackGetFileTrace";

afterEach(() => vi.restoreAllMocks());

describe("playback upload.getFile trace", () => {
  it("attributes overlapping requests from call through socket send and RPC result by AbortSignal", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let nextId = 0n;
    const queued: Array<{ method: string; resolve(value: unknown): void }> = [];
    const pending = new Map<bigint, { rpc: { method: string; resolve(value: unknown): void } }>();
    const listeners = new Set<(event: { data: ArrayBuffer }) => void>();
    const socket = {
      bufferedAmount: 0,
      send: vi.fn((_data: Uint8Array) => {}),
      addEventListener(_type: string, listener: (event: { data: ArrayBuffer }) => void) { listeners.add(listener); },
      removeEventListener(_type: string, listener: (event: { data: ArrayBuffer }) => void) { listeners.delete(listener); },
      receive(bytes: Uint8Array) {
        const data = bytes.slice().buffer;
        transport.onMessage({ data });
        for (const listener of listeners) listener({ data });
      },
    };
    const transport = { socket, onMessage(_event: { data: ArrayBuffer }) {} };
    const socketSend = socket.send;
    const connection: any = {
      _usable: true,
      _fuman: { connection: transport, params: { onOpen() {} } },
      _codec: {
        async encode(_packet: Uint8Array, _into: unknown) {},
        async decode(frame: Uint8Array) { return frame; },
      },
      _sendOnceConnected: [],
      _session: {
        queuedRpc: {
          get length() { return queued.length; },
          popFront: () => queued.shift(),
        },
        pendingMessages: pending,
      },
      _enqueueRpc(rpc: any) { queued.push(rpc); },
      sendRpc(request: { _: string }) {
        return new Promise(resolve => this._enqueueRpc({ method: request._, resolve }));
      },
      _doFlush() {
        const rpc = this._session.queuedRpc.popFront();
        if (!rpc) return;
        this._session.pendingMessages.set(++nextId, { rpc });
        void this.send(new Uint8Array([Number(nextId), 1, 2, 3, 4, 5, 6, 7]));
      },
      send(data: Uint8Array) { return this._writer.write(data); },
      _onRpcResult(_incoming: unknown, reader: { dataView: DataView; pos: number }) {
        const id = reader.dataView.getBigInt64(reader.pos, true);
        const item = this._session.pendingMessages.get(id);
        item.rpc.resolve({ _: "upload.file", bytes: new Uint8Array(65_536) });
        this._session.pendingMessages.delete(id);
      },
      onMessage(frame: Uint8Array) { this._onRpcResult(null, { dataView: new DataView(frame.buffer), pos: 0 }); },
      _onMessageFailed(id: bigint) {
        const item = this._session.pendingMessages.get(id);
        this._session.pendingMessages.delete(id);
        if (item) this._enqueueRpc(item.rpc);
      },
    };
    connection._writer = {
      async write(packet: Uint8Array) {
        await connection._codec.encode(packet, { result: () => packet });
        socket.send(packet);
      },
    };
    const network: any = {
      _dcConnections: new Map([[1, { main: { _connections: [connection] } }]]),
      _call(request: unknown, params: { abortSignal: AbortSignal }) {
        return connection.sendRpc(request, undefined, params.abortSignal);
      },
    };
    const core = {
      mt: { network },
      call(request: unknown, params: { abortSignal: AbortSignal }) {
        return network._call(request, params);
      },
    };
    const originalCall = core.call;
    const observer = installPlaybackGetFileTrace({ _client: core }, { focusedMessageId: () => 96 });
    const first = new AbortController();
    const second = new AbortController();
    const download = (signal: AbortSignal) => core.call({ _: "upload.getFile", offset: 0, limit: 65_536 }, { abortSignal: signal });
    try {
      const a = observer.run(first.signal, () => ({ request_id: "batch-a", message_id: 37, intent_id: 25 }), () => download(first.signal));
      const b = observer.run(second.signal, () => ({ request_id: "batch-b", message_id: 27, intent_id: 33 }), () => download(second.signal));
      connection._doFlush();
      connection._doFlush();
      connection._onMessageFailed(1n, "message info state = 0");
      connection._doFlush();
      await vi.waitFor(() => expect(socketSend).toHaveBeenCalledTimes(3));
      for (const id of [2n, 3n]) {
        const frame = new Uint8Array(12);
        new DataView(frame.buffer).setBigInt64(0, id, true);
        const incoming = new Uint8Array(16);
        incoming.set(frame, 4);
        socket.receive(incoming);
        connection.onMessage(await connection._codec.decode(frame));
      }
      await Promise.all([a, b]);

      const rows = info.mock.calls
        .map(([value]) => String(value))
        .filter(value => value.startsWith("[play-trace] "))
        .map(value => JSON.parse(value.slice("[play-trace] ".length)));
      expect(rows.filter(row => row.stage === "WORKER_GET_FILE_WEBSOCKET_MESSAGE")).toHaveLength(2);
      expect(rows.findIndex(row => row.stage === "WORKER_GET_FILE_WEBSOCKET_MESSAGE"))
        .toBeLessThan(rows.findIndex(row => row.stage === "WORKER_GET_FILE_RPC_RESULT_ENTER"));
      for (const [requestId, messageId, intentId] of [["batch-a", 37, 25], ["batch-b", 27, 33]] as const) {
        const own = rows.filter(row => row.request_id === requestId);
        expect(own.map(row => row.stage)).toEqual(expect.arrayContaining([
          "WORKER_GET_FILE_CALL_ENTER", "WORKER_GET_FILE_MIDDLEWARE_PASSED", "WORKER_GET_FILE_CONNECTION_RPC_BEGIN", "WORKER_GET_FILE_RPC_QUEUED",
          "WORKER_GET_FILE_SOCKET_SEND_CALLED", "WORKER_GET_FILE_WEBSOCKET_SEND_CALLED", "WORKER_GET_FILE_WEBSOCKET_SEND_RETURNED",
          "WORKER_GET_FILE_RPC_RESULT_ENTER", "WORKER_GET_FILE_CALL_DONE",
        ]));
        expect(own.every(row => row.message_id === messageId && row.intent_id === intentId)).toBe(true);
        expect(own.find(row => row.stage === "WORKER_GET_FILE_SOCKET_SEND_CALLED")?.writer_present).toBe(true);
        expect(Number.isFinite(own.find(row => row.stage === "WORKER_GET_FILE_RPC_RESULT_ENTER")?.response_frame_ts_ms)).toBe(true);
        const result = own.find(row => row.stage === "WORKER_GET_FILE_RPC_RESULT_ENTER");
        expect(Number.isFinite(result?.websocket_message_ts_ms)).toBe(true);
        expect(Number.isFinite(result?.framed_decode_ts_ms)).toBe(true);
        expect(result?.websocket_message_count).toBe(1);
        if (requestId === "batch-a") {
          expect(own.filter(row => row.stage === "WORKER_GET_FILE_SOCKET_SEND_CALLED")).toHaveLength(2);
          expect(own.find(row => row.stage === "WORKER_GET_FILE_RPC_RETRY")?.reason).toBe("message info state = 0");
        }
      }
      const getMessages = core.call({ _: "channels.getMessages", id: [{ _: "inputMessageID", id: 96 }] },
        { abortSignal: new AbortController().signal });
      connection._doFlush();
      await vi.waitFor(() => expect(socketSend).toHaveBeenCalledTimes(4));
      const response = new Uint8Array(12);
      new DataView(response.buffer).setBigInt64(0, 4n, true);
      connection.onMessage(await connection._codec.decode(response));
      await getMessages;
      const messagesRows = info.mock.calls.map(([value]) => String(value))
        .filter(value => value.startsWith("[play-trace] "))
        .map(value => JSON.parse(value.slice("[play-trace] ".length)))
        .filter(row => row.stage.startsWith("WORKER_GET_MESSAGES_") && row.stage !== "WORKER_GET_MESSAGES_TRACE_CAPABILITY");
      expect(messagesRows.map(row => row.stage)).toEqual(expect.arrayContaining([
        "WORKER_GET_MESSAGES_CALL_ENTER", "WORKER_GET_MESSAGES_CONNECTION_RPC_BEGIN",
        "WORKER_GET_MESSAGES_RPC_QUEUED", "WORKER_GET_MESSAGES_MT_PROTO_FLUSH",
        "WORKER_GET_MESSAGES_WEBSOCKET_SEND_CALLED", "WORKER_GET_MESSAGES_RPC_RESULT_ENTER",
        "WORKER_GET_MESSAGES_CALL_DONE",
      ]));
      expect(messagesRows.every(row => row.batch_id === messagesRows[0].batch_id && row.message_id === 96)).toBe(true);
      expect(messagesRows.find(row => row.stage === "WORKER_GET_MESSAGES_RPC_RESULT_ENTER")?.rpc_msg_id).toBe("4");
    } finally {
      observer.detach();
    }
    expect(core.call).toBe(originalCall);
  });

  it("attaches probes to a DC that mtcute creates after middleware", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const connection: any = {
      _session: { queuedRpc: { length: 0 }, pendingMessages: new Map() },
      _enqueueRpc() {},
      sendRpc() { return Promise.resolve({ _: "upload.file", bytes: new Uint8Array(1) }); },
    };
    const network: any = {
      _primaryDc: { dcId: 1 },
      _dcConnections: new Map(),
      async _getOtherDc(dcId: number) {
        await Promise.resolve();
        const dc = { download: { _connections: [connection] } };
        this._dcConnections.set(dcId, dc);
        return dc;
      },
      async _call(request: unknown, params: { dcId: number; abortSignal: AbortSignal }) {
        const dc = await this._getOtherDc(params.dcId);
        return dc.download._connections[0].sendRpc(request, undefined, params.abortSignal);
      },
    };
    const core = { mt: { network }, call(request: unknown, params: { dcId: number; abortSignal: AbortSignal }) { return network._call(request, params); } };
    const observer = installPlaybackGetFileTrace({ _client: core });
    try {
      const signal = new AbortController().signal;
      await observer.run(signal, () => ({ message_id: 7, intent_id: 12 }),
        () => core.call({ _: "upload.getFile" }, { dcId: 4, abortSignal: signal }));
      const rows = info.mock.calls.map(([value]) => String(value))
        .filter(value => value.startsWith("[play-trace] "))
        .map(value => JSON.parse(value.slice("[play-trace] ".length)));
      expect(rows.find(row => row.stage === "WORKER_GET_FILE_MIDDLEWARE_PASSED")?.target_dc_known).toBe(false);
      expect(rows.find(row => row.stage === "WORKER_GET_FILE_CONNECTION_RPC_BEGIN")?.intent_id).toBe(12);
    } finally {
      observer.detach();
    }
  });
});
