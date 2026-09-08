import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Beat } from "../../types";
import {
  createBeatRuntimeState,
  hydrateBeatRuntimeState,
  transitionBeatRuntimeState,
  type BeatRuntimeEvent,
  type BeatRuntimeState,
} from "./beatRuntimeState";

export type BeatRuntimeRegistry = {
  beatRuntimeStates: Record<string, BeatRuntimeState>;
  beatRuntimeStatesRef: MutableRefObject<Record<string, BeatRuntimeState>>;
  transitionRuntime: (beatId: string, event: BeatRuntimeEvent, beatHint?: Beat) => void;
  forgetRuntimeState: (beatId: string) => void;
  clearReconciledTrashRuntimeStates: () => void;
};

export function useBeatRuntimeRegistry(
  beats: Beat[],
  beatsLatestRef: MutableRefObject<Beat[]>,
): BeatRuntimeRegistry {
  // Definitive per-beat operation model. These states are intentionally session-local:
  // unfinished upload/download/playback work never resurrects after an app restart.
  // Stable Offline availability is re-hydrated from native durable BeatMeta instead.
  const [beatRuntimeStates, setBeatRuntimeStates] = useState<Record<string, BeatRuntimeState>>({});
  const beatRuntimeStatesRef = useRef<Record<string, BeatRuntimeState>>({});
  useEffect(() => { beatRuntimeStatesRef.current = beatRuntimeStates; }, [beatRuntimeStates]);

  const transitionRuntime = useCallback((beatId: string, event: BeatRuntimeEvent, beatHint?: Beat) => {
    setBeatRuntimeStates(current => {
      const beat = beatHint ?? beatsLatestRef.current.find(item => item.id === beatId);
      const base = current[beatId] ?? createBeatRuntimeState(beat);
      try {
        const nextState = transitionBeatRuntimeState(base, event);
        if (nextState === base) return current;
        return { ...current, [beatId]: nextState };
      } catch (error) {
        // A rejected transition is a programming bug, not a user-facing failure.
        // Keep the last valid state so races cannot corrupt the machine.
        console.warn(`Beat runtime transition rejected for ${beatId}:`, event.type, error);
        return current;
      }
    });
  }, [beatsLatestRef]);

  const forgetRuntimeState = useCallback((beatId: string) => {
    setBeatRuntimeStates(current => {
      if (!(beatId in current)) return current;
      const next = { ...current };
      delete next[beatId];
      return next;
    });
  }, []);

  const clearReconciledTrashRuntimeStates = useCallback(() => {
    const visibleIds = new Set(beatsLatestRef.current.map(beat => beat.id));
    setBeatRuntimeStates(current => {
      let changed = false;
      const next = { ...current };
      for (const [id, runtime] of Object.entries(current)) {
        if (!visibleIds.has(id) && runtime.trash_sync_required) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [beatsLatestRef]);

  useEffect(() => {
    // Library reloads/Telegram refreshes must not overwrite transient machines,
    // but the durable Offline bit always comes from the native source of truth.
    setBeatRuntimeStates(current => {
      const next: Record<string, BeatRuntimeState> = {};
      let changed = false;
      for (const beat of beats) {
        const hydrated = hydrateBeatRuntimeState(current[beat.id], beat);
        next[beat.id] = hydrated;
        if (hydrated !== current[beat.id]) changed = true;
      }
      // A deleting beat leaves the visible library before its cloud-index commit
      // finishes. Keep that transient state (and the Offline Trash intent bit)
      // until the responsible operation explicitly clears it.
      for (const [id, runtime] of Object.entries(current)) {
        if (next[id]) continue;
        if (runtime.sync_state === "deleting" || runtime.trash_sync_required) next[id] = runtime;
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [beats]);

  return {
    beatRuntimeStates,
    beatRuntimeStatesRef,
    transitionRuntime,
    forgetRuntimeState,
    clearReconciledTrashRuntimeStates,
  };
}
