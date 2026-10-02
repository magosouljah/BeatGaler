import { afterEach, describe, expect, it, vi } from "vitest";
import { installMtcutePingSocketRecovery } from "../../src/features/cloud/mtcutePingSocketRecovery";

afterEach(() => vi.useRealTimers());

function fixture() {
  const pingId = { eq: (other: unknown) => other === pingId, toString: () => "42" };
  const session = {
    lastPingMsgId: pingId,
    lastPingTime: performance.now(),
    pendingMessages: new Map<unknown, { _: string }>(),
  };
  const connection = {
    _session: session,
    _writer: {},
    _pingDisconnectDelay: () => 5_000,
    reconnect: vi.fn(),
  };
  return { connection, session, pingId };
}

describe("mtcute ping socket recovery", () => {
  it("refreshes a socket once for an unanswered ping before the session watchdog", () => {
    vi.useFakeTimers();
    const { connection, session, pingId } = fixture();
    const onRecovery = vi.fn();
    const detach = installMtcutePingSocketRecovery(connection, onRecovery);
    session.pendingMessages.set(pingId, { _: "ping" });
    expect(connection._pingDisconnectDelay()).toBe(12_000);
    vi.advanceTimersByTime(7_999);
    expect(connection.reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(connection.reconnect).toHaveBeenCalledTimes(1);
    expect(onRecovery).toHaveBeenCalledWith(expect.objectContaining({ pingMsgId: "42" }));
    detach();
    expect(connection._pingDisconnectDelay()).toBe(5_000);
  });

  it("leaves a answered, replaced, or disconnected ping alone", () => {
    vi.useFakeTimers();
    for (const change of [
      (test: ReturnType<typeof fixture>) => test.session.pendingMessages.delete(test.pingId),
      (test: ReturnType<typeof fixture>) => { test.session.lastPingMsgId = { eq: () => false }; },
      (test: ReturnType<typeof fixture>) => { test.connection._writer = undefined; },
    ]) {
      const test = fixture();
      const detach = installMtcutePingSocketRecovery(test.connection, vi.fn());
      test.session.pendingMessages.set(test.pingId, { _: "ping" });
      change(test);
      vi.advanceTimersByTime(8_000);
      expect(test.connection.reconnect).not.toHaveBeenCalled();
      detach();
    }
  });

  it("cancels recovery when the client closes", () => {
    vi.useFakeTimers();
    const { connection, session, pingId } = fixture();
    const detach = installMtcutePingSocketRecovery(connection, vi.fn());
    session.pendingMessages.set(pingId, { _: "ping" });
    detach();
    vi.advanceTimersByTime(8_000);
    expect(connection.reconnect).not.toHaveBeenCalled();
  });
});
