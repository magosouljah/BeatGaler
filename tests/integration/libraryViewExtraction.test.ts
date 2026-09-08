import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const libraryView = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryViewState.ts"), "utf8");
const librarySelectors = readFileSync(resolve(process.cwd(), "src/features/library/librarySelectors.ts"), "utf8");
const tagFilters = readFileSync(resolve(process.cwd(), "src/features/tags/useTagFilters.ts"), "utf8");
const tagSelectors = readFileSync(resolve(process.cwd(), "src/features/tags/tagSelectors.ts"), "utf8");

describe("task 3.3 extraction wiring", () => {
  it("moves library view and tag filter ownership out of App without changing UI wiring", () => {
    expect(app).toContain("useLibraryViewState()");
    expect(app).toContain("useTagFilters()");
    expect(app).toContain("selectFilteredAndSortedBeats(");
    expect(app).toContain("selectTagFrequency(beats)");
    expect(app).toContain("selectAllTags(beats, tagFrequency)");
    expect(app).toContain("selectTagSuggestions(beats)");
    expect(app).not.toContain('const [search, setSearch] = useState("")');
    expect(app).not.toContain("const [includedTags, setIncludedTags]");
    expect(app).not.toContain("const [excludedTags, setExcludedTags]");
    expect(libraryView).toContain("saveCachedSort(sortBy)");
    expect(tagFilters).toContain("toggleTagFilter");
    expect(librarySelectors).toContain('if (sortBy === "rating")');
    expect(tagSelectors).toContain("selectTagFrequency");
    expect(tagSelectors).toContain("displayByNormalized");
  });

  it("keeps Web sort-to-playback routing composed above the extracted owner", () => {
    expect(app).toContain('useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web")');
  });

  it("does not begin task 3.4 selection/reorder extraction", () => {
    expect(app).toContain("const handleToggleSelect = useCallback");
    expect(app).toContain("const handleDragEnd = useCallback");
    expect(app).toContain("reorderBeats(next.map((b) => b.id))");
  });
});
