import { describe, expect, it, vi } from "vitest";
import { Bytes, FramedWriter } from "@fuman/io";
import { Long, SessionConnection } from "@mtcute/web";
import { AuthKey } from "../../node_modules/@mtcute/core/network/auth-key.js";
import { MtprotoSession } from "../../node_modules/@mtcute/core/network/mtproto-session.js";
import { Task2PacketLedger, task2DecryptWarningReason } from "../../src/features/cloud/task2PacketLedger";

const id = (value: number) => Long.fromNumber(value);
const silentLog = () => ({ warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() });

function connectionWithPing() {
  const pingA = id(100);
  const pingB = id(104);
  const session: any = {
    _authKey: { ready: true },
    pendingMessages: new Map<any, any>(),
    lastPingMsgId: pingA,
    lastPingTime: 10,
    lastActivityTime: 10,
    lastPingRtt: Number.NaN,
    queuedRpc: [],
    queuedResendReq: [],
    hasPendingMessages: true,
    resetLastPing: MtprotoSession.prototype.resetLastPing,
  };
  session.pendingMessages.set(pingA, { _: "ping", pingId: id(900), containerId: pingA });
  const conn: any = Object.create(SessionConnection.prototype);
  conn._session = session;
  conn._online = true;
  conn._active = false;
  conn._isActive = () => true;
  conn._checkTimeouts = () => false;
  conn._flushTimer = { emitWhenIdle: vi.fn(), emitBefore: vi.fn() };
  conn._pingMustDelay = () => 2000;
  conn.log = silentLog();
  conn._doFlush = () => {
    session.lastPingMsgId = pingB;
    session.pendingMessages.set(pingB, { _: "ping", pingId: id(904), containerId: pingB });
  };
  return { conn, session, pingA, pingB };
}

describe("Task 2: mtcute 0.31.0 state semantics", () => {
  it("forgets ping A on inactive→active and treats its late pong as unknown while B remains pending", () => {
    const { conn, session, pingA, pingB } = connectionWithPing();
    SessionConnection.prototype._flush.call(conn);
    expect(session.pendingMessages.has(pingA)).toBe(false);
    expect(session.pendingMessages.has(pingB)).toBe(true);
    SessionConnection.prototype._onPong.call(conn, { msgId: pingA, pingId: id(900) });
    expect(conn.log.warn).toHaveBeenCalledWith(expect.stringContaining("unknown ping"), pingA, expect.anything());
    expect(session.lastPingMsgId).toBe(pingB);
  });

  it("clears B only when its msg_id is pending; a wrong ping_id is warned but still clears B", () => {
    const normal = connectionWithPing();
    SessionConnection.prototype._flush.call(normal.conn);
    SessionConnection.prototype._onPong.call(normal.conn, { msgId: normal.pingB, pingId: id(904) });
    expect(normal.session.lastPingMsgId.isZero()).toBe(true);
    expect(normal.session.pendingMessages.has(normal.pingB)).toBe(false);

    const wrongMsg = connectionWithPing();
    SessionConnection.prototype._flush.call(wrongMsg.conn);
    SessionConnection.prototype._onPong.call(wrongMsg.conn, { msgId: id(999), pingId: id(904) });
    expect(wrongMsg.session.lastPingMsgId).toBe(wrongMsg.pingB);

    const wrongPing = connectionWithPing();
    SessionConnection.prototype._flush.call(wrongPing.conn);
    SessionConnection.prototype._onPong.call(wrongPing.conn, { msgId: wrongPing.pingB, pingId: id(999) });
    expect(wrongPing.conn.log.warn).toHaveBeenCalledWith(expect.stringContaining("expected ping_id"), expect.anything(), expect.anything(), expect.anything());
    expect(wrongPing.session.lastPingMsgId.isZero()).toBe(true);

    const bothWrong = connectionWithPing();
    SessionConnection.prototype._flush.call(bothWrong.conn);
    SessionConnection.prototype._onPong.call(bothWrong.conn, { msgId: id(999), pingId: id(999) });
    expect(bothWrong.session.lastPingMsgId).toBe(bothWrong.pingB);
  });

  it("does not treat an ACK of a ping/RPC container as a pong or RPC result", () => {
    const { conn, session, pingB } = connectionWithPing();
    const rpcId = id(108);
    const containerId = id(112);
    const rpc = { method: "channels.getMessages", acked: false };
    session.pendingMessages.set(pingB, { _: "ping", pingId: id(904), containerId });
    session.pendingMessages.set(rpcId, { _: "rpc", rpc });
    session.pendingMessages.set(containerId, { _: "container", msgIds: [pingB, rpcId] });
    SessionConnection.prototype._onMessageAcked.call(conn, containerId);
    expect(session.pendingMessages.has(containerId)).toBe(false);
    expect(session.pendingMessages.has(pingB)).toBe(true);
    expect(session.pendingMessages.has(rpcId)).toBe(true);
    expect(rpc.acked).toBe(true);
    expect(session.lastPingMsgId.toString()).toBe("100");
  });
});

