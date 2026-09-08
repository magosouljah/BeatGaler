import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const controllerSource = readFileSync(resolve(process.cwd(), "src/features/playback/usePlaybackController.ts"), "utf8");
const offlineSource = readFileSync(resolve(process.cwd(), "src/features/offline/useOfflineAvailability.ts"), "utf8");
describe("App playback extraction", () => {
  it("moves playback preparation, invalidation, audio events and play routing out of App", () => {
    expect(appSource).toContain('usePlaybackController({');
    expect(offlineSource).toContain('invalidatePlaybackPreparation(beat.id)');
    expect(appSource).not.toContain('const ensureWarmPlaybackUrl = useCallback');
    expect(appSource).not.toContain('APP_HANDLE_PLAY_ENTER');
    expect(appSource).not.toContain('beatgaler:playback-cache-cleared');
    expect(appSource).not.toContain('cookingPlaybackUrlRef');
    expect(controllerSource).toContain('beatgaler:playback-cache-cleared');
    expect(controllerSource).toContain('beatgaler:audio-playing');
    expect(controllerSource).toContain('invalidatePlaybackPreparation');
    expect(controllerSource).toContain('PLAY_BLOCKED_LOADING');
    expect(controllerSource).toContain('playbackCacheEpochRef.current !== cacheEpoch');
    expect(controllerSource).toContain('APP_HANDLE_PLAY_ENTER');
    expect(controllerSource).toContain('if (!isTauriAvailable)');
    expect(controllerSource).toContain('prepareBeatForPlayback(beat)');
  });
});
