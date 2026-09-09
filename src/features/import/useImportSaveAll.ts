import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Beat } from "../../types";
import {
  discardImportReviewBatch,
  saveBeatMeta,
  type ImportBatchPreview,
} from "../../lib/tauri";
import { cleanTags, validateBpm, validateMusicKey } from "../../lib/metadataValidation";
import { cleanupStagedDropPaths } from "../dragdrop/dropStaging";
import type { ImportReviewQueueState } from "./useImportSession";

export type ImportSaveAllServices = {
  saveMeta: typeof saveBeatMeta;
  discardBatch: typeof discardImportReviewBatch;
  cleanupStaging: typeof cleanupStagedDropPaths;
};

const defaultServices: ImportSaveAllServices = {
  saveMeta: saveBeatMeta,
  discardBatch: discardImportReviewBatch,
  cleanupStaging: cleanupStagedDropPaths,
};

type UseImportSaveAllOptions = {
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  beatsLatestRef: MutableRefObject<Beat[]>;
  reviewQueue: ImportReviewQueueState | null;
  setReviewQueue: Dispatch<SetStateAction<ImportReviewQueueState | null>>;
  reviewQueueLatestRef: MutableRefObject<ImportReviewQueueState | null>;
  reviewBootstrap: { total: number | null } | null;
  reviewPreparationDone: boolean;
  reviewPreparationPromiseRef: MutableRefObject<Promise<Beat[]> | null>;
  deferredImportBatch: ImportBatchPreview | null;
  setDeferredImportBatch: Dispatch<SetStateAction<ImportBatchPreview | null>>;
  stagedImportPathsRef: MutableRefObject<Map<string, string[]>>;
  setDropImporting: Dispatch<SetStateAction<boolean>>;
  cloudifyImportedBeats: (beats: Beat[]) => void | Promise<void>;
  addBeatsAndReview: (beats: Beat[]) => void;
  services?: ImportSaveAllServices;
};

