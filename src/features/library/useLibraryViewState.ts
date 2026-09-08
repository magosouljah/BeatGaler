import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { SortKey } from "./components/SortMenu";
import { loadCachedSort, saveCachedSort } from "./libraryPresentationCache";

export type LibraryViewState = {
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  sortBy: SortKey;
  setSortBy: Dispatch<SetStateAction<SortKey>>;
};

export function useLibraryViewState(): LibraryViewState {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>(() => loadCachedSort());

  useEffect(() => {
    saveCachedSort(sortBy);
  }, [sortBy]);

  return { search, setSearch, sortBy, setSortBy };
}
