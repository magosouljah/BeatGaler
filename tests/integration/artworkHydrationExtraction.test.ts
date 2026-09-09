import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("artwork hydration extraction", () => {
  it("keeps hydration ownership outside App and does not turn display loads into cloud commits", () => {
    const app = fs.readFileSync("src/app/useBeatGalerComposition.ts", "utf8").replaceAll("../", "./");
    const hook = fs.readFileSync("src/features/artwork/useArtworkHydration.ts", "utf8");
    expect(app).toContain('useArtworkHydration({');
    expect(app).not.toContain('artworkLoadPromisesRef');
    expect(app).not.toContain('const ensureArtworkReady = useCallback');
    expect(hook).toContain('platform.media.loadArtwork(beat)');
    expect(hook).toContain('readCachedArtworkThumbnail(beat)');
    expect(hook).toContain('cacheArtworkThumbnail(beat, artwork)');
    expect(hook).toContain('invalidateArtworkHydration');
    expect(hook).not.toContain('syncBeatMetadataToTelegram');
    expect(hook).not.toContain('saveBeatMeta');
    expect(hook).not.toContain('commitSnapshot');
  });
});