describe("Task 2: outgoing byte correlation", () => {
  it("matches exact encoded chunks even when two async FramedWriter writes share one WebSocket send", async () => {
    const ledger = new Task2PacketLedger();
    const sent: Uint8Array[] = [];
    let serial = 0;
    const codec = {
      async encode(packet: Uint8Array, into: Bytes) {
        await Promise.resolve();
        const chunk = Uint8Array.of(packet.length, ...packet);
        into.writeSync(chunk.length).set(chunk);
        ledger.recordEncoded({
          packet_id: ++serial,
          ping_msg_ids: serial === 1 ? ["100"] : [],
          rpc_msg_ids: serial === 2 ? ["108"] : [],
          container_msg_ids: ["112"],
          session_id: "42",
        }, chunk);
      },
    };
    const writer = new FramedWriter({ write: async (bytes: Uint8Array) => { sent.push(bytes.slice()); } } as any, codec as any);
    await Promise.all([writer.write(Uint8Array.of(1, 2)), writer.write(Uint8Array.of(3, 4))]);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const matched = sent.map(bytes => ledger.matchSocketSend(bytes));
    expect(matched.every(row => row.matched)).toBe(true);
    expect(matched.flatMap(row => row.packet_ids)).toEqual([1, 2]);
    expect(ledger.pendingCount).toBe(0);
    const duplicate = ledger.matchSocketSend(sent[0]);
    expect(duplicate.matched).toBe(false);
  });

  it("reproduces the old cleared ping marker before an async WebSocket write", async () => {
    let currentPingMsgIds = ["100"];
    const seenAtSend: string[][] = [];
    const writer = new FramedWriter({
      write: async () => { seenAtSend.push([...currentPingMsgIds]); },
    } as any, {
      encode: async (_packet: Uint8Array, into: Bytes) => {
        await Promise.resolve();
        into.writeSync(1).set(Uint8Array.of(7));
      },
    } as any);
    const pendingWrite = writer.write(Uint8Array.of(1));
    currentPingMsgIds = [];
    await pendingWrite;
    expect(seenAtSend).toEqual([[]]);
  });

  it("does not claim a send if bytes differ or the underlying write fails", async () => {
    const ledger = new Task2PacketLedger();
    ledger.recordEncoded({ packet_id: 1, ping_msg_ids: ["100"], rpc_msg_ids: [], container_msg_ids: [], session_id: "42" }, Uint8Array.of(1, 2, 3));
    expect(ledger.matchSocketSend(Uint8Array.of(1, 2, 4)).matched).toBe(false);
    expect(ledger.pendingCount).toBe(1);
    const writer = new FramedWriter({ write: async () => { throw new Error("socket failed"); } } as any, {
      encode: async (_packet: Uint8Array, into: Bytes) => { into.writeSync(3).set(Uint8Array.of(1, 2, 3)); },
    } as any);
    await expect(writer.write(Uint8Array.of(9))).rejects.toThrow("socket failed");
    expect(ledger.pendingCount).toBe(1);
  });

  it("matches a later encoded packet without consuming an earlier packet that may still be sent", () => {
    const ledger = new Task2PacketLedger();
    const identity = (packet_id: number) => ({ packet_id, ping_msg_ids: [String(packet_id)],
      rpc_msg_ids: [], container_msg_ids: [], session_id: "42" });
    ledger.recordEncoded(identity(1), Uint8Array.of(1, 2));
    ledger.recordEncoded(identity(2), Uint8Array.of(3, 4));
    expect(ledger.matchSocketSend(Uint8Array.of(3, 4)).packet_ids).toEqual([2]);
    expect(ledger.matchSocketSend(Uint8Array.of(1, 2)).packet_ids).toEqual([1]);
    expect(ledger.clear()).toEqual([]);
  });
});

