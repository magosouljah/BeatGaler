import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_DIRECT_MAX_FILE_BYTES } from "../../src/features/cloud/webTransportWorkerProtocol";

const transport = vi.hoisted(() => {
  const indexMedia = { type: "document", mimeType: "application/json" };
  const artworkMedia = { type: "document", mimeType: "image/png" };
  const audioMedia = { type: "audio", mimeType: "audio/mpeg", fileSize: 5 };
  const projectMedia = { type: "document", mimeType: "application/zip", fileSize: 5 };
  let pinnedId = 501;
  let missingPinnedReads = 0;
  let clientOptions: any = null;
  const importSession = vi.fn(async () => undefined);
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
    resetState() {
      this._sessionId = new FakeLong(9, 9, false);
      this._seqNo = 0;
      this._lastMessageId = new FakeLong(0, 0, false);
      this.initConnectionCalled = false;
    },
  };
  class SessionConnection {
    params = { isMainConnection: true, isMainDcConnection: true, dc: { id: 2 } };
    _session = boundSession;
    _salts = { currentSalt: new FakeLong(0, 0, false) };
    connect() {
      connectSnapshot = {
        low: this._session._sessionId.low,
        high: this._session._sessionId.high,
        unsigned: this._session._sessionId.unsigned,
        seqNo: this._session._seqNo,
        lastMessageId: this._session._lastMessageId,
        timeOffset: this._session._timeOffset,
        serverSalt: this._salts.currentSalt,
        queuedAcks: [...this._session.queuedAcks],
        initConnectionCalled: this._session.initConnectionCalled,
      };
    }
    reset() { this._session.initConnectionCalled = false; }
  }
  const boundConnection = new SessionConnection();
  let connectSnapshot: any = null;
  const connect = vi.fn(async () => { boundConnection.connect(); });
  const onUsableAdd = vi.fn();
  const network = {
    _dcConnections: new Map([
      [2, {
        main: {
          _connections: [boundConnection],
          onUsable: { add: onUsableAdd },
        },
      }],
    ]),
  };
  const sendMedia = vi.fn(async (_vault: unknown, media: any, options: any) => {
    options.progressCallback?.(2, 5);
    options.progressCallback?.(5, 5);
    return { id: media.caption === "BEATGALER_LIBRARY_INDEX_V1" ? 901 : 91 };
  });
  const pinMessage = vi.fn(async ({ message }: { message: number }) => { pinnedId = message; });
  const deleteMessagesById = vi.fn(async () => undefined);
  class TelegramClient {
    constructor(options: unknown) { clientOptions = options; }
    importSession = importSession;
    connect = connect;
    mt = { network };
    getMe = vi.fn(async () => ({ id: 4242, isBot: true }));
    getChat = vi.fn(async () => ({ id: -1001234567890 }));
    getFullChat = vi.fn(async () => {
      if (missingPinnedReads > 0) {
        missingPinnedReads -= 1;
        return { pinnedMsgId: 0 };
      }
      return { pinnedMsgId: pinnedId };
    });
    getMessages = vi.fn(async (_vault: unknown, ids: number[]) => ids.map(id => id === 501
      ? { id, text: "BEATGALER_LIBRARY_INDEX_V1", media: indexMedia }
      : id === 601
        ? { id, text: "", media: artworkMedia }
        : id === 701
          ? { id, text: "", media: audioMedia }
          : id === 702
            ? { id, text: "", media: projectMedia }
        : null));
    downloadAsBuffer = vi.fn(async (media: unknown) => media === indexMedia
      ? new TextEncoder().encode(JSON.stringify({
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [{ id: "beat-from-index", name: "Cloud Beat" }],
          trash: [],
        }))
      : new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    downloadAsIterable = vi.fn(async function* () {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4, 5]);
    });
    sendMedia = sendMedia;
    pinMessage = pinMessage;
    deleteMessagesById = deleteMessagesById;
    destroy = vi.fn(async () => {});
  }
  return {
    importSession,
    connect,
    boundSession,
    boundConnection,
    onUsableAdd,
    sendMedia,
    pinMessage,
    deleteMessagesById,
    resetPinned: () => { pinnedId = 501; missingPinnedReads = 0; },
    delayPinnedReads: (count: number) => { missingPinnedReads = Math.max(0, count); },
    TelegramClient,
    SessionConnection,
    getConnectSnapshot: () => connectSnapshot,
    WebCryptoProvider: class {
      constructor(public readonly options: unknown) {}
    },
    getClientOptions: () => clientOptions,
  };
});

