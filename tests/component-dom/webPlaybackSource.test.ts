import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bufferAheadSeconds,
  WebPlaybackSourceManager,
  type WebPlaybackTransport,
} from "../../src/features/playback/webPlaybackSource";

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = "segments";
  appended: ArrayBuffer[] = [];

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

function unusedPrefetch(): WebPlaybackTransport["prefetchFile"] {
  return vi.fn(async () => {
    throw new Error("prefetch not expected in this test");
  });
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
      prefetchFile: unusedPrefetch(),
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
      { messageId: 91, mimeType: "audio/mpeg", offsetBytes: 0 },
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
    expect(createObjectURL).toHaveBeenCalledWith(mediaSource);

    manager.release("beat-1");
    expect(cancel).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    const replay = await manager.prepare("beat-1", 91);
    expect(replay.url).toBe("blob:session-cache-1");
    expect(transport.streamFile).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[1][0]).toBeInstanceOf(Blob);
    expect((createObjectURL.mock.calls[1][0] as Blob).size).toBe(4);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cloud-master");

    manager.release("beat-1");
    const replayAgain = await manager.prepare("beat-1", 91);
    expect(replayAgain.url).toBe("blob:session-cache-2");
    expect(transport.streamFile).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:session-cache-1");

    manager.clearCache();
    expect(cancel).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:session-cache-2");
  });

  it("submits the visible group together with a six-lane physical transfer limit", async () => {
    const batches: Array<{ ids: number[]; maxLanes: number | undefined }> = [];
    const transport: WebPlaybackTransport = {
      prefetchFile: unusedPrefetch(),
      async prefetchFiles(inputs, maxLanes) {
        batches.push({ ids: inputs.map(input => input.messageId), maxLanes });
        return inputs.map(input => ({
          input,
          result: {
            messageId: input.messageId,
            totalBytes: 65536,
            mimeType: input.mimeType || "audio/mpeg",
            prefix: new ArrayBuffer(65536),
          },
          playableSeconds: 1.05,
          targetMet: true,
          error: null,
        }));
      },
      streamFile: vi.fn(async () => { throw new Error("stream not expected"); }),
    };
    const manager = new WebPlaybackSourceManager(transport);
    const jobs = Array.from({ length: 8 }, (_, index) => {
      const messageId = index + 1;
      return manager.prefetch(`beat-${messageId}`, messageId);
    });

    await Promise.all(jobs);

    expect(batches).toHaveLength(1);
    expect(batches[0].ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(batches[0].maxLanes).toBe(6);
  });

  it("measures actual MSE buffer ahead from the range containing currentTime", () => {
    const sourceBuffer = {
      buffered: {
        length: 2,
        start: (index: number) => index === 0 ? 0 : 5,
        end: (index: number) => index === 0 ? 2.5 : 8,
      },
    } as unknown as SourceBuffer;

    expect(bufferAheadSeconds(sourceBuffer, 1)).toBe(1.5);
    expect(bufferAheadSeconds(sourceBuffer, 6.25)).toBe(1.75);
    expect(bufferAheadSeconds(sourceBuffer, 4)).toBe(0);
  });

  it("does not hot-loop a failed speculative prefetch", async () => {
    const prefetchFile = vi.fn(async () => {
      throw new Error("502 Bad Gateway");
    });
    const transport: WebPlaybackTransport = {
      prefetchFile,
      streamFile: vi.fn(async () => { throw new Error("stream not expected"); }),
    };
    const manager = new WebPlaybackSourceManager(transport);

    await expect(manager.prefetch("beat-fail", 404)).rejects.toThrow("502 Bad Gateway");
    await expect(manager.prefetch("beat-fail", 404)).resolves.toBeUndefined();
    expect(prefetchFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to a complete MP3 Blob when MediaSource is unavailable", async () => {
    vi.stubGlobal("MediaSource", undefined);
    const createObjectURL = vi.fn(() => "blob:fallback-master");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const transport: WebPlaybackTransport = {
      prefetchFile: unusedPrefetch(),
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
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect((createObjectURL.mock.calls[0][0] as Blob).size).toBe(3);
  });
});