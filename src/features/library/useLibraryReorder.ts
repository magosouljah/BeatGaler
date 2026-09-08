import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { type DragEndEvent, type DragStartEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { Beat } from "../../types";
import { reorderBeats } from "../../lib/tauri";
import type { SortKey } from "./components/SortMenu";

type Params = {
  sortBy: SortKey;
  setSortBy: Dispatch<SetStateAction<SortKey>>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
};

export function useLibraryReorder({ sortBy, setSortBy, setBeats }: Params) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 140, tolerance: 6 },
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveDragId(id);
    if (sortBy !== "rating") setSortBy("manual");
  }, [sortBy, setSortBy]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    setActiveDragId(null);
    if (!overId || activeId === overId) return;

    setBeats(current => {
      const oldIndex = current.findIndex(beat => beat.id === activeId);
      const newIndex = current.findIndex(beat => beat.id === overId);
      if (oldIndex === -1 || newIndex === -1) return current;

      if (sortBy === "rating") {
        const moved = current[oldIndex];
        const target = current[newIndex];
        if (moved.rating !== target.rating) return current;
      }

      const next = arrayMove(current, oldIndex, newIndex);
      reorderBeats(next.map(beat => beat.id)).catch(console.error);
      return next;
    });
  }, [sortBy, setBeats]);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  return { sensors, activeDragId, handleDragStart, handleDragEnd, handleDragCancel };
}
