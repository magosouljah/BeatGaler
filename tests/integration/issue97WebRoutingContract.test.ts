import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8").replaceAll("../", "./");
const drawerPersistence = readFileSync(resolve(process.cwd(), "src/features/edit/useDrawerCloudPersistence.ts"), "utf8");
const startupBootstrap = readFileSync(resolve(process.cwd(), "src/features/startup/useStartupBootstrap.ts"), "utf8");

function sourceSection(source: string, startMarker: string, endMarker: string, label: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Could not find ${label} section: ${startMarker}`);
  return source.slice(start, end);
}

function section(startMarker: string, endMarker: string): string {
  return sourceSection(app, startMarker, endMarker, "App.tsx");
}

describe("Issue #97 Web routing contracts", () => {
  it("routes browser artwork through the browser-editing capability before any Desktop-only metadata path", () => {
    const artwork = section(
      "const handleDropArtwork = useCallback",
      "const {\n    runBeatCloudUpdate,",
    );
    const webBranch = artwork.indexOf("if (platform.capabilities.browserCloudEditing)");
    const webCommit = artwork.indexOf("platform.editor.commit(beat, updated, {})");
    const desktopMeta = artwork.indexOf("saveBeatMeta({");
    const desktopTelegram = artwork.indexOf("syncBeatMetadataToTelegram(updated)");

    expect(webBranch).toBeGreaterThanOrEqual(0);
    expect(webCommit).toBeGreaterThan(webBranch);
    expect(desktopMeta).toBeGreaterThan(webCommit);
    expect(desktopTelegram).toBeGreaterThan(desktopMeta);
  });

  it("does not install the legacy metadata-to-Tauri observer when browser cloud editing owns commits", () => {
    expect(drawerPersistence).toContain("if (browserCloudEditing) return;");
    expect(drawerPersistence).toContain("syncBeatMetadataToTelegram(latestBeat)");
  });

  it("keeps an online transient startup authority failure visible but read-only", () => {
    const startupCatch = sourceSection(
      startupBootstrap,
      'console.warn("Telegram vault startup check failed:", error);',
      "return () => { cancelled = true; };",
      "useStartupBootstrap.ts",
    );
    expect(startupCatch).toContain("setCloudSessionVerified(false)");
    expect(startupCatch).toContain('await showOfflineLibrary("offline")');
    expect(startupCatch).toContain('setConnectionState("poor")');
    expect(startupCatch).toContain("Authority is temporarily unknown, not empty");
  });
});
