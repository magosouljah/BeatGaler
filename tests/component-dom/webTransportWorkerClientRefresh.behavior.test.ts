import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebTransportWorkerClient } from "../../src/features/cloud/webTransportWorkerClient";
import type { WebTransportSession } from "../../src/features/cloud/webTransportSession";

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  succeed(requestId: string, result?: unknown): void {
    this.onmessage?.({ data: { requestId, ok: true, result } } as MessageEvent);
  }

  fail(requestId: string, error: string, code?: string): void {
    this.onmessage?.({ data: { requestId, ok: false, error, code } } as MessageEvent);
  }

  chunk(requestId: string, downloadedBytes: number, totalBytes: number, byteLength: number): void {
    this.onmessage?.({
      data: {
        requestId,
        event: "download-chunk",
        chunk: new ArrayBuffer(byteLength),
        downloadedBytes,
        totalBytes,
      },
    } as MessageEvent);
  }
}

function session(credentialVersion = 2): WebTransportSession {
  return {
    session_id: "session-1",
    generation: 1,
    credential_version: credentialVersion,
    chat_id: "-100123",
    transport_user_id: "77",
    temp_auth: { expected_bot_id: "77", api_id: 12345 },
    temp_auth_key: new Uint8Array(256),
    temp_session_id: { low: 1, high: 2, unsigned: false },
    temp_session_state: {
      seqNo: 0,
      lastMessageId: { low: 0, high: 0, unsigned: false },
      timeOffset: 0,
      serverSalt: { low: 0, high: 0, unsigned: false },
      queuedAcks: [],
      bindMsgId: { low: 0, high: 0, unsigned: false },
      lastSessionCreatedUid: { low: 0, high: 0, unsigned: false },
    },
    temp_primary_dcs: { main: { id: 2 } },
  } as WebTransportSession;
}

function posted(worker: FakeWorker, op: string) {
  return worker.postMessage.mock.calls
    .map(call => call[0])
    .filter(message => message?.op === op);
}

