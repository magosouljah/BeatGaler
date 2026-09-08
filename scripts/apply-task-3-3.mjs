import { readFileSync, writeFileSync } from "node:fs";

const appPath = "src/App.tsx";
let app = readFileSync(appPath, "utf8");

function replaceOnce(label, before, after) {
  const first = app.indexOf(before);
  if (first < 0) throw new Error(`Task 3.3 patch failed: missing ${label}`);
  if (app.indexOf(before, first + before.length) >= 0) throw new Error(`Task 3.3 patch failed: duplicate ${label}`);
  app = app.slice(0, first) + after + app.slice(first + before.length);
}

replaceOnce(
  "SortMenu type import",
  'import SortMenu, { type SortKey } from "./features/library/components/SortMenu";',
  'import SortMenu from "./features/library/components/SortMenu";',
);

replaceOnce(
  "library cache/view imports",
  'import { clearCachedBeats, clearUploadPreviewCache, loadCachedSort, preserveLoadedArtwork, saveCachedSort } from "./features/library/libraryPresentationCache";',
  'import { clearCachedBeats, clearUploadPreviewCache, preserveLoadedArtwork } from "./features/library/libraryPresentationCache";\nimport { selectFilteredAndSortedBeats } from "./features/library/librarySelectors";\nimport { useLibraryViewState } from "./features/library/useLibraryViewState";\nimport { selectAllTags, selectTagSuggestions } from "./features/tags/tagSelectors";\nimport { useTagFilters } from "./features/tags/useTagFilters";',
);

replaceOnce(
  "library view and tag filter state",
`  const [search, setSearch] = useState("");
  const [includedTags, setIncludedTags] = useState<Set<string>>(new Set());
  const [excludedTags, setExcludedTags] = useState<Set<string>>(new Set());
  const [tagColorMenu, setTagColorMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  const [tagRename, setTagRename] = useState<{ oldTag: string; newTag: string; stage: "name" | "confirm" } | null>(null);
  const [tagRenameBusy, setTagRenameBusy] = useState(false);
  const [tagRenameError, setTagRenameError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>(() => loadCachedSort());
  useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web");`,
`  const { search, setSearch, sortBy, setSortBy } = useLibraryViewState();
  const {
    includedTags,
    excludedTags,
    clearTagFilters,
    toggleTagFilter,
    replaceTagFilter,
  } = useTagFilters();
  const [tagColorMenu, setTagColorMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  const [tagRename, setTagRename] = useState<{ oldTag: string; newTag: string; stage: "name" | "confirm" } | null>(null);
  const [tagRenameBusy, setTagRenameBusy] = useState(false);
  const [tagRenameError, setTagRenameError] = useState<string | null>(null);
  useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web");`,
);

replaceOnce(
  "sort persistence effect",
`  useEffect(() => {
    saveCachedSort(sortBy);
  }, [sortBy]);

`,
  "",
);

replaceOnce(
  "tag rename filter reconciliation",
`    setIncludedTags(s => new Set([...s].map(t => t.trim().toLowerCase() === oldTag ? newTag : t)));
    setExcludedTags(s => new Set([...s].map(t => t.trim().toLowerCase() === oldTag ? newTag : t)));`,
  `    replaceTagFilter(oldTag, newTag);`,
);

replaceOnce(
  "tag rename callback deps",
  `}, [tagRename]);`,
  `}, [tagRename, replaceTagFilter]);`,
);

replaceOnce(
  "tag click filter mutations",
`const handleTagClick = useCallback((tag: string, e: React.MouseEvent) => {
  if (e.altKey) {
    // Alt/Option + click -> excluir (o quitar si ya estaba excluido)
    setExcludedTags(s => {
      const n = new Set(s);
      n.has(tag) ? n.delete(tag) : n.add(tag);
      return n;
    });
    setIncludedTags(s => { const n = new Set(s); n.delete(tag); return n; });
  } else {
    // Click normal -> incluir (o quitar si ya estaba incluido)
    setIncludedTags(s => {
      const n = new Set(s);
      n.has(tag) ? n.delete(tag) : n.add(tag);
      return n;
    });
    setExcludedTags(s => { const n = new Set(s); n.delete(tag); return n; });
  }
}, []);`,
`const handleTagClick = useCallback((tag: string, e: React.MouseEvent) => {
  toggleTagFilter(tag, e.altKey ? "exclude" : "include");
}, [toggleTagFilter]);`,
);

const derivedStart = app.indexOf("  // Global tag usage, normalized and counted once per beat.");
const derivedEnd = app.indexOf("\n  const filteredBeatIdsKey =", derivedStart);
if (derivedStart < 0 || derivedEnd < 0) throw new Error("Task 3.3 patch failed: derived library/tag block not found");
app = app.slice(0, derivedStart) + `  const allTags = useMemo(() => selectAllTags(beats), [beats]);
  const tagSuggestions = useMemo(() => selectTagSuggestions(beats), [beats]);
  const filteredBeats = selectFilteredAndSortedBeats(
    beats,
    search,
    includedTags,
    excludedTags,
    sortBy,
  );
` + app.slice(derivedEnd);

replaceOnce(
  "clear tag filters button",
  'onClick={() => { setIncludedTags(new Set()); setExcludedTags(new Set()); }}',
  'onClick={clearTagFilters}',
);

writeFileSync(appPath, app);
console.log("Task 3.3 App extraction applied; selection/reorder remains in App.");
