import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`Missing replacement anchor: ${label}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`Duplicate replacement anchor: ${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

const appPath = "src/App.tsx";
let app = readFileSync(appPath, "utf8");

app = replaceOnce(
  app,
  'loadLibrary, loadOfflineLibrary, makeBeatAvailableOffline, removeBeatOfflineAvailability, recordOfflineTrashIntent, flushOfflineTrashIntents, removeBeatFromLibrary, reorderBeats, readBeatMeta',
  'loadLibrary, loadOfflineLibrary, makeBeatAvailableOffline, removeBeatOfflineAvailability, recordOfflineTrashIntent, flushOfflineTrashIntents, removeBeatFromLibrary, readBeatMeta',
  "remove reorderBeats import",
);
app = replaceOnce(
  app,
  'import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";\nimport { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";',
  'import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";\nimport { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";',
  "trim dnd imports",
);
app = replaceOnce(
  app,
  'import { useLibraryViewState } from "./features/library/useLibraryViewState";\n',
  'import { useLibraryViewState } from "./features/library/useLibraryViewState";\nimport { useLibraryReorder } from "./features/library/useLibraryReorder";\nimport { useBeatSelection } from "./features/selection/useBeatSelection";\n',
  "add task 3.4 imports",
);

app = replaceOnce(
  app,
  `  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());\n  const [selectMode, setSelectMode] = useState(false);\n  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);\n  const [activeDragId, setActiveDragId] = useState<string | null>(null);`,
  `  const {\n    selectedIds,\n    selectMode,\n    toggleSelection,\n    toggleSelectAll,\n    finishSelection,\n    clearSelection,\n  } = useBeatSelection(beats);\n  const {\n    sensors,\n    activeDragId,\n    handleDragStart,\n    handleDragEnd,\n    handleDragCancel,\n  } = useLibraryReorder({ sortBy, setSortBy, setBeats });`,
  "replace selection/reorder state ownership",
);

app = replaceOnce(
  app,
  `  const handleToggleSelect = useCallback((beat: Beat, e: React.MouseEvent, currentFiltered: Beat[]) => {\n    const idx = currentFiltered.findIndex(b => b.id === beat.id);\n    if (idx < 0) return;\n\n    if (e.shiftKey && anchorIdx !== null) {\n      const lo = Math.min(idx, anchorIdx);\n      const hi = Math.max(idx, anchorIdx);\n      // Windows-style range selection: replace the previous range instead of\n      // adding to it. The anchor stays fixed until a non-shift click.\n      setSelectedIds(new Set(currentFiltered.slice(lo, hi + 1).map(b => b.id)));\n    } else {\n      setSelectedIds(current => {\n        const next = new Set(current);\n        next.has(beat.id) ? next.delete(beat.id) : next.add(beat.id);\n        return next;\n      });\n      setAnchorIdx(idx);\n    }\n\n    if (!selectMode) setSelectMode(true);\n  }, [anchorIdx, selectMode]);\n  \n`,
  "",
  "remove local selection handler",
);

app = replaceOnce(
  app,
  `  const sensors = useSensors(\n    useSensor(PointerSensor, {\n      activationConstraint: { delay: 140, tolerance: 6 },\n    })\n  );\n\n  const handleDragStart = useCallback((event: DragStartEvent) => {\n    const id = String(event.active.id);\n    setActiveDragId(id);\n    if (sortBy !== "rating") setSortBy("manual");\n  }, [sortBy]);\n\n  const handleDragEnd = useCallback((event: DragEndEvent) => {\n    const activeId = String(event.active.id);\n    const overId = event.over ? String(event.over.id) : null;\n    setActiveDragId(null);\n    if (!overId || activeId === overId) return;\n\n    setBeats((current) => {\n      const oldIndex = current.findIndex((b) => b.id === activeId);\n      const newIndex = current.findIndex((b) => b.id === overId);\n      if (oldIndex === -1 || newIndex === -1) return current;\n\n      if (sortBy === "rating") {\n        const moved = current[oldIndex];\n        const target = current[newIndex];\n        if (moved.rating !== target.rating) return current;\n      }\n\n      const next = arrayMove(current, oldIndex, newIndex);\n      reorderBeats(next.map((b) => b.id)).catch(console.error);\n      return next;\n    });\n  }, [sortBy]);\n\n  const handleDragCancel = useCallback(() => {\n    setActiveDragId(null);\n  }, []);\n\n`,
  "",
  "remove local reorder handlers",
);

app = replaceOnce(
  app,
  `    setSelectedIds(ids => {\n      const next = new Set(Array.from(ids).filter(id => liveIds.has(id)));\n      return next.size === ids.size ? ids : next;\n    });\n`,
  "",
  "remove selection reconciliation from playback effect",
);
app = replaceOnce(app, `      setAnchorIdx(null);\n`, "", "remove playback anchor reset");

app = replaceOnce(
  app,
  `                onClick={() => {\n                  const allSelected = displayedBeats.every(b => selectedIds.has(b.id));\n                  setSelectedIds(allSelected ? new Set() : new Set(displayedBeats.map(b => b.id)));\n                }}`,
  `                onClick={() => toggleSelectAll(displayedBeats)}`,
  "select all action",
);
app = replaceOnce(
  app,
  `                onClick={() => { setSelectMode(false); setSelectedIds(new Set()); setAnchorIdx(null); }}`,
  `                onClick={finishSelection}`,
  "done action",
);
app = replaceOnce(
  app,
  `              onClick={() => setSelectMode(true)}`,
  `              onClick={() => toggleSelection(null, false, displayedBeats)}`,
  "enter select mode",
);
app = replaceOnce(
  app,
  `          <button onClick={() => { setSelectedIds(new Set()); setSelectMode(false); setAnchorIdx(null); }}`,
  `          <button onClick={finishSelection}`,
  "selection toolbar cancel",
);
app = replaceOnce(
  app,
  `                    onToggleSelect={(b, e) => handleToggleSelect(b, e, filteredBeats)}`,
  `                    onToggleSelect={(b, e) => toggleSelection(b, e.shiftKey, filteredBeats)}`,
  "BeatCard selection wiring",
);
app = replaceOnce(
  app,
  `          onClose={() => { setDrawer(null); setSelectedIds(new Set()); setSelectMode(false); setAnchorIdx(null); }}`,
  `          onClose={() => { setDrawer(null); clearSelection(); }}`,
  "drawer selection cleanup",
);

if (app.includes("setSelectedIds") || app.includes("setAnchorIdx") || app.includes("setActiveDragId")) {
  throw new Error("Task 3.4 ownership remains in App.tsx");
}
if (app.includes("const handleToggleSelect = useCallback") || app.includes("const handleDragEnd = useCallback")) {
  throw new Error("Task 3.4 handlers remain in App.tsx");
}
writeFileSync(appPath, app);

mkdirSync("src/features/selection", { recursive: true });
writeFileSync("src/features/selection/useBeatSelection.ts", `import { useCallback, useEffect, useState } from "react";\nimport type { Beat } from "../../types";\n\nexport type BeatSelection = {\n  selectedIds: Set<string>;\n  selectMode: boolean;\n  toggleSelection: (beat: Beat | null, shiftKey: boolean, currentFiltered: Beat[]) => void;\n  toggleSelectAll: (displayedBeats: Beat[]) => void;\n  finishSelection: () => void;\n  clearSelection: () => void;\n};\n\nexport function useBeatSelection(beats: Beat[]): BeatSelection {\n  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());\n  const [selectMode, setSelectMode] = useState(false);\n  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);\n\n  const clearSelection = useCallback(() => {\n    setSelectedIds(new Set());\n    setSelectMode(false);\n    setAnchorIdx(null);\n  }, []);\n\n  const finishSelection = clearSelection;\n\n  const toggleSelection = useCallback((beat: Beat | null, shiftKey: boolean, currentFiltered: Beat[]) => {\n    if (!beat) {\n      setSelectMode(true);\n      return;\n    }\n\n    const idx = currentFiltered.findIndex(item => item.id === beat.id);\n    if (idx < 0) return;\n\n    if (shiftKey && anchorIdx !== null) {\n      const lo = Math.min(idx, anchorIdx);\n      const hi = Math.max(idx, anchorIdx);\n      // Windows-style range selection: replace the previous range instead of\n      // adding to it. The anchor stays fixed until a non-shift click.\n      setSelectedIds(new Set(currentFiltered.slice(lo, hi + 1).map(item => item.id)));\n    } else {\n      setSelectedIds(current => {\n        const next = new Set(current);\n        next.has(beat.id) ? next.delete(beat.id) : next.add(beat.id);\n        return next;\n      });\n      setAnchorIdx(idx);\n    }\n\n    setSelectMode(true);\n  }, [anchorIdx]);\n\n  const toggleSelectAll = useCallback((displayedBeats: Beat[]) => {\n    setSelectedIds(current => {\n      const allSelected = displayedBeats.every(beat => current.has(beat.id));\n      return allSelected ? new Set() : new Set(displayedBeats.map(beat => beat.id));\n    });\n  }, []);\n\n  useEffect(() => {\n    const liveIds = new Set(beats.map(beat => beat.id));\n    setSelectedIds(current => {\n      const next = new Set(Array.from(current).filter(id => liveIds.has(id)));\n      return next.size === current.size ? current : next;\n    });\n    if (beats.length === 0) setAnchorIdx(null);\n  }, [beats]);\n\n  return {\n    selectedIds,\n    selectMode,\n    toggleSelection,\n    toggleSelectAll,\n    finishSelection,\n    clearSelection,\n  };\n}\n`);

writeFileSync("src/features/library/useLibraryReorder.ts", `import { useCallback, useState, type Dispatch, type SetStateAction } from "react";\nimport { type DragEndEvent, type DragStartEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";\nimport { arrayMove } from "@dnd-kit/sortable";\nimport type { Beat } from "../../types";\nimport { reorderBeats } from "../../lib/tauri";\nimport type { SortKey } from "./libraryPresentationCache";\n\ntype Params = {\n  sortBy: SortKey;\n  setSortBy: Dispatch<SetStateAction<SortKey>>;\n  setBeats: Dispatch<SetStateAction<Beat[]>>;\n};\n\nexport function useLibraryReorder({ sortBy, setSortBy, setBeats }: Params) {\n  const [activeDragId, setActiveDragId] = useState<string | null>(null);\n  const sensors = useSensors(\n    useSensor(PointerSensor, {\n      activationConstraint: { delay: 140, tolerance: 6 },\n    }),\n  );\n\n  const handleDragStart = useCallback((event: DragStartEvent) => {\n    const id = String(event.active.id);\n    setActiveDragId(id);\n    if (sortBy !== "rating") setSortBy("manual");\n  }, [sortBy, setSortBy]);\n\n  const handleDragEnd = useCallback((event: DragEndEvent) => {\n    const activeId = String(event.active.id);\n    const overId = event.over ? String(event.over.id) : null;\n    setActiveDragId(null);\n    if (!overId || activeId === overId) return;\n\n    setBeats(current => {\n      const oldIndex = current.findIndex(beat => beat.id === activeId);\n      const newIndex = current.findIndex(beat => beat.id === overId);\n      if (oldIndex === -1 || newIndex === -1) return current;\n\n      if (sortBy === "rating") {\n        const moved = current[oldIndex];\n        const target = current[newIndex];\n        if (moved.rating !== target.rating) return current;\n      }\n\n      const next = arrayMove(current, oldIndex, newIndex);\n      reorderBeats(next.map(beat => beat.id)).catch(console.error);\n      return next;\n    });\n  }, [sortBy, setBeats]);\n\n  const handleDragCancel = useCallback(() => {\n    setActiveDragId(null);\n  }, []);\n\n  return { sensors, activeDragId, handleDragStart, handleDragEnd, handleDragCancel };\n}\n`);

writeFileSync("tests/component-dom/beatSelection.test.tsx", `// @vitest-environment jsdom\nimport React, { act } from "react";\nimport { createRoot, type Root } from "react-dom/client";\nimport { afterEach, describe, expect, it } from "vitest";\nimport type { Beat } from "../../src/types";\nimport { useBeatSelection, type BeatSelection } from "../../src/features/selection/useBeatSelection";\n\n(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;\nlet host: HTMLDivElement | null = null;\nlet root: Root | null = null;\nlet latest: BeatSelection | null = null;\nlet currentBeats: Beat[] = [];\n\nconst beat = (id: string): Beat => ({ id, name: id, bpm: 120, key: "c", tags: [], rating: 0 } as Beat);\n\nfunction Harness() { latest = useBeatSelection(currentBeats); return <div />; }\nasync function render(beats: Beat[]) {\n  currentBeats = beats;\n  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);\n  await act(async () => { root!.render(<Harness />); });\n}\nasync function rerender(beats: Beat[]) { currentBeats = beats; await act(async () => { root!.render(<Harness />); }); }\n\nafterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); host = null; latest = null; currentBeats = []; });\n\ndescribe("useBeatSelection", () => {\n  it("preserves single toggle, fixed-anchor Shift range, select all and cleanup", async () => {\n    const beats = [beat("a"), beat("b"), beat("c"), beat("d")];\n    await render(beats);\n    await act(async () => { latest!.toggleSelection(beats[1], false, beats); });\n    expect([...latest!.selectedIds]).toEqual(["b"]);\n    expect(latest!.selectMode).toBe(true);\n    await act(async () => { latest!.toggleSelection(beats[3], true, beats); });\n    expect([...latest!.selectedIds]).toEqual(["b", "c", "d"]);\n    await act(async () => { latest!.toggleSelection(beats[2], true, beats); });\n    expect([...latest!.selectedIds]).toEqual(["b", "c"]);\n    await act(async () => { latest!.toggleSelectAll(beats); });\n    expect([...latest!.selectedIds]).toEqual(["a", "b", "c", "d"]);\n    await rerender([beats[0], beats[2]]);\n    expect([...latest!.selectedIds]).toEqual(["a", "c"]);\n    await act(async () => { latest!.finishSelection(); });\n    expect(latest!.selectedIds.size).toBe(0);\n    expect(latest!.selectMode).toBe(false);\n  });\n});\n`);

writeFileSync("tests/integration/selectionReorderExtraction.test.ts", `import { readFileSync } from "node:fs";\nimport { resolve } from "node:path";\nimport { describe, expect, it } from "vitest";\n\nconst app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst selection = readFileSync(resolve(process.cwd(), "src/features/selection/useBeatSelection.ts"), "utf8");\nconst reorder = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryReorder.ts"), "utf8");\n\ndescribe("task 3.4 extraction wiring", () => {\n  it("moves selection ownership out of App while preserving Shift and reconciliation contracts", () => {\n    expect(app).toContain("useBeatSelection(beats)");\n    expect(app).toContain("toggleSelection(b, e.shiftKey, filteredBeats)");\n    expect(app).not.toContain("const [selectedIds, setSelectedIds]");\n    expect(app).not.toContain("const handleToggleSelect = useCallback");\n    expect(selection).toContain("currentFiltered.slice(lo, hi + 1)");\n    expect(selection).toContain("const liveIds = new Set(beats.map(beat => beat.id))");\n  });\n\n  it("moves reorder ownership out of App and preserves rating-group limits", () => {\n    expect(app).toContain("useLibraryReorder({ sortBy, setSortBy, setBeats })");\n    expect(app).not.toContain("const handleDragEnd = useCallback");\n    expect(app).not.toContain("reorderBeats(next.map((b) => b.id))");\n    expect(reorder).toContain('if (sortBy !== "rating") setSortBy("manual")');\n    expect(reorder).toContain("if (moved.rating !== target.rating) return current");\n    expect(reorder).toContain("reorderBeats(next.map(beat => beat.id))");\n  });\n});\n`);

const viewTestPath = "tests/integration/libraryViewExtraction.test.ts";
let viewTest = readFileSync(viewTestPath, "utf8");
viewTest = replaceOnce(
  viewTest,
  `  it("does not begin task 3.4 selection/reorder extraction", () => {\n    expect(app).toContain("const handleToggleSelect = useCallback");\n    expect(app).toContain("const handleDragEnd = useCallback");\n    expect(app).toContain("reorderBeats(next.map((b) => b.id))");\n  });`,
  `  it("hands task 3.4 selection/reorder ownership to its dedicated modules", () => {\n    expect(app).toContain("useBeatSelection(beats)");\n    expect(app).toContain("useLibraryReorder({ sortBy, setSortBy, setBeats })");\n  });`,
  "update 3.3 boundary assertion",
);
writeFileSync(viewTestPath, viewTest);

console.log("Task 3.4 extraction applied successfully.");
