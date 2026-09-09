import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const beatGalerApp = readFileSync("src/app/BeatGalerApp.tsx", "utf8");
const composition = readFileSync("src/app/useBeatGalerComposition.ts", "utf8");

describe("minimal application composition", () => {
  it("keeps App as a tiny entry point", () => {
    const lines = app.trimEnd().split(/\r?\n/).length;
    expect(lines).toBeGreaterThanOrEqual(5);
    expect(lines).toBeLessThanOrEqual(15);
    expect(app).toContain("<BeatGalerApp />");
    expect(app).not.toContain("AccountGate");
    expect(app).not.toContain("platform.kind");
    expect(app).not.toContain("AppShell");
  });

  it("keeps the single platform authentication route in BeatGalerApp", () => {
    expect(beatGalerApp).toContain('platform.kind === "web"');
    expect(beatGalerApp).toContain("<BeatGalerWorkspace />");
    expect(beatGalerApp).toContain("<AccountGate><BeatGalerWorkspace /></AccountGate>");
    expect(beatGalerApp).toContain("<AppShell scope={scope} />");
  });

  it("keeps feature wiring in the composition boundary without hiding a legacy app component", () => {
    expect(composition).toContain("export function useBeatGalerComposition()");
    expect(composition).toContain("useLibraryState()");
    expect(composition).toContain("usePlaybackController({");
    expect(composition).toContain("useCloudUploadQueue({");
    expect(composition).toContain("useAppShortcuts({");
    expect(composition).not.toContain("BeatGalerCompositionLegacy");
    expect(composition).not.toContain("<AppShell");
  });
});
