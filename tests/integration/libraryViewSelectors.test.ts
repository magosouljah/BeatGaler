import { describe, expect, it } from "vitest";
import type { Beat } from "../../src/types";
import { selectFilteredAndSortedBeats } from "../../src/features/library/librarySelectors";
import { selectAllTags, selectTagSuggestions } from "../../src/features/tags/tagSelectors";

function beat(id: string, name: string, bpm: string, key: string, tags: string[], rating: number): Beat {
  return { id, name, bpm, key, tags, rating, other_files: [] } as unknown as Beat;
}

const beats = [
  beat("a", "Zulu", "140", "Cm", ["dark", "Trap"], 4),
  beat("b", "Alpha", "90", "Am", ["dark", "lofi"], 5),
  beat("c", "Beta", "120", "Gm", ["lofi", "dark"], 5),
  beat("d", "Gamma", "110", "Dm", ["Trap", "trap"], 2),
];

describe("task 3.3 library/tag selectors", () => {
  it("preserves search fields plus include/exclude semantics", () => {
    expect(selectFilteredAndSortedBeats(beats, "alpha", new Set(), new Set(), "manual").map(b => b.id)).toEqual(["b"]);
    expect(selectFilteredAndSortedBeats(beats, "120", new Set(), new Set(), "manual").map(b => b.id)).toEqual(["c"]);
    expect(selectFilteredAndSortedBeats(beats, "gm", new Set(), new Set(), "manual").map(b => b.id)).toEqual(["c"]);
    expect(selectFilteredAndSortedBeats(beats, "dark", new Set(["dark"]), new Set(["lofi"]), "manual").map(b => b.id)).toEqual(["a"]);
  });

  it("preserves manual, BPM, name and rating ordering with manual tie-breaks", () => {
    expect(selectFilteredAndSortedBeats(beats, "", new Set(), new Set(), "manual").map(b => b.id)).toEqual(["a", "b", "c", "d"]);
    expect(selectFilteredAndSortedBeats(beats, "", new Set(), new Set(), "bpm").map(b => b.id)).toEqual(["b", "d", "c", "a"]);
    expect(selectFilteredAndSortedBeats(beats, "", new Set(), new Set(), "name").map(b => b.id)).toEqual(["b", "c", "d", "a"]);
    expect(selectFilteredAndSortedBeats(beats, "", new Set(), new Set(), "rating").map(b => b.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("preserves normalized global-tag ranking and suggestion counting", () => {
    expect(selectAllTags(beats)).toEqual(["dark", "lofi", "Trap"]);
    expect(selectTagSuggestions(beats)).toEqual(["dark", "trap", "lofi"]);
  });
});
