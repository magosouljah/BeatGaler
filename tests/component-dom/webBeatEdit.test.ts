import { describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import { commitWebBeatEdit, type WebBeatEditRuntime } from "../../src/features/edit/webBeatEdit";

function beat(overrides: Partial<Beat> = {}): Beat {
  return {
    id: "beat-1",
    name: "Before",
    folder_path: "",
    mp3_path: "",
    wav_path: null,
    playback_path: "",
    bpm: "120",
    key: "Cm",
    needs_resolution: false,
    tags: ["old"],
    rating: 2,
    image_base64: "data:image/png;base64,iVBORw==",
    image_preview_base64: "data:image/png;base64,iVBORw==",
    image_crop: null,
    has_wav: true,
    has_stems: true,
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
    cloud_status: "CLOUD_ONLY",
    telegram_file_id: "direct:10",
    telegram_message_id: 10,
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
      index: 0,
      size: file.size,
      filename: file.name,
    }],
    transport: "direct-web" as const,
  };
}

function manifest() {
  return {
    schema: "beatgaler.telegram.library",
    version: 2,
    custom_root: "keep",
    beats: [{
      id: "beat-1",
      sort_order: 3,
      name: "Before",
      bpm: "120",
      key: "Cm",
      tags: ["old"],
      rating: 2,
      color: "#111111",
      color2: "#222222",
      custom_entry: { keep: true },
      master: { telegram_file_id: "direct:10", telegram_message_id: 10, filename: "Before.mp3" },
      artwork: { telegram_file_id: "direct:11", telegram_message_id: 11, filename: "Before.png" },
      files: [
        { cloud_file_id: "WAV:old", type: "WAV", filename: "Before.wav", manifest: { telegram_message_id: 12 } },
        { cloud_file_id: "STEMS:old", type: "STEMS", filename: "Stems.zip", manifest: { telegram_message_id: 13 } },
      ],
      project: { manifest: { telegram_message_id: 14 }, size: 9, has_flp: true },
    }, { id: "beat-2", name: "Second", master: { telegram_message_id: 20 } }],
    trash: [{ id: "trashed" }],
    deleted: [{ beat_id: "gone" }],
  };
}

function runtime(upload = vi.fn()): WebBeatEditRuntime {
  return {
    getLibraryIndex: vi.fn(async () => ({ messageId: 500, manifest: manifest() })),
    upload,
    replaceLibraryIndex: vi.fn(async () => ({ messageId: 501, previousMessageId: 500, beatCount: 2 })),
  };
}

describe("Web Galer Cloud beat editing", () => {
  it("publishes metadata in one index transaction without re-uploading unchanged assets", async () => {
    const cloud = runtime();
    const updated = beat({ name: "After", bpm: "140", key: "F#m", tags: ["dark"], rating: 5 });

    const result = await commitWebBeatEdit(beat(), updated, {}, cloud);

    expect(cloud.upload).not.toHaveBeenCalled();
    expect(cloud.replaceLibraryIndex).toHaveBeenCalledOnce();
    const input: any = vi.mocked(cloud.replaceLibraryIndex).mock.calls[0][0];
    expect(input.expectedMessageId).toBe(500);
    expect(input.manifest.custom_root).toBe("keep");
    expect(input.manifest.trash).toEqual([{ id: "trashed" }]);
    expect(input.manifest.deleted).toEqual([{ beat_id: "gone" }]);
    expect(input.manifest.beats.map((row: any) => row.id)).toEqual(["beat-1", "beat-2"]);
    expect(input.manifest.beats[0]).toMatchObject({
      name: "After",
      bpm: "140",
      key: "F#m",
      tags: ["dark"],
      rating: 5,
      custom_entry: { keep: true },
      master: { telegram_message_id: 10 },
      artwork: { telegram_message_id: 11 },
    });
    expect(result.beat.name).toBe("After");
    expect(result.beat.image_base64).toBe(updated.image_base64);
  });

  it("replaces MASTER, WAV, PROJECT and artwork once before the single index commit", async () => {
    let messageId = 100;
    const upload = vi.fn(async (input: any, progress?: (value: any) => void) => {
      progress?.({ uploadedBytes: input.file.size, totalBytes: input.file.size });
      return uploaded(messageId++, input.file);
    });
    const cloud = runtime(upload);
    const master = new File(["new-master"], "After.mp3", { type: "audio/mpeg", lastModified: 1 });
    const wav = new File(["new-wav"], "After.wav", { type: "audio/wav", lastModified: 2 });
    const project = new File(["new-project"], "After.zip", { type: "application/zip", lastModified: 3 });
    const updated = beat({ name: "After", image_base64: "data:image/png;base64,AA==" });

    const result = await commitWebBeatEdit(beat(), updated, { MASTER: master, WAV: wav, PROJECT: project }, cloud);

    expect(upload.mock.calls.map(call => call[0].kind)).toEqual(["MASTER", "WAV", "PROJECT", "ARTWORK"]);
    expect(cloud.replaceLibraryIndex).toHaveBeenCalledOnce();
    const candidate: any = vi.mocked(cloud.replaceLibraryIndex).mock.calls[0][0].manifest;
    expect(candidate.beats[0]).toMatchObject({
      master: { telegram_message_id: 100, filename: "After.mp3" },
      artwork: { telegram_message_id: 103, filename: "After-artwork.png" },
      project: { manifest: { telegram_message_id: 102 }, size: project.size },
    });
    expect(candidate.beats[0].files.filter((file: any) => file.type === "WAV")).toHaveLength(1);
    expect(candidate.beats[0].files).toContainEqual(expect.objectContaining({ type: "STEMS" }));
    expect(candidate.beats[0].files).toContainEqual(expect.objectContaining({ type: "WAV", manifest: expect.objectContaining({ telegram_message_id: 101 }) }));
    expect(result.beat.telegram_message_id).toBe(100);
    expect(result.beat.has_wav).toBe(true);
    expect(result.beat.assets?.project).not.toBeNull();
  });

  it("removes artwork only in the index and leaves the other assets intact", async () => {
    const cloud = runtime();
    const result = await commitWebBeatEdit(beat(), beat({ image_base64: null, image_preview_base64: null }), {}, cloud);

    expect(cloud.upload).not.toHaveBeenCalled();
    const candidate: any = vi.mocked(cloud.replaceLibraryIndex).mock.calls[0][0].manifest;
    expect(candidate.beats[0].artwork).toBeNull();
    expect(candidate.beats[0].master.telegram_message_id).toBe(10);
    expect(result.beat.assets?.artwork).toBeNull();
  });
});
