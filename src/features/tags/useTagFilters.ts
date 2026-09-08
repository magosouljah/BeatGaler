import { useCallback, useState } from "react";

export type TagFilterMode = "include" | "exclude";

export type TagFilters = {
  includedTags: Set<string>;
  excludedTags: Set<string>;
  clearTagFilters: () => void;
  toggleTagFilter: (tag: string, mode: TagFilterMode) => void;
  replaceTagFilter: (oldTag: string, newTag: string) => void;
};

export function useTagFilters(): TagFilters {
  const [includedTags, setIncludedTags] = useState<Set<string>>(new Set());
  const [excludedTags, setExcludedTags] = useState<Set<string>>(new Set());

  const clearTagFilters = useCallback(() => {
    setIncludedTags(new Set());
    setExcludedTags(new Set());
  }, []);

  const toggleTagFilter = useCallback((tag: string, mode: TagFilterMode) => {
    if (mode === "exclude") {
      setExcludedTags(current => {
        const next = new Set(current);
        next.has(tag) ? next.delete(tag) : next.add(tag);
        return next;
      });
      setIncludedTags(current => {
        const next = new Set(current);
        next.delete(tag);
        return next;
      });
      return;
    }

    setIncludedTags(current => {
      const next = new Set(current);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });
    setExcludedTags(current => {
      const next = new Set(current);
      next.delete(tag);
      return next;
    });
  }, []);

  const replaceTagFilter = useCallback((oldTag: string, newTag: string) => {
    setIncludedTags(current => new Set([...current].map(tag => tag.trim().toLowerCase() === oldTag ? newTag : tag)));
    setExcludedTags(current => new Set([...current].map(tag => tag.trim().toLowerCase() === oldTag ? newTag : tag)));
  }, []);

  return { includedTags, excludedTags, clearTagFilters, toggleTagFilter, replaceTagFilter };
}
