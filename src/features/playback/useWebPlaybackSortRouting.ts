import { useEffect, useRef } from "react";
import type { Beat } from "../../types";
import {
  updatePlaybackRoutingSort,
  type WebPlaybackSort,
} from "./webPlaybackRoutingCache";

/**
 * Keeps the persisted Web startup selection in lockstep with the UI sort.
 * The effect is intentionally keyed only by the user's sort choice: ordinary
 * library mutations update routing through their existing authoritative paths.
 */
export function useWebPlaybackSortRouting(
  sortBy: WebPlaybackSort,
  beats: readonly Beat[],
  enabled: boolean,
): void {
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  useEffect(() => {
    if (!enabled) return;
    updatePlaybackRoutingSort(sortBy, beatsRef.current);
  }, [enabled, sortBy]);
}
