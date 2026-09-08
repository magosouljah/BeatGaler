import { useCallback, useEffect, useState } from "react";
import type { Beat } from "../../types";

export type BeatSelection = {
  selectedIds: Set<string>;
  selectMode: boolean;
  toggleSelection: (beat: Beat | null, shiftKey: boolean, currentFiltered: Beat[]) => void;
  toggleSelectAll: (displayedBeats: Beat[]) => void;
  finishSelection: () => void;
  clearSelection: () => void;
};

export function useBeatSelection(beats: Beat[]): BeatSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectMode(false);
    setAnchorIdx(null);
  }, []);

  const finishSelection = clearSelection;

  const toggleSelection = useCallback((beat: Beat | null, shiftKey: boolean, currentFiltered: Beat[]) => {
    if (!beat) {
      setSelectMode(true);
      return;
    }

    const idx = currentFiltered.findIndex(item => item.id === beat.id);
    if (idx < 0) return;

    if (shiftKey && anchorIdx !== null) {
      const lo = Math.min(idx, anchorIdx);
      const hi = Math.max(idx, anchorIdx);
      // Windows-style range selection: replace the previous range instead of
      // adding to it. The anchor stays fixed until a non-shift click.
      setSelectedIds(new Set(currentFiltered.slice(lo, hi + 1).map(item => item.id)));
    } else {
      setSelectedIds(current => {
        const next = new Set(current);
        next.has(beat.id) ? next.delete(beat.id) : next.add(beat.id);
        return next;
      });
      setAnchorIdx(idx);
    }

    setSelectMode(true);
  }, [anchorIdx]);

  const toggleSelectAll = useCallback((displayedBeats: Beat[]) => {
    setSelectedIds(current => {
      const allSelected = displayedBeats.every(beat => current.has(beat.id));
      return allSelected ? new Set() : new Set(displayedBeats.map(beat => beat.id));
    });
  }, []);

  useEffect(() => {
    const liveIds = new Set(beats.map(beat => beat.id));
    setSelectedIds(current => {
      const next = new Set(Array.from(current).filter(id => liveIds.has(id)));
      return next.size === current.size ? current : next;
    });
    if (beats.length === 0) setAnchorIdx(null);
  }, [beats]);

  return {
    selectedIds,
    selectMode,
    toggleSelection,
    toggleSelectAll,
    finishSelection,
    clearSelection,
  };
}
