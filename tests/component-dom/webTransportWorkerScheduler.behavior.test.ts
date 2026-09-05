import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Transfer = {
    messageId: number;
    signal: AbortSignal;
    settled: boolean;
    resolve(bytes?: number): void;
    reject(error: Error): void;
  };

  class FakeLong {
    constructor(public low: number, public high: number, public unsigned = false) {}
  }

  const boundSession: any = {
    initConnectionCalled: false,
    _sessionId: new FakeLong(1, 2, false),
    _seqNo: 0,
    _lastMessageId: new FakeLong(0, 0, false),
    _timeOffset: 0,
    queuedAcks: [],
    recentOutgoingMsgIds: new Set(),
    recentIncomingMsgIds: new Set(),
    lastSessionCreatedUid: new FakeLong(0, 0, false),
    resetState() {},
  };

  class SessionConnection {
    params = { isMainConnection: true, isMainDcConnection: true, dc: { id: 2 } };
    _session = boundSession;
    _salts = { currentSalt: new FakeLong(0, 0, false) };
    connect() {}
    reset() {}
  }

  const connection = new SessionConnection();
  const getMessages = vi.fn(async (_chat: unknown, ids: number[]) => ids.map(id => ({
    id,
    text: "",
    media: { type: "audio", mimeType: "audio/mpeg", fileSize: 200_000, messageId: id },
  })));
  const transfers: Transfer[] = [];
  const downloadChunk = vi.fn((options: any) => new Promise<Uint8Array>((resolve, reject) => {
    const messageId = Number(options.location?.messageId || 0);
    const signal = options.abortSignal as AbortSignal;
    const transfer: Transfer = {
      messageId,
      signal,
      settled: false,
      resolve(bytes = 65_536) {
        if (transfer.settled) return;
        transfer.settled = true;
        resolve(new Uint8Array(bytes));
      },
      reject(error: Error) {
        if (transfer.settled) return;
        transfer.settled = true;
        reject(error);
      },
    };
    transfers.push(transfer);
    const abort = () => transfer.reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }));

  class TelegramClient {
    importSession = vi.fn(async () => undefined);
    connect = vi.fn(async () => undefined);
    destroy = vi.fn(async () => undefined);
    getMe = vi.fn(async () => ({ id: 4242, isBot: true }));
    getChat = vi.fn(async () => ({ id: -1001234567890 }));
    getMessages = getMessages;
    downloadChunk = downloadChunk;
    mt = {
      network: {
        _dcConnections: new Map([[2, {
          main: {
            _connections: [connection],
            onUsable: { add: vi.fn() },
          },
        }]]),
      },
    };
  }

  return {
    FakeLong,
    SessionConnection,
    TelegramClient,
    getMessages,
    downloadChunk,
    transfers,
    activeTransfers: () => transfers.filter(transfer => !transfer.settled),
    transfersFor: (messageId: number) => transfers.filter(transfer => transfer.messageId === messageId),
    WebCryptoProvider: class { constructor(public readonly options: unknown) {} },
  };
});

vi.mock("@mtcute/web", () => ({
  TelegramClient: harness.TelegramClient,
  SessionConnection: harness.SessionConnection,
  WebCryptoProvider: harness.WebCryptoProvider,
  MemoryStorage: class {},
  InputMedia: { document: vi.fn() },
}));

const originalOnMessage = globalThis.onmessage;
const posted: any[] = [];

function dispatch(data: any): void {
  (globalThis.onmessage as any)?.({ data });
}

async function dispatchAndWait(data: any): Promise<any> {
  dispatch(data);
  await vi.waitFor(() => {
    expect(posted.some(message => message.requestId === data.requestId && "ok" in message)).toBe(true);
  });
  return posted.findLast(message => message.requestId === data.requestId && "ok" in message);
}

function terminal(messageId: number, status?: string): any[] {
  return posted.filter(message =>
    message.event === "prefetch-terminal" &&
    message.terminal?.messageId === messageId &&
    (!status || message.terminal?.status === status)
  );
}