vi.mock("@mtcute/web", () => ({
  TelegramClient: transport.TelegramClient,
  SessionConnection: transport.SessionConnection,
  WebCryptoProvider: transport.WebCryptoProvider,
  MemoryStorage: class {},
  InputMedia: {
    document: (file: File, options: unknown) => ({ type: "document", file, ...options as object }),
  },
}));

const originalOnMessage = globalThis.onmessage;
const posted: any[] = [];

beforeAll(async () => {
  vi.stubGlobal("postMessage", (message: any) => {
    posted.push(message);
    if (message?.event === "download-chunk") {
      queueMicrotask(() => {
        (globalThis.onmessage as any)?.({
          data: { requestId: `ack-${message.downloadedBytes}`, op: "stream_ack", targetRequestId: message.requestId },
        });
      });
    }
  });
  await import("../../src/features/cloud/webTransport.worker");
  await send({
    requestId: "init",
    op: "initialize",
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
        queuedAcks: [{ low: 77, high: 88, unsigned: false }],
        bindMsgId: { low: 111, high: 222, unsigned: false },
        lastSessionCreatedUid: { low: 0, high: 0, unsigned: false },
      },
      temp_primary_dcs: { main: { id: 2 }, media: { id: 2 } },
    },
  });
  await send({ requestId: "verify", op: "verify" });
});

afterAll(() => {
  globalThis.onmessage = originalOnMessage;
  vi.unstubAllGlobals();
});

async function send(data: any, timeout = 1000): Promise<any[]> {
  const start = posted.length;
  (globalThis.onmessage as any)?.({ data });
  await vi.waitFor(() => {
    expect(posted.slice(start).some(message => message.requestId === data.requestId && "ok" in message)).toBe(true);
  }, { timeout });
  return posted.slice(start);
}

