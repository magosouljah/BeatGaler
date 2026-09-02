import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const drawer = readFileSync(new URL("../../src/components/Drawer.tsx", import.meta.url), "utf8");

describe("Issue #97 Drawer Web routing contracts", () => {
  it("uses the browser editor commit for supported single-beat Web edits even when App supplies the Desktop cloud commit prop", () => {
    expect(drawer).toContain('if (platform.capabilities.browserCloudEditing && !reviewInfo && !isBulk) {');
    expect(drawer).toContain("platform.editor.commit(");
    expect(drawer).not.toContain('platform.capabilities.browserCloudEditing && !reviewInfo && !isBulk && !onCloudMutationCommit');
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
