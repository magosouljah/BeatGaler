import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Beat } from "../../types";
import {
  discardImportReviewBatch,
  getImportReviewBatchSummary,
  prepareNextImportReviewBeat,
  startImportReviewStream,
  type ImportBatchPreview,
} from "../../lib/tauri";
import { appAlert } from "../../lib/dialog";
import { cleanTags } from "../../lib/metadataValidation";
import { fileNameFromPath } from "../dragdrop/pathHelpers";
import { reviewPerfMark } from "../perf/reviewPerf";
import { reviewSourceKey, type ImportReviewQueueState } from "./useImportSession";

export type ImportDiscoveryServices = {
  startStream: typeof startImportReviewStream;
  prepareNext: typeof prepareNextImportReviewBeat;
  getSummary: typeof getImportReviewBatchSummary;
  discardBatch: typeof discardImportReviewBatch;
};

const defaultServices: ImportDiscoveryServices = {
  startStream: startImportReviewStream,
  prepareNext: prepareNextImportReviewBeat,
  getSummary: getImportReviewBatchSummary,
  discardBatch: discardImportReviewBatch,
};

type UseImportDiscoveryOptions = {
  dropImporting: boolean;
  setDropImporting: Dispatch<SetStateAction<boolean>>;
  rejectOfflineMutation: (action: string) => boolean;
  setDropActive: Dispatch<SetStateAction<boolean>>;
  setShowAdd: Dispatch<SetStateAction<boolean>>;
  setDeferredImportBatch: Dispatch<SetStateAction<ImportBatchPreview | null>>;
  setAudioConflictBatch: Dispatch<SetStateAction<ImportBatchPreview | null>>;
  setDropImportBatch: Dispatch<SetStateAction<ImportBatchPreview | null>>;
  setReviewQueue: Dispatch<SetStateAction<ImportReviewQueueState | null>>;
  skippedReviewSourceKeysRef: MutableRefObject<Set<string>>;
  stagedImportPathsRef: MutableRefObject<Map<string, string[]>>;
  skeletonEnabled: boolean;
  services?: ImportDiscoveryServices;
};

