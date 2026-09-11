import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = [
  readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/edit/useBeatEditing.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/dragdrop/useBeatFileDropRouting.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/cloud/beatCloudUpdateBusy.ts"), "utf8"),
].join("\n").replaceAll("../", "./");
const browserImport = readFileSync(resolve(process.cwd(), "src/features/import/useBrowserImport.ts"), "utf8");
const htmlDropOwner = readFileSync(resolve(process.cwd(), "src/features/dragdrop/useHtmlLibraryDrop.ts"), "utf8");
const review = readFileSync(resolve(process.cwd(), "src/features/import/useImportReview.ts"), "utf8");
const capabilities = readFileSync(resolve(process.cwd(), "src/platform/capabilities.ts"), "utf8");

describe("task 7.4 browser import extraction", () => {
  it("moves the browser File to Review path out of App and keeps App as capability-gated wiring", () => {
    expect(app).toContain('import { useBrowserImport } from "./features/import/useBrowserImport";');
    expect((app.match(/useBrowserImport\(/g) ?? []).length).toBe(1);
    expect(app).not.toContain("const importDroppedBrowserFiles = useCallback");
    expect(app).toContain("browserFileImport: platform.capabilities.browserFileImport");
    expect(app).toContain("importDroppedBrowserFiles,");
    expect(htmlDropOwner).toContain("onBrowserLibraryFileDrop: browserFileImport ? importDroppedBrowserFiles : undefined");
  });

  it("preserves one beat per gesture, hydration, tag cleanup and immediate Review preparation", () => {
    expect(browserImport).toContain("if (supported.length > 1)");
    expect(browserImport).toContain("BeatGaler Web imports one beat per drag action.");
    expect(browserImport).toContain("platform.importer.fromFile(supported[0])");
    expect(browserImport).toContain("const beat = candidate.beat;");
    expect(browserImport).toContain("void candidate.hydrated.then(hydrated => {");
    expect(browserImport).toContain("cleanTags(hydrated.tags || []).tags");
    expect(browserImport).toContain("completeImmediateReviewPreparation();");
    expect(browserImport).toContain("resetImportResolutionState();");
    expect(browserImport).toContain("setReviewQueue({ beats: [beat], index: 0, total: 1, batchId: null, preparing: false });");
  });

  it("contains no native invocation path and leaves browser candidate release on Skip/Cancel", () => {
    expect(browserImport).not.toContain("../../lib/tauri");
    expect(browserImport).not.toContain("@tauri");
    expect(browserImport).not.toContain("invoke(");
    expect(review).toContain("if (currentBeat) releaseBeat?.(currentBeat.id);");
    expect(review).toContain("for (const beat of queue.beats.slice(queue.index)) releaseBeat?.(beat.id);");
    expect(app).toContain("? beatId => platform.importer.releaseBeat(beatId)");
    expect(capabilities).toContain("browserFileImport: false,");
    expect(capabilities).toContain("reviewBeatCloudCommit: false,");
    expect(capabilities).toContain("browserFileImport: true,");
    expect(capabilities).toContain("reviewBeatCloudCommit: true,");
  });
});
