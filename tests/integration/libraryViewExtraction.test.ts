import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8").replaceAll("../", "./");
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

  it("hands task 3.4 selection/reorder ownership to its dedicated modules", () => {
    expect(app).toContain("useBeatSelection(beats)");
    expect(app).toContain("useLibraryReorder({ sortBy, setSortBy, setBeats })");
  });
});