export function useImportSaveAll({
  setBeats,
  beatsLatestRef,
  reviewQueue,
  setReviewQueue,
  reviewQueueLatestRef,
  reviewBootstrap,
  reviewPreparationDone,
  reviewPreparationPromiseRef,
  deferredImportBatch,
  setDeferredImportBatch,
  stagedImportPathsRef,
  setDropImporting,
  cloudifyImportedBeats,
  addBeatsAndReview,
  services = defaultServices,
}: UseImportSaveAllOptions) {
  const [bulkSaveAllBusy, setBulkSaveAllBusy] = useState(false);
  const [audioConflictBatch, setAudioConflictBatch] = useState<ImportBatchPreview | null>(null);
  const [dropImportBatch, setDropImportBatch] = useState<ImportBatchPreview | null>(null);

  const resetImportResolutionState = useCallback(() => {
    setDeferredImportBatch(null);
    setAudioConflictBatch(null);
    setDropImportBatch(null);
  }, [setDeferredImportBatch]);

  const handleReviewedSaveAll = useCallback(async (currentUpdated: Beat) => {
    const queue = reviewQueueLatestRef.current;
    if (!queue) return;
    const startIndex = queue.index;
    setBulkSaveAllBusy(true);

    // Save All is a UX command, not a request to wait for Review preparation.
    // Close Review immediately, commit the current beat, then let the same
    // sequential worker finish metadata for the remaining beats in background.
    setReviewQueue(null);
    setBeats(current => {
      const exists = current.some(item => item.id === currentUpdated.id);
      const next = exists
        ? current.map(item => item.id === currentUpdated.id ? currentUpdated : item)
        : [currentUpdated, ...current];
      beatsLatestRef.current = next;
      return next;
    });
    void cloudifyImportedBeats([currentUpdated]);

    let allPrepared = queue.beats;
    if (reviewPreparationPromiseRef.current) {
      try {
        allPrepared = await reviewPreparationPromiseRef.current;
      } catch (error) {
        // The background preparer already surfaces the real error. Save All
        // must still keep already-prepared beats usable instead of rejecting
        // the whole batch promise.
        console.warn("Save All continued with already-prepared beats:", error);
        allPrepared = reviewQueueLatestRef.current?.beats ?? queue.beats;
      }
    }
    const remaining = allPrepared.slice(startIndex + 1);
    const committed: Beat[] = [];
    const nameConflicts: Beat[] = [];

    const queueIds = new Set(allPrepared.map(item => item.id));
    const reservedNames = new Set(
      beatsLatestRef.current
        .filter(item => !queueIds.has(item.id) && item.id !== currentUpdated.id)
        .map(item => item.name.trim().toLocaleLowerCase())
        .filter(Boolean)
    );
    const currentName = currentUpdated.name.trim().toLocaleLowerCase();
    if (currentName) reservedNames.add(currentName);

    for (const beat of remaining) {
      const nameKey = beat.name.trim().toLocaleLowerCase();
      if (nameKey && reservedNames.has(nameKey)) {
        // Duplicate review candidates are not auto-renamed. They are moved to
        // the end so Save All remains fast and the user can choose a real name.
        nameConflicts.push(beat);
        continue;
      }
      if (nameKey) reservedNames.add(nameKey);

      try {
        const bpmCheck = validateBpm(beat.bpm);
        const keyCheck = validateMusicKey(beat.key);
        if (bpmCheck.valid === false) throw new Error(`${beat.name}: ${bpmCheck.reason}`);
        if (keyCheck.valid === false) throw new Error(`${beat.name}: ${keyCheck.reason}`);

        const cleaned = cleanTags(beat.tags);
        const normalized: Beat = {
          ...beat,
          tags: cleaned.tags,
          bpm: bpmCheck.normalized,
          key: keyCheck.normalized,
        };

        const result = await services.saveMeta({
          mp3_path: normalized.mp3_path,
          wav_path: normalized.wav_path,
          bpm: normalized.bpm,
          key: normalized.key,
          tags: normalized.tags,
          rating: normalized.rating,
          image_base64: normalized.image_base64,
          image_preview_base64: normalized.image_preview_base64 ?? null,
          image_crop: normalized.image_crop ?? null,
          update_filename: normalized.bpm !== beat.bpm || normalized.key !== beat.key,
        });

        committed.push({
          ...normalized,
          mp3_path: result.new_mp3_path || normalized.mp3_path,
          wav_path: result.new_wav_path ?? normalized.wav_path,
          playback_path: result.new_mp3_path || normalized.mp3_path || normalized.playback_path,
        });
      } catch (error) {
        console.warn(`Save All could not commit ${beat.name}:`, error);
        nameConflicts.push(beat);
      }

      // Keep WebView responsive even when hundreds of beats are selected.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }

    if (committed.length > 0) {
      const committedIds = new Set(committed.map(beat => beat.id));
      setBeats(current => {
        const next = [
          ...committed,
          ...current.filter(beat => !committedIds.has(beat.id)),
        ];
        beatsLatestRef.current = next;
        return next;
      });
      void cloudifyImportedBeats(committed);
    }

    // Local duplicate/validation conflicts are intentionally last and reopen
    // Review instead of blocking the whole Save All batch.
    if (nameConflicts.length > 0) {
      setReviewQueue({ beats: nameConflicts, index: 0, total: nameConflicts.length, batchId: queue.batchId, preparing: false });
    }
    setBulkSaveAllBusy(false);
  }, [beatsLatestRef, cloudifyImportedBeats, reviewPreparationPromiseRef, reviewQueueLatestRef, services, setBeats, setReviewQueue]);

  // A replacement/cancelled import invalidates any modal state from the old
  // batch. This keeps the old discovery-generation behavior without making
  // discovery own conflict UI state again.
  useEffect(() => {
    const batchId = deferredImportBatch?.batch_id ?? null;
    setAudioConflictBatch(current => current && current.batch_id !== batchId ? null : current);
    setDropImportBatch(current => current && current.batch_id !== batchId ? null : current);
  }, [deferredImportBatch?.batch_id]);

  // Normal Review is always resolved first. Only after preparation is done and
  // Review is closed do deferred native conflicts/decisions get surfaced.
  useEffect(() => {
    if (!deferredImportBatch || !reviewPreparationDone || bulkSaveAllBusy) return;
    if (reviewBootstrap || reviewQueue || audioConflictBatch || dropImportBatch) return;

    if (deferredImportBatch.audio_conflicts.length > 0) {
      setAudioConflictBatch(deferredImportBatch);
      return;
    }
    if (deferredImportBatch.pending.length > 0) {
      setDropImportBatch(deferredImportBatch);
      return;
    }

    const batchId = deferredImportBatch.batch_id;
    stagedImportPathsRef.current.delete(batchId);
    setDeferredImportBatch(null);
    void services.discardBatch(batchId);
  }, [
    audioConflictBatch,
    bulkSaveAllBusy,
    deferredImportBatch,
    dropImportBatch,
    reviewBootstrap,
    reviewPreparationDone,
    reviewQueue,
    services,
    setDeferredImportBatch,
    stagedImportPathsRef,
  ]);

  const cancelAudioConflicts = useCallback(() => {
    if (!audioConflictBatch) return;
    const batchId = audioConflictBatch.batch_id;
    stagedImportPathsRef.current.delete(batchId);
    setAudioConflictBatch(null);
    setDeferredImportBatch(null);
    // Cancel only the unresolved tail. Already-saved normal beats/uploads keep
    // their staged files via the existing protected cleanup path.
    void services.discardBatch(batchId);
  }, [audioConflictBatch, services, setDeferredImportBatch, stagedImportPathsRef]);

  const resolveAudioConflicts = useCallback((resolved: Beat[]) => {
    if (!audioConflictBatch) return;
    const batchId = audioConflictBatch.batch_id;
    setAudioConflictBatch(null);
    setDeferredImportBatch(current => current ? { ...current, audio_conflicts: [] } : current);
    if (resolved.length > 0) {
      setReviewQueue({ beats: resolved, index: 0, total: resolved.length, batchId, preparing: false });
    }
  }, [audioConflictBatch, setDeferredImportBatch, setReviewQueue]);

  const closeImportDecisions = useCallback(() => {
    if (!dropImportBatch) return;
    const batchId = dropImportBatch.batch_id;
    const staged = stagedImportPathsRef.current.get(batchId) ?? [];
    stagedImportPathsRef.current.delete(batchId);
    void services.cleanupStaging(staged);
    void services.discardBatch(batchId);
    setDeferredImportBatch(null);
    setDropImportBatch(null);
    setDropImporting(false);
  }, [dropImportBatch, services, setDeferredImportBatch, setDropImporting, stagedImportPathsRef]);

  const importResolvedDecisions = useCallback((imported: Beat[]) => {
    if (!dropImportBatch) return;
    // Do not delete the captured files here. The imported BeatMeta records still
    // point at them and the Cloud upload may happen seconds later. Deleting the
    // map entry prevents the modal close callback from cleaning those paths.
    stagedImportPathsRef.current.delete(dropImportBatch.batch_id);
    setDeferredImportBatch(null);
    setDropImportBatch(null);
    setDropImporting(false);
    addBeatsAndReview(imported);
  }, [addBeatsAndReview, dropImportBatch, setDeferredImportBatch, setDropImporting, stagedImportPathsRef]);

  return {
    audioConflictBatch,
    dropImportBatch,
    resetImportResolutionState,
    handleReviewedSaveAll,
    cancelAudioConflicts,
    resolveAudioConflicts,
    closeImportDecisions,
    importResolvedDecisions,
  };
}
