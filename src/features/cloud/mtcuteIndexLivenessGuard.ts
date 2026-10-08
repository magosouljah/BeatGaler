type PendingMessage = { _: string; rpc?: { method?: string } };

type IndexConnection = {
  _session: {
    _sessionId: unknown;
    lastPingMsgId: unknown;
    lastPingRtt: number;
    pendingMessages: Map<unknown, PendingMessage>;
  };
  _writer?: unknown;
  reconnect: () => void;
  _resetSession: (reason: string) => void;
};

/** Recover an INDEX read when its fresh ping and RPC both stop receiving replies. */
export function armMtcuteIndexLivenessGuard(
  connection: IndexConnection | null,
  isIndexActive: () => boolean,
  onRecovery: (detail: { rpcMsgId: string; pingMsgId: string; delayMs: number }) => void,
): () => void {
  if (!connection || !Number.isFinite(connection._session.lastPingRtt)) return () => {};
  const session = connection._session;
  const sessionId = session._sessionId;
  const initialPingMsgId = session.lastPingMsgId;
  const previousIndexRpcIds = new Set([...session.pendingMessages].filter(([, pending]) =>
    pending?._ === "rpc" && pending.rpc?.method === "channels.getMessages").map(([id]) => id));
  const delayMs = Math.max(2_500, Math.min(4_000, Math.ceil(session.lastPingRtt * 8)));
  let fallback: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    if (!isIndexActive() || connection._session !== session || session._sessionId !== sessionId || !connection._writer) return;
    const pingMsgId = session.lastPingMsgId;
    if (pingMsgId === initialPingMsgId || session.pendingMessages.get(pingMsgId)?._ !== "ping") return;
    const rpc = [...session.pendingMessages].find(([id, pending]) =>
      !previousIndexRpcIds.has(id) && pending?._ === "rpc" && pending.rpc?.method === "channels.getMessages");
    if (!rpc) return;
    try { onRecovery({ rpcMsgId: String(rpc[0]), pingMsgId: String(pingMsgId), delayMs }); } catch { /* diagnostic only */ }
    try { connection.reconnect(); } catch { /* the fallback still bounds the pending RPC */ }
    fallback = setTimeout(() => {
      if (!isIndexActive() || connection._session !== session || session._sessionId !== sessionId ||
        !session.pendingMessages.has(rpc[0])) return;
      try { connection._resetSession("index rpc unanswered after socket reconnect"); } catch { /* mtcute owns the connection */ }
    }, 3_000);
  }, delayMs);
  return () => {
    clearTimeout(timer);
    if (fallback !== null) clearTimeout(fallback);
  };
}
