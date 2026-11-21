import { afterEach, describe, expect, it, vi } from "vitest";
import { WebPlaybackSourceManager, type WebPlaybackTransport } from "../../src/features/playback/webPlaybackSource";
import { webAdapter } from "../../src/platform/webAdapter";
import type { Beat } from "../../src/types";

const coordinator = vi.hoisted(() => ({
  getPlaybackSources: vi.fn(),
  moveBeatsToTrash: vi.fn<(ids: string[], clientId: string) => Promise<string[]>>(),
}));

vi.mock("../../src/features/playback/webStartupPlaybackCoordinator", () => ({
  getWebStartupPlaybackCoordinator: () => ({
    start: async () => {},
    getTransport: () => ({ moveBeatsToTrash: coordinator.moveBeatsToTrash }),
    getPlaybackSources: coordinator.getPlaybackSources,
  }),
  disconnectWebStartupPlaybackCoordinator: async () => {},
}));

it("forgets a deleted beat by cancelling its warm member and removing its job", async () => {
  let finish!: (value: any) => void;
  const cancelMessage = vi.fn();
  const prefetchFiles = vi.fn(async () => ({
    completed: new Promise(resolve => { finish = resolve; }),
    cancelMessage,
    cancel: vi.fn(),
  }));
  const manager = new WebPlaybackSourceManager({
    prefetchFiles,
    streamFile: vi.fn(async () => { throw new Error("stream not expected"); }),
  });

  const warming = manager.prefetch("deleted-beat", 88);
  await vi.waitFor(() => expect(prefetchFiles).toHaveBeenCalledOnce());
  manager.forget("deleted-beat");

  await expect(warming).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelMessage).toHaveBeenCalledWith(88);

  finish({ results: [{ ok: false, messageId: 88, error: "Cancelled.", code: "CANCELLED" }] });
  const next = manager.prefetch("deleted-beat", 89);
  await vi.waitFor(() => expect(prefetchFiles).toHaveBeenCalledTimes(2));
  manager.forget("deleted-beat");
  await expect(next).rejects.toMatchObject({ name: "AbortError" });
});

describe("Web adapter trash playback cache", () => {
  afterEach(async () => {
    try {
      await webAdapter.cloudData.disconnect();
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      localStorage.clear();
    }
  });

  it("evicts cached audio only for beats confirmed moved to trash", async () => {
    const bytes = 4;
    const prefetchFiles: WebPlaybackTransport["prefetchFiles"] = async (inputs, onChunk) => {
      for (const { messageId } of inputs) {
        onChunk?.({
          messageId,
          mimeType: "audio/mpeg",
          chunk: new ArrayBuffer(bytes),
          offsetBytes: 0,
          downloadedBytes: bytes,
          totalBytes: bytes,
          playableSeconds: 0,
          targetMet: false,
        });
      }
      return { completed: Promise.resolve({ results: [] }), cancelMessage: vi.fn(), cancel: vi.fn() };
    };
    coordinator.getPlaybackSources.mockReturnValue(new WebPlaybackSourceManager({
      prefetchFiles,
      streamFile: async () => { throw new Error("Expected complete audio from prefetch"); },
    }));

    let urlSequence = 0;
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("MediaSource", undefined);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = () => `blob:c03e-${++urlSequence}`;
      static revokeObjectURL = revokeObjectURL;
    });

    const moved = { id: "moved", telegram_message_id: 101, playback_path: "" } as Beat;
    const retained = { id: "retained", telegram_message_id: 102, playback_path: "" } as Beat;
    const movedAudio = await webAdapter.media.preparePlayback(moved);
    const retainedAudio = await webAdapter.media.preparePlayback(retained);
    await Promise.all([movedAudio.completed, retainedAudio.completed]);

    webAdapter.media.releasePlayback(moved.id);
    expect(await webAdapter.playbackCache.status()).toMatchObject({ used_bytes: 2 * bytes });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    coordinator.moveBeatsToTrash.mockResolvedValue([moved.id]);
    const requestedIds = [moved.id, retained.id];
    await expect(webAdapter.trash.moveBeats(requestedIds)).resolves.toEqual([moved.id]);
    expect(coordinator.moveBeatsToTrash).toHaveBeenCalledWith(requestedIds, webAdapter.clientId);

    expect(await webAdapter.playbackCache.status()).toMatchObject({ used_bytes: bytes });
    expect(revokeObjectURL.mock.calls).toEqual([[movedAudio.url]]);
  });
});
