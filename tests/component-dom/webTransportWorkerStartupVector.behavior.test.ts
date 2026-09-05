import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
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
  const getMessages = vi.fn(async (_chat: unknown, ids: number[]) => ids.map(id => missingIds.has(id) ? null : ({
    id,
    text: "",
    media: { type: "audio", mimeType: "audio/mpeg", fileSize: 200_000, messageId: id },
  })));
  const downloadChunk = vi.fn(async () => new Uint8Array(65_536));

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
    missingIds,
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

function boundSessionCommand(requestId: string, startupMessageIds: number[]) {
  return {
    requestId,
    op: "initialize" as const,
    startupMessageIds,
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
  };
}

beforeAll(async () => {
  vi.stubGlobal("postMessage", (message: any) => posted.push(message));
  await import("../../src/features/cloud/webTransport.worker");
});

afterAll(() => {
  globalThis.onmessage = originalOnMessage;
  vi.unstubAllGlobals();
});

describe("Worker startup metadata vector", () => {
  it("resolves fourteen startup messages once and reuses both positive and negative results during warm", async () => {
    const ids = Array.from({ length: 14 }, (_, index) => 501 + index);
    const missingId = ids.at(-1)!;
    harness.missingIds.add(missingId);
    harness.getMessages.mockClear();
    harness.downloadChunk.mockClear();

    const initialized = await dispatchAndWait(boundSessionCommand("vector-init", ids));
    expect(initialized.ok).toBe(true);
    expect(harness.getMessages).toHaveBeenCalledTimes(1);
    expect(harness.getMessages).toHaveBeenCalledWith(-1001234567890, ids);

    const start = posted.length;
    const warmed = await dispatchAndWait({
      requestId: "vector-warm",
      op: "prefetch_batch",
      input: {
        inputs: ids.map(messageId => ({ messageId, mimeType: "audio/mpeg", offsetBytes: 0 })),
        maxConcurrency: 7,
      },
    });

    expect(warmed.ok).toBe(true);
    expect(harness.getMessages).toHaveBeenCalledTimes(1);
    expect(harness.downloadChunk).toHaveBeenCalledTimes(13);

    const events = posted.slice(start).filter(message => message.requestId === "vector-warm");
    const missingTerminal = events.find(message =>
      message.event === "prefetch-terminal" && message.terminal?.messageId === missingId
    );
    expect(missingTerminal?.terminal).toMatchObject({
      messageId: missingId,
      status: "FAILED",
      code: "ROUTE_MISSING",
    });

    const readyIds = events
      .filter(message => message.event === "prefetch-terminal" && message.terminal?.status === "READY")
      .map(message => message.terminal.messageId)
      .sort((a, b) => a - b);
    expect(readyIds).toEqual(ids.slice(0, -1));
    expect(warmed.result.results).toHaveLength(14);
    expect(warmed.result.results.at(-1)).toMatchObject({ ok: false, messageId: missingId, code: "ROUTE_MISSING" });
  });
});
