import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const discovery = readFileSync(resolve(process.cwd(), "src/features/import/useImportDiscovery.ts"), "utf8");
const saveAll = readFileSync(resolve(process.cwd(), "src/features/import/useImportSaveAll.ts"), "utf8");
const host = readFileSync(resolve(process.cwd(), "src/features/import/components/ImportReviewHost.tsx"), "utf8");

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing task 7.3 marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 7.3 Save All/conflict extraction", () => {
  it("moves Save All and conflict state/callback ownership out of App while leaving browser import for 7.4", () => {
    expect(app).toContain("useImportSaveAll({");
    expect(app).not.toContain("const handleReviewedSaveAll = useCallback");
    expect(app).not.toContain("const [audioConflictBatch, setAudioConflictBatch] = useState");
    expect(app).not.toContain("const [dropImportBatch, setDropImportBatch] = useState");
    expect(app).toContain("setAudioConflictBatch(null);");
    expect(app).toContain("setDropImportBatch(null);");
    expect(saveAll).toContain("saveMeta: saveBeatMeta,");
    expect(app).toContain("const importDroppedBrowserFiles = useCallback");
    expect(discovery).toContain("const [deferredImportBatch, setDeferredImportBatch]");
    expect(discovery).not.toContain("setAudioConflictBatch");
    expect(discovery).not.toContain("setDropImportBatch");
  });

  it("closes Review before waiting for the shared background worker and sends duplicate/errors back to Review", () => {
    expectOrdered(saveAll, [
      "setReviewQueue(null);",
      "cloudifyImportedBeats([currentUpdated])",
      "if (reviewPreparationPromiseRef.current)",
      "const remaining = allPrepared.slice(startIndex + 1)",
      "if (nameConflicts.length > 0)",
      "setReviewQueue({ beats: nameConflicts",
    ]);
    expect(saveAll).toContain("await services.saveMeta({");
    expect(saveAll).toContain("await new Promise<void>(resolve => window.setTimeout(resolve, 0));");
  });

  it("surfaces native conflicts only after normal Review and keeps staging protected across resolution", () => {
    expectOrdered(saveAll, [
      "if (!deferredImportBatch || !reviewPreparationDone || bulkSaveAllBusy) return;",
      "if (reviewBootstrap || reviewQueue || audioConflictBatch || dropImportBatch) return;",
      "if (deferredImportBatch.audio_conflicts.length > 0)",
      "if (deferredImportBatch.pending.length > 0)",
    ]);
    expect(saveAll).toContain("stagedImportPathsRef.current.delete(dropImportBatch.batch_id);");
    expect(saveAll).toContain("addBeatsAndReview(imported);");
    expect(host).toContain("export function ImportResolutionHost");
    expect(host).toContain("<ImportAudioConflictsModal");
    expect(host).toContain("<ImportDecisionsModal");
    expect(app).toContain("<ImportResolutionHost");
  });
});
