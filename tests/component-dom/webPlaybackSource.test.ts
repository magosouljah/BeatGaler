import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeMediaSource.instances.length = 0;
});

describe("Web MASTER playback source", () => {
  it("feeds authorized chunks into MediaSource and revokes the temporary URL", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    const createObjectURL = vi.fn(() => "blob:cloud-master");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let emitChunk!: (chunk: ArrayBuffer, downloaded: number, total: number) => void;
    let finish!: (value: { messageId: number; totalBytes: number; mimeType: string }) => void;
    const cancel = vi.fn();
    const transport: WebPlaybackTransport = {
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
      { messageId: 91, mimeType: "audio/mpeg" },
      expect.any(Function),
    );

    const mediaSource = FakeMediaSource.instances[0];
    mediaSource.open();
    emitChunk(new Uint8Array([1, 2]).buffer, 2, 4);
    emitChunk(new Uint8Array([3, 4]).buffer, 4, 4);
    finish({ messageId: 91, totalBytes: 4, mimeType: "audio/mpeg" });
    await prepared.completed;

    expect(mediaSource.sourceBuffer.appended).toHaveLength(2);
    expect(mediaSource.sourceBuffer.mode).toBe("sequence");
    expect(mediaSource.endReason).toBe("complete");
    expect(createObjectURL).toHaveBeenCalledWith(mediaSource);

    manager.release("beat-1");
    expect(cancel).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cloud-master");
  });

  it("falls back to a complete MP3 Blob when MediaSource is unavailable", async () => {
    vi.stubGlobal("MediaSource", undefined);
    const createObjectURL = vi.fn(() => "blob:fallback-master");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const transport: WebPlaybackTransport = {
      streamFile: vi.fn(async (_input, onChunk) => {
        onChunk(new Uint8Array([1, 2, 3]).buffer, 3, 3);
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
