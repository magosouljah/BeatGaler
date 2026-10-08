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
  let getMessagesGate: Promise<void> | null = null;
  let releaseGetMessagesGate: (() => void) | null = null;
  const getMessages = vi.fn(async (_chat: unknown, ids: number[]) => {
    if (getMessagesGate) await getMessagesGate;
    return ids.map(id => {
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
    });
  });
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
  const downloadAsIterable = vi.fn(async function* (_media: unknown, options: { offset?: number }) {
    const offset = Math.max(0, Number(options?.offset) || 0);
    if (offset < 200_000) yield new Uint8Array(200_000 - offset);
  });
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
    onConnectionState = { add: vi.fn(), remove: vi.fn() };
    onError = { add: vi.fn(), remove: vi.fn() };
    importSession = vi.fn(async () => undefined);
    connect = vi.fn(async () => { connection.connect(); });
    startUpdatesLoop = vi.fn(async () => undefined);
    destroy = vi.fn(async () => undefined);
    getMe = vi.fn(async () => ({ id: 4242, isBot: true }));
    getChat = vi.fn(async () => ({ id: -1001234567890 }));
    resolvePeer = vi.fn(async () => ({ _: "inputPeerChannel", channelId: 1234567890, accessHash: new FakeLong(42, 0) }));
    getMessages = getMessages;
    getFullChat = getFullChat;
    downloadChunk = downloadChunk;
    downloadAsIterable = downloadAsIterable;
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
    downloadAsIterable,
    downloadAsBuffer,
    transfers,
    indexTransfers,
    missingIds,
    holdGetMessages: () => {
      getMessagesGate = new Promise<void>(resolve => { releaseGetMessagesGate = resolve; });
    },
    releaseGetMessages: () => {
      releaseGetMessagesGate?.();
      releaseGetMessagesGate = null;
      getMessagesGate = null;
    },
    activeTransfers: () => transfers.filter(transfer => !transfer.settled),
    transfersFor: (messageId: number) => transfers.filter(transfer => transfer.messageId === messageId),
    activeIndexTransfers: () => indexTransfers.filter(transfer => !transfer.settled),
    getPeakActive: () => peakActive,
    resetObservations: () => {
      transfers.length = 0;
      indexTransfers.length = 0;
      peakActive = 0;
      missingIds.clear();
      releaseGetMessagesGate?.();
      releaseGetMessagesGate = null;
      getMessagesGate = null;
      getMessages.mockClear();
      getFullChat.mockClear();
      downloadChunk.mockClear();
      downloadAsIterable.mockClear();
      downloadAsBuffer.mockClear();
    },
    WebCryptoProvider: class { constructor(public readonly options: unknown) {} },
  };
});

