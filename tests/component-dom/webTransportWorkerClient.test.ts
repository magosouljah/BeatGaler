import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebTransportWorkerClient } from "../../src/features/cloud/webTransportWorkerClient";

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  respond(result: unknown = undefined): void {
    const request = this.postMessage.mock.calls.findLast(call => call[0]?.op !== "prefetch_batch_cancel")?.[0] as { requestId?: string } | undefined;
    if (!request?.requestId) throw new Error("Fake Worker has no request to answer.");
    this.onmessage?.({ data: { requestId: request.requestId, ok: true, result } } as MessageEvent);
  }
}

describe("Galer Cloud Web transport bootstrap deadlines", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("passes a verified vault peer to a replacement Worker without repeating discovery", async () => {
    const client = new WebTransportWorkerClient(1000);
    const session = { chat_id: "-1001234567890", transport_user_id: "4242", temp_auth: { expected_bot_id: "4242", api_id: 1 } } as any;
    const initial = client.initialize(session, []);
    const firstWorker = FakeWorker.instances[0];
    expect(firstWorker.postMessage.mock.calls.at(-1)?.[0].session.vault_peer).toBeNull();
    firstWorker.respond();
    await initial;

    const verification = client.verifyReady();
    const peer = { channelId: 1234567890, accessHash: { low: 42, high: 7 } };
    firstWorker.respond(peer);
    await verification;
    firstWorker.onerror?.({} as ErrorEvent);

    const replacement = client.initialize(session, []);
    const secondWorker = FakeWorker.instances[1];
    expect(secondWorker.postMessage.mock.calls.at(-1)?.[0].session.vault_peer).toEqual(peer);
    secondWorker.respond();
    await replacement;
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
  });

  it("keeps an INDEX request alive beyond the bootstrap timeout without terminating the Worker", async () => {
    const client = new WebTransportWorkerClient(1000);
    const request = client.getLibraryIndex();
    const worker = FakeWorker.instances[0];

    await vi.advanceTimersByTimeAsync(31_000);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.respond({ manifest: { schema: "beatgaler.telegram.library", version: 2, beats: [] }, messageId: 7 });
    await expect(request).resolves.toEqual({
      manifest: { schema: "beatgaler.telegram.library", version: 2, beats: [] },
      messageId: 7,
    });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("clears the bootstrap deadline when the worker answers", async () => {
    const client = new WebTransportWorkerClient(1000);
    const request = client.verifyReady();
    const worker = FakeWorker.instances[0];

    worker.respond();
    await expect(request).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);

    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("uses a fresh worker after an unresponsive bootstrap worker is terminated", async () => {
    const client = new WebTransportWorkerClient(1000);
    const firstRequest = client.verifyReady();
    const firstRejection = expect(firstRequest).rejects.toThrow("timed out during verify");

    await vi.advanceTimersByTimeAsync(1000);
    await firstRejection;

    const secondRequest = client.verifyReady();
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].respond();

    await expect(secondRequest).resolves.toBeUndefined();
  });

  it("reapplies the latest focus after initialize before reporting readiness", async () => {
    const client = new WebTransportWorkerClient(1000);
    const focus = client.focusPlayback(77, 42);
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ op: "playback_focus", messageId: 77, traceIntentId: 42 }));
    worker.respond();
    await focus;

    const initialize = client.initialize({
      chat_id: -100123,
      transport_user_id: "transport-1",
      temp_auth: { expected_bot_id: "77", api_id: 1 },
    } as any, [11, 12]);

    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      op: "initialize",
      startupMessageIds: [11, 12],
    }));
    worker.respond();
    await Promise.resolve();

    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      op: "playback_focus",
      messageId: 77,
      traceIntentId: 42,
    }));
    let settled = false;
    void initialize.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.respond();
    await expect(initialize).resolves.toBeUndefined();
  });

  it("correlates a foreground prefix request with its main-thread delivery", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const client = new WebTransportWorkerClient(1000);
      const request = client.prefetch({ messageId: 777, mimeType: "audio/mpeg", offsetBytes: 0, traceIntentId: 42 });
      const worker = FakeWorker.instances[0];
      const command = worker.postMessage.mock.calls[0][0];
      expect(command).toMatchObject({ op: "prefetch", input: { messageId: 777, traceIntentId: 42 } });
      worker.respond({ messageId: 777, totalBytes: 200_000, mimeType: "audio/mpeg", prefix: new ArrayBuffer(65_536), playableSeconds: 0, targetMet: true });
      await request;

      const rows = info.mock.calls
        .map(([value]) => String(value))
        .filter(value => value.startsWith("[play-trace] "))
        .map(value => JSON.parse(value.slice("[play-trace] ".length)))
        .filter(row => row.request_id === command.requestId);
      expect(rows.map(row => row.stage)).toEqual(expect.arrayContaining(["WORKER_PLAYBACK_REQUEST_POSTED", "WORKER_PREFIX_RESPONSE_RECEIVED_MAIN"]));
      for (const row of rows) {
        expect(row.message_id).toBe(777);
        expect(row.intent_id).toBe(42);
        expect(Number.isFinite(row.ts_ms)).toBe(true);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("routes warm-prefix progress and cancels one batch member without cancelling the batch", async () => {
    const client = new WebTransportWorkerClient(1000);
    const onChunk = vi.fn();
    const handle = client.prefetchBatch({ inputs: [
      { messageId: 11, mimeType: "audio/mpeg" },
      { messageId: 12, mimeType: "audio/mpeg" },
    ] }, onChunk);
    const worker = FakeWorker.instances[0];
    const batchRequest = worker.postMessage.mock.calls[0][0];

    worker.onmessage?.({
      data: {
        requestId: batchRequest.requestId,
        event: "prefetch-chunk",
        progress: {
          messageId: 11,
          totalBytes: 200000,
          mimeType: "audio/mpeg",
          offsetBytes: 0,
          chunk: new ArrayBuffer(65536),
          downloadedBytes: 65536,
          playableSeconds: 0.7,
          targetMet: false,
        },
      },
    } as MessageEvent);
    handle.cancelMessage(11);

    expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ messageId: 11, downloadedBytes: 65536 }));
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      op: "prefetch_batch_cancel",
      targetRequestId: batchRequest.requestId,
      messageId: 11,
    }));

    worker.onmessage?.({ data: { requestId: batchRequest.requestId, ok: true, result: { results: [] } } } as MessageEvent);
    await expect(handle.completed).resolves.toEqual({ results: [] });
  });

  it("rejects a foreground partial prefix that cannot resume without repeating offset zero", async () => {
    const client = new WebTransportWorkerClient(1000);
    const request = client.prefetch({ messageId: 21, mimeType: "audio/mpeg", offsetBytes: 0 });
    const worker = FakeWorker.instances[0];
    const posted = worker.postMessage.mock.calls[0][0];

    worker.onmessage?.({
      data: {
        requestId: posted.requestId,
        ok: true,
        result: {
          messageId: 21,
          totalBytes: 200000,
          mimeType: "audio/mpeg",
          prefix: new ArrayBuffer(60000),
          playableSeconds: 0,
          targetMet: true,
        },
      },
    } as MessageEvent);

    await expect(request).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
  });

  it("accepts aligned partial prefixes and short EOF prefixes", async () => {
    const client = new WebTransportWorkerClient(1000);
    const aligned = client.prefetch({ messageId: 22, mimeType: "audio/mpeg", offsetBytes: 0 });
    const worker = FakeWorker.instances[0];
    let posted = worker.postMessage.mock.calls.at(-1)?.[0];
    worker.onmessage?.({ data: {
      requestId: posted.requestId,
      ok: true,
      result: {
        messageId: 22,
        totalBytes: 200000,
        mimeType: "audio/mpeg",
        prefix: new ArrayBuffer(65536),
        playableSeconds: 0,
        targetMet: true,
      },
    } } as MessageEvent);
    await expect(aligned).resolves.toMatchObject({ messageId: 22 });

    const eof = client.prefetch({ messageId: 23, mimeType: "audio/mpeg", offsetBytes: 0 });
    posted = worker.postMessage.mock.calls.at(-1)?.[0];
    worker.onmessage?.({ data: {
      requestId: posted.requestId,
      ok: true,
      result: {
        messageId: 23,
        totalBytes: 60000,
        mimeType: "audio/mpeg",
        prefix: new ArrayBuffer(60000),
        playableSeconds: 0,
        targetMet: true,
      },
    } } as MessageEvent);
    await expect(eof).resolves.toMatchObject({ messageId: 23 });
  });

  it("fails only the non-resumable member of a warm batch and never publishes its bytes", async () => {
    const client = new WebTransportWorkerClient(1000);
    const onChunk = vi.fn();
    const onTerminal = vi.fn();
    const handle = client.prefetchBatch({ inputs: [
      { messageId: 31, mimeType: "audio/mpeg" },
      { messageId: 32, mimeType: "audio/mpeg" },
    ] }, onChunk, onTerminal);
    const worker = FakeWorker.instances[0];
    const posted = worker.postMessage.mock.calls[0][0];

    worker.onmessage?.({ data: {
      requestId: posted.requestId,
      event: "prefetch-chunk",
      progress: {
        messageId: 31,
        totalBytes: 200000,
        mimeType: "audio/mpeg",
        offsetBytes: 0,
        chunk: new ArrayBuffer(60000),
        downloadedBytes: 60000,
        playableSeconds: 0,
        targetMet: true,
      },
    } } as MessageEvent);
    worker.onmessage?.({ data: {
      requestId: posted.requestId,
      event: "prefetch-chunk",
      progress: {
        messageId: 32,
        totalBytes: 200000,
        mimeType: "audio/mpeg",
        offsetBytes: 0,
        chunk: new ArrayBuffer(65536),
        downloadedBytes: 65536,
        playableSeconds: 0,
        targetMet: true,
      },
    } } as MessageEvent);
    worker.onmessage?.({ data: {
      requestId: posted.requestId,
      event: "prefetch-terminal",
      terminal: { messageId: 31, status: "READY" },
    } } as MessageEvent);
    worker.onmessage?.({ data: {
      requestId: posted.requestId,
      event: "prefetch-terminal",
      terminal: { messageId: 32, status: "READY" },
    } } as MessageEvent);
    worker.onmessage?.({ data: {
      requestId: posted.requestId,
      ok: true,
      result: {
        results: [
          { ok: true, result: { messageId: 31, totalBytes: 200000, mimeType: "audio/mpeg", prefix: new ArrayBuffer(60000), playableSeconds: 0, targetMet: true } },
          { ok: true, result: { messageId: 32, totalBytes: 200000, mimeType: "audio/mpeg", prefix: new ArrayBuffer(65536), playableSeconds: 0, targetMet: true } },
        ],
      },
    } } as MessageEvent);

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ messageId: 32, downloadedBytes: 65536 }));
    expect(onTerminal).toHaveBeenCalledTimes(2);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ messageId: 31, status: "FAILED", code: "TRANSFER_FAILED" }));
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ messageId: 32, status: "READY" }));
    await expect(handle.completed).resolves.toEqual({
      results: [
        expect.objectContaining({ ok: false, messageId: 31, code: "TRANSFER_FAILED" }),
        expect.objectContaining({ ok: true, result: expect.objectContaining({ messageId: 32 }) }),
      ],
    });
  });
});