describe("Galer Cloud single-file Web Worker", () => {
  beforeEach(() => {
    transport.resetPinned();
    transport.sendMedia.mockClear();
    transport.pinMessage.mockClear();
    transport.deleteMessagesById.mockClear();
  });

  it("continues the bound temporary MTProto session and allows post-bind initConnection without exposing permanent credentials", () => {
    expect(transport.getClientOptions()?.crypto?.options?.wasmInput).toMatch(/mtcute\.wasm/);
    expect(transport.getClientOptions()).toMatchObject({ apiId: 12345, apiHash: "" });
    expect(transport.importSession).toHaveBeenCalledOnce();
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(transport.getConnectSnapshot()).toEqual({
      low: 123456,
      high: 789,
      unsigned: false,
      seqNo: 2,
      lastMessageId: expect.objectContaining({ low: 333, high: 444, unsigned: false }),
      timeOffset: 5,
      serverSalt: expect.objectContaining({ low: 55, high: 66, unsigned: false }),
      queuedAcks: [expect.objectContaining({ low: 77, high: 88, unsigned: false })],
      initConnectionCalled: false,
    });
    expect(transport.boundSession.initConnectionCalled).toBe(false);
    expect(transport.boundSession._sessionId).toMatchObject({ low: 123456, high: 789, unsigned: false });
    expect(transport.boundSession._seqNo).toBe(2);
    expect(transport.boundConnection._salts.currentSalt).toMatchObject({ low: 55, high: 66, unsigned: false });
    expect(transport.boundSession.recentOutgoingMsgIds.has(expect.objectContaining({ low: 111, high: 222, unsigned: false }))).toBe(false);

    transport.boundSession.resetState();
    expect(transport.boundSession._sessionId).toMatchObject({ low: 9, high: 9, unsigned: false });
    expect(transport.boundSession.initConnectionCalled).toBe(false);
  });

  it("sends the original File once and returns one stored-file manifest", async () => {
    const file = new File(["audio"], "beat.mp3", { type: "audio/mpeg" });
    const messages = await send({
      requestId: "upload",
      op: "upload",
      input: { file, filename: file.name, beatId: "beat-1", kind: "MASTER", threadId: 77 },
    });

    expect(transport.sendMedia).toHaveBeenCalledOnce();
    expect(transport.sendMedia.mock.calls[0][0]).toBe(-1001234567890);
    expect(transport.sendMedia.mock.calls[0][1]).toMatchObject({
      file,
      fileSize: 5,
      fileName: "beat.mp3",
      type: "document",
    });
    expect(transport.sendMedia.mock.calls[0][2]).toMatchObject({
      replyTo: 77,
      threadId: 77,
    });
    const progress = messages.filter(message => message.event === "progress");
    expect(progress.at(-1)?.progress).toEqual({ uploadedBytes: 5, totalBytes: 5 });
    const completed = messages.find(message => message.ok === true);
    expect(completed.result).toMatchObject({
      telegram_file_id: "direct:91",
      telegram_message_id: 91,
      original_size: 5,
      transport: "direct-web",
      parts: [{ telegram_message_id: 91, size: 5 }],
    });
    expect(completed.result.parts).toHaveLength(1);
  });

  it("reads the authorized pinned library index directly", async () => {
    const messages = await send({ requestId: "get-index", op: "get_index" });
    const completed = messages.find(message => message.ok === true);

    expect(completed.result).toMatchObject({
      messageId: 501,
      manifest: {
        schema: "beatgaler.telegram.library",
        version: 2,
        beats: [{ id: "beat-from-index", name: "Cloud Beat" }],
      },
    });
  });

  it("waits for a new phone session to receive the pinned library index", async () => {
    transport.delayPinnedReads(2);
    const messages = await send({ requestId: "get-index-after-propagation", op: "get_index" });
    const completed = messages.find(message => message.ok === true);

    expect(completed.result).toMatchObject({
      messageId: 501,
      manifest: { beats: [{ id: "beat-from-index", name: "Cloud Beat" }] },
    });
  });

  it("never turns a missing pinned index into an authoritative empty gallery", async () => {
    transport.delayPinnedReads(10);
    const messages = await send({ requestId: "get-index-still-missing", op: "get_index" }, 2500);

    expect(messages.find(message => message.ok === true)).toBeUndefined();
    expect(messages.find(message => message.ok === false)?.error).toContain("still synchronizing");
  });

  it("pins one complete replacement index before deleting the previous index", async () => {
    const messages = await send({
      requestId: "replace-index",
      op: "replace_index",
      input: {
        expectedMessageId: 501,
        manifest: {
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [
            { id: "new-beat", name: "New Beat" },
            { id: "beat-from-index", name: "Cloud Beat" },
          ],
          trash: [],
        },
      },
    });
    const completed = messages.find(message => message.ok === true);

    expect(transport.sendMedia).toHaveBeenCalledOnce();
    expect(transport.sendMedia.mock.calls[0][1]).toMatchObject({
      caption: "BEATGALER_LIBRARY_INDEX_V1",
      fileMime: "application/json",
    });
    expect(transport.pinMessage).toHaveBeenCalledWith({ chatId: -1001234567890, message: 901, notify: false });
    expect(transport.deleteMessagesById).toHaveBeenCalledWith(-1001234567890, [501]);
    expect(completed.result).toEqual({ messageId: 901, previousMessageId: 501, beatCount: 2 });
  });

  it("allows an identity to disappear only when the replacement carries its tombstone", async () => {
    const messages = await send({
      requestId: "replace-with-tombstone",
      op: "replace_index",
      input: {
        expectedMessageId: 501,
        manifest: {
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [],
          trash: [],
          deleted: [{ beat_id: "beat-from-index", deleted_at: 100 }],
        },
      },
    });

    expect(messages.find(message => message.ok === false)).toBeUndefined();
    expect(messages.find(message => message.ok === true)?.result).toMatchObject({ beatCount: 0 });
  });

  it("deletes permanent media references in bounded batches", async () => {
    const ids = Array.from({ length: 105 }, (_, index) => index + 1);
    const messages = await send({ requestId: "delete-media", op: "delete_messages", input: { messageIds: ids } });

    expect(transport.deleteMessagesById).toHaveBeenNthCalledWith(1, -1001234567890, ids.slice(0, 100));
    expect(transport.deleteMessagesById).toHaveBeenNthCalledWith(2, -1001234567890, ids.slice(100));
    expect(messages.find(message => message.ok === true)?.result).toEqual({ deleted: 105 });
  });

  it("hydrates artwork by its direct message reference", async () => {
    const messages = await send({
      requestId: "download-artwork",
      op: "download",
      input: { messageId: 601, mimeType: "image/png" },
    });
    const completed = messages.find(message => message.ok === true);

    expect(completed.result).toEqual({
      messageId: 601,
      dataUrl: "data:image/png;base64,iVBORw==",
    });
  });

  it("streams MASTER chunks progressively from one authorized message", async () => {
    const messages = await send({
      requestId: "stream-master",
      op: "stream",
      input: { messageId: 701, mimeType: "audio/mpeg" },
    });
    const chunks = messages.filter(message => message.event === "download-chunk");
    const completed = messages.find(message => message.requestId === "stream-master" && message.ok === true);

    expect(chunks).toHaveLength(2);
    expect(Array.from(new Uint8Array(chunks[0].chunk))).toEqual([1, 2]);
    expect(chunks.at(-1)).toMatchObject({ downloadedBytes: 5, totalBytes: 5 });
    expect(completed.result).toEqual({ messageId: 701, totalBytes: 5, mimeType: "audio/mpeg" });
  });

  it("streams non-audio Cloud objects without rewriting their MIME type", async () => {
    const messages = await send({
      requestId: "stream-project",
      op: "stream",
      input: { messageId: 702, mimeType: "application/zip" },
    });
    const completed = messages.find(message => message.requestId === "stream-project" && message.ok === true);

    expect(completed.result).toEqual({ messageId: 702, totalBytes: 5, mimeType: "application/zip" });
  });

  it("passes a large browser File once and still creates one cloud file", async () => {
    const file = new File(["x"], "PROJECT.zip", { type: "application/zip" });
    Object.defineProperty(file, "size", { configurable: true, value: 10 * 1024 * 1024 + 1 });

    const messages = await send({
      requestId: "large-upload",
      op: "upload",
      input: { file, filename: file.name, beatId: "beat-2", kind: "PROJECT", threadId: 77 },
    });

    expect(messages.find(message => message.ok === false)).toBeUndefined();
    expect(transport.sendMedia).toHaveBeenCalledOnce();
    expect(transport.sendMedia.mock.calls[0][1]).toMatchObject({ file, fileSize: 10 * 1024 * 1024 + 1 });
    const completed = messages.find(message => message.ok === true);
    expect(completed.result.parts).toHaveLength(1);
    expect(completed.result.original_size).toBe(10 * 1024 * 1024 + 1);
  });

  it("accepts one complete 1.9 GB file and rejects anything larger", async () => {
    const limitFile = new File(["x"], "full-project.zip", { type: "application/zip" });
    Object.defineProperty(limitFile, "size", { configurable: true, value: WEB_DIRECT_MAX_FILE_BYTES });
    const accepted = await send({
      requestId: "limit-upload",
      op: "upload",
      input: { file: limitFile, filename: limitFile.name, beatId: "beat-3", kind: "PROJECT", threadId: 77 },
    });

    expect(accepted.find(message => message.ok === false)).toBeUndefined();
    expect(transport.sendMedia).toHaveBeenCalledOnce();
    expect(transport.sendMedia.mock.calls[0][1]).toMatchObject({ file: limitFile, fileSize: WEB_DIRECT_MAX_FILE_BYTES });

    transport.sendMedia.mockClear();
    const oversized = new File(["x"], "too-large.zip", { type: "application/zip" });
    Object.defineProperty(oversized, "size", { configurable: true, value: WEB_DIRECT_MAX_FILE_BYTES + 1 });
    const rejected = await send({
      requestId: "oversized-upload",
      op: "upload",
      input: { file: oversized, filename: oversized.name, beatId: "beat-4", kind: "PROJECT", threadId: 77 },
    });

    expect(transport.sendMedia).not.toHaveBeenCalled();
    expect(rejected.find(message => message.ok === false)?.error).toContain("1.9 GB");
  });
});