describe("Task 2: decrypt callback versus silent discard", () => {
  const reason = task2DecryptWarningReason;
  it("classifies every silent validation guard in the pinned AuthKey implementation", () => {
    expect(reason("received message with unknown authKey = %h")).toBe("unknown_auth_key");
    expect(reason("received message with invalid messageKey = %h")).toBe("invalid_message_key");
    expect(reason("ignoring message with invalid sessionId = %h")).toBe("invalid_session_id");
    expect(reason("ignoring message with invalid length: %d > %d")).toBe("invalid_length");
    expect(reason("ignoring message with invalid length: %d is not a multiple of 4")).toBe("invalid_length");
    expect(reason("ignoring message with invalid padding size: %d")).toBe("invalid_padding");
  });

  it("returns undefined both on a valid callback and on each silent discard", () => {
    const warnings: string[] = [];
    const log = { warn: (format: string) => warnings.push(format), verbose: () => {} };
    let plaintext = new Uint8Array(48);
    const crypto = {
      sha256: () => new Uint8Array(32),
      createAesIge: () => ({ decrypt: () => plaintext }),
    };
    const auth: any = new AuthKey(crypto as any, log as any, {} as any);
    auth.ready = true;
    auth.key = new Uint8Array(256);
    auth.id = Uint8Array.of(1, 1, 1, 1, 1, 1, 1, 1);
    auth.serverSalt = new Uint8Array(32);
    const session: any = Object.create(MtprotoSession.prototype);
    session._authKey = auth;
    session._authKeyTemp = { match: () => false };
    session._authKeyTempSecondary = { match: () => false };
    session._sessionId = id(7);
    session.log = log;
    const data = new Uint8Array(72);
    data.set(auth.id);
    let callbackCount = 0;
    const decrypt = () => MtprotoSession.prototype.decryptMessage.call(session, data, () => { callbackCount += 1; });
    const valid = () => {
      plaintext = new Uint8Array(48);
      new DataView(plaintext.buffer).setBigInt64(8, 7n, true);
      new DataView(plaintext.buffer).setInt32(28, 4, true);
    };
    valid();
    expect(decrypt()).toBeUndefined();
    expect(callbackCount).toBe(1);

    data[0] = 2;
    expect(decrypt()).toBeUndefined();
    expect(callbackCount).toBe(1);
    expect(reason(warnings.at(-1) || "")).toBe("unknown_auth_key");
    data[0] = 1;

    data[8] = 1;
    expect(decrypt()).toBeUndefined();
    expect(callbackCount).toBe(1);
    expect(reason(warnings.at(-1) || "")).toBe("invalid_message_key");
    data[8] = 0;

    valid();
    new DataView(plaintext.buffer).setBigInt64(8, 8n, true);
    expect(decrypt()).toBeUndefined();
    expect(reason(warnings.at(-1) || "")).toBe("invalid_session_id");

    valid();
    new DataView(plaintext.buffer).setInt32(28, 20, true);
    expect(decrypt()).toBeUndefined();
    expect(reason(warnings.at(-1) || "")).toBe("invalid_length");

    valid();
    new DataView(plaintext.buffer).setInt32(28, 5, true);
    expect(decrypt()).toBeUndefined();
    expect(reason(warnings.at(-1) || "")).toBe("invalid_length");

    valid();
    new DataView(plaintext.buffer).setInt32(28, 8, true);
    expect(decrypt()).toBeUndefined();
    expect(reason(warnings.at(-1) || "")).toBe("invalid_padding");
    expect(callbackCount).toBe(1);
  });
});
