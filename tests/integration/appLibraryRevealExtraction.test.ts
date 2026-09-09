import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/app/useBeatGalerComposition.ts", "utf8").replaceAll("../", "./");
const reveal = readFileSync("src/features/startup/useLibraryReveal.ts", "utf8");
const loader = readFileSync("src/features/startup/startupLoader.ts", "utf8");
const startup = readFileSync("src/features/startup/useStartupBootstrap.ts", "utf8");

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing task 9.5 marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 9.5 library reveal extraction", () => {
  it("moves reveal and startup-loader ownership out of App", () => {
    expect(app).toContain('import { useLibraryReveal } from "./features/startup/useLibraryReveal";');
    expect(app).toContain("useLibraryReveal({");
    expect(app).not.toContain("const revealBeat = useCallback");
    expect(app).not.toContain("function dismissBeatGalerStartupLoader");
    expect(app).not.toContain("ensureArtworkReady(beat, false)");
    expect(app).not.toContain("ensureArtworkReady(beat, true)");
    expect(loader).toContain('document.getElementById("beatgaler-startup-loader")');
    expect(loader).toContain("loader.remove()");
  });

  it("preserves cache-first reveal and authority gating without waiting for audio", () => {
    expect(reveal).toContain("ensureArtworkReady(beat, false)");
    expectOrdered(reveal, [
      'if (connectionState === "checking")',
      'if (connectionState !== "online" || !settings.telegram_cloud_connected)',
      'if (!cloudSessionVerified)',
      'const runId = ++progressiveRevealRunRef.current',
    ]);
    expect(reveal).toContain("ensureArtworkReady(beat, true)");
    expect(reveal).toContain("const delay = [350, 900, 1800, 3200][attempt] ?? 3200");
    expect(reveal).toContain("const workerCount = Math.min(nativeParallelism, queue.length)");
    expect(reveal).not.toContain("prepareBeatForPlayback");
    expect(reveal).not.toContain("warmBeatForPlayback");
  });

  it("keeps validated Offline startup atomic before the reveal owner exposes cards", () => {
    expectOrdered(startup, [
      "const offline = await loadOfflineLibrary()",
      "setRevealedBeatIds(new Set(offline.map(beat => beat.id)))",
      "setBeats(offline)",
    ]);
    expect(reveal).toContain('if (connectionState === "checking")');
    expect(reveal).toContain('if (connectionState !== "online" || !settings.telegram_cloud_connected)');
  });
});
