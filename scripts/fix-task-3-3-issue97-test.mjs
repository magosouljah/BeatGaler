import { readFileSync, writeFileSync } from "node:fs";

const path = "tests/integration/issue97PlaybackOptimization.test.ts";
let source = readFileSync(path, "utf8");

const before = `  it("wires the real App caller to UI sort routing and authoritative reconcile", () => {
    const app = source("src/App.tsx");

    expect(app).toContain('import { useWebPlaybackSortRouting } from "./features/playback/useWebPlaybackSortRouting";');
    expect(app).toContain('import { useWebLibraryReconciled } from "./features/library/useWebLibraryReconciled";');

    const sortState = app.indexOf("const [sortBy, setSortBy] = useState<SortKey>(() => loadCachedSort());");
    const sortRouting = app.indexOf('useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web");', sortState);
    const reconcileCallback = app.indexOf("const onWebLibraryReconciled = useCallback((incoming: Beat[]) => {", sortRouting);
    const preserveArtwork = app.indexOf("const next = preserveLoadedArtwork(incoming, current);", reconcileCallback);
    const updateLatest = app.indexOf("beatsLatestRef.current = next;", preserveArtwork);
    const reconcileHook = app.indexOf('useWebLibraryReconciled(platform.kind === "web", onWebLibraryReconciled);', updateLatest);

    expect(sortState).toBeGreaterThanOrEqual(0);
    expect(sortRouting).toBeGreaterThan(sortState);
    expect(reconcileCallback).toBeGreaterThan(sortRouting);
    expect(preserveArtwork).toBeGreaterThan(reconcileCallback);
    expect(updateLatest).toBeGreaterThan(preserveArtwork);
    expect(reconcileHook).toBeGreaterThan(updateLatest);
  });`;

const after = `  it("wires the real App caller to UI sort routing and authoritative reconcile", () => {
    const app = source("src/App.tsx");
    const libraryViewState = source("src/features/library/useLibraryViewState.ts");

    expect(app).toContain('import { useLibraryViewState } from "./features/library/useLibraryViewState";');
    expect(app).toContain('import { useWebPlaybackSortRouting } from "./features/playback/useWebPlaybackSortRouting";');
    expect(app).toContain('import { useWebLibraryReconciled } from "./features/library/useWebLibraryReconciled";');
    expect(libraryViewState).toContain("const [sortBy, setSortBy] = useState<SortKey>(() => loadCachedSort());");
    expect(libraryViewState).toContain("saveCachedSort(sortBy);");

    const viewState = app.indexOf("const { search, setSearch, sortBy, setSortBy } = useLibraryViewState();");
    const sortRouting = app.indexOf('useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web");', viewState);
    const reconcileCallback = app.indexOf("const onWebLibraryReconciled = useCallback((incoming: Beat[]) => {", sortRouting);
    const preserveArtwork = app.indexOf("const next = preserveLoadedArtwork(incoming, current);", reconcileCallback);
    const updateLatest = app.indexOf("beatsLatestRef.current = next;", preserveArtwork);
    const reconcileHook = app.indexOf('useWebLibraryReconciled(platform.kind === "web", onWebLibraryReconciled);', updateLatest);

    expect(viewState).toBeGreaterThanOrEqual(0);
    expect(sortRouting).toBeGreaterThan(viewState);
    expect(reconcileCallback).toBeGreaterThan(sortRouting);
    expect(preserveArtwork).toBeGreaterThan(reconcileCallback);
    expect(updateLatest).toBeGreaterThan(preserveArtwork);
    expect(reconcileHook).toBeGreaterThan(updateLatest);
  });`;

if (!source.includes(before)) {
  throw new Error("Task 3.3 Issue #97 test patch failed: expected original sort-routing contract not found");
}
if (source.indexOf(before) !== source.lastIndexOf(before)) {
  throw new Error("Task 3.3 Issue #97 test patch failed: duplicate original contract");
}

source = source.replace(before, after);
writeFileSync(path, source);
console.log("Task 3.3 Issue #97 sort-routing contract adapted to extracted view-state owner.");
