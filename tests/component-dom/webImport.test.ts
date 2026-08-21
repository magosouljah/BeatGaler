import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebImportCandidate, webImportPort } from "../../src/platform/webImport";

describe("BeatGaler Web single-beat import", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:beat-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    (window as any).jsmediatags = {
      read(_file: File, callbacks: any) {
        callbacks.onSuccess({ tags: { TBPM: "140", TKEY: "Cm", genre: "Trap; Dark" } });
      },
    };
  });

  afterEach(() => {
    delete (window as any).jsmediatags;
    vi.restoreAllMocks();
  });

  it("opens Review from a minimal candidate before metadata hydration", async () => {
    const file = new File(["audio"], "Night Drive.mp3", { type: "audio/mpeg" });
    const candidate = createWebImportCandidate(file);

    expect(candidate.beat.name).toBe("Night Drive");
    expect(candidate.beat.bpm).toBe("");
    expect(candidate.beat.playback_path).toBe("blob:beat-preview");
    expect(candidate.beat.cloud_status).toBe("PENDING_UPLOAD");
    expect(webImportPort.fileForBeat(candidate.beat.id)).toBe(file);

    const hydrated = await candidate.hydrated;
    expect(hydrated.bpm).toBe("140");
    expect(hydrated.key).toBe("Cm");
    expect(hydrated.tags).toEqual(["trap", "dark"]);

    webImportPort.releaseBeat(candidate.beat.id);
    expect(webImportPort.fileForBeat(candidate.beat.id)).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:beat-preview");
  });

  it("rejects non-audio files before Review", () => {
    const file = new File(["nope"], "notes.txt", { type: "text/plain" });
    expect(() => createWebImportCandidate(file)).toThrow("Choose one MP3 or WAV file.");
  });
});