describe("WorkerClient playback continuity during credential refresh", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resumes the same focused stream from the last consumer-confirmed byte after a valid refresh", async () => {
    const client = new WebTransportWorkerClient(1000);
    const focus = client.focusPlayback(77);
    const worker = FakeWorker.instances[0];
    const initialFocus = posted(worker, "playback_focus")[0];
    worker.succeed(initialFocus.requestId);
    await focus;

    const onChunk = vi.fn(async () => {});
    const stream = client.stream({
      messageId: 77,
      mimeType: "audio/mpeg",
      offsetBytes: 65536,
      purpose: "playback",
    }, onChunk);
    const firstStream = posted(worker, "stream")[0];

    worker.chunk(firstStream.requestId, 69632, 200000, 4096);
    await vi.waitFor(() => expect(onChunk).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(posted(worker, "stream_ack")).toHaveLength(1));

    const refresh = client.replaceCredentials(session(2));
    const initialize = posted(worker, "initialize").at(-1)!;

    // initialize() destroys the old MTProto client in the Worker. The stream
    // failure is expected during a valid credential rotation and must stay
    // inside WorkerClient rather than tearing down Source/MSE.
    worker.fail(firstStream.requestId, "Playback stream cancelled.", "CANCELLED");
    worker.succeed(initialize.requestId);

    await vi.waitFor(() => expect(posted(worker, "playback_focus")).toHaveLength(2));
    const restoredFocus = posted(worker, "playback_focus").at(-1)!;
    expect(restoredFocus.messageId).toBe(77);
    worker.succeed(restoredFocus.requestId);
    await expect(refresh).resolves.toBeUndefined();

    await vi.waitFor(() => expect(posted(worker, "stream")).toHaveLength(2));
    const resumed = posted(worker, "stream")[1];
    expect(resumed.input).toEqual(expect.objectContaining({
      messageId: 77,
      offsetBytes: 69632,
      purpose: "playback",
    }));

    worker.succeed(resumed.requestId, { messageId: 77, totalBytes: 200000, mimeType: "audio/mpeg" });
    await expect(stream.completed).resolves.toEqual({
      messageId: 77,
      totalBytes: 200000,
      mimeType: "audio/mpeg",
    });

    expect(posted(worker, "stream").map(request => request.input.offsetBytes)).toEqual([65536, 69632]);
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it("does not resume playback when credential refresh is invalid", async () => {
    const client = new WebTransportWorkerClient(1000);
    const stream = client.stream({ messageId: 88, mimeType: "audio/mpeg", offsetBytes: 0, purpose: "playback" }, vi.fn());
    const worker = FakeWorker.instances[0];
    const firstStream = posted(worker, "stream")[0];
    const streamFailure = expect(stream.completed).rejects.toThrow("invalid refreshed credentials");

    const refresh = client.replaceCredentials(session(3));
    const refreshFailure = expect(refresh).rejects.toThrow("invalid refreshed credentials");
    const initialize = posted(worker, "initialize").at(-1)!;

    worker.fail(firstStream.requestId, "Playback stream cancelled.", "CANCELLED");
    worker.fail(initialize.requestId, "invalid refreshed credentials", "SESSION_INVALID");

    await refreshFailure;
    await streamFailure;
    expect(posted(worker, "stream")).toHaveLength(1);
  });

  it("physically cancels a secondary stream for Play and resumes from the last consumer-confirmed byte only after stable", async () => {
    const client = new WebTransportWorkerClient(1000);
    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>(resolve => { releaseChunk = resolve; });
    const onChunk = vi.fn(() => chunkGate);
    const stream = client.stream({
      messageId: 91,
      mimeType: "audio/wav",
      offsetBytes: 0,
      purpose: "export",
    }, onChunk);
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    await vi.waitFor(() => expect(posted(worker, "stream")).toHaveLength(1));
    const firstStream = posted(worker, "stream")[0];

    worker.chunk(firstStream.requestId, 4096, 200000, 4096);
    await vi.waitFor(() => expect(onChunk).toHaveBeenCalledTimes(1));

    const focus = client.focusPlayback(77);
    const focusRequest = posted(worker, "playback_focus").at(-1)!;
    await vi.waitFor(() => expect(posted(worker, "cancel").some(request => request.targetRequestId === firstStream.requestId)).toBe(true));
    worker.fail(firstStream.requestId, "Playback stream cancelled.", "CANCELLED");
    worker.succeed(focusRequest.requestId);
    await focus;

    // The worker-side stream is already physically cancelled, but the consumer
    // has not confirmed its 4 KiB chunk yet. A replacement must not start from
    // offset zero or race that consumer acknowledgement.
    expect(posted(worker, "stream")).toHaveLength(1);
    releaseChunk();
    await vi.waitFor(() => expect(posted(worker, "stream_ack")).toHaveLength(1));
    expect(posted(worker, "stream")).toHaveLength(1);

    const stable = client.markPlaybackStable(77);
    const stableRequest = posted(worker, "playback_stable").at(-1)!;
    worker.succeed(stableRequest.requestId);
    await stable;

    await vi.waitFor(() => expect(posted(worker, "stream")).toHaveLength(2));
    const resumed = posted(worker, "stream")[1];
    expect(resumed.input).toEqual(expect.objectContaining({
      messageId: 91,
      purpose: "export",
      offsetBytes: 4096,
    }));
    expect(onChunk).toHaveBeenCalledTimes(1);

    worker.succeed(resumed.requestId, { messageId: 91, totalBytes: 200000, mimeType: "audio/wav" });
    await expect(stream.completed).resolves.toMatchObject({ messageId: 91, totalBytes: 200000 });
    expect(posted(worker, "stream").map(request => request.input.offsetBytes)).toEqual([0, 4096]);
  });

  it("never preempts a playback stream when applying Play focus", async () => {
    const client = new WebTransportWorkerClient(1000);
    const stream = client.stream({ messageId: 77, mimeType: "audio/mpeg", offsetBytes: 65536, purpose: "playback" }, vi.fn());
    const worker = FakeWorker.instances[0];
    const playbackStream = posted(worker, "stream")[0];

    const focus = client.focusPlayback(77);
    const focusRequest = posted(worker, "playback_focus").at(-1)!;
    worker.succeed(focusRequest.requestId);
    await focus;

    expect(posted(worker, "cancel").some(request => request.targetRequestId === playbackStream.requestId)).toBe(false);
    worker.succeed(playbackStream.requestId, { messageId: 77, totalBytes: 200000, mimeType: "audio/mpeg" });
    await expect(stream.completed).resolves.toMatchObject({ messageId: 77 });
  });
});
