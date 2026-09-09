import { describe, expect, it } from "vitest";
import fs from "node:fs";

const app = fs.readFileSync("src/app/useBeatGalerComposition.ts", "utf8").replaceAll("../", "./");
const appShell = fs.readFileSync("src/app/AppShell.tsx", "utf8");
const hook = fs.readFileSync("src/features/tags/useTagRename.ts", "utf8");
const dialog = fs.readFileSync("src/features/tags/components/TagRenameDialog.tsx", "utf8");

describe("App tag rename extraction", () => {
  it("moves global rename operation and operation state to useTagRename", () => {
    expect(app).toContain('useTagRename({ beats, setBeats, replaceTagFilter })');
    expect(app).not.toContain('renameTagEverywhere(');
    expect(app).not.toContain('const [tagRenameBusy');
    expect(hook).toContain('await renameTagEverywhere(oldTag, newTag, jobId)');
    expect(hook).toContain('registerJob(jobId');
    expect(hook).toContain('updateJob(jobId, { status: "processing"');
    expect(hook).toContain('updateJob(jobId, { status: "error", message })');
  });

  it("preserves beat order, filter replacement, color rename and recovery feedback", () => {
    expect(hook).toContain('setBeats(current => current.map');
    expect(hook).toContain('beat.tags.map');
    expect(hook).toContain('Array.from(new Set(renamed))');
    expect(hook).toContain('replaceTagFilter(oldTag, newTag)');
    expect(hook).toContain('renameTagColor(oldTag, newTag)');
    expect(dialog).toContain('The original metadata order will be preserved');
    expect(dialog).toContain('A recovery journal will roll back an interrupted operation on the next start.');
  });

  it("moves the dialog while preserving pre-run cancel, back, busy and error feedback", () => {
    expect(appShell).toContain('<TagRenameDialog');
    expect(app).not.toContain('Rename tag globally</div>');
    expect(dialog).toContain('Rename tag globally');
    expect(dialog).toContain('onClick={onCancel}');
    expect(dialog).toContain('disabled={busy} onClick={onBack}');
    expect(dialog).toContain('disabled={busy || affectedCount === 0}');
    expect(dialog).toContain('{busy ? "Renaming…" : "Rename everywhere"}');
    expect(dialog).toContain('{error &&');
  });
});
