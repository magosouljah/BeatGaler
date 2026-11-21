import type { Beat } from "../../types";
import type { SortKey } from "./components/SortMenu";

export function selectFilteredAndSortedBeats(
  beats: readonly Beat[],
  search: string,
  includedTags: ReadonlySet<string>,
  excludedTags: ReadonlySet<string>,
  sortBy: SortKey,
  includeMode: "all" | "any" = "all",
): Beat[] {
  const manualOrderIndex = new Map<string, number>();
  beats.forEach((beat, index) => manualOrderIndex.set(beat.id, index));

  return beats
    .filter(beat => {
      const q = search.trim().toLowerCase();
      return (!q || beat.name.toLowerCase().includes(q) || beat.tags.some(tag => tag.toLowerCase().includes(q)) || beat.key.toLowerCase().includes(q) || String(beat.bpm).includes(q))
        && (includedTags.size === 0 || (includeMode === "any"
          ? [...includedTags].some(tag => beat.tags.includes(tag))
          : [...includedTags].every(tag => beat.tags.includes(tag))))
        && (excludedTags.size === 0 || ![...excludedTags].some(tag => beat.tags.includes(tag)));
    })
    .sort((a, b) => {
      if (sortBy === "manual") return 0;
      if (sortBy === "bpm") return Number(a.bpm || 0) - Number(b.bpm || 0);
      if (sortBy === "rating") {
        const ratingDiff = b.rating - a.rating;
        if (ratingDiff !== 0) return ratingDiff;
        return (manualOrderIndex.get(a.id) ?? 0) - (manualOrderIndex.get(b.id) ?? 0);
      }
      return a.name.localeCompare(b.name);
    });
}
