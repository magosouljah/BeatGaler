import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

function section(startMarker: string, endMarker: string): string {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Could not find App.tsx section: ${startMarker}`);
  return app.slice(start, end);
}

describe("Issue #97 Web routing contracts", () => {
  it("routes browser artwork through the browser-editing capability before any Desktop-only metadata path", () => {
    const artwork = section(
      "const handleDropArtwork = useCallback",
      "const runBeatCloudUpdate = useCallback",
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
    const observer = section(
      "// Web edits are explicit durable transactions through platform.editor.",
      "useEffect(() => () => {",
    );
    expect(observer).toContain("if (platform.capabilities.browserCloudEditing) return;");
    expect(observer).toContain("syncBeatMetadataToTelegram(latestBeat)");
  });

  it("keeps an online transient startup authority failure visible but read-only", () => {
    const startupCatch = section(
      'console.warn("Telegram vault startup check failed:", error);',
      "return () => { cancelled = true; };",
    );
    expect(startupCatch).toContain("setCloudSessionVerified(false)");
    expect(startupCatch).toContain('await showOfflineLibrary("offline")');
    expect(startupCatch).toContain('setConnectionState("poor")');
    expect(startupCatch).toContain("Authority is temporarily unknown, not empty");
  });
});
