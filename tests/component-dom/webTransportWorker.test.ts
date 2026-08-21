import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalOnMessage = globalThis.onmessage;
const posted: any[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url.endsWith("/sendDocument")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 91, document: { file_id: "bot-file-91" } } }),
    };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
});

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
  await import("../../src/features/cloud/webTransport.worker");
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

describe("Galer Cloud direct Web Worker", () => {
  it("keeps file bytes off the control server and returns a direct manifest", async () => {
    await send({ requestId: "init", op: "initialize", session: { bot_token: "secret-token", chat_id: "vault-1" } });
    const file = new File(["audio"], "beat.mp3", { type: "audio/mpeg" });
    const messages = await send({
      requestId: "upload",
      op: "upload",
      input: { file, filename: file.name, beatId: "beat-1", kind: "MASTER", threadId: 77 },
    });

    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/sendDocument"));
    expect(String(uploadCall?.[0])).toBe("https://api.telegram.org/botsecret-token/sendDocument");
    const progress = messages.find(message => message.event === "progress");
    expect(progress.progress).toMatchObject({ uploadedBytes: 5, totalBytes: 5, partCount: 1 });
    const completed = messages.find(message => message.ok === true);
    expect(completed.result).toMatchObject({
      telegram_file_id: "direct:91",
      telegram_message_id: 91,
      original_size: 5,
      transport: "direct-web",
      parts: [{ telegram_message_id: 91, size: 5 }],
    });
  });
});