export function useImportDiscovery({
  dropImporting,
  setDropImporting,
  rejectOfflineMutation,
  setDropActive,
  setShowAdd,
  setDeferredImportBatch,
  setAudioConflictBatch,
  setDropImportBatch,
  setReviewQueue,
  skippedReviewSourceKeysRef,
  stagedImportPathsRef,
  skeletonEnabled,
  services = defaultServices,
}: UseImportDiscoveryOptions) {
  const [reviewBootstrap, setReviewBootstrap] = useState<{ total: number | null } | null>(null);
  const [reviewPreparationDone, setReviewPreparationDone] = useState(true);
  const reviewPreparationRunRef = useRef(0);
  const reviewPreparationPromiseRef = useRef<Promise<Beat[]> | null>(null);
  // Every import gesture gets its own generation. Cancel/replacement
  // invalidates the generation so late async results can only discard.
  const importReviewRequestRunRef = useRef(0);

  const completeImmediateReviewPreparation = useCallback(() => {
    setReviewPreparationDone(true);
    setReviewBootstrap(null);
  }, []);

  const cancelPendingReviewWork = useCallback(() => {
    importReviewRequestRunRef.current += 1;
    reviewPreparationRunRef.current += 1;
    reviewPreparationPromiseRef.current = null;
    setReviewPreparationDone(true);
    setReviewBootstrap(null);
    setAudioConflictBatch(null);
    setDeferredImportBatch(current => {
      if (current?.batch_id) void services.discardBatch(current.batch_id);
      return null;
    });
  }, [services, setAudioConflictBatch, setDeferredImportBatch]);

  const importDroppedPaths = useCallback(async (paths: string[]) => {
    if (rejectOfflineMutation("Importing beats")) return;
    const normalized = Array.from(new Set(paths.map(path => path.trim()).filter(Boolean)));
    if (normalized.length === 0 || dropImporting) return;

    const dropStarted = performance.now();
    const diagRun = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    reviewPerfMark(`run=${diagRun} IMPORT_BEGIN path_count=${normalized.length} names=${normalized.map(fileNameFromPath).slice(0, 12).join("|")}`);
    const requestRunId = ++importReviewRequestRunRef.current;
    setDropImporting(true);
    setReviewPreparationDone(false);
    setDeferredImportBatch(null);
    setAudioConflictBatch(null);
    setDropImportBatch(null);
    skippedReviewSourceKeysRef.current.clear();
    if (skeletonEnabled) {
      setReviewBootstrap({ total: null });
      reviewPerfMark(`run=${diagRun} SKELETON_STATE_REQUESTED elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      requestAnimationFrame(() => reviewPerfMark(`run=${diagRun} SKELETON_FRAME elapsed_ms=${Math.round(performance.now() - dropStarted)}`));
    }
    console.info("[review-perf] DROP_RECEIVED 0 ms");

    try {
      // Starting the stream creates only a cursor. Recursive discovery
      // remains lazy so Beat 1 never waits for the full tree.
      reviewPerfMark(`run=${diagRun} STREAM_INVOKE_START elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      const stream = await services.startStream(normalized);
      reviewPerfMark(`run=${diagRun} STREAM_INVOKE_END elapsed_ms=${Math.round(performance.now() - dropStarted)} batch=${stream.batch_id}`);
      if (importReviewRequestRunRef.current !== requestRunId) {
        void services.discardBatch(stream.batch_id);
        return;
      }
      stagedImportPathsRef.current.set(stream.batch_id, normalized);
      console.info(`[review-perf] STREAM_READY ${Math.round(performance.now() - dropStarted)} ms`);

      // Critical path: stop as soon as the first normal playable beat
      // is prepared. N remains unknown until the background worker ends.
      reviewPerfMark(`run=${diagRun} FIRST_PREPARE_INVOKE_START elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      const firstStep = await services.prepareNext(stream.batch_id);
      reviewPerfMark(`run=${diagRun} FIRST_PREPARE_INVOKE_END elapsed_ms=${Math.round(performance.now() - dropStarted)} has_beat=${Boolean(firstStep.beat)} discovery_complete=${firstStep.discovery_complete}`);
      if (importReviewRequestRunRef.current !== requestRunId) {
        stagedImportPathsRef.current.delete(stream.batch_id);
        void services.discardBatch(stream.batch_id);
        return;
      }

      const first = firstStep.beat
        ? { ...firstStep.beat, tags: cleanTags(firstStep.beat.tags || []).tags }
        : null;

      if (first) {
        setShowAdd(false);
        setReviewQueue({
          beats: [first],
          index: 0,
          total: firstStep.total_normal,
          batchId: stream.batch_id,
          preparing: !firstStep.discovery_complete,
        });
        reviewPerfMark(`run=${diagRun} FIRST_REVIEW_STATE_SET elapsed_ms=${Math.round(performance.now() - dropStarted)} beat=${first.name}`);

        // Do not start Beat 2..N work until the first Review drawer had
        // a browser frame. This preserves the direct skeleton handoff.
        await new Promise<void>(resolve => {
          requestAnimationFrame(() => {
            reviewPerfMark(`run=${diagRun} FIRST_REVIEW_FRAME elapsed_ms=${Math.round(performance.now() - dropStarted)} beat=${first.name}`);
            resolve();
          });
        });
        setReviewBootstrap(null);
        reviewPerfMark(`run=${diagRun} BACKGROUND_ALLOWED elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
        console.info(`[review-perf] FIRST_REVIEW_READY ${Math.round(performance.now() - dropStarted)} ms`);
      } else if (firstStep.discovery_complete) {
        const summary = await services.getSummary(stream.batch_id);
        if (importReviewRequestRunRef.current !== requestRunId) {
          stagedImportPathsRef.current.delete(stream.batch_id);
          void services.discardBatch(stream.batch_id);
          return;
        }
        setDeferredImportBatch(summary);
        setReviewBootstrap(null);
        setReviewPreparationDone(true);
        if (summary.audio_conflicts.length > 0) {
          setAudioConflictBatch(summary);
        } else if (summary.pending.length > 0) {
          setDropImportBatch(summary);
        } else {
          stagedImportPathsRef.current.delete(stream.batch_id);
          setDeferredImportBatch(null);
          await services.discardBatch(stream.batch_id);
          await appAlert({ title: "Nothing to import", message: "No playable beats were found in the dropped files." });
        }
        return;
      }

      const runId = ++reviewPreparationRunRef.current;
      const preparation = (async () => {
        const prepared: Beat[] = first ? [first] : [];
        let step = firstStep;

        // Continue from the same cursor one beat at a time and yield
        // between steps so Review remains interactive during big trees.
        while (!step.discovery_complete && reviewPreparationRunRef.current === runId && importReviewRequestRunRef.current === requestRunId) {
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          const bgIndex = prepared.length + 1;
          const bgStarted = performance.now();
          reviewPerfMark(`run=${diagRun} BACKGROUND_PREPARE_START n=${bgIndex} elapsed_ms=${Math.round(bgStarted - dropStarted)}`);
          step = await services.prepareNext(stream.batch_id);
          reviewPerfMark(`run=${diagRun} BACKGROUND_PREPARE_END n=${bgIndex} step_ms=${Math.round(performance.now() - bgStarted)} elapsed_ms=${Math.round(performance.now() - dropStarted)} has_beat=${Boolean(step.beat)} done=${step.discovery_complete}`);
          if (reviewPreparationRunRef.current !== runId || importReviewRequestRunRef.current !== requestRunId) break;

          if (step.beat) {
            const nextBeat = { ...step.beat, tags: cleanTags(step.beat.tags || []).tags };
            prepared.push(nextBeat);
            const sourceKey = reviewSourceKey(nextBeat);
            setReviewQueue(queue => {
              if (!queue || queue.batchId !== stream.batch_id) return queue;
              if (sourceKey && skippedReviewSourceKeysRef.current.has(sourceKey)) return {
                ...queue,
                total: step.total_normal ?? queue.total,
                preparing: !step.discovery_complete,
              };
              if (sourceKey && queue.beats.some(item => reviewSourceKey(item) === sourceKey)) return queue;
              return {
                ...queue,
                beats: [...queue.beats, nextBeat],
                total: step.total_normal ?? queue.total,
                preparing: !step.discovery_complete,
              };
            });
          }
        }

        if (reviewPreparationRunRef.current !== runId || importReviewRequestRunRef.current !== requestRunId) {
          return prepared;
        }

        const summary = await services.getSummary(stream.batch_id);
        if (reviewPreparationRunRef.current !== runId || importReviewRequestRunRef.current !== requestRunId) {
          return prepared;
        }
        setDeferredImportBatch(summary);
        setReviewPreparationDone(true);
        console.info(`[review-perf] DISCOVERY_FINISHED ${Math.round(performance.now() - dropStarted)} ms (${summary.normal_count} normal, ${summary.audio_conflicts.length} conflict)`);
        reviewPerfMark(`run=${diagRun} DISCOVERY_FINISHED elapsed_ms=${Math.round(performance.now() - dropStarted)} normal=${summary.normal_count} conflicts=${summary.audio_conflicts.length}`);

        setReviewQueue(queue => {
          if (!queue || queue.batchId !== stream.batch_id) return queue;
          // If Save/Skip already moved beyond the now-known N, close
          // instead of leaving a permanent loading skeleton.
          if (queue.index >= summary.normal_count) return null;
          return { ...queue, total: summary.normal_count, preparing: false };
        });
        return prepared;
      })();
      reviewPreparationPromiseRef.current = preparation;

      void preparation.catch(async error => {
        console.error("Background streaming Review preparation failed:", error);
        if (reviewPreparationRunRef.current === runId && importReviewRequestRunRef.current === requestRunId) {
          setReviewPreparationDone(true);
          setReviewQueue(queue => queue && queue.batchId === stream.batch_id ? { ...queue, preparing: false } : queue);
          setReviewBootstrap(null);
          await appAlert({ title: "Review preparation failed", message: String(error), danger: true });
        }
      });
    } catch (error) {
      reviewPerfMark(`run=${diagRun} IMPORT_ERROR elapsed_ms=${Math.round(performance.now() - dropStarted)} error=${String(error)}`);
      console.error(error);
      setReviewBootstrap(null);
      setReviewPreparationDone(true);
      await appAlert({ title: "Import failed", message: `Could not import the dropped files: ${String(error)}`, danger: true });
    } finally {
      setDropImporting(false);
      setDropActive(false);
    }
  }, [
    dropImporting,
    rejectOfflineMutation,
    services,
    setAudioConflictBatch,
    setDeferredImportBatch,
    setDropActive,
    setDropImportBatch,
    setDropImporting,
    setReviewQueue,
    setShowAdd,
    skippedReviewSourceKeysRef,
    skeletonEnabled,
    stagedImportPathsRef,
  ]);

  return {
    reviewBootstrap,
    reviewPreparationDone,
    reviewPreparationPromiseRef,
    importDroppedPaths,
    cancelPendingReviewWork,
    completeImmediateReviewPreparation,
  };
}
