import { expect, it, vi } from "vitest";
import { WebTransportWorkerClient } from "../../src/features/cloud/webTransportWorkerClient";
import type { WebTransportSession } from "../../src/features/cloud/webTransportSession";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;

  postMessage({ requestId }: { requestId: string }) {
    queueMicrotask(() => this.onmessage?.(new MessageEvent("message", {
      data: { requestId, ok: true },
    })));
  }

  terminate = vi.fn();
}

it("publishes one browser invalidation when an initialized Worker shuts down", async () => {
  const session = {
    chat_id: "-1001234567890",
    transport_user_id: "4242",
    temp_auth: { expected_bot_id: "4242", api_id: 1 },
  } as WebTransportSession;
  const invalidated = vi.fn();
  const event = "beatgaler:web-session-invalidated";
  vi.stubGlobal("Worker", FakeWorker);
  window.addEventListener(event, invalidated);
  try {
    const client = new WebTransportWorkerClient();
    await client.initialize(session, []);
    expect(invalidated).not.toHaveBeenCalled();
    await client.shutdown();
    expect(invalidated).toHaveBeenCalledOnce();
    await client.shutdown();
    expect(invalidated).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener(event, invalidated);
    vi.unstubAllGlobals();
  }
});