vi.mock("@mtcute/web", () => ({
  TelegramClient: harness.TelegramClient,
  Long: harness.FakeLong,
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
  expect(await dispatchAndWait({ requestId: "scheduler-peer-ready", op: "verify" }))
    .toMatchObject({ ok: true });
});

beforeEach(async () => {
  harness.resetObservations();
  await dispatchAndWait({ requestId: `scheduler-reset-${Math.random()}`, op: "playback_release", messageId: 3 });
  await dispatchAndWait({ requestId: `scheduler-reset-10-${Math.random()}`, op: "playback_release", messageId: 10 });
  await dispatchAndWait({ requestId: `scheduler-reset-99-${Math.random()}`, op: "playback_release", messageId: 99 });
});

afterAll(() => {
  globalThis.onmessage = originalOnMessage;
  vi.unstubAllGlobals();
});

describe("Worker playback scheduler with pending Telegram transfers", () => {
  it("traces a focused cache miss through media RPC, lane, first bytes and worker response", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await dispatchAndWait({ requestId: "trace-focus-777", op: "playback_focus", messageId: 777, traceIntentId: 42 });
      dispatch({ requestId: "trace-prefix-777", op: "prefetch", input: { messageId: 777, mimeType: "audio/mpeg", offsetBytes: 0, traceIntentId: 42 } });
      await vi.waitFor(() => expect(harness.transfersFor(777)).toHaveLength(1));
      harness.transfersFor(777)[0].resolve();
      await vi.waitFor(() => expect(posted.some(message => message.requestId === "trace-prefix-777" && message.ok === true)).toBe(true));

      const rows = info.mock.calls
        .map(([value]) => String(value))
        .filter(value => value.startsWith("[play-trace] "))
        .map(value => JSON.parse(value.slice("[play-trace] ".length)))
        .filter(row => row.request_id === "trace-prefix-777");
      const stages = rows.map(row => row.stage);
      const expected = [
        "WORKER_PLAYBACK_REQUEST_RECEIVED",
        "WORKER_PREFETCH_ENTER",
        "WORKER_PLAYBACK_MEDIA_CACHE_MISS",
        "WORKER_MEDIA_GET_MESSAGES_BEGIN",
        "WORKER_MEDIA_GET_MESSAGES_DONE",
        "WORKER_MEDIA_RESOLVE_DONE",
        "WORKER_DATA_LANE_ACQUIRED",
        "WORKER_PREFIX_DOWNLOAD_BEGIN",
        "WORKER_PREFIX_DOWNLOAD_DONE",
        "WORKER_DATA_LANE_RELEASED",
        "WORKER_PREFIX_RESPONSE_POST_BEGIN",
      ];
      for (const stage of expected) expect(stages).toContain(stage);
      expect(expected.map(stage => stages.indexOf(stage))).toEqual([...expected.map(stage => stages.indexOf(stage))].sort((a, b) => a - b));
      for (const row of rows) {
        expect(row.message_id).toBe(777);
        expect(row.intent_id).toBe(42);
        expect(Number.isFinite(row.ts_ms)).toBe(true);
      }
      expect(rows.find(row => row.stage === "WORKER_MEDIA_GET_MESSAGES_DONE")?.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(rows.find(row => row.stage === "WORKER_PREFIX_DOWNLOAD_DONE")?.bytes).toBe(65_536);
    } finally {
      info.mockRestore();
      await dispatchAndWait({ requestId: "trace-release-777", op: "playback_release", messageId: 777 });
    }
  });

  it("attaches the clicked intent to an already active warm before its first bytes arrive", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      dispatch({ requestId: "trace-warm-778", op: "prefetch_batch", input: { inputs: [{ messageId: 778, mimeType: "audio/mpeg" }], maxConcurrency: 7 } });
      await vi.waitFor(() => expect(harness.transfersFor(778)).toHaveLength(1));
      await dispatchAndWait({ requestId: "trace-focus-778", op: "playback_focus", messageId: 778, traceIntentId: 43 });
      harness.transfersFor(778)[0].resolve();
      await vi.waitFor(() => expect(terminal(778, "READY")).toHaveLength(1));

      const rows = info.mock.calls
        .map(([value]) => String(value))
        .filter(value => value.startsWith("[play-trace] "))
        .map(value => JSON.parse(value.slice("[play-trace] ".length)))
        .filter(row => row.request_id === "trace-warm-778" && row.message_id === 778);
      expect(rows.find(row => row.stage === "WORKER_WARM_QUEUE_ENTER")).toMatchObject({ intent_id: null });
      expect(rows.find(row => row.stage === "WORKER_PREFIX_DOWNLOAD_BEGIN")).toMatchObject({ intent_id: null });
      expect(rows.find(row => row.stage === "WORKER_PREFIX_DOWNLOAD_DONE")).toMatchObject({ intent_id: 43, bytes: 65_536 });
      expect(rows.find(row => row.stage === "WORKER_PREFIX_POST_BEGIN")).toMatchObject({ intent_id: 43, bytes: 65_536 });
      expect(rows.find(row => row.stage === "WARM_PREFIX_READY")).toMatchObject({ intent_id: 43 });
    } finally {
      info.mockRestore();
      await dispatchAndWait({ requestId: "trace-release-778", op: "playback_release", messageId: 778 });
    }
  });

  it("singleflights startup, warm and Play resolution plus the shared first range", async () => {
    harness.holdGetMessages();
    try {
      await dispatchAndWait({
        requestId: "shared-reinitialize-1201",
        op: "initialize",
        startupMessageIds: [1201],
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
      await dispatchAndWait({ requestId: "shared-verify-1201", op: "verify" });
      await vi.waitFor(() => expect(harness.getMessages).toHaveBeenCalledTimes(1));

      dispatch({
        requestId: "shared-warm-1201",
        op: "prefetch_batch",
        input: { inputs: [{ messageId: 1201, mimeType: "audio/mpeg" }], maxConcurrency: 1 },
      });

      await dispatchAndWait({ requestId: "shared-focus-1201", op: "playback_focus", messageId: 1201, traceIntentId: 51 });
      dispatch({
        requestId: "shared-play-1201",
        op: "prefetch",
        input: { messageId: 1201, mimeType: "audio/mpeg", offsetBytes: 0, traceIntentId: 51 },
      });
      await flushMicrotasks();
      expect(harness.getMessages).toHaveBeenCalledTimes(1);

      harness.releaseGetMessages();
      await vi.waitFor(() => expect(harness.transfersFor(1201)).toHaveLength(1));
      expect(harness.downloadChunk).toHaveBeenCalledTimes(1);
      harness.transfersFor(1201)[0].resolve();

      await vi.waitFor(() => expect(terminal(1201, "READY")).toHaveLength(1));
      await vi.waitFor(() => expect(posted.some(message => message.requestId === "shared-play-1201" && message.ok === true)).toBe(true));
      await vi.waitFor(() => expect(posted.some(message => message.requestId === "shared-warm-1201" && message.ok === true)).toBe(true));
      expect(harness.getMessages).toHaveBeenCalledTimes(1);
      expect(harness.transfersFor(1201)).toHaveLength(1);
    } finally {
      harness.releaseGetMessages();
      await dispatchAndWait({ requestId: "shared-release-1201", op: "playback_release", messageId: 1201, traceIntentId: 51 });
    }
  });

  it("keeps a shared range alive when one consumer cancels", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      dispatch({
        requestId: "shared-cancel-warm-1202",
        op: "prefetch_batch",
        input: { inputs: [{ messageId: 1202, mimeType: "audio/mpeg" }], maxConcurrency: 1 },
      });
      await vi.waitFor(() => expect(harness.transfersFor(1202)).toHaveLength(1));
      const physicalTransfer = harness.transfersFor(1202)[0];

      dispatch({
        requestId: "shared-cancel-play-1202",
        op: "prefetch",
        input: { messageId: 1202, mimeType: "audio/mpeg", offsetBytes: 0, traceIntentId: 52 },
      });
      await vi.waitFor(() => {
        const joined = info.mock.calls.some(([value]) => {
          const text = String(value);
          return text.includes("WORKER_PLAYBACK_RANGE_PENDING_JOIN") && text.includes("shared-cancel-play-1202");
        });
        expect(joined).toBe(true);
      });

      await dispatchAndWait({
        requestId: "shared-cancel-one-1202",
        op: "prefetch_batch_cancel",
        targetRequestId: "shared-cancel-warm-1202",
        messageId: 1202,
      });
      await vi.waitFor(() => expect(terminal(1202, "FAILED")).toHaveLength(1));
      expect(physicalTransfer.signal.aborted).toBe(false);
      expect(harness.transfersFor(1202)).toHaveLength(1);

      physicalTransfer.resolve();
      await vi.waitFor(() => expect(posted.some(message => message.requestId === "shared-cancel-play-1202" && message.ok === true)).toBe(true));
      await vi.waitFor(() => expect(posted.some(message => message.requestId === "shared-cancel-warm-1202" && message.ok === true)).toBe(true));
      expect(harness.transfersFor(1202)).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it("retains a completed focused range after its warm consumer cancels so Play can adopt the bytes", async () => {
    await dispatchAndWait({ requestId: "retained-focus-1204", op: "playback_focus", messageId: 1204, traceIntentId: 53 });
    try {
      dispatch({
        requestId: "retained-warm-1204",
        op: "prefetch_batch",
        input: { inputs: [{ messageId: 1204, mimeType: "audio/mpeg" }], maxConcurrency: 1 },
      });
      await vi.waitFor(() => expect(harness.transfersFor(1204)).toHaveLength(1));
      const physicalTransfer = harness.transfersFor(1204)[0];

      await dispatchAndWait({
        requestId: "retained-cancel-1204",
        op: "prefetch_batch_cancel",
        targetRequestId: "retained-warm-1204",
        messageId: 1204,
      });
      await vi.waitFor(() => expect(terminal(1204, "FAILED")).toHaveLength(1));
      expect(physicalTransfer.signal.aborted).toBe(false);

      physicalTransfer.resolve();
      await vi.waitFor(() => expect(posted.some(message => message.requestId === "retained-warm-1204" && message.ok === true)).toBe(true));
      dispatch({
        requestId: "retained-play-1204",
        op: "prefetch",
        input: { messageId: 1204, mimeType: "audio/mpeg", offsetBytes: 0, traceIntentId: 53 },
      });
      await vi.waitFor(() => expect(posted.some(message => message.requestId === "retained-play-1204" && message.ok === true)).toBe(true));
      expect(harness.transfersFor(1204)).toHaveLength(1);
    } finally {
      await dispatchAndWait({ requestId: "retained-release-1204", op: "playback_release", messageId: 1204, traceIntentId: 53 });
    }
  });

  it("lets the foreground stream adopt a focused warm range after that warm consumer is cancelled", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await dispatchAndWait({ requestId: "stream-adopt-focus-1205", op: "playback_focus", messageId: 1205, traceIntentId: 54 });
    try {
      dispatch({
        requestId: "stream-adopt-warm-1205",
        op: "prefetch_batch",
        input: { inputs: [{ messageId: 1205, mimeType: "audio/mpeg" }], maxConcurrency: 1 },
      });
      await vi.waitFor(() => expect(harness.transfersFor(1205)).toHaveLength(1));
      const physicalTransfer = harness.transfersFor(1205)[0];
      await dispatchAndWait({
        requestId: "stream-adopt-cancel-1205",
        op: "prefetch_batch_cancel",
        targetRequestId: "stream-adopt-warm-1205",
        messageId: 1205,
      });

      dispatch({
        requestId: "stream-adopt-play-1205",
        op: "stream",
        input: { messageId: 1205, mimeType: "audio/mpeg", offsetBytes: 0, purpose: "playback", traceIntentId: 54 },
      });
      await vi.waitFor(() => {
        expect(info.mock.calls.some(([value]) => {
          const text = String(value);
          return text.includes("WORKER_PLAYBACK_RANGE_PENDING_JOIN") && text.includes("stream-adopt-play-1205");
        })).toBe(true);
      });
      expect(physicalTransfer.signal.aborted).toBe(false);
      physicalTransfer.resolve();

      await vi.waitFor(() => expect(posted.filter(message => message.requestId === "stream-adopt-play-1205" && message.event === "download-chunk")).toHaveLength(1));
      dispatch({ requestId: "stream-adopt-ack-1", op: "stream_ack", targetRequestId: "stream-adopt-play-1205" });
      await vi.waitFor(() => expect(posted.filter(message => message.requestId === "stream-adopt-play-1205" && message.event === "download-chunk")).toHaveLength(2));
      dispatch({ requestId: "stream-adopt-ack-2", op: "stream_ack", targetRequestId: "stream-adopt-play-1205" });
      await vi.waitFor(() => expect(posted.some(message => message.requestId === "stream-adopt-play-1205" && message.ok === true)).toBe(true));

      expect(harness.transfersFor(1205)).toHaveLength(1);
      expect(harness.downloadAsIterable).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 1205 }),
        expect.objectContaining({ offset: 65_536 }),
      );
    } finally {
      info.mockRestore();
      await dispatchAndWait({ requestId: "stream-adopt-release-1205", op: "playback_release", messageId: 1205, traceIntentId: 54 });
    }
  });

  it("ignores stable and release responses from an older intent for the same message", async () => {
    expect(await dispatchAndWait({ requestId: "intent-focus-1", op: "playback_focus", messageId: 1203, traceIntentId: 61 }))
      .toMatchObject({ ok: true, result: { focused: true } });
    expect(await dispatchAndWait({ requestId: "intent-focus-2", op: "playback_focus", messageId: 1203, traceIntentId: 62 }))
      .toMatchObject({ ok: true, result: { focused: true } });

    expect(await dispatchAndWait({ requestId: "intent-stable-old", op: "playback_stable", messageId: 1203, traceIntentId: 61 }))
      .toMatchObject({ ok: true, result: { stable: false } });
    expect(await dispatchAndWait({ requestId: "intent-release-old", op: "playback_release", messageId: 1203, traceIntentId: 61 }))
      .toMatchObject({ ok: true, result: { released: false } });
    expect(await dispatchAndWait({ requestId: "intent-stable-current", op: "playback_stable", messageId: 1203, traceIntentId: 62 }))
      .toMatchObject({ ok: true, result: { stable: true } });
    expect(await dispatchAndWait({ requestId: "intent-release-current", op: "playback_release", messageId: 1203, traceIntentId: 62 }))
      .toMatchObject({ ok: true, result: { released: true } });
  });

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

  it("keeps the physically active same-beat warm, aborts the other six lanes, and never restarts offset zero", async () => {
    const ids = Array.from({ length: 14 }, (_, index) => index + 21);
    dispatch({
      requestId: "warm-active-target",
      op: "prefetch_batch",
      input: { inputs: ids.map(messageId => ({ messageId, mimeType: "audio/mpeg" })), maxConcurrency: 7 },
    });
    await vi.waitFor(() => expect(harness.activeTransfers()).toHaveLength(7));

    const target = harness.transfersFor(23)[0];
    expect(target).toBeTruthy();
    const unrelated = harness.activeTransfers().filter(transfer => transfer.messageId !== 23);
    expect(unrelated).toHaveLength(6);

    await dispatchAndWait({ requestId: "focus-active-23", op: "playback_focus", messageId: 23 });
    await vi.waitFor(() => expect(harness.activeTransfers().map(transfer => transfer.messageId)).toEqual([23]));

    expect(target.signal.aborted).toBe(false);
    for (const transfer of unrelated) {
      expect(transfer.signal.aborted).toBe(true);
      expect(terminal(transfer.messageId, "FAILED")).toHaveLength(0);
    }
    expect(harness.transfersFor(23)).toHaveLength(1);

    target.resolve();
    await vi.waitFor(() => expect(terminal(23, "READY")).toHaveLength(1));
    expect(harness.transfersFor(23)).toHaveLength(1);

    await dispatchAndWait({ requestId: "release-active-23", op: "playback_release", messageId: 23 });
    await drainBatch("warm-active-target");
    expect(harness.transfersFor(23)).toHaveLength(1);
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

  it("keeps an active INDEX read ahead of a newly queued WARM transfer", async () => {
    dispatch({ requestId: "index-warm-race", op: "get_index" });
    await vi.waitFor(() => expect(harness.activeIndexTransfers()).toHaveLength(1));
    const firstIndex = harness.activeIndexTransfers()[0];

    dispatch({
      requestId: "index-preempting-warm",
      op: "prefetch_batch",
      input: { inputs: [{ messageId: 888, mimeType: "audio/mpeg" }], maxConcurrency: 1 },
    });
    await vi.waitFor(() => expect(harness.activeTransfers().map(transfer => transfer.messageId)).toEqual([888]));
    expect(firstIndex.signal.aborted).toBe(false);
    expect(harness.indexTransfers).toHaveLength(1);

    firstIndex.resolve();
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "index-warm-race" && message.ok === true)).toBe(true));
    expect(posted.some(message => message.requestId === "index-preempting-warm" && message.ok === true)).toBe(false);
    harness.activeTransfers()[0].resolve();
    await vi.waitFor(() => expect(posted.some(message => message.requestId === "index-preempting-warm" && message.ok === true)).toBe(true));
    expect(harness.downloadAsBuffer).toHaveBeenCalledOnce();
  });
});
