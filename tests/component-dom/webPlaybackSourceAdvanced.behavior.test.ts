import { afterEach, describe, expect, it, vi } from "vitest";
import { WebPlaybackSourceManager, type WebPlaybackTransport } from "../../src/features/playback/webPlaybackSource";
import type {
  WebTransportPrefetchBatchResult,
  WebTransportPrefetchChunk,
  WebTransportPrefetchTerminal,
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

  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }

  addSourceBuffer() { return this.sourceBuffer as unknown as SourceBuffer; }
  endOfStream() { this.readyState = "ended"; }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }
}

function batchResult(messageId: number, bytes: number, totalBytes: number): WebTransportPrefetchBatchResult {
  return {
    results: [{
      ok: true,
      result: {
        messageId,
        totalBytes,
        mimeType: "audio/mpeg",
        prefix: new ArrayBuffer(bytes),
        playableSeconds: 0,
        targetMet: true,
      },
    }],
  };
}

function warmHarness() {
  let onChunk!: (progress: WebTransportPrefetchChunk) => void;
  let onTerminal!: (terminal: WebTransportPrefetchTerminal) => void;
  let finish!: (result: WebTransportPrefetchBatchResult) => void;
  const cancel = vi.fn();
  const cancelMessage = vi.fn();
  const promoteMessage = vi.fn(async () => {});
  const prefetchFiles = vi.fn(async (_inputs: any[], chunk?: typeof onChunk, terminal?: typeof onTerminal) => {
    onChunk = chunk!;
    onTerminal = terminal!;
    return {
      completed: new Promise<WebTransportPrefetchBatchResult>(resolve => { finish = resolve; }),
      cancel,
      cancelMessage,
      promoteMessage,
    };
  });
  return { prefetchFiles, cancel, cancelMessage, promoteMessage, emitChunk: (value: WebTransportPrefetchChunk) => onChunk(value), emitTerminal: (value: WebTransportPrefetchTerminal) => onTerminal(value), finish: (value: WebTransportPrefetchBatchResult) => finish(value) };
}

