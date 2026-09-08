import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const selection = readFileSync(resolve(process.cwd(), "src/features/selection/useBeatSelection.ts"), "utf8");
const reorder = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryReorder.ts"), "utf8");

describe("task 3.4 extraction wiring", () => {
  it("moves selection ownership out of App while preserving Shift and reconciliation contracts", () => {
    expect(app).toContain("useBeatSelection(beats)");
    expect(app).toContain("toggleSelection(b, e.shiftKey, filteredBeats)");
    expect(app).not.toContain("const [selectedIds, setSelectedIds]");
    expect(app).not.toContain("const handleToggleSelect = useCallback");
    expect(selection).toContain("currentFiltered.slice(lo, hi + 1)");
    expect(selection).toContain("const liveIds = new Set(beats.map(beat => beat.id))");
  });

  it("moves reorder ownership out of App and preserves rating-group limits", () => {
    expect(app).toContain("useLibraryReorder({ sortBy, setSortBy, setBeats })");
    expect(app).not.toContain("const handleDragEnd = useCallback");
    expect(app).not.toContain("reorderBeats(next.map((b) => b.id))");
    expect(reorder).toContain('if (sortBy !== "rating") setSortBy("manual")');
    expect(reorder).toContain("if (moved.rating !== target.rating) return current");
    expect(reorder).toContain("reorderBeats(next.map(beat => beat.id))");
  });
});