beforeAll(async () => {
  vi.stubGlobal("postMessage", (message: any) => posted.push(message));
  await import("../../src/features/cloud/webTransport.worker");
  await dispatchAndWait({
    requestId: "scheduler-init",
    op: "initialize",
    startupMessageIds: [],
    session: {
      chat_id: "-1001234567890",
      transport_user_id: "4242",
      expected_bot_id: "4242",
      temp_api_id: 12345,
      temp_auth_key: new Uint8Array(256).fill(7),
      temp_session_id: { low: 123456, high: 789, unsigned: false },
      temp_session_state: {
        seqNo: 2,
        lastMessageId: { low: 333, high: 444, unsigned: false },
        timeOffset: 5,
        serverSalt: { low: 55, high: 66, unsigned: false },
        queuedAcks: [],
        bindMsgId: { low: 111, high: 222, unsigned: false },
        lastSessionCreatedUid: { low: 0, high: 0, unsigned: false },
      },
      temp_primary_dcs: { main: { id: 2 } },
    },
  });
});

afterAll(() => {
  globalThis.onmessage = originalOnMessage;
  vi.unstubAllGlobals();
});

describe("Worker playback scheduler with pending Telegram transfers", () => {
  it("enforces 7 idle lanes, aborts unrelated warm for queued Play, keeps 0 unrelated critical lanes and resumes exactly 6 when stable", async () => {
    const ids = Array.from({ length: 14 }, (_, index) => index + 1);
    dispatch({
      requestId: "warm-14",
      op: "prefetch_batch",
      input: {
        inputs: ids.map(messageId => ({ messageId, mimeType: "audio/mpeg" })),
        maxConcurrency: 7,
      },
    });

    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(7));
    expect(harness.downloadChunk).toHaveBeenCalledTimes(7);
    expect(harness.getMessages).toHaveBeenCalledWith(-1001234567890, ids);
    const initiallyActive = harness.activeTransfers().map(transfer => transfer.messageId);
    expect(initiallyActive).toEqual(ids.slice(0, 7));

    // Beat 10 is queued behind the seven active warms. Play must abort all
    // unrelated active transfers and promote 10 immediately, without waiting
    // for their natural completion.
    await dispatchAndWait({ requestId: "focus-10", op: "playback_focus", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers().map(transfer => transfer.messageId)).toEqual([10]));
    for (const id of initiallyActive) {
      expect(harness.transfersFor(id)[0]?.signal.aborted).toBe(true);
      expect(terminal(id, "FAILED")).toHaveLength(0);
    }

    harness.activeTransfers()[0].resolve();
    await vi.waitFor(() => expect(terminal(10, "READY")).toHaveLength(1));
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(0));

    // PLAY_STABLE opens only six warm lanes even though the physical pool has 7.
    await dispatchAndWait({ requestId: "stable-10", op: "playback_stable", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(6));
    const stableIds = harness.activeTransfers().map(transfer => transfer.messageId);
    expect(new Set(stableIds).size).toBe(6);
    expect(stableIds).not.toContain(10);

    // waiting=true is represented by focusPlayback again. Every unrelated warm
    // must be physically aborted and no replacement warm may start while critical.
    await dispatchAndWait({ requestId: "waiting-10", op: "playback_focus", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(0));
    for (const id of stableIds) expect(terminal(id, "FAILED")).toHaveLength(0);

    await dispatchAndWait({ requestId: "stable-again-10", op: "playback_stable", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(6));

    // End/pause restores IDLE. Existing six are not restarted; one seventh lane
    // joins them because the configured idle limit is seven.
    const beforeRelease = harness.activeTransfers().slice();
    await dispatchAndWait({ requestId: "release-10", op: "playback_release", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(7));
    for (const transfer of beforeRelease) expect(transfer.signal.aborted).toBe(false);

    // Drain the real batch so the test also proves PREEMPTED entries requeue and
    // eventually reach READY instead of FAILED/cooldown.
    for (let turn = 0; turn < 20; turn += 1) {
      for (const transfer of harness.activeTransfers()) transfer.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      if (posted.some(message => message.requestId === "warm-14" && message.ok === true)) break;
    }
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "warm-14" && message.ok === true)).toBe(true));

    for (const id of ids) {
      expect(terminal(id, "READY")).toHaveLength(1);
      expect(terminal(id, "FAILED")).toHaveLength(0);
    }
    expect(harness.transfersFor(1)).toHaveLength(2);
    expect(harness.transfersFor(10)).toHaveLength(1);
  });
});
