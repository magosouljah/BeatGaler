import type { Beat } from "../../types";

export function selectAllTags(beats: readonly Beat[]): string[] {
  const tagFrequency = new Map<string, number>();
  for (const beat of beats) {
    const uniqueTags = new Set(
      beat.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean),
    );
    for (const tag of uniqueTags) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
  }

  const displayByNormalized = new Map<string, string>();
  for (const beat of beats) {
    for (const rawTag of beat.tags) {
      const normalized = rawTag.trim().toLowerCase();
      if (normalized && !displayByNormalized.has(normalized)) {
        displayByNormalized.set(normalized, rawTag.trim());
      }
    }
  }

  return [...displayByNormalized.entries()]
    .sort(([a], [b]) =>
      (tagFrequency.get(b) ?? 0) - (tagFrequency.get(a) ?? 0) || a.localeCompare(b),
    )
    .map(([, display]) => display);
}

export function selectTagSuggestions(beats: readonly Beat[]): string[] {
  const freq = new Map<string, number>();
  for (const beat of beats) {
    for (const tag of beat.tags) {
      const normalized = tag.trim().toLowerCase();
      if (!normalized) continue;
      freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}
