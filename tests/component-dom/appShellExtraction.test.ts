import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const shell = readFileSync("src/app/AppShell.tsx", "utf8");
const shortcuts = readFileSync("src/app/useAppShortcuts.ts", "utf8");
const publishing = readFileSync("src/features/publishing/usePublishingActions.ts", "utf8");

describe("App visual shell extraction", () => {
  it("moves the large visual regions out of App", () => {
    expect(app).toContain("<AppShell scope={{");
    expect(app).not.toContain("{/* Top bar */}");
    expect(app).not.toContain("{/* Selection toolbar */}");
    expect(app).not.toContain("{/* Grid — OS file drag-drop */}");
    expect(shell).toContain("{/* Top bar */}");
    expect(shell).toContain("{/* Selection toolbar */}");
    expect(shell).toContain("{/* Grid — OS file drag-drop */}");
    expect(shell).toContain("<Player");
    expect(shell).toContain("<ImportReviewHost");
    expect(shell).toContain("<JobStatusBar />");
  });

  it("moves shortcuts and YouTube opening to dedicated owners", () => {
    expect(app).toContain("useAppShortcuts({");
    expect(app).toContain("usePublishingActions({");
    expect(app).not.toContain("window.addEventListener(\"keydown\"");
    expect(shortcuts).toContain("window.addEventListener(\"keydown\"");
    expect(publishing).toContain("Uploading to YouTube");
    expect(publishing).toContain("Bulk upload");
  });
});
