import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import { WebDownloadsManager } from "../../src/features/downloads/webDownloads";

function beat(): Beat {
  const ref = (id: number, filename: string, mime_type: string) => ({ object_id: `direct:${id}`, filename, mime_type, size_bytes: 3 });
  return {
    id: "beat-download",
    name: "Night:Drive",
    folder_path: "",
    mp3_path: "",
    wav_path: null,
    playback_path: "",
    bpm: "140",
    key: "C#m",
    needs_resolution: false,
    tags: ["dark", "trap"],
    rating: 4,
    image_base64: null,
    has_wav: true,
    has_stems: false,
    has_samples: false,
    samples_path: null,
    has_flp: false,
    has_als: false,
    stems_path: null,
    flp_path: null,
    als_path: null,
    other_files: [],
    color: "#111111",
    color2: "#222222",
    has_loop: false,
    loop_path: null,
    telegram_file_id: "direct:11",
    telegram_message_id: 11,
    assets: {
      master: ref(11, "source.mp3", "audio/mpeg"),
      wav: ref(12, "source.wav", "audio/wav"),
      artwork: ref(13, "cover.png", "image/png"),
      project: ref(14, "project.zip", "application/zip"),
      samples: null,
      stems: null,
      loop: null,
    },
  };
}

function immediateTransport() {
  return {
    streamFile: vi.fn(async (input: any, onChunk: any) => {
      const bytes = new Uint8Array([input.messageId, 2, 3]).buffer;
      const completed = Promise.resolve(onChunk(bytes, 3, 3)).then(() => ({
        messageId: input.messageId,
        totalBytes: 3,
        mimeType: input.mimeType,
      }));
      return { completed, cancel: vi.fn() };
    }),
  };
}

beforeEach(() => {
  delete (window as any).showSaveFilePicker;
  delete (window as any).showDirectoryPicker;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).showSaveFilePicker;
  delete (window as any).showDirectoryPicker;
});

describe("BeatGaler Web downloads", () => {
  it("rebuilds MP3 ID3 metadata + cover before streaming the clean Cloud MASTER", async () => {
    const writable = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => writable }));
    (window as any).showSaveFilePicker = showSaveFilePicker;
    const transport = immediateTransport();
    const progress = vi.fn();
    const manager = new WebDownloadsManager(transport);

    const task = manager.start(beat(), "MP3", progress);
    const result = await task.completed;

    expect(result).toEqual({ cancelled: false });
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: "Night_Drive [140 C#m].mp3" });
    expect(transport.streamFile.mock.calls.map(call => call[0].messageId)).toEqual([13, 11]);
    expect(writable.write).toHaveBeenCalledTimes(2);
    const id3 = new Uint8Array(writable.write.mock.calls[0][0] as ArrayBuffer);
    expect(Array.from(id3.slice(0, 3))).toEqual([0x49, 0x44, 0x33]);
    const frameText = String.fromCharCode(...id3);
    expect(frameText).toContain("TIT2");
    expect(frameText).toContain("TBPM");
    expect(frameText).toContain("TKEY");
    expect(frameText).toContain("TCON");
    expect(frameText).toContain("POPM");
    expect(frameText).toContain("APIC");
    expect(Array.from(id3.slice(-3))).toEqual([13, 2, 3]);
    expect(Array.from(new Uint8Array(writable.write.mock.calls[1][0] as ArrayBuffer))).toEqual([11, 2, 3]);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith({ currentKind: "MP3", downloadedBytes: 3, totalBytes: 3 });
  });

  it("creates one unique Everything folder, reuses artwork for APIC, and writes every slot once", async () => {
    const writes = new Map<string, ReturnType<typeof vi.fn>>();
    const directory = {
      getFileHandle: vi.fn(async (name: string) => ({
        createWritable: async () => {
          const write = vi.fn(async () => undefined);
          writes.set(name, write);
          return { write, close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
        },
      })),
    };
    const root = {
      getDirectoryHandle: vi.fn(async (_name: string, options?: { create?: boolean }) => {
        if (!options?.create) throw new DOMException("Missing", "NotFoundError");
        return directory;
      }),
    };
    (window as any).showDirectoryPicker = vi.fn(async () => root);
    const transport = immediateTransport();
    const manager = new WebDownloadsManager(transport);

    const result = await manager.start(beat(), "ALL").completed;

    expect(result.cancelled).toBe(false);
    expect(root.getDirectoryHandle).toHaveBeenCalledWith("Night_Drive", { create: true });
    expect(Array.from(writes.keys())).toEqual([
      "Night_Drive [140 C#m].mp3",
      "Night_Drive [140 C#m].wav",
      "Night_Drive-artwork.png",
      "Night_Drive.zip",
    ]);
    expect(transport.streamFile.mock.calls.map(call => call[0].messageId)).toEqual([13, 11, 12, 14]);
    expect(writes.get("Night_Drive [140 C#m].mp3")?.mock.calls).toHaveLength(2);
    expect(writes.get("Night_Drive [140 C#m].wav")?.mock.calls).toHaveLength(1);
    expect(writes.get("Night_Drive-artwork.png")?.mock.calls).toHaveLength(1);
    expect(writes.get("Night_Drive.zip")?.mock.calls).toHaveLength(1);
    expect(Array.from(new Uint8Array(writes.get("Night_Drive-artwork.png")!.mock.calls[0][0] as ArrayBuffer))).toEqual([13, 2, 3]);
  });

  it("cancels the active Cloud stream and aborts the partial native file", async () => {
    const writable = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    (window as any).showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => writable }));
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<any>((_resolve, reject) => { rejectCompleted = reject; });
    const cancel = vi.fn(() => rejectCompleted(new DOMException("Cancelled", "AbortError")));
    const transport = { streamFile: vi.fn(async () => ({ completed, cancel })) };
    const manager = new WebDownloadsManager(transport);
    const task = manager.start(beat(), "PROJECT");
    await vi.waitFor(() => expect(transport.streamFile).toHaveBeenCalledOnce());

    task.cancel();
    const result = await task.completed;

    expect(result).toEqual({ cancelled: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(writable.abort).toHaveBeenCalledOnce();
    expect(writable.close).not.toHaveBeenCalled();
  });
});
