import { describe, expect, it, vi } from "vitest";
import {
  GALER_T_LIBRARY_SCHEMA,
  WEB_LIBRARY_FIRST_PAGE_SIZE,
  beatFromWebLibraryEntry,
  classifyWebLibraryLoadError,
  classifyWebLibraryResult,
  loadWebLibrary,
  loadWebLibraryPage,
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
    master: { telegram_file_id: "direct:101", telegram_message_id: 101, filename: "Night Drive.mp3" },
    artwork: { telegram_file_id: "direct:102", telegram_message_id: 102, filename: "cover.webp", mime: "image/webp" },
    files: [
      { cloud_file_id: "wav-slot", type: "WAV", filename: "Night Drive.wav", size: 5000, manifest: { parts: [{ telegram_file_id: "direct:103", telegram_message_id: 103, size: 5000 }] } },
      { cloud_file_id: "stems-slot", type: "STEMS", filename: "stems.zip", manifest: { parts: [{ telegram_message_id: 104 }] } },
      { cloud_file_id: "loop-slot", type: "LOOP", filename: "loop.mp3", manifest: { parts: [{ telegram_message_id: 105 }] } },
    ],
    project: { size: 9000, has_flp: true, has_samples: true, manifest: { filename: "PROJECT.zip", parts: [{ telegram_file_id: "direct:106", telegram_message_id: 106, size: 9000 }] } },
  };
}

describe("BeatGaler Web Galer T-Library", () => {
  it("normalizes compatible v1 indexes and rejects future schemas", () => {
    expect(normalizeWebLibraryManifest({ schema: GALER_T_LIBRARY_SCHEMA, version: 1, beats: [] })).toMatchObject({ version: 2, beats: [], trash: [] });
    expect(() => normalizeWebLibraryManifest({ schema: GALER_T_LIBRARY_SCHEMA, version: 99, beats: [] })).toThrow("newer BeatGaler");
  });

  it("maps metadata and Cloud slots without creating Desktop paths", () => {
    const beat = beatFromWebLibraryEntry(manifestEntry());
    expect(beat).toMatchObject({ id: "beat-1", name: "Night Drive", bpm: "142", key: "F# Minor", tags: ["dark", "trap"], rating: 4, color: "#112233", color2: "#445566", folder_path: "", mp3_path: "", playback_path: "", wav_path: null, has_wav: true, has_stems: true, has_loop: true, has_flp: true, has_samples: true, telegram_file_id: "direct:101", telegram_message_id: 101, cloud_status: "CLOUD_ONLY" });
    expect(beat.assets).toMatchObject({ master: { object_id: "direct:101", filename: "Night Drive.mp3" }, artwork: { object_id: "direct:102", mime_type: "image/webp" }, wav: { object_id: "direct:103", filename: "Night Drive.wav", size_bytes: 5000 }, stems: { object_id: "direct:104" }, loop: { object_id: "direct:105" }, project: { object_id: "direct:106", filename: "PROJECT.zip", size_bytes: 9000 } });
  });

  it("keeps artwork lazy during startup and emits reproducible metadata timing", async () => {
    const transport: WebLibraryTransport = {
      getLibraryIndex: vi.fn(async () => ({ messageId: 500, manifest: { schema: GALER_T_LIBRARY_SCHEMA, version: 2, beats: [manifestEntry()], trash: [] } })),
      downloadFiles: vi.fn(async () => []),
    };
    const observations: unknown[] = [];
    const ticks = [100, 125];
    const beats = await loadWebLibrary(transport, { now: () => ticks.shift() ?? 125, onObservation: observation => observations.push(observation) });
    expect(transport.downloadFiles).not.toHaveBeenCalled();
    expect(beats).toHaveLength(1);
    expect(beats[0].image_base64).toBeNull();
    expect(beats[0].assets?.artwork).toMatchObject({ object_id: "direct:102" });
    expect(observations).toEqual([{ state: "ready", durationMs: 25, beatCount: 1 }]);
  });

  it("keeps 10k+ first-load and subsequent pages bounded independently of total library size", async () => {
    const total = 10_321;
    const entries = Array.from({ length: total }, (_, index) => ({
      ...manifestEntry(),
      id: `beat-${index + 1}`,
      name: `Beat ${index + 1}`,
      master: { telegram_file_id: `direct:${index + 101}`, telegram_message_id: index + 101, filename: `Beat ${index + 1}.mp3` },
    }));
    const transport: WebLibraryTransport = {
      getLibraryIndex: vi.fn(async () => ({ messageId: 700, manifest: { schema: GALER_T_LIBRARY_SCHEMA, version: 2, beats: entries, trash: [] } })),
      downloadFiles: vi.fn(async () => []),
    };

    const firstLoad = await loadWebLibrary(transport);
    expect(firstLoad).toHaveLength(WEB_LIBRARY_FIRST_PAGE_SIZE);
    expect(firstLoad[0].id).toBe("beat-1");
    expect(firstLoad.at(-1)?.id).toBe(`beat-${WEB_LIBRARY_FIRST_PAGE_SIZE}`);
    expect(transport.downloadFiles).not.toHaveBeenCalled();

    const secondPage = await loadWebLibraryPage(transport, { offset: WEB_LIBRARY_FIRST_PAGE_SIZE });
    expect(secondPage.totalVisible).toBe(total);
    expect(secondPage.materializedCount).toBe(WEB_LIBRARY_FIRST_PAGE_SIZE);
    expect(secondPage.beats).toHaveLength(WEB_LIBRARY_FIRST_PAGE_SIZE);
    expect(secondPage.beats[0].id).toBe(`beat-${WEB_LIBRARY_FIRST_PAGE_SIZE + 1}`);
    expect(secondPage.hasMore).toBe(true);
    expect(secondPage.nextOffset).toBe(WEB_LIBRARY_FIRST_PAGE_SIZE * 2);

    const lastPage = await loadWebLibraryPage(transport, { offset: total - 11 });
    expect(lastPage.totalVisible).toBe(total);
    expect(lastPage.materializedCount).toBe(11);
    expect(lastPage.beats).toHaveLength(11);
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.nextOffset).toBeNull();
  });

  it("exposes the minimum empty/no-results/offline/auth/cloud taxonomy", () => {
    expect(classifyWebLibraryResult(0)).toBe("empty");
    expect(classifyWebLibraryResult(0, true)).toBe("no-results");
    expect(classifyWebLibraryResult(2)).toBe("ready");
    expect(classifyWebLibraryLoadError(new Error("401 Unauthorized"), true)).toBe("auth-failure");
    expect(classifyWebLibraryLoadError(new Error("network down"), false)).toBe("offline");
    expect(classifyWebLibraryLoadError(new Error("network down"), true)).toBe("cloud-failure");
  });

  it("observes failed startup using the same timing boundary", async () => {
    const transport: WebLibraryTransport = { getLibraryIndex: vi.fn(async () => { throw new Error("403 Forbidden"); }), downloadFiles: vi.fn(async () => []) };
    const observations: unknown[] = [];
    const ticks = [50, 62];
    await expect(loadWebLibrary(transport, { now: () => ticks.shift() ?? 62, onObservation: observation => observations.push(observation) })).rejects.toThrow("403");
    expect(observations).toEqual([{ state: "auth-failure", durationMs: 12, beatCount: 0 }]);
  });
});
