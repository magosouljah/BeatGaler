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

  event(requestId: string, state: "active" | "paused"): void {
    this.onmessage?.({ data: { requestId, event: "index-state", state } } as MessageEvent);
  }

  succeed(requestId: string, result?: unknown): void {
    this.onmessage?.({ data: { requestId, ok: true, result } } as MessageEvent);
  }
}

function messages(worker: FakeWorker, op: string) {
  return worker.postMessage.mock.calls.map(call => call[0]).filter(message => message?.op === op);
}

describe("WorkerClient INDEX active-time accounting", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not count more than 30 seconds of scheduler/preemption pause against the INDEX deadline", async () => {
    const client = new WebTransportWorkerClient(1000);
    const index = client.getLibraryIndex();
    const worker = FakeWorker.instances[0];
    const request = messages(worker, "get_index")[0];

    worker.event(request.requestId, "active");
    await vi.advanceTimersByTimeAsync(700);
    worker.event(request.requestId, "paused");

    await vi.advanceTimersByTimeAsync(31_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(messages(worker, "cancel_index")).toHaveLength(0);

    worker.event(request.requestId, "active");
    await vi.advanceTimersByTimeAsync(900);
    expect(messages(worker, "cancel_index")).toHaveLength(0);

    worker.succeed(request.requestId, { manifest: { schema: "beatgaler.telegram.library", version: 2, beats: [] }, messageId: 501 });
    await expect(index).resolves.toMatchObject({ messageId: 501 });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("cancels only an INDEX read that hangs while active and keeps the Worker usable", async () => {
    const client = new WebTransportWorkerClient(1000);
    const index = client.getLibraryIndex();
    const rejection = expect(index).rejects.toThrow("timed out during active get_index");
    const worker = FakeWorker.instances[0];
    const request = messages(worker, "get_index")[0];

    worker.event(request.requestId, "active");
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;

    expect(worker.terminate).not.toHaveBeenCalled();
    expect(messages(worker, "cancel_index")).toHaveLength(1);
    expect(messages(worker, "cancel_index")[0]).toEqual(expect.objectContaining({
      targetRequestId: request.requestId,
    }));

    const verify = client.verifyReady();
    const verifyRequest = messages(worker, "verify").at(-1)!;
    worker.succeed(verifyRequest.requestId);
    await expect(verify).resolves.toBeUndefined();
    expect(FakeWorker.instances).toHaveLength(1);
  });
});
