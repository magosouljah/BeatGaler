import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("../../src/components/Drawer.tsx", import.meta.url), "utf8");

describe("Issue #97 Drawer Web routing contracts", () => {
  it("uses the browser editor when no explicit Desktop cloud commit owner is supplied", () => {
    expect(drawer).toContain('if (platform.capabilities.browserCloudEditing && !reviewInfo && !isBulk && !onCloudMutationCommit) {');
    expect(drawer).toContain("platform.editor.commit(");
  });

  it("does not give the Web Drawer the Desktop cloud commit owner", () => {
    const marker = "onCloudMutationCommit={platform.capabilities.browserCloudEditing ? undefined : commitDrawerCloudMutation}";
    expect(app.split(marker).length - 1).toBe(2);
  });

  it("does not probe the Desktop cloud-file bridge when the browser-editing capability owns Drawer", () => {
    const start = drawer.indexOf("const refreshCloudFiles = useCallback");
    const end = drawer.indexOf("const handleCloudDownload", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const refresh = drawer.slice(start, end);
    expect(refresh).toContain("if (platform.capabilities.browserCloudEditing)");
    expect(refresh).toContain("setCloudError(null)");
    expect(refresh.indexOf("if (platform.capabilities.browserCloudEditing)")).toBeLessThan(refresh.indexOf("listCloudFilesForBeat"));
  });
});