afterEach(() => {
  FakeMediaSource.instances.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WebPlaybackSourceManager advanced scheduling behavior", () => {
  it("adopts the same active warm transfer for Play and never starts a second offset-zero prefix", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:active-warm"), revokeObjectURL: vi.fn() });
    const warm = warmHarness();
    const focusPlayback = vi.fn(async () => {});
    const streamFile = vi.fn(async () => ({ completed: new Promise<never>(() => {}), cancel: vi.fn() }));
    const manager = new WebPlaybackSourceManager({
      prefetchFiles: warm.prefetchFiles,
      focusPlayback,
      streamFile,
    });

    const warming = manager.prefetch("beat-active", 77, "audio/mpeg", "visible");
    await vi.waitFor(() => expect(warm.prefetchFiles).toHaveBeenCalledOnce());
    expect(warm.prefetchFiles.mock.calls[0][0]).toEqual([{ messageId: 77, mimeType: "audio/mpeg", offsetBytes: 0 }]);

    let playSettled = false;
    const play = manager.prepare("beat-active", 77, "audio/mpeg", 1).then(value => {
      playSettled = true;
      return value;
    });
    await vi.waitFor(() => expect(warm.promoteMessage).toHaveBeenCalledWith(77));
    expect(playSettled).toBe(false);
    expect(warm.cancel).not.toHaveBeenCalled();
    expect(warm.cancelMessage).not.toHaveBeenCalled();

    warm.emitChunk({
      messageId: 77,
      totalBytes: 200000,
      mimeType: "audio/mpeg",
      offsetBytes: 0,
      chunk: new ArrayBuffer(65536),
      downloadedBytes: 65536,
      playableSeconds: 0,
      targetMet: true,
    });
    warm.emitTerminal({ messageId: 77, status: "READY" });
    warm.finish(batchResult(77, 65536, 200000));

    await expect(warming).resolves.toBeUndefined();
    const prepared = await play;
    expect(prepared.url).toBe("blob:active-warm");
    expect(warm.prefetchFiles).toHaveBeenCalledTimes(1);
    expect(streamFile).toHaveBeenCalledWith(
      { messageId: 77, mimeType: "audio/mpeg", offsetBytes: 65536, purpose: "playback" },
      expect.any(Function),
    );
    expect(focusPlayback).toHaveBeenCalledWith(77);
  });

  it("promotes a target queued only in SourceManager without waiting for the active warm batch", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:local-queued"), revokeObjectURL: vi.fn() });
    const warm = warmHarness();
    const focusPlayback = vi.fn(async () => {});
    const prefetchFile = vi.fn(async (input: { messageId: number; mimeType: string; offsetBytes?: number }) => ({
      messageId: input.messageId,
      totalBytes: 200000,
      mimeType: input.mimeType,
      prefix: new ArrayBuffer(65536),
      playableSeconds: 0,
      targetMet: true,
    }));
    const streamFile = vi.fn(async () => ({ completed: new Promise<never>(() => {}), cancel: vi.fn() }));
    const manager = new WebPlaybackSourceManager({
      prefetchFiles: warm.prefetchFiles,
      prefetchFile,
      focusPlayback,
      streamFile,
    });

    const activeWarm = manager.prefetch("beat-a", 101, "audio/mpeg", "visible");
    await vi.waitFor(() => expect(warm.prefetchFiles).toHaveBeenCalledOnce());
    expect(warm.prefetchFiles.mock.calls[0][0]).toEqual([{ messageId: 101, mimeType: "audio/mpeg", offsetBytes: 0 }]);

    const queuedWarm = manager.prefetch("beat-b", 102, "audio/mpeg", "visible");
    await Promise.resolve();
    expect(warm.prefetchFiles).toHaveBeenCalledTimes(1);

    const prepared = await manager.prepare("beat-b", 102, "audio/mpeg", 1);
    await expect(queuedWarm).resolves.toBeUndefined();
    expect(prepared.url).toBe("blob:local-queued");
    expect(prefetchFile).toHaveBeenCalledTimes(1);
    expect(prefetchFile).toHaveBeenCalledWith({ messageId: 102, mimeType: "audio/mpeg", offsetBytes: 0 });
    expect(warm.prefetchFiles).toHaveBeenCalledTimes(1);
    expect(focusPlayback).toHaveBeenCalledWith(102);
    expect(streamFile).toHaveBeenCalledWith(
      { messageId: 102, mimeType: "audio/mpeg", offsetBytes: 65536, purpose: "playback" },
      expect.any(Function),
    );

    warm.emitChunk({
      messageId: 101,
      totalBytes: 200000,
      mimeType: "audio/mpeg",
      offsetBytes: 0,
      chunk: new ArrayBuffer(65536),
      downloadedBytes: 65536,
      playableSeconds: 0,
      targetMet: true,
    });
    warm.emitTerminal({ messageId: 101, status: "READY" });
    warm.finish(batchResult(101, 65536, 200000));
    await expect(activeWarm).resolves.toBeUndefined();
  });

  it("uses a short EOF prefix as the complete file and performs no continuation", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:eof"), revokeObjectURL: vi.fn() });
    const warm = warmHarness();
    const streamFile = vi.fn(async () => { throw new Error("EOF must not continue"); });
    const manager = new WebPlaybackSourceManager({ prefetchFiles: warm.prefetchFiles, streamFile });

    const warming = manager.prefetch("beat-eof", 88);
    await vi.waitFor(() => expect(warm.prefetchFiles).toHaveBeenCalledOnce());
    warm.emitChunk({
      messageId: 88,
      totalBytes: 1000,
      mimeType: "audio/mpeg",
      offsetBytes: 0,
      chunk: new ArrayBuffer(1000),
      downloadedBytes: 1000,
      playableSeconds: 0,
      targetMet: true,
    });
    warm.emitTerminal({ messageId: 88, status: "READY" });
    warm.finish(batchResult(88, 1000, 1000));
    await warming;

    const prepared = await manager.prepare("beat-eof", 88);
    expect(prepared.url).toBe("blob:eof");
    expect(streamFile).not.toHaveBeenCalled();
  });

  it("continues an aligned 32 KiB prefix exactly at 32768 without repeating bytes", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:aligned"), revokeObjectURL: vi.fn() });
    const warm = warmHarness();
    const streamFile = vi.fn(async () => ({ completed: new Promise<never>(() => {}), cancel: vi.fn() }));
    const manager = new WebPlaybackSourceManager({ prefetchFiles: warm.prefetchFiles, streamFile });

    const warming = manager.prefetch("beat-aligned", 89);
    await vi.waitFor(() => expect(warm.prefetchFiles).toHaveBeenCalledOnce());
    warm.emitChunk({
      messageId: 89,
      totalBytes: 200000,
      mimeType: "audio/mpeg",
      offsetBytes: 0,
      chunk: new ArrayBuffer(32768),
      downloadedBytes: 32768,
      playableSeconds: 0,
      targetMet: true,
    });
    warm.emitTerminal({ messageId: 89, status: "READY" });
    warm.finish(batchResult(89, 32768, 200000));
    await warming;

    await manager.prepare("beat-aligned", 89);
    expect(streamFile).toHaveBeenCalledWith(
      { messageId: 89, mimeType: "audio/mpeg", offsetBytes: 32768, purpose: "playback" },
      expect.any(Function),
    );
  });

  it("requires a real contiguous 2.00 seconds ahead and evaluates the range containing currentTime after seek", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:threshold"), revokeObjectURL: vi.fn() });
    const markPlaybackStable = vi.fn(async () => {});
    const focusPlayback = vi.fn(async () => {});
    const manager = new WebPlaybackSourceManager({
      prefetchFiles: vi.fn(async () => { throw new Error("warm not expected"); }),
      focusPlayback,
      markPlaybackStable,
      streamFile: vi.fn(async () => ({ completed: new Promise<never>(() => {}), cancel: vi.fn() })),
    });

    await manager.prepare("beat-threshold", 90);
    const mediaSource = FakeMediaSource.instances[0];
    mediaSource.open();
    const source = mediaSource.sourceBuffer;
    source.ranges = [[0, 1.99], [5, 8]];

    manager.updatePlaybackState({ beatId: "beat-threshold", currentTime: 0, playing: true, waiting: false });
    expect(markPlaybackStable).not.toHaveBeenCalled();

    source.ranges = [[0, 2], [5, 8]];
    manager.updatePlaybackState({ beatId: "beat-threshold", currentTime: 0, playing: true, waiting: false });
    expect(markPlaybackStable).toHaveBeenCalledTimes(1);

    const secondStable = vi.fn(async () => {});
    const secondManager = new WebPlaybackSourceManager({
      prefetchFiles: vi.fn(async () => { throw new Error("warm not expected"); }),
      focusPlayback: vi.fn(async () => {}),
      markPlaybackStable: secondStable,
      streamFile: vi.fn(async () => ({ completed: new Promise<never>(() => {}), cancel: vi.fn() })),
    });
    await secondManager.prepare("beat-seek", 91);
    const secondMediaSource = FakeMediaSource.instances[1];
    secondMediaSource.open();
    const secondSource = secondMediaSource.sourceBuffer;
    secondSource.ranges = [[0, 1], [5, 8]];
    secondManager.updatePlaybackState({ beatId: "beat-seek", currentTime: 1.5, playing: true, waiting: false });
    expect(secondStable).not.toHaveBeenCalled();
    secondManager.updatePlaybackState({ beatId: "beat-seek", currentTime: 5.1, playing: true, waiting: false });
    expect(secondStable).toHaveBeenCalledTimes(1);
  });

  it("drops replay retention when a file exceeds the RAM budget but keeps feeding the active MSE stream", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:large"), revokeObjectURL: vi.fn() });
    let emit!: (chunk: ArrayBuffer, downloaded: number, total: number) => void | Promise<void>;
    let finish!: (value: { messageId: number; totalBytes: number; mimeType: string }) => void;
    const streamFile = vi.fn(async (_input, onChunk) => {
      emit = onChunk;
      return { completed: new Promise(resolve => { finish = resolve; }), cancel: vi.fn() };
    });
    const manager = new WebPlaybackSourceManager({
      prefetchFiles: vi.fn(async () => { throw new Error("warm not expected"); }),
      streamFile,
    });
    manager.setCacheLimitMb(1);

    const prepared = await manager.prepare("beat-large", 92);
    const mediaSource = FakeMediaSource.instances[0];
    mediaSource.open();
    await emit(new ArrayBuffer(700 * 1024), 700 * 1024, 1400 * 1024);
    await emit(new ArrayBuffer(700 * 1024), 1400 * 1024, 1400 * 1024);
    finish({ messageId: 92, totalBytes: 1400 * 1024, mimeType: "audio/mpeg" });
    await prepared.completed;

    expect(mediaSource.sourceBuffer.appended).toHaveLength(2);
    expect(manager.cacheStatus().used_bytes).toBeLessThanOrEqual(1024 * 1024);
    manager.release("beat-large");
    await manager.prepare("beat-large", 92);
    expect(streamFile).toHaveBeenCalledTimes(2);
  });
});
