import { describe, expect, it, vi } from "vitest";
import {
  GALER_T_LIBRARY_SCHEMA,
  beatFromWebLibraryEntry,
  loadWebLibrary,
  normalizeWebLibraryManifest,
  type WebLibraryTransport,
} from "../../src/features/library/webLibrary";

function manifestEntry() {
  return {
    id: "beat-1",
    sort_order: 0,
    name: "Night Drive",
    bpm: "142",
    key: "F# Minor",
    tags: ["dark", "trap"],
    rating: 4,
    color: "#112233",
    color2: "#445566",
    master: {
      telegram_file_id: "direct:101",
      telegram_message_id: 101,
      filename: "Night Drive.mp3",
    },
    artwork: {
      telegram_file_id: "direct:102",
      telegram_message_id: 102,
      filename: "cover.webp",
      mime: "image/webp",
    },
    files: [
      {
        cloud_file_id: "wav-slot",
        type: "WAV",
        filename: "Night Drive.wav",
        size: 5000,
        manifest: { parts: [{ telegram_file_id: "direct:103", telegram_message_id: 103, size: 5000 }] },
      },
      {
        cloud_file_id: "stems-slot",
        type: "STEMS",
        filename: "stems.zip",
        manifest: { parts: [{ telegram_message_id: 104 }] },
      },
      {
        cloud_file_id: "loop-slot",
        type: "LOOP",
        filename: "loop.mp3",
        manifest: { parts: [{ telegram_message_id: 105 }] },
      },
    ],
    project: {
      size: 9000,
      has_flp: true,
      has_samples: true,
      manifest: {
        filename: "PROJECT.zip",
        parts: [{ telegram_file_id: "direct:106", telegram_message_id: 106, size: 9000 }],
      },
    },
  };
}

describe("BeatGaler Web Galer T-Library", () => {
  it("normalizes compatible v1 indexes and rejects future schemas", () => {
    expect(normalizeWebLibraryManifest({ schema: GALER_T_LIBRARY_SCHEMA, version: 1, beats: [] }))
      .toMatchObject({ version: 2, beats: [], trash: [] });
    expect(() => normalizeWebLibraryManifest({ schema: GALER_T_LIBRARY_SCHEMA, version: 99, beats: [] }))
      .toThrow("newer BeatGaler");
  });

  it("maps metadata and Cloud slots without creating Desktop paths", () => {
    const beat = beatFromWebLibraryEntry(manifestEntry());

    expect(beat).toMatchObject({
      id: "beat-1",
      name: "Night Drive",
      bpm: "142",
      key: "F# Minor",
      tags: ["dark", "trap"],
      rating: 4,
      color: "#112233",
      color2: "#445566",
      folder_path: "",
      mp3_path: "",
      playback_path: "",
      wav_path: null,
      has_wav: true,
      has_stems: true,
      has_loop: true,
      has_flp: true,
      has_samples: true,
      telegram_file_id: "direct:101",
      telegram_message_id: 101,
      cloud_status: "CLOUD_ONLY",
    });
    expect(beat.assets).toMatchObject({
      master: { object_id: "direct:101", filename: "Night Drive.mp3" },
      artwork: { object_id: "direct:102", mime_type: "image/webp" },
      wav: { object_id: "direct:103", filename: "Night Drive.wav", size_bytes: 5000 },
      stems: { object_id: "direct:104" },
      loop: { object_id: "direct:105" },
      project: { object_id: "direct:106", filename: "PROJECT.zip", size_bytes: 9000 },
    });
  });

  it("hydrates artwork through direct authorized object references", async () => {
    const transport: WebLibraryTransport = {
      getLibraryIndex: vi.fn(async () => ({
        messageId: 500,
        manifest: { schema: GALER_T_LIBRARY_SCHEMA, version: 2, beats: [manifestEntry()], trash: [] },
      })),
      downloadFiles: vi.fn(async inputs => inputs.map(input => ({
        messageId: input.messageId,
        dataUrl: "data:image/webp;base64,Y292ZXI=",
      }))),
    };

    const beats = await loadWebLibrary(transport);

    expect(transport.downloadFiles).toHaveBeenCalledWith([{ messageId: 102, mimeType: "image/webp" }]);
    expect(beats).toHaveLength(1);
    expect(beats[0].image_base64).toBe("data:image/webp;base64,Y292ZXI=");
    expect(beats[0].image_preview_base64).toBe(beats[0].image_base64);
  });
});
