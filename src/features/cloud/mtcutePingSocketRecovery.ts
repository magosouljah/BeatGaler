type PingId = { eq?: (other: unknown) => boolean };
type PingPending = { _: string };
type PingSession = {
  lastPingMsgId: PingId;
  lastPingTime: number;
  pendingMessages: Map<unknown, PingPending>;
};
type PingConnection = {
  _session: PingSession;
  _writer?: unknown;
  _destroyed?: boolean;
  _pingDisconnectDelay: () => number;
  reconnect: () => void;
};

const SOCKET_RECOVERY_MS = 8_000;
const PING_FALLBACK_MS = 12_000;

/** Refresh a stalled socket once before mtcute resets its MTProto session. */
export function installMtcutePingSocketRecovery(
  connection: PingConnection | null,
  onRecovery: (detail: { pingMsgId: string; elapsedMs: number }) => void,
): () => void {
  if (!connection || typeof connection.reconnect !== "function" ||
    typeof connection._pingDisconnectDelay !== "function") return () => {};
  const session = connection._session;
  const pending = session?.pendingMessages;
  if (!pending || typeof pending.set !== "function") return () => {};

  const originalDelay = connection._pingDisconnectDelay;
  const originalSet = pending.set;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = (id: PingId, remainingMs = SOCKET_RECOVERY_MS) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (connection._destroyed || connection._session !== session || !connection._writer ||
        pending.get(id)?._ !== "ping" ||
        !(session.lastPingMsgId?.eq?.(id) ?? session.lastPingMsgId === id)) return;
      const elapsedMs = performance.now() - session.lastPingTime;
      try { onRecovery({ pingMsgId: String(id), elapsedMs }); } catch { /* observation only */ }
      try { connection.reconnect(); } catch { /* mtcute's watchdog remains the fallback */ }
    }, Math.max(0, remainingMs));
  };

  connection._pingDisconnectDelay = function () {
    return Math.max(originalDelay.call(this), PING_FALLBACK_MS);
  };
  pending.set = function (id: unknown, value: PingPending) {
    const result = originalSet.call(this, id, value);
    if (value?._ === "ping") arm(id as PingId);
    return result;
  };

  const currentPing = session.lastPingMsgId;
  if (pending.get(currentPing)?._ === "ping") {
    arm(currentPing, SOCKET_RECOVERY_MS - (performance.now() - session.lastPingTime));
  }

  return () => {
    if (timer !== null) clearTimeout(timer);
    if (connection._pingDisconnectDelay !== originalDelay) connection._pingDisconnectDelay = originalDelay;
    if (pending.set !== originalSet) pending.set = originalSet;
  };
}
