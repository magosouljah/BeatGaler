import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebImportCandidate, waitForWebImportFiles, webImportPort } from "../../src/platform/webImport";
import { createWebWavMaster } from "../../src/features/import/webWavMaster";

vi.mock("../../src/features/import/webWavMaster", () => ({ createWebWavMaster: vi.fn() }));

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
    expect(webImportPort.slotFilesForBeat(candidate.beat.id)).toEqual({ MASTER: file });

    const hydrated = await candidate.hydrated;
    expect(hydrated.bpm).toBe("140");
    expect(hydrated.key).toBe("Cm");
    expect(hydrated.tags).toEqual(["trap", "dark"]);

    webImportPort.releaseBeat(candidate.beat.id);
    expect(webImportPort.fileForBeat(candidate.beat.id)).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:beat-preview");
  });

  it("keeps the original WAV and prepares a generated MP3 as MASTER and playback source", async () => {
    const file = new File(["hq"], "Night Drive.wav", { type: "audio/wav" });
    const master = new File(["mp3"], "Night Drive.mp3", { type: "audio/mpeg" });
    vi.mocked(createWebWavMaster).mockResolvedValueOnce(master);
    const candidate = createWebImportCandidate(file);
    expect(candidate.beat.playback_path).toBe("");
    const prepared = await candidate.hydrated;
    expect(createWebWavMaster).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    expect(webImportPort.slotFilesForBeat(candidate.beat.id)).toEqual({ WAV: file, MASTER: master });
    expect(prepared.mp3_path).toBe(master.name);
    expect(prepared.wav_path).toBe(file.name);
    expect(prepared.playback_path).toBe("blob:beat-preview");
    expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toBe(master);
    webImportPort.releaseBeat(candidate.beat.id);
  });

  it("keeps conversion errors observable by Save until Review is cancelled", async () => {
    vi.mocked(createWebWavMaster).mockRejectedValueOnce(new Error("conversion failed"));
    const candidate = createWebImportCandidate(new File(["bad"], "Broken.wav", { type: "audio/wav" }));
    await expect(candidate.hydrated).rejects.toThrow("conversion failed");
    await expect(waitForWebImportFiles(candidate.beat.id)).rejects.toThrow("conversion failed");
    webImportPort.releaseBeat(candidate.beat.id);
    expect(webImportPort.slotFilesForBeat(candidate.beat.id)).toEqual({});
    expect(webImportPort.fileForBeat(candidate.beat.id)).toBeNull();
  });

  it("returns a picked WAV immediately and discards a late MASTER after cancellation", async () => {
    let finish!: (file: File) => void;
    vi.mocked(createWebWavMaster).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const picked = webImportPort.pickBeat();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const source = new File(["wav"], "Selected.wav", { type: "audio/wav" });
    Object.defineProperty(input, "files", { value: [source] });
    input.dispatchEvent(new Event("change"));
    const candidate = (await picked)!;
    expect(candidate.beat.mp3_path).toBe("");
    expect(webImportPort.slotFilesForBeat(candidate.beat.id).WAV).toBe(source);
    const waiting = waitForWebImportFiles(candidate.beat.id);
    webImportPort.releaseBeat(candidate.beat.id);
    const master = new File(["mp3"], "Selected.mp3", { type: "audio/mpeg" });
    finish(master);
    await expect(waiting).rejects.toThrow("cancelled");
    await expect(candidate.hydrated).rejects.toThrow("cancelled");
    expect(webImportPort.slotFilesForBeat(candidate.beat.id)).toEqual({});
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects non-audio files before Review", () => {
    const file = new File(["nope"], "notes.txt", { type: "text/plain" });
    expect(() => createWebImportCandidate(file)).toThrow("Choose one MP3 or WAV file.");
  });
});
