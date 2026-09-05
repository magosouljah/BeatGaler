import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Transfer = {
    messageId: number;
    signal: AbortSignal;
    settled: boolean;
    resolve(bytes?: number): void;
    reject(error: Error): void;
  };
  type IndexTransfer = {
    signal: AbortSignal;
    settled: boolean;
    resolve(): void;
    reject(error: Error): void;
    rejectAbort(): void;
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
  const missingIds = new Set<number>();
  const indexMessageId = 9001;
  const getMessages = vi.fn(async (_chat: unknown, ids: number[]) => ids.map(id => {
    if (missingIds.has(id)) return null;
    if (id === indexMessageId) {
      return {
        id,
        text: "BEATGALER_LIBRARY_INDEX_V1\n{}",
        media: { type: "document", mimeType: "application/json", fileSize: 128, messageId: id },
      };
    }
    return {
      id,
      text: "",
      media: { type: "audio", mimeType: "audio/mpeg", fileSize: 200_000, messageId: id },
    };
  }));
  const getFullChat = vi.fn(async () => ({ pinnedMsgId: indexMessageId }));
  const transfers: Transfer[] = [];
  const indexTransfers: IndexTransfer[] = [];
  let peakActive = 0;
  const downloadChunk = vi.fn((options: any) => new Promise<Uint8Array>((resolve, reject) => {
    const messageId = Number(options.location?.messageId || 0);
    const signal = (options.abortSignal as AbortSignal | undefined) ?? new AbortController().signal;
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
    peakActive = Math.max(peakActive, transfers.filter(item => !item.settled).length);
    const abort = () => transfer.reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }));
  const downloadAsBuffer = vi.fn((_location: unknown, options: any) => new Promise<Uint8Array>((resolve, reject) => {
    const signal = (options?.abortSignal as AbortSignal | undefined) ?? new AbortController().signal;
    const transfer: IndexTransfer = {
      signal,
      settled: false,
      resolve() {
        if (transfer.settled) return;
        transfer.settled = true;
        resolve(new TextEncoder().encode(JSON.stringify({ schema: "beatgaler.telegram.library", version: 2, beats: [] })));
      },
      reject(error: Error) {
        if (transfer.settled) return;
        transfer.settled = true;
        reject(error);
      },
      rejectAbort() {
        transfer.reject(new DOMException("aborted", "AbortError"));
      },
    };
    indexTransfers.push(transfer);
  }));

  class TelegramClient {
    importSession = vi.fn(async () => undefined);
    connect = vi.fn(async () => undefined);
    destroy = vi.fn(async () => undefined);
    getMe = vi.fn(async () => ({ id: 4242, isBot: true }));
    getChat = vi.fn(async () => ({ id: -1001234567890 }));
    getMessages = getMessages;
    getFullChat = getFullChat;
    downloadChunk = downloadChunk;
    downloadAsBuffer = downloadAsBuffer;
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
    getFullChat,
    downloadChunk,
    downloadAsBuffer,
    transfers,
    indexTransfers,
    missingIds,
    activeTransfers: () => transfers.filter(transfer => !transfer.settled),
    transfersFor: (messageId: number) => transfers.filter(transfer => transfer.messageId === messageId),
    activeIndexTransfers: () => indexTransfers.filter(transfer => !transfer.settled),
    getPeakActive: () => peakActive,
    resetObservations: () => {
      transfers.length = 0;
      indexTransfers.length = 0;
      peakActive = 0;
      missingIds.clear();
      getMessages.mockClear();
      getFullChat.mockClear();
      downloadChunk.mockClear();
      downloadAsBuffer.mockClear();
    },
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

async function drainBatch(requestId: string, maxTurns = 30): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    for (const transfer of harness.activeTransfers()) transfer.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    if (posted.some(message => message.requestId === requestId && message.ok === true)) return;
  }
  throw new Error(`Batch ${requestId} did not drain.`);
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
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

beforeEach(async () => {
  harness.resetObservations();
  await dispatchAndWait({ requestId: `scheduler-reset-${Math.random()}`, op: "playback_release", messageId: 10 });
  await dispatchAndWait({ requestId: `scheduler-reset-99-${Math.random()}`, op: "playback_release", messageId: 99 });
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

    await dispatchAndWait({ requestId: "focus-10", op: "playback_focus", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers().map(transfer => transfer.messageId)).toEqual([10]));
    for (const id of initiallyActive) {
      expect(harness.transfersFor(id)[0]?.signal.aborted).toBe(true);
      expect(terminal(id, "FAILED")).toHaveLength(0);
    }

    harness.activeTransfers()[0].resolve();
    await vi.waitFor(() => expect(terminal(10, "READY")).toHaveLength(1));
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(0));

    await dispatchAndWait({ requestId: "stable-10", op: "playback_stable", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(6));
    const stableIds = harness.activeTransfers().map(transfer => transfer.messageId);
    expect(new Set(stableIds).size).toBe(6);
    expect(stableIds).not.toContain(10);

    await dispatchAndWait({ requestId: "waiting-10", op: "playback_focus", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(0));
    for (const id of stableIds) expect(terminal(id, "FAILED")).toHaveLength(0);

    await dispatchAndWait({ requestId: "stable-again-10", op: "playback_stable", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(6));

    const beforeRelease = harness.activeTransfers().slice();
    await dispatchAndWait({ requestId: "release-10", op: "playback_release", messageId: 10 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(7));
    for (const transfer of beforeRelease) expect(transfer.signal.aborted).toBe(false);

    await drainBatch("warm-14");
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "warm-14" && message.ok === true)).toBe(true));

    for (const id of ids) {
      expect(terminal(id, "READY")).toHaveLength(1);
      expect(terminal(id, "FAILED")).toHaveLength(0);
    }
    expect(harness.transfersFor(1)).toHaveLength(2);
    expect(harness.transfersFor(10)).toHaveLength(1);
  });

  it("gives a Play outside startup14 foreground priority after physically preempting all startup warm", async () => {
    const ids = Array.from({ length: 14 }, (_, index) => 101 + index);
    dispatch({ requestId: "warm-outside", op: "prefetch_batch", input: { inputs: ids.map(messageId => ({ messageId, mimeType: "audio/mpeg" })), maxConcurrency: 7 } });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(7));
    const startupTransfers = harness.activeTransfers().slice();

    await dispatchAndWait({ requestId: "focus-99", op: "playback_focus", messageId: 99 });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(0));
    for (const transfer of startupTransfers) expect(transfer.signal.aborted).toBe(true);

    dispatch({ requestId: "outside-prefix", op: "prefetch", input: { messageId: 99, mimeType: "audio/mpeg", offsetBytes: 0 } });
    await vi.waitFor(() => expect(harness.activeTransfers().map(transfer => transfer.messageId)).toEqual([99]));
    harness.activeTransfers()[0].resolve();
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "outside-prefix" && message.ok === true)).toBe(true));
    expect(harness.activeTransfers()).toHaveLength(0);

    await dispatchAndWait({ requestId: "release-99", op: "playback_release", messageId: 99 });
    await drainBatch("warm-outside");
  });

  it("publishes an individual missing target before the rest of its warm batch completes", async () => {
    harness.missingIds.add(301);
    dispatch({
      requestId: "warm-missing",
      op: "prefetch_batch",
      input: { inputs: [301, 302].map(messageId => ({ messageId, mimeType: "audio/mpeg" })), maxConcurrency: 2 },
    });

    await vi.waitFor(() => expect(terminal(301, "FAILED")).toHaveLength(1));
    expect(terminal(301)[0].terminal.code).toBe("ROUTE_MISSING");
    await vi.waitFor(() => expect(harness.activeTransfers().map(transfer => transfer.messageId)).toEqual([302]));
    expect(posted.some(message => message.requestId === "warm-missing" && message.ok === true)).toBe(false);

    harness.activeTransfers()[0].resolve();
    await vi.waitFor(() => expect(terminal(302, "READY")).toHaveLength(1));
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "warm-missing" && message.ok === true)).toBe(true));
  });

  it("never exceeds the configured seven physical lanes when simultaneous completions release queued work", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => 401 + index);
    dispatch({ requestId: "warm-peak", op: "prefetch_batch", input: { inputs: ids.map(messageId => ({ messageId, mimeType: "audio/mpeg" })), maxConcurrency: 7 } });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(7));

    for (let turn = 0; turn < 10; turn += 1) {
      const active = harness.activeTransfers().slice();
      active.forEach(transfer => transfer.resolve());
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(harness.getPeakActive()).toBeLessThanOrEqual(7);
      if (posted.some(message => message.requestId === "warm-peak" && message.ok === true)) break;
    }
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "warm-peak" && message.ok === true)).toBe(true));
    expect(harness.getPeakActive()).toBe(7);
  });

  it("restarts an active INDEX immediately after Play preemption even when focus is released before the abort rejection", async () => {
    vi.useFakeTimers();
    try {
      dispatch({ requestId: "index-play-race", op: "get_index" });
      await flushMicrotasks();
      expect(harness.activeIndexTransfers()).toHaveLength(1);
      const firstIndex = harness.activeIndexTransfers()[0];

      dispatch({ requestId: "index-focus", op: "playback_focus", messageId: 777 });
      await flushMicrotasks();
      expect(firstIndex.signal.aborted).toBe(true);

      dispatch({ requestId: "index-release", op: "playback_release", messageId: 777 });
      await flushMicrotasks();
      firstIndex.rejectAbort();
      await flushMicrotasks(16);

      // A misclassified abort increments `failures` and sleeps 80 ms before retry.
      // Correct preemption restarts without consuming that error/backoff budget.
      expect(harness.indexTransfers).toHaveLength(2);
      expect(harness.activeIndexTransfers()).toHaveLength(1);
      harness.activeIndexTransfers()[0].resolve();
      await flushMicrotasks(16);

      const response = posted.findLast(message => message.requestId === "index-play-race" && "ok" in message);
      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(harness.downloadAsBuffer).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts active INDEX bytes for WARM and resumes only after the warm transfer settles", async () => {
    dispatch({ requestId: "index-warm-race", op: "get_index" });
    await vi.waitFor(() => expect(harness.activeIndexTransfers()).toHaveLength(1));
    const firstIndex = harness.activeIndexTransfers()[0];

    dispatch({
      requestId: "index-preempting-warm",
      op: "prefetch_batch",
      input: { inputs: [{ messageId: 888, mimeType: "audio/mpeg" }], maxConcurrency: 1 },
    });
    await vi.waitFor(() => expect(firstIndex.signal.aborted).toBe(true));
    firstIndex.rejectAbort();
    await vi.waitFor(() => expect(harness.activeTransfers().map(transfer => transfer.messageId)).toEqual([888]));
    expect(harness.indexTransfers).toHaveLength(1);

    harness.activeTransfers()[0].resolve();
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "index-preempting-warm" && message.ok === true)).toBe(true));
    await vi.waitFor(() => expect(harness.indexTransfers).toHaveLength(2));

    harness.activeIndexTransfers()[0].resolve();
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "index-warm-race" && message.ok === true)).toBe(true));
    expect(harness.downloadAsBuffer).toHaveBeenCalledTimes(2);
  });
});
