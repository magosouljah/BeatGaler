// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const mt = vi.hoisted(() => {
  class FakeLong {
    static ZERO: FakeLong;
    constructor(public low: number, public high: number, public unsigned = false) {}
  }
  FakeLong.ZERO = new FakeLong(0, 0, false);
  const state = { connections: [] as any[], bindRequest: null as any, rejectBind: null as any };
  class FakeSessionConnection {
    onUsable = { add: (fn: () => void) => { queueMicrotask(fn); } };
    destroy = vi.fn(async () => undefined);
    _session: any;
    constructor(public params: any) {
      state.connections.push(this);
      const tempKey = { id: new Uint8Array(8), setup: vi.fn(), encryptMessage: vi.fn(() => new Uint8Array([1])) };
      this._session = {
        _authKey: { setup: vi.fn() },
        _authKeyTempSecondary: tempKey,
        _sessionId: new FakeLong(404, 4, false),
        _seqNo: 0,
        _lastMessageId: new FakeLong(0, 0, false),
        _timeOffset: 0,
        queuedAcks: [] as FakeLong[],
        lastSessionCreatedUid: new FakeLong(0, 0, false),
        pendingMessages: new Map<unknown, any>(),
        getMessageId: () => new FakeLong(11, 12, false),
        getSeqNo: () => { this._session._seqNo += 3; return this._session._seqNo; },
      };
    }
    connect() {}
    _registerOutgoingMsgId(id: unknown) { return id; }
    async send() {
      const pending = [...this._session.pendingMessages.values()][0];
      this._session._lastMessageId = new FakeLong(70, 71, false);
      this._session._timeOffset = 9;
      this._session.queuedAcks = [new FakeLong(80, 81, false)];
      this._session.lastSessionCreatedUid = new FakeLong(90, 91, false);
      pending.promise.resolve(state.rejectBind ?? true);
    }
  }
  return { FakeLong, FakeSessionConnection, state };
});

vi.mock("@mtcute/web", () => ({
  Long: mt.FakeLong,
  SessionConnection: mt.FakeSessionConnection,
  WebCryptoProvider: class { initialize = async () => undefined; randomBytes = (n: number) => new Uint8Array(n); },
  WebSocketTransport: class {},
  tl: { LAYER: 1 },
}));
vi.mock("__beatgaler_mtcute_utils__", () => ({
  TlBinaryWriter: { alloc: () => ({ long() {}, uint() {}, object(value: unknown) { mt.state.bindRequest = value; }, result: () => new Uint8Array([2]) }) },
  TlSerializationCounter: { countNeededBytes: () => 8 },
  __tlReaderMap: {},
  __tlWriterMap: {},
  longFromBuffer: () => new mt.FakeLong(5, 6, false),
  randomLong: () => new mt.FakeLong(21, 22, false),
}));
vi.mock("__beatgaler_mtcute_authorization__", () => ({
  doAuthorization: vi.fn(async () => [new Uint8Array(256).fill(4), new mt.FakeLong(60, 61, false)]),
}));

import { prepareWebTempAuth } from "../../src/features/cloud/webTempAuth";

afterEach(() => {
  mt.state.connections.length = 0;
  mt.state.bindRequest = null;
  mt.state.rejectBind = null;
  vi.unstubAllGlobals();
});

const binding = { perm_auth_key_id: { low: 1, high: 2, unsigned: false }, encrypted_message: "AQID" };

describe("Web temporary-auth binder (M10: comportamiento)", () => {
  it("exports the exact MTProto session state that bound the key, so the Worker can continue it", async () => {
    vi.stubGlobal("WebSocket", class {});
    const prepared = await prepareWebTempAuth(2);
    expect(prepared.metadata.tempSessionId).toEqual({ low: 404, high: 4, unsigned: false });
    expect(prepared.metadata.msgId).toEqual({ low: 11, high: 12, unsigned: false });

    const imported = await prepared.bind(binding);

    expect(mt.state.bindRequest).toMatchObject({ _: "auth.bindTempAuthKey", permAuthKeyId: expect.objectContaining({ low: 1, high: 2 }) });
    expect(imported.authKey).toEqual(new Uint8Array(256).fill(4));
    expect(imported.primaryDcs).toMatchObject({ main: { id: 2 }, media: { id: 2 } });
    expect(imported.sessionState).toEqual({
      seqNo: 3,
      lastMessageId: { low: 70, high: 71, unsigned: false },
      timeOffset: 9,
      serverSalt: { low: 60, high: 61, unsigned: false },
      queuedAcks: [{ low: 80, high: 81, unsigned: false }],
      bindMsgId: { low: 11, high: 12, unsigned: false },
      lastSessionCreatedUid: { low: 90, high: 91, unsigned: false },
    });
    await prepared.destroy();
    expect(mt.state.connections[0].destroy).toHaveBeenCalled();
  });

  it("refuses to export a session when Telegram rejects the bind, and incomplete bindings never reach the socket", async () => {
    vi.stubGlobal("WebSocket", class {});
    const prepared = await prepareWebTempAuth(2);
    await expect(prepared.bind({ perm_auth_key_id: null, encrypted_message: "" } as never)).rejects.toThrow("incomplete temporary authorization");
    mt.state.rejectBind = { errorCode: 400, errorMessage: "ENCRYPTED_MESSAGE_INVALID" };
    await expect(prepared.bind(binding)).rejects.toThrow("ENCRYPTED_MESSAGE_INVALID");
  });
});
