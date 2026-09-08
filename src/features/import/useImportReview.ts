import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Beat } from "../../types";
import { reviewSourceKey, type ImportReviewQueueState } from "./useImportSession";

type UseImportReviewOptions = {
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  beatsLatestRef: MutableRefObject<Beat[]>;
  setReviewQueue: Dispatch<SetStateAction<ImportReviewQueueState | null>>;
  skippedReviewSourceKeysRef: MutableRefObject<Set<string>>;
  cloudifyImportedBeats: (beats: Beat[]) => void;
  getQueuedBeatsSnapshot: () => Beat[];
  onCancelPendingWork: () => void;
  releaseBeat?: (beatId: string) => void;
  discardBatch: (batchId: string) => void | Promise<unknown>;
  cleanupStaging: (protectedBeats: Beat[]) => void | Promise<unknown>;
};

export function useImportReview({
  setBeats,
  beatsLatestRef,
  setReviewQueue,
  skippedReviewSourceKeysRef,
  cloudifyImportedBeats,
  getQueuedBeatsSnapshot,
  onCancelPendingWork,
  releaseBeat,
  discardBatch,
  cleanupStaging,
}: UseImportReviewOptions) {
  const cleanupUnusedStaging = useCallback(() => {
    window.setTimeout(() => {
      void cleanupStaging([
        ...beatsLatestRef.current,
        ...getQueuedBeatsSnapshot(),
      ]);
    }, 0);
  }, [beatsLatestRef, cleanupStaging, getQueuedBeatsSnapshot]);

  const skipCurrentReviewBeat = useCallback(() => {
    setReviewQueue(queue => {
      if (!queue) return null;
      const currentBeat = queue.beats[queue.index];
      const sourceKey = currentBeat ? reviewSourceKey(currentBeat) : "";
      if (sourceKey) skippedReviewSourceKeysRef.current.add(sourceKey);
      if (currentBeat) releaseBeat?.(currentBeat.id);

      const knownLast = queue.total !== null && queue.index >= queue.total - 1;
      if (knownLast && !queue.preparing) {
        cleanupUnusedStaging();
        return null;
      }
      // Discovery may still be filling Beat N+1. Advancing the cursor
      // preserves the existing skeleton handoff without owning discovery.
      return { ...queue, index: queue.index + 1 };
    });
  }, [cleanupUnusedStaging, releaseBeat, setReviewQueue, skippedReviewSourceKeysRef]);

  const cancelReview = useCallback(() => {
    onCancelPendingWork();
    skippedReviewSourceKeysRef.current.clear();
    setReviewQueue(queue => {
      if (!queue) return null;
      for (const beat of queue.beats.slice(queue.index)) releaseBeat?.(beat.id);
      if (queue.batchId) void discardBatch(queue.batchId);
      cleanupUnusedStaging();
      return null;
    });
  }, [cleanupUnusedStaging, discardBatch, onCancelPendingWork, releaseBeat, setReviewQueue, skippedReviewSourceKeysRef]);

  const handleReviewedBeatSaved = useCallback((updated: Beat) => {
    setBeats(current => {
      const exists = current.some(beat => beat.id === updated.id);
      const next = exists
        ? current.map(beat => beat.id === updated.id ? updated : beat)
        : [updated, ...current];
      beatsLatestRef.current = next;
      return next;
    });
    setReviewQueue(queue => {
      if (!queue) return null;
      const nextBeats = queue.beats.map(beat => beat.id === updated.id ? updated : beat);
      const knownLast = queue.total !== null && queue.index >= queue.total - 1;
      if (knownLast && !queue.preparing) return null;
      return { ...queue, beats: nextBeats, index: queue.index + 1 };
    });

    // Save/next stays immediate; the extracted cloud queue owns upload work.
    cloudifyImportedBeats([updated]);
  }, [beatsLatestRef, cloudifyImportedBeats, setBeats, setReviewQueue]);

  return {
    skipCurrentReviewBeat,
    cancelReview,
    handleReviewedBeatSaved,
  };
}
