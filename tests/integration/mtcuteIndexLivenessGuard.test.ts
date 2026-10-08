import { afterEach, describe, expect, it, vi } from "vitest";
import { Long } from "@mtcute/web";
import { armMtcuteIndexLivenessGuard } from "../../src/features/cloud/mtcuteIndexLivenessGuard";

afterEach(() => vi.useRealTimers());

function connectionFixture() {
  const oldPing = Long.fromNumber(4);
  const ping = Long.fromNumber(8);
  const rpc = Long.fromNumber(12);
  const sessionId = Long.fromNumber(17);
  const pendingMessages = new Map<any, any>([[oldPing, { _: "ping" }]]);
  const connection: any = {
    _session: { _sessionId: sessionId, lastPingMsgId: oldPing, lastPingRtt: 110, pendingMessages },
    _writer: {},
    reconnect: vi.fn(),
    _resetSession: vi.fn(),
  };
  const sendIndex = () => {
    connection._session.lastPingMsgId = ping;
    pendingMessages.set(ping, { _: "ping" });
    pendingMessages.set(rpc, { _: "rpc", rpc: { method: "channels.getMessages" } });
  };
  return { connection, pendingMessages, ping, rpc, sendIndex };
}

describe("INDEX liveness guard", () => {
  it("reconnects the socket first and resets the session only if INDEX remains unanswered", () => {
    vi.useFakeTimers();
    const test = connectionFixture();
    const recovered = vi.fn();
    armMtcuteIndexLivenessGuard(test.connection, () => true, recovered);
    test.sendIndex();
    vi.advanceTimersByTime(2_499);
    expect(test.connection._resetSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recovered).toHaveBeenCalledWith({ rpcMsgId: "12", pingMsgId: "8", delayMs: 2_500 });
    expect(test.connection.reconnect).toHaveBeenCalledTimes(1);
    expect(test.connection._resetSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(test.connection._resetSession).toHaveBeenCalledWith("index rpc unanswered after socket reconnect");
  });

  it("does not reset a session when INDEX completes after socket reconnection", () => {
    vi.useFakeTimers();
    const test = connectionFixture();
    const disarm = armMtcuteIndexLivenessGuard(test.connection, () => true, vi.fn());
    test.sendIndex();
    vi.advanceTimersByTime(2_500);
    expect(test.connection.reconnect).toHaveBeenCalledTimes(1);
    test.pendingMessages.delete(test.rpc);
    disarm();
    vi.advanceTimersByTime(3_000);
    expect(test.connection._resetSession).not.toHaveBeenCalled();
  });

  it("keeps a healthy or completed INDEX connection", () => {
    vi.useFakeTimers();
    for (const finish of [
      (test: ReturnType<typeof connectionFixture>) => test.pendingMessages.delete(test.ping),
      (test: ReturnType<typeof connectionFixture>) => test.pendingMessages.delete(test.rpc),
      (test: ReturnType<typeof connectionFixture>) => { test.connection._session._sessionId = Long.fromNumber(18); },
    ]) {
      const test = connectionFixture();
      armMtcuteIndexLivenessGuard(test.connection, () => true, vi.fn());
      test.sendIndex();
      finish(test);
      vi.advanceTimersByTime(2_500);
      expect(test.connection.reconnect).not.toHaveBeenCalled();
      expect(test.connection._resetSession).not.toHaveBeenCalled();
    }
  });

  it("disarms when INDEX is cancelled and ignores unrelated pending RPCs", () => {
    vi.useFakeTimers();
    const cancelled = connectionFixture();
    const disarm = armMtcuteIndexLivenessGuard(cancelled.connection, () => true, vi.fn());
    cancelled.sendIndex();
    disarm();
    vi.advanceTimersByTime(2_500);
    expect(cancelled.connection._resetSession).not.toHaveBeenCalled();

    const unrelated = connectionFixture();
    armMtcuteIndexLivenessGuard(unrelated.connection, () => true, vi.fn());
    unrelated.sendIndex();
    unrelated.pendingMessages.get(unrelated.rpc).rpc.method = "upload.getFile";
    vi.advanceTimersByTime(2_500);
    expect(unrelated.connection._resetSession).not.toHaveBeenCalled();
  });
});
