import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebPlaybackSourceManager,
  type WebPlaybackTransport,
} from "../../src/features/playback/webPlaybackSource";
import type {
  WebTransportPrefetchBatchResult,
  WebTransportPrefetchChunk,
} from "../../src/features/cloud/webTransportWorkerProtocol";

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = "segments";
  appended: ArrayBuffer[] = [];
  ranges: Array<[number, number]> = [];

  get buffered() {
    const ranges = this.ranges;
    return {
      length: ranges.length,
      start(index: number) { return ranges[index][0]; },
      end(index: number) { return ranges[index][1]; },
    } as TimeRanges;
  }

  appendBuffer(chunk: ArrayBuffer) {
    this.updating = true;
    this.appended.push(chunk);
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }

  abort() { this.updating = false; }
}

class FakeMediaSource extends EventTarget {
  static instances: FakeMediaSource[] = [];
  static isTypeSupported = vi.fn(() => true);
  readyState: "closed" | "open" | "ended" = "closed";
  sourceBuffer = new FakeSourceBuffer();
  endReason: string | null = null;

  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }

  addSourceBuffer() { return this.sourceBuffer as unknown as SourceBuffer; }
  endOfStream(reason?: string) {
    this.endReason = reason || "complete";
    this.readyState = "ended";
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }
}

function unusedPrefetchFiles(): WebPlaybackTransport["prefetchFiles"] {
  return vi.fn(async () => {
    throw new Error("prefetch not expected in this test");
  });
}

