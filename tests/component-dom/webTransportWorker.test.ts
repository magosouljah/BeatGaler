import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_DIRECT_MAX_FILE_BYTES } from "../../src/features/cloud/webTransportWorkerProtocol";

const transport = vi.hoisted(() => {
  const sendMedia = vi.fn(async (_vault: unknown, _media: unknown, options: any) => {
    options.progressCallback?.(2, 5);
    options.progressCallback?.(5, 5);
    return { id: 91 };
  });
  class TelegramClient {
    start = vi.fn(async () => ({}));
    getMe = vi.fn(async () => ({}));
    getChat = vi.fn(async () => ({ id: "vault-1" }));
    sendMedia = sendMedia;
    destroy = vi.fn(async () => {});
  }
  return { sendMedia, TelegramClient };
});

vi.mock("@mtcute/web", () => ({
  TelegramClient: transport.TelegramClient,
  MemoryStorage: class {},
  InputMedia: {
    document: (file: File, options: unknown) => ({ type: "document", file, ...options as object }),
  },
}));

const originalOnMessage = globalThis.onmessage;
const posted: any[] = [];

beforeAll(async () => {
  vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
  await import("../../src/features/cloud/webTransport.worker");
  await send({
    requestId: "init",
    op: "initialize",
    session: {
      bot_token: "secret-token",
      chat_id: "vault-1",
      telegram_api_id: 123,
      telegram_api_hash: "secret-hash",
    },
  });
  await send({ requestId: "verify", op: "verify" });
});

afterAll(() => {
  globalThis.onmessage = originalOnMessage;
  vi.unstubAllGlobals();
});

async function send(data: any): Promise<any[]> {
  const start = posted.length;
  (globalThis.onmessage as any)?.({ data });
  await vi.waitFor(() => {
    expect(posted.slice(start).some(message => message.requestId === data.requestId && "ok" in message)).toBe(true);
  });
  return posted.slice(start);
}

describe("Galer Cloud single-file Web Worker", () => {
  beforeEach(() => {
    transport.sendMedia.mockClear();
  });

  it("sends the original File once and returns one stored-file manifest", async () => {
    const file = new File(["audio"], "beat.mp3", { type: "audio/mpeg" });
    const messages = await send({
      requestId: "upload",
      op: "upload",
      input: { file, filename: file.name, beatId: "beat-1", kind: "MASTER", threadId: 77 },
    });

    expect(transport.sendMedia).toHaveBeenCalledOnce();
    expect(transport.sendMedia.mock.calls[0][0]).toBe("vault-1");
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
