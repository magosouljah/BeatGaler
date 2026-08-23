import { describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import { commitWebImportedBeat, type WebImportCommitRuntime } from "../../src/features/import/webImportCommit";

function beat(overrides: Partial<Beat> = {}): Beat {
  return {
    id: "web-import-1",
    name: "Midnight",
    folder_path: "web-file://web-import-1",
    mp3_path: "Midnight.mp3",
    wav_path: null,
    playback_path: "blob:preview",
    bpm: "140",
    key: "C#m",
    needs_resolution: false,
    tags: ["dark"],
    rating: 4,
    image_base64: "data:image/png;base64,iVBORw==",
    has_wav: false,
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
    cloud_status: "PENDING_UPLOAD",
    ...overrides,
  };
}

function uploaded(messageId: number, file: File) {
  return {
    telegram_file_id: `direct:${messageId}`,
    telegram_message_id: messageId,
    filename: file.name,
    original_size: file.size,
    parts: [{
      telegram_file_id: `direct:${messageId}`,
      telegram_message_id: messageId,
      index: 0 as const,
      size: file.size,
      filename: file.name,
    }] as [any],
    transport: "direct-web" as const,
  };
}

describe("Review Beat Web durable commit", () => {
  it("uploads each available slot once and publishes one merged authoritative index", async () => {
    const source = new File(["audio"], "Midnight.mp3", { type: "audio/mpeg", lastModified: 7 });
    const wav = new File(["hq-audio"], "Midnight.wav", { type: "audio/wav", lastModified: 8 });
    const project = new File(["project"], "Midnight-project.zip", { type: "application/zip", lastModified: 9 });
    let nextMessageId = 100;
    const upload = vi.fn(async (input: any, onProgress?: (value: any) => void) => {
      onProgress?.({ uploadedBytes: input.file.size, totalBytes: input.file.size });
      return uploaded(nextMessageId++, input.file);
    });
    const replaceLibraryIndex = vi.fn(async () => ({ messageId: 900, previousMessageId: 500, beatCount: 2 }));
    const runtime: WebImportCommitRuntime = {
      getLibraryIndex: vi.fn(async () => ({
        messageId: 500,
        manifest: {
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [{ id: "existing", name: "Existing", master: { telegram_file_id: "direct:10", telegram_message_id: 10 } }],
          trash: [{ trash_id: "trash-1", beat: { id: "trashed" } }],
          deleted: [{ beat_id: "gone", deleted_at: 1 }],
        },
      })),
      upload,
      replaceLibraryIndex,
    };
    const progress = vi.fn();

    const result = await commitWebImportedBeat(beat(), { master: source, wav, project }, runtime, progress);

    expect(upload).toHaveBeenCalledTimes(4);
    expect(upload.mock.calls.map(call => call[0].kind)).toEqual(["MASTER", "WAV", "PROJECT", "ARTWORK"]);
    expect(replaceLibraryIndex).toHaveBeenCalledOnce();
    const candidate: any = replaceLibraryIndex.mock.calls[0][0].manifest;
    expect(candidate.beats.map((row: any) => row.id)).toEqual(["web-import-1", "existing"]);
    expect(candidate.trash).toHaveLength(1);
    expect(candidate.deleted).toEqual([{ beat_id: "gone", deleted_at: 1 }]);
    expect(candidate.beats[0]).toMatchObject({
      name: "Midnight",
      bpm: "140",
      key: "C#m",
      tags: ["dark"],
      master: { telegram_file_id: "direct:100", telegram_message_id: 100 },
      artwork: { telegram_file_id: "direct:103", telegram_message_id: 103, mime: "image/png" },
      files: [{ type: "WAV", manifest: { telegram_message_id: 101 } }],
      project: { manifest: { telegram_message_id: 102 }, size: project.size },
    });
    expect(result.beat).toMatchObject({
      id: "web-import-1",
      telegram_file_id: "direct:100",
      telegram_message_id: 100,
      cloud_status: "CLOUD_ONLY",
      image_base64: "data:image/png;base64,iVBORw==",
    });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "library" }));
  });

  it("treats an already committed beat ID as an idempotent retry", async () => {
    const source = new File(["audio"], "Midnight.mp3", { type: "audio/mpeg" });
    const upload = vi.fn();
    const replaceLibraryIndex = vi.fn();
    const runtime: WebImportCommitRuntime = {
      getLibraryIndex: vi.fn(async () => ({
        messageId: 501,
        manifest: {
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [{
            id: "web-import-1",
            name: "Midnight",
            master: { telegram_file_id: "direct:222", telegram_message_id: 222, filename: "Midnight.mp3" },
            files: [],
          }],
          trash: [],
        },
      })),
      upload,
      replaceLibraryIndex,
    };

    const result = await commitWebImportedBeat(beat(), { master: source }, runtime);

    expect(upload).not.toHaveBeenCalled();
    expect(replaceLibraryIndex).not.toHaveBeenCalled();
    expect(result.index).toBeNull();
    expect(result.beat.telegram_message_id).toBe(222);
  });
});
