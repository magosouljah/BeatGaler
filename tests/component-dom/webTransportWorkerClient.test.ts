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
    const request = this.postMessage.mock.calls.at(-1)?.[0] as { requestId?: string } | undefined;
    if (!request?.requestId) throw new Error("Fake Worker has no request to answer.");
    this.onmessage?.({
      data: { requestId: request.requestId, ok: true, result },
    } as MessageEvent);
  }
}

describe("Galer Cloud Web transport bootstrap deadlines", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects a silent bootstrap index request instead of waiting forever", async () => {
    const client = new WebTransportWorkerClient(1000);
    const request = client.getLibraryIndex();
    const rejection = expect(request).rejects.toThrow("timed out during get_index");

    await vi.advanceTimersByTimeAsync(1000);
    await rejection;

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
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
});
