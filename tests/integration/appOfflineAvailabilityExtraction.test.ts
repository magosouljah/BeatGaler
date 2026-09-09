import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8").replaceAll("../", "./");
const offline = readFileSync(resolve(process.cwd(), "src/features/offline/useOfflineAvailability.ts"), "utf8");

describe("App Available Offline extraction", () => {
  it("moves durable Offline ownership out of App while keeping composition explicit", () => {
    expect(app).toContain("useOfflineAvailability");
    expect(app).toContain("const { offlineBusyIds, handleToggleOffline } = useOfflineAvailability({");
    expect(app).not.toContain("const handleToggleOffline = useCallback");
    expect(app).not.toContain("makeBeatAvailableOffline");
    expect(app).not.toContain("removeBeatOfflineAvailability");
  });

  it("preserves durable package creation/removal and runtime ownership", () => {
    expect(offline).toContain("makeBeatAvailableOffline(beat)");
    expect(offline).toContain("removeBeatOfflineAvailability(beat.id)");
    expect(offline).toContain("DOWNLOAD_STARTED");
    expect(offline).toContain("DOWNLOAD_SUCCEEDED");
    expect(offline).toContain("OFFLINE_DOWNLOAD_FAILED");
    expect(offline).toContain("SET_OFFLINE_AVAILABLE");
  });

  it("invalidates playback before package removal and preserves online/offline outcomes", () => {
    expect(offline.indexOf("invalidatePlaybackPreparation(beat.id)")).toBeLessThan(offline.indexOf("removeBeatOfflineAvailability(beat.id)"));
    expect(offline).toContain("if (audioPlayingId === beat.id) releaseFile()");
    expect(offline).toContain("setBeats(current => current.filter(item => item.id !== beat.id))");
    expect(offline).toContain('folder_path: ""');
    expect(offline).toContain("void ensureWarmPlaybackUrl(cloudBeat)");
  });
});
