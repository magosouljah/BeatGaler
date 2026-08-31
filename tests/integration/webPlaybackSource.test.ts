import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEB_PLAYBACK_BLOB_FALLBACK_MAX_BYTES,
  WebPlaybackSourceManager,
  type WebPlaybackTransport,
} from "../../src/features/playback/webPlaybackSource";

const originalMediaSource = globalThis.MediaSource;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMediaSource) globalThis.MediaSource = originalMediaSource;
  else delete (globalThis as { MediaSource?: typeof MediaSource }).MediaSource;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("WebPlaybackSourceManager blob fallback", () => {
  it("keeps the non-streaming fallback bounded and cancels oversized media", async () => {
    delete (globalThis as { MediaSource?: typeof MediaSource }).MediaSource;
    let cancelled = false;
    const transport: WebPlaybackTransport = {
      async streamFile(_input, onChunk) {
        let rejectCompleted!: (error: unknown) => void;
        const completed = new Promise<never>((_resolve, reject) => { rejectCompleted = reject; });
        queueMicrotask(async () => {
          try {
            await onChunk(new ArrayBuffer(1024), 1024, WEB_PLAYBACK_BLOB_FALLBACK_MAX_BYTES + 1);
          } catch (error) {
            rejectCompleted(error);
          }
        });
        return {
          completed,
          cancel() { cancelled = true; },
        };
      },
    };

    const manager = new WebPlaybackSourceManager(transport);
    await expect(manager.prepare("giant", 1)).rejects.toThrow("too large for safe fallback playback");
    expect(cancelled).toBe(true);
  });

  it("creates and revokes a blob URL for a small fallback file", async () => {
    delete (globalThis as { MediaSource?: typeof MediaSource }).MediaSource;
    const createObjectURL = vi.fn(() => "blob:small");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const transport: WebPlaybackTransport = {
      async streamFile(_input, onChunk) {
        const completed = (async () => {
          await onChunk(new Uint8Array([1, 2, 3]).buffer, 3, 3);
          return { bytes: 3, mimeType: "audio/mpeg" } as never;
        })();
        return { completed, cancel() {} };
      },
    };

    const manager = new WebPlaybackSourceManager(transport);
    const prepared = await manager.prepare("small", 2);
    expect(prepared.url).toBe("blob:small");
    expect(createObjectURL).toHaveBeenCalledOnce();

    manager.release("small");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:small");
  });
});