function successfulBatch(inputs: readonly { messageId: number }[]): WebTransportPrefetchBatchResult {
  return {
    results: inputs.map(input => ({
      ok: true as const,
      result: {
        messageId: input.messageId,
        totalBytes: 65536,
        mimeType: "audio/mpeg",
        prefix: new ArrayBuffer(65536),
        playableSeconds: 0,
        targetMet: false,
      },
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeMediaSource.instances.length = 0;
});

describe("Web MASTER playback source", () => {
  it("replays completed MSE audio from retained bytes with a fresh Blob URL", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    let sessionUrl = 0;
    const createObjectURL = vi.fn((value: unknown) => value instanceof Blob
      ? `blob:session-cache-${++sessionUrl}`
      : "blob:cloud-master");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let emitChunk!: (chunk: ArrayBuffer, downloaded: number, total: number) => void | Promise<void>;
    let finish!: (value: { messageId: number; totalBytes: number; mimeType: string }) => void;
    const cancel = vi.fn();
    const transport: WebPlaybackTransport = {
      prefetchFiles: unusedPrefetchFiles(),
      streamFile: vi.fn(async (_input, onChunk) => {
        emitChunk = onChunk;
        return {
          completed: new Promise(resolve => { finish = resolve; }),
          cancel,
        };
      }),
    };
    const manager = new WebPlaybackSourceManager(transport);

    const prepared = await manager.prepare("beat-1", 91);
    expect(prepared.url).toBe("blob:cloud-master");
    expect(transport.streamFile).toHaveBeenCalledWith(
      { messageId: 91, mimeType: "audio/mpeg", offsetBytes: 0, purpose: "playback" },
      expect.any(Function),
    );

    const mediaSource = FakeMediaSource.instances[0];
    mediaSource.open();
    await emitChunk(new Uint8Array([1, 2]).buffer, 2, 4);
    await emitChunk(new Uint8Array([3, 4]).buffer, 4, 4);
    finish({ messageId: 91, totalBytes: 4, mimeType: "audio/mpeg" });
    await prepared.completed;

    expect(mediaSource.sourceBuffer.appended).toHaveLength(2);
    expect(mediaSource.sourceBuffer.mode).toBe("sequence");
    expect(mediaSource.endReason).toBe("complete");

    manager.release("beat-1");
    expect(cancel).not.toHaveBeenCalled();

    const replay = await manager.prepare("beat-1", 91);
    expect(replay.url).toBe("blob:session-cache-1");
    expect(transport.streamFile).toHaveBeenCalledTimes(1);
    expect((createObjectURL.mock.calls[1][0] as Blob).size).toBe(4);

    manager.clearCache();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("coalesces all currently visible warm candidates into one batch", async () => {
    const cancel = vi.fn();
    const cancelMessage = vi.fn();
    const prefetchFiles = vi.fn(async (inputs: any[], onChunk?: (progress: WebTransportPrefetchChunk) => void) => {
      for (const input of inputs) {
        onChunk?.({
          messageId: input.messageId,
          totalBytes: 65536,
          mimeType: "audio/mpeg",
          offsetBytes: 0,
          chunk: new ArrayBuffer(65536),
          downloadedBytes: 65536,
          playableSeconds: 0,
          targetMet: false,
        });
      }
      return {
        completed: Promise.resolve(successfulBatch(inputs)),
        cancelMessage,
        cancel,
      };
    });
    const transport: WebPlaybackTransport = {
      prefetchFiles,
      streamFile: vi.fn(async () => { throw new Error("stream not expected"); }),
    };
    const manager = new WebPlaybackSourceManager(transport);
    const jobs = Array.from({ length: 14 }, (_, index) => manager.prefetch(`beat-${index + 1}`, index + 1));

    await Promise.all(jobs);

    expect(prefetchFiles).toHaveBeenCalledTimes(1);
    expect(prefetchFiles.mock.calls[0][0]).toHaveLength(14);
    expect(prefetchFiles.mock.calls[0][0].every((input: any) => input.offsetBytes === 0)).toBe(true);
  });

  it("treats FAR as advisory and never turns an existing warm into a terminal cancellation", async () => {
    let finishBatch!: (value: WebTransportPrefetchBatchResult) => void;
    const cancel = vi.fn();
    const cancelMessage = vi.fn();
    const prefetchFiles = vi.fn(async (inputs: any[]) => ({
      completed: new Promise<WebTransportPrefetchBatchResult>(resolve => { finishBatch = resolve; }),
      cancelMessage,
      cancel,
    }));
    const manager = new WebPlaybackSourceManager({
      prefetchFiles,
      streamFile: vi.fn(async () => { throw new Error("stream not expected"); }),
    });

    let settled = false;
    const warm = manager.prefetch("beat-far", 41, "audio/mpeg", "visible").then(() => { settled = true; });
    await vi.waitFor(() => expect(prefetchFiles).toHaveBeenCalledOnce());

    manager.setPrefetchPriority("beat-far", 41, "audio/mpeg", "far");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(cancelMessage).not.toHaveBeenCalled();

    finishBatch(successfulBatch([{ messageId: 41 }]));
    await warm;
    expect(settled).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(cancelMessage).not.toHaveBeenCalled();
  });

  it("adopts any aligned partial prefix for Play and resumes at its exact byte length", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:cloud-master"), revokeObjectURL: vi.fn() });
    let reportChunk!: (progress: WebTransportPrefetchChunk) => void;
    let completeBatch!: (value: WebTransportPrefetchBatchResult) => void;
    const cancelMessage = vi.fn();
    const prefetchFiles = vi.fn(async (_inputs: any[], onChunk?: (progress: WebTransportPrefetchChunk) => void) => {
      reportChunk = onChunk!;
      return {
        completed: new Promise<WebTransportPrefetchBatchResult>(resolve => { completeBatch = resolve; }),
        cancelMessage,
        cancel: vi.fn(),
      };
    });
    const streamFile = vi.fn(async () => ({
      completed: new Promise<never>(() => {}),
      cancel: vi.fn(),
    }));
    const manager = new WebPlaybackSourceManager({ prefetchFiles, streamFile });
    const warm = manager.prefetch("beat-partial", 77);
    await vi.waitFor(() => expect(prefetchFiles).toHaveBeenCalledOnce());

    reportChunk({
      messageId: 77,
      totalBytes: 500000,
      mimeType: "audio/mpeg",
      offsetBytes: 0,
      chunk: new ArrayBuffer(65536),
      downloadedBytes: 65536,
      playableSeconds: 0,
      targetMet: false,
    });

    const prepared = await manager.prepare("beat-partial", 77);
    await warm;
    expect(prepared.url).toBe("blob:cloud-master");
    expect(cancelMessage).not.toHaveBeenCalled();
    expect(streamFile).toHaveBeenCalledWith(
      { messageId: 77, mimeType: "audio/mpeg", offsetBytes: 65536, purpose: "playback" },
      expect.any(Function),
    );

    completeBatch(successfulBatch([{ messageId: 77 }]));
  });

  it("promotes a target queued only in SourceManager without waiting for the unrelated active batch", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:promoted"), revokeObjectURL: vi.fn() });
    let finishBatch!: (value: WebTransportPrefetchBatchResult) => void;
    const prefetchFiles = vi.fn(async (inputs: any[]) => ({
      completed: new Promise<WebTransportPrefetchBatchResult>(resolve => { finishBatch = resolve; }),
      cancelMessage: vi.fn(),
      cancel: vi.fn(),
      promoteMessage: vi.fn(async () => {}),
    }));
    const prefetchFile = vi.fn(async ({ messageId, mimeType, offsetBytes }: any) => ({
      messageId,
      totalBytes: 200000,
      mimeType: mimeType || "audio/mpeg",
      prefix: new ArrayBuffer(65536),
      playableSeconds: 0,
      targetMet: false,
      offsetBytes,
    }));
    const focusPlayback = vi.fn(async () => {});
    const streamFile = vi.fn(async () => ({ completed: new Promise<never>(() => {}), cancel: vi.fn() }));
    const manager = new WebPlaybackSourceManager({ prefetchFiles, prefetchFile, focusPlayback, streamFile });

    const warmA = manager.prefetch("beat-a", 1);
    await vi.waitFor(() => expect(prefetchFiles).toHaveBeenCalledOnce());
    const warmB = manager.prefetch("beat-b", 2);

    const prepared = await manager.prepare("beat-b", 2, "audio/mpeg", 1);
    expect(prepared.url).toBe("blob:promoted");
    await expect(warmB).resolves.toBeUndefined();
    expect(focusPlayback).toHaveBeenCalledWith(2);
    expect(prefetchFile).toHaveBeenCalledWith({ messageId: 2, mimeType: "audio/mpeg", offsetBytes: 0 });

    finishBatch(successfulBatch([{ messageId: 1 }]));
    await warmA;
  });

  it("keeps waiting critical even with >=2s buffered and a completed stream, then stabilizes after waiting clears", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:waiting"), revokeObjectURL: vi.fn() });
    let emitChunk!: (chunk: ArrayBuffer, downloaded: number, total: number) => void | Promise<void>;
    let finish!: (value: { messageId: number; totalBytes: number; mimeType: string }) => void;
    const focusPlayback = vi.fn(async () => {});
    const markPlaybackStable = vi.fn(async () => {});
    const releasePlaybackFocus = vi.fn(async () => {});
    const manager = new WebPlaybackSourceManager({
      prefetchFiles: unusedPrefetchFiles(),
      focusPlayback,
      markPlaybackStable,
      releasePlaybackFocus,
      streamFile: vi.fn(async (_input, onChunk) => {
        emitChunk = onChunk;
        return { completed: new Promise(resolve => { finish = resolve; }), cancel: vi.fn() };
      }),
    });

    const prepared = await manager.prepare("beat-wait", 51, "audio/mpeg", 1);
    expect(focusPlayback).toHaveBeenCalledTimes(1);
    const mediaSource = FakeMediaSource.instances[0];
    mediaSource.sourceBuffer.ranges = [[0, 5]];
    manager.updatePlaybackState({ beatId: "beat-wait", currentTime: 0, playing: false, waiting: true });
    expect(focusPlayback).toHaveBeenCalledTimes(2);
    mediaSource.open();
    await emitChunk(new ArrayBuffer(8), 8, 8);
    finish({ messageId: 51, totalBytes: 8, mimeType: "audio/mpeg" });
    await prepared.completed;

    expect(markPlaybackStable).not.toHaveBeenCalled();
    expect(focusPlayback).toHaveBeenCalledWith(51);

    manager.updatePlaybackState({ beatId: "beat-wait", currentTime: 0, playing: true, waiting: false });
    expect(markPlaybackStable).toHaveBeenCalledWith(51);
    expect(markPlaybackStable).toHaveBeenCalledTimes(1);

    manager.updatePlaybackState({ beatId: "beat-wait", currentTime: 0, playing: false, waiting: false });
    expect(releasePlaybackFocus).toHaveBeenCalledWith(51);
    expect(markPlaybackStable).toHaveBeenCalledTimes(1);

    manager.updatePlaybackState({ beatId: "beat-wait", currentTime: 0, playing: true, waiting: false });
    expect(focusPlayback).toHaveBeenCalledTimes(3);
    expect(focusPlayback).toHaveBeenLastCalledWith(51);
    expect(markPlaybackStable).toHaveBeenCalledTimes(2);
    expect(markPlaybackStable).toHaveBeenLastCalledWith(51);
  });

  it("stops retaining replay bytes at a zero cache budget without interrupting the active MSE stream", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:bounded"), revokeObjectURL: vi.fn() });
    const emitters: Array<(chunk: ArrayBuffer, downloaded: number, total: number) => void | Promise<void>> = [];
    const finishers: Array<(value: { messageId: number; totalBytes: number; mimeType: string }) => void> = [];
    const streamFile = vi.fn(async (_input, onChunk) => ({
      completed: new Promise(resolve => { emitters.push(onChunk); finishers.push(resolve); }),
      cancel: vi.fn(),
    }));
    const manager = new WebPlaybackSourceManager({ prefetchFiles: unusedPrefetchFiles(), streamFile });
    manager.setCacheLimitMb(0);

    const first = await manager.prepare("beat-big", 71);
    FakeMediaSource.instances[0].open();
    await emitters[0](new ArrayBuffer(16), 16, 16);
    finishers[0]({ messageId: 71, totalBytes: 16, mimeType: "audio/mpeg" });
    await first.completed;
    expect(manager.cacheStatus().used_bytes).toBe(0);

    manager.release("beat-big");
    await manager.prepare("beat-big", 71);
    expect(streamFile).toHaveBeenCalledTimes(2);
  });

  it("cools down the whole batch when transport admission fails", async () => {
    const prefetchFiles = vi.fn(async () => {
      throw new Error("502 Bad Gateway");
    });
    const manager = new WebPlaybackSourceManager({
      prefetchFiles,
      streamFile: vi.fn(async () => { throw new Error("stream not expected"); }),
    });

    const first = Promise.all([
      manager.prefetch("beat-fail-1", 401),
      manager.prefetch("beat-fail-2", 402),
    ]);
    await expect(first).rejects.toThrow("502 Bad Gateway");
    await expect(manager.prefetch("beat-fail-1", 401)).resolves.toBeUndefined();
    await expect(manager.prefetch("beat-fail-2", 402)).resolves.toBeUndefined();
    expect(prefetchFiles).toHaveBeenCalledTimes(1);
  });

  it("falls back to a complete MP3 Blob when MediaSource is unavailable", async () => {
    vi.stubGlobal("MediaSource", undefined);
    const createObjectURL = vi.fn(() => "blob:fallback-master");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const transport: WebPlaybackTransport = {
      prefetchFiles: unusedPrefetchFiles(),
      streamFile: vi.fn(async (_input, onChunk) => {
        await onChunk(new Uint8Array([1, 2, 3]).buffer, 3, 3);
        return {
          completed: Promise.resolve({ messageId: 92, totalBytes: 3, mimeType: "audio/mpeg" }),
          cancel: vi.fn(),
        };
      }),
    };

    const prepared = await new WebPlaybackSourceManager(transport).prepare("beat-2", 92);

    expect(prepared.url).toBe("blob:fallback-master");
    expect((createObjectURL.mock.calls[0][0] as Blob).size).toBe(3);
  });
});
