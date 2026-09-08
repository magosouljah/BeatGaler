from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")

def write(rel: str, text: str) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")

def replace_once(rel: str, old: str, new: str) -> None:
    text = read(rel)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{rel}: expected exactly one occurrence, found {count}: {old[:120]!r}")
    write(rel, text.replace(old, new, 1))

def replace_between(rel: str, start: str, end: str, replacement: str) -> None:
    text = read(rel)
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f"{rel}: start marker missing: {start!r}")
    b = text.find(end, a + len(start))
    if b < 0:
        raise RuntimeError(f"{rel}: end marker missing: {end!r}")
    write(rel, text[:a] + replacement + text[b:])

# ---------------------------------------------------------------------------
# useImportDiscovery: discovery owns its deferred summary, but no longer owns
# the decision/audio-conflict modal state introduced by task 7.3.
# ---------------------------------------------------------------------------
discovery = "src/features/import/useImportDiscovery.ts"
replace_once(discovery,
'''  setDeferredImportBatch: Dispatch<SetStateAction<ImportBatchPreview | null>>;\n  setAudioConflictBatch: Dispatch<SetStateAction<ImportBatchPreview | null>>;\n  setDropImportBatch: Dispatch<SetStateAction<ImportBatchPreview | null>>;\n''', '')
replace_once(discovery,
'''  setDeferredImportBatch,\n  setAudioConflictBatch,\n  setDropImportBatch,\n''', '')
replace_once(discovery,
'''  const [reviewPreparationDone, setReviewPreparationDone] = useState(true);\n  const reviewPreparationRunRef = useRef(0);\n''',
'''  const [reviewPreparationDone, setReviewPreparationDone] = useState(true);\n  const [deferredImportBatch, setDeferredImportBatch] = useState<ImportBatchPreview | null>(null);\n  const reviewPreparationRunRef = useRef(0);\n''')
replace_once(discovery,
'''    setReviewPreparationDone(true);\n    setReviewBootstrap(null);\n    setAudioConflictBatch(null);\n    setDeferredImportBatch(current => {\n      if (current?.batch_id) void services.discardBatch(current.batch_id);\n      return null;\n    });\n  }, [services, setAudioConflictBatch, setDeferredImportBatch]);\n''',
'''    setReviewPreparationDone(true);\n    setReviewBootstrap(null);\n    setDeferredImportBatch(current => {\n      if (current?.batch_id) void services.discardBatch(current.batch_id);\n      return null;\n    });\n  }, [services]);\n''')
replace_once(discovery,
'''    setReviewPreparationDone(false);\n    setDeferredImportBatch(null);\n    setAudioConflictBatch(null);\n    setDropImportBatch(null);\n    skippedReviewSourceKeysRef.current.clear();\n''',
'''    setReviewPreparationDone(false);\n    setDeferredImportBatch(null);\n    skippedReviewSourceKeysRef.current.clear();\n''')
replace_once(discovery,
'''        setDeferredImportBatch(summary);\n        setReviewBootstrap(null);\n        setReviewPreparationDone(true);\n        if (summary.audio_conflicts.length > 0) {\n          setAudioConflictBatch(summary);\n        } else if (summary.pending.length > 0) {\n          setDropImportBatch(summary);\n        } else {\n          stagedImportPathsRef.current.delete(stream.batch_id);\n          setDeferredImportBatch(null);\n          await services.discardBatch(stream.batch_id);\n          await appAlert({ title: "Nothing to import", message: "No playable beats were found in the dropped files." });\n        }\n        return;\n''',
'''        setDeferredImportBatch(summary);\n        setReviewBootstrap(null);\n        setReviewPreparationDone(true);\n        if (summary.audio_conflicts.length === 0 && summary.pending.length === 0) {\n          stagedImportPathsRef.current.delete(stream.batch_id);\n          setDeferredImportBatch(null);\n          await services.discardBatch(stream.batch_id);\n          await appAlert({ title: "Nothing to import", message: "No playable beats were found in the dropped files." });\n        }\n        return;\n''')
replace_once(discovery,
'''    services,\n    setAudioConflictBatch,\n    setDeferredImportBatch,\n    setDropActive,\n    setDropImportBatch,\n    setDropImporting,\n''',
'''    services,\n    setDropActive,\n    setDropImporting,\n''')
replace_once(discovery,
'''  return {\n    reviewBootstrap,\n    reviewPreparationDone,\n    reviewPreparationPromiseRef,\n''',
'''  return {\n    reviewBootstrap,\n    reviewPreparationDone,\n    reviewPreparationPromiseRef,\n    deferredImportBatch,\n    setDeferredImportBatch,\n''')

# ---------------------------------------------------------------------------
# New task-7.3 owner.
# ---------------------------------------------------------------------------
write("src/features/import/useImportSaveAll.ts", r'''import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
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
    handleReviewedSaveAll,
    cancelAudioConflicts,
    resolveAudioConflicts,
    closeImportDecisions,
    importResolvedDecisions,
  };
}
''')

# ---------------------------------------------------------------------------
# Review host file also owns the existing modal connections. A named resolution
# host lets App keep the old render position relative to BeatFileDropModal.
# ---------------------------------------------------------------------------
write("src/features/import/components/ImportReviewHost.tsx", r'''import type { ComponentProps } from "react";
import type { Beat } from "../../../types";
import type { ImportBatchPreview } from "../../../lib/tauri";
import Drawer from "../../../components/Drawer";
import ReviewBeatSkeleton from "../../../components/ReviewBeatSkeleton";
import ImportAudioConflictsModal from "../../../components/ImportAudioConflictsModal";
import ImportDecisionsModal from "../../../components/ImportDecisionsModal";
import type { ImportReviewQueueState } from "../useImportSession";

type DrawerProps = ComponentProps<typeof Drawer>;

type ImportReviewHostProps = {
  libraryDropStaging: boolean;
  reviewBootstrap: { total: number | null } | null;
  reviewQueue: ImportReviewQueueState | null;
  skeletonEnabled: boolean;
  tagSuggestions: string[];
  mutationAllowed: boolean;
  onSkipCurrent: () => void;
  onCancel: () => void;
  onSaveAll?: DrawerProps["onSaveAll"];
  isReviewNameTaken: NonNullable<DrawerProps["isReviewNameTaken"]>;
  onCloudMutationCommit?: DrawerProps["onCloudMutationCommit"];
  onSaved: DrawerProps["onSaved"];
  onReleaseAudio: (beat: Beat) => void;
};

type ImportResolutionHostProps = {
  audioConflictBatch: ImportBatchPreview | null;
  dropImportBatch: ImportBatchPreview | null;
  onAudioConflictsCancel: () => void;
  onAudioConflictsResolved: (resolved: Beat[]) => void;
  onImportDecisionsClose: () => void;
  onImportDecisionsImported: (imported: Beat[]) => void;
};

export default function ImportReviewHost({
  libraryDropStaging,
  reviewBootstrap,
  reviewQueue,
  skeletonEnabled,
  tagSuggestions,
  mutationAllowed,
  onSkipCurrent,
  onCancel,
  onSaveAll,
  isReviewNameTaken,
  onCloudMutationCommit,
  onSaved,
  onReleaseAudio,
}: ImportReviewHostProps) {
  const currentBeat = reviewQueue?.beats[reviewQueue.index];

  return (
    <>
      {libraryDropStaging && !reviewBootstrap && !reviewQueue && skeletonEnabled && (
        <ReviewBeatSkeleton current={1} total={null} />
      )}

      {reviewBootstrap && skeletonEnabled && (
        <ReviewBeatSkeleton current={1} total={reviewBootstrap.total} onCancel={onCancel} />
      )}

      {reviewQueue && !currentBeat && skeletonEnabled && (
        <ReviewBeatSkeleton current={reviewQueue.index + 1} total={reviewQueue.total} onCancel={onCancel} />
      )}

      {reviewQueue && currentBeat && (
        <Drawer
          beat={currentBeat}
          mode="edit"
          tagSuggestions={tagSuggestions}
          reviewInfo={{ current: reviewQueue.index + 1, total: reviewQueue.total }}
          closeAfterSave={false}
          onClose={onSkipCurrent}
          onSkipCurrent={onSkipCurrent}
          onSkipAll={onCancel}
          onSaveAll={onSaveAll}
          mutationAllowed={mutationAllowed}
          isReviewNameTaken={isReviewNameTaken}
          onCloudMutationCommit={onCloudMutationCommit}
          onSaved={onSaved}
          onReleaseAudio={() => onReleaseAudio(currentBeat)}
        />
      )}
    </>
  );
}

export function ImportResolutionHost({
  audioConflictBatch,
  dropImportBatch,
  onAudioConflictsCancel,
  onAudioConflictsResolved,
  onImportDecisionsClose,
  onImportDecisionsImported,
}: ImportResolutionHostProps) {
  return (
    <>
      {audioConflictBatch && audioConflictBatch.audio_conflicts.length > 0 && (
        <ImportAudioConflictsModal
          batchId={audioConflictBatch.batch_id}
          conflicts={audioConflictBatch.audio_conflicts}
          onCancel={onAudioConflictsCancel}
          onResolved={onAudioConflictsResolved}
        />
      )}

      {dropImportBatch && (
        <ImportDecisionsModal
          batch={dropImportBatch}
          onClose={onImportDecisionsClose}
          onImported={onImportDecisionsImported}
        />
      )}
    </>
  );
}
''')

# ---------------------------------------------------------------------------
# App wiring only.
# ---------------------------------------------------------------------------
app = "src/App.tsx"
replace_once(app, 'import ImportDecisionsModal from "./components/ImportDecisionsModal";\n', '')
replace_once(app, 'import ImportAudioConflictsModal from "./components/ImportAudioConflictsModal";\n', '')
replace_once(app, 'import { loadLibrary, loadOfflineLibrary, flushOfflineTrashIntents, readBeatMeta, getSettings, saveBeatMeta, discardImportReviewBatch, resolveImportDecisions, ',
                    'import { loadLibrary, loadOfflineLibrary, flushOfflineTrashIntents, readBeatMeta, getSettings, discardImportReviewBatch, ')
replace_once(app, ', type CloudFileType, type ImportBatchPreview, isTauriAvailable } from "./lib/tauri";',
                    ', type CloudFileType, isTauriAvailable } from "./lib/tauri";')
replace_once(app, 'import { cleanTags, validateBpm, validateMusicKey } from "./lib/metadataValidation";',
                    'import { cleanTags } from "./lib/metadataValidation";')
replace_once(app, 'import ImportReviewHost from "./features/import/components/ImportReviewHost";',
                    'import ImportReviewHost, { ImportResolutionHost } from "./features/import/components/ImportReviewHost";')
replace_once(app, 'import { useImportDiscovery } from "./features/import/useImportDiscovery";\n',
                    'import { useImportDiscovery } from "./features/import/useImportDiscovery";\nimport { useImportSaveAll } from "./features/import/useImportSaveAll";\n')
replace_once(app,
'''  const [dropImporting, setDropImporting] = useState(false);\n  const [dropImportBatch, setDropImportBatch] = useState<ImportBatchPreview | null>(null);\n  const [deferredImportBatch, setDeferredImportBatch] = useState<ImportBatchPreview | null>(null);\n  const [audioConflictBatch, setAudioConflictBatch] = useState<ImportBatchPreview | null>(null);\n''',
'''  const [dropImporting, setDropImporting] = useState(false);\n''')
replace_once(app, '  const [bulkSaveAllBusy, setBulkSaveAllBusy] = useState(false);\n', '')
replace_once(app,
'''    reviewPreparationPromiseRef,\n    importDroppedPaths,\n''',
'''    reviewPreparationPromiseRef,\n    deferredImportBatch,\n    setDeferredImportBatch,\n    importDroppedPaths,\n''')
replace_once(app,
'''    setDropActive,\n    setShowAdd,\n    setDeferredImportBatch,\n    setAudioConflictBatch,\n    setDropImportBatch,\n    setReviewQueue,\n''',
'''    setDropActive,\n    setShowAdd,\n    setReviewQueue,\n''')
replace_between(app,
'  const handleReviewedSaveAll = useCallback',
'  const updateExistingBeatFromFolder = useCallback',
'''  const {\n    audioConflictBatch,\n    dropImportBatch,\n    handleReviewedSaveAll,\n    cancelAudioConflicts,\n    resolveAudioConflicts,\n    closeImportDecisions,\n    importResolvedDecisions,\n  } = useImportSaveAll({\n    setBeats,\n    beatsLatestRef,\n    reviewQueue,\n    setReviewQueue,\n    reviewQueueLatestRef,\n    reviewBootstrap,\n    reviewPreparationDone,\n    reviewPreparationPromiseRef,\n    deferredImportBatch,\n    setDeferredImportBatch,\n    stagedImportPathsRef,\n    setDropImporting,\n    cloudifyImportedBeats,\n    addBeatsAndReview,\n  });\n\n  const updateExistingBeatFromFolder = useCallback''')
replace_between(app,
'      {audioConflictBatch && audioConflictBatch.audio_conflicts.length > 0 && (',
'      {(dropActive || dropImporting) && !libraryDropStaging && !reviewBootstrap && !reviewQueue && (',
'''      <ImportResolutionHost\n        audioConflictBatch={audioConflictBatch}\n        dropImportBatch={dropImportBatch}\n        onAudioConflictsCancel={cancelAudioConflicts}\n        onAudioConflictsResolved={resolveAudioConflicts}\n        onImportDecisionsClose={closeImportDecisions}\n        onImportDecisionsImported={importResolvedDecisions}\n      />\n\n      {(dropActive || dropImporting) && !libraryDropStaging && !reviewBootstrap && !reviewQueue && (''')

# ---------------------------------------------------------------------------
# Component behavior tests for Save All + deferred conflict/staging rules.
# ---------------------------------------------------------------------------
write("tests/component-dom/importSaveAll.test.tsx", r'''// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import type { ImportBatchPreview } from "../../src/lib/tauri";
import { useImportSession, type ImportSession } from "../../src/features/import/useImportSession";
import { useImportSaveAll, type ImportSaveAllServices } from "../../src/features/import/useImportSaveAll";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const beat = (id: string, name = id): Beat => ({
  id,
  name,
  bpm: 120,
  key: "c",
  tags: [],
  rating: 0,
  mp3_path: `C:\\staging\\${id}.mp3`,
} as Beat);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

type Latest = {
  session: ImportSession;
  actions: ReturnType<typeof useImportSaveAll>;
  library: Beat[];
  preparationRef: React.MutableRefObject<Promise<Beat[]> | null>;
  setDeferredBatch: React.Dispatch<React.SetStateAction<ImportBatchPreview | null>>;
  stagedRef: React.MutableRefObject<Map<string, string[]>>;
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: Latest | null = null;
let uploads: string[][] = [];
let imported: string[][] = [];
let discarded: string[] = [];
let cleaned: string[][] = [];
let saveMeta = vi.fn();

function Harness() {
  const [library, setLibrary] = useState<Beat[]>([]);
  const beatsLatestRef = useRef<Beat[]>([]);
  const session = useImportSession();
  const preparationRef = useRef<Promise<Beat[]> | null>(null);
  const [deferredBatch, setDeferredBatch] = useState<ImportBatchPreview | null>(null);
  const stagedRef = useRef<Map<string, string[]>>(new Map());
  const services: ImportSaveAllServices = {
    saveMeta: saveMeta as ImportSaveAllServices["saveMeta"],
    discardBatch: (async batchId => { discarded.push(batchId); }) as ImportSaveAllServices["discardBatch"],
    cleanupStaging: (async paths => { cleaned.push([...paths]); }) as ImportSaveAllServices["cleanupStaging"],
  };
  const actions = useImportSaveAll({
    setBeats: setLibrary,
    beatsLatestRef,
    reviewQueue: session.reviewQueue,
    setReviewQueue: session.setReviewQueue,
    reviewQueueLatestRef: session.reviewQueueLatestRef,
    reviewBootstrap: null,
    reviewPreparationDone: true,
    reviewPreparationPromiseRef: preparationRef,
    deferredImportBatch: deferredBatch,
    setDeferredImportBatch: setDeferredBatch,
    stagedImportPathsRef: stagedRef,
    setDropImporting: () => {},
    cloudifyImportedBeats: beats => { uploads.push(beats.map(item => item.id)); },
    addBeatsAndReview: beats => { imported.push(beats.map(item => item.id)); },
    services,
  });
  latest = { session, actions, library, preparationRef, setDeferredBatch, stagedRef };
  return <div />;
}

async function renderHarness() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}

beforeEach(() => {
  uploads = [];
  imported = [];
  discarded = [];
  cleaned = [];
  saveMeta = vi.fn(async (input: { mp3_path: string }) => ({
    new_mp3_path: input.mp3_path,
    new_wav_path: null,
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latest = null;
});

describe("task 7.3 Save All and deferred conflicts", () => {
  it("closes Review and saves the current beat before waiting for background preparation", async () => {
    await renderHarness();
    const first = beat("first");
    const second = beat("second");
    const preparation = deferred<Beat[]>();

    await act(async () => {
      latest!.session.startReview([first], { batchId: "batch-1", total: null, preparing: true });
      latest!.preparationRef.current = preparation.promise;
    });

    let savePromise!: Promise<void>;
    await act(async () => {
      savePromise = latest!.actions.handleReviewedSaveAll(first);
      await Promise.resolve();
    });

    expect(latest!.session.reviewQueue).toBeNull();
    expect(latest!.library.map(item => item.id)).toEqual(["first"]);
    expect(uploads).toEqual([["first"]]);
    expect(saveMeta).not.toHaveBeenCalled();

    preparation.resolve([first, second]);
    await act(async () => { await savePromise; });

    expect(saveMeta).toHaveBeenCalledTimes(1);
    expect(latest!.library.map(item => item.id)).toEqual(["second", "first"]);
    expect(uploads).toEqual([["first"], ["second"]]);
  });

  it("reopens duplicate-name candidates at the end instead of auto-renaming or uploading them", async () => {
    await renderHarness();
    const first = beat("first", "same name");
    const duplicate = beat("duplicate", "same name");

    await act(async () => {
      latest!.session.startReview([first, duplicate], { batchId: "batch-dup", total: 2, preparing: false });
    });
    await act(async () => { await latest!.actions.handleReviewedSaveAll(first); });

    expect(saveMeta).not.toHaveBeenCalled();
    expect(uploads).toEqual([["first"]]);
    expect(latest!.session.reviewQueue?.beats.map(item => item.id)).toEqual(["duplicate"]);
    expect(latest!.session.reviewQueue?.batchId).toBe("batch-dup");
  });

  it("defers audio conflicts until normal Review is closed and cancels only the unresolved tail without deleting staged files", async () => {
    await renderHarness();
    const batch = {
      batch_id: "batch-audio",
      confirmed_count: 0,
      normal_count: 0,
      pending: [],
      audio_conflicts: [{ root_path: "C:\\drop", candidates: ["a.mp3", "b.wav"] }],
    } as unknown as ImportBatchPreview;
    latest!.stagedRef.current.set("batch-audio", ["C:\\staging\\a.mp3"]);

    await act(async () => { latest!.setDeferredBatch(batch); });
    expect(latest!.actions.audioConflictBatch?.batch_id).toBe("batch-audio");
    expect(latest!.stagedRef.current.has("batch-audio")).toBe(true);

    await act(async () => { latest!.actions.cancelAudioConflicts(); });
    expect(latest!.stagedRef.current.has("batch-audio")).toBe(false);
    expect(discarded).toContain("batch-audio");
    expect(cleaned).toEqual([]);
  });

  it("keeps decision-import staging alive when imported beats still point at it", async () => {
    await renderHarness();
    const batch = {
      batch_id: "batch-pending",
      confirmed_count: 0,
      normal_count: 0,
      pending: [{ root_path: "C:\\drop" }],
      audio_conflicts: [],
    } as unknown as ImportBatchPreview;
    latest!.stagedRef.current.set("batch-pending", ["C:\\staging\\kept.mp3"]);

    await act(async () => { latest!.setDeferredBatch(batch); });
    expect(latest!.actions.dropImportBatch?.batch_id).toBe("batch-pending");

    const capturedActions = latest!.actions;
    await act(async () => {
      capturedActions.importResolvedDecisions([beat("resolved")]);
      capturedActions.closeImportDecisions();
    });

    expect(imported).toEqual([["resolved"]]);
    expect(discarded).toContain("batch-pending");
    expect(cleaned).toEqual([[]]);
  });
});
''')

# Discovery test: new hook signature + output ownership.
test_discovery = "tests/component-dom/importDiscovery.test.tsx"
replace_once(test_discovery,
'''  const [, setDeferredImportBatch] = useState<ImportBatchPreview | null>(null);\n  const [, setAudioConflictBatch] = useState<ImportBatchPreview | null>(null);\n  const [, setDropImportBatch] = useState<ImportBatchPreview | null>(null);\n''', '')
replace_once(test_discovery,
'''    setDropActive,\n    setShowAdd,\n    setDeferredImportBatch,\n    setAudioConflictBatch,\n    setDropImportBatch,\n    setReviewQueue: session.setReviewQueue,\n''',
'''    setDropActive,\n    setShowAdd,\n    setReviewQueue: session.setReviewQueue,\n''')

# ---------------------------------------------------------------------------
# Static ownership/characterization checks.
# ---------------------------------------------------------------------------
write("tests/integration/appImportSaveAllExtraction.test.ts", r'''import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const discovery = readFileSync(resolve(process.cwd(), "src/features/import/useImportDiscovery.ts"), "utf8");
const saveAll = readFileSync(resolve(process.cwd(), "src/features/import/useImportSaveAll.ts"), "utf8");
const host = readFileSync(resolve(process.cwd(), "src/features/import/components/ImportReviewHost.tsx"), "utf8");

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing task 7.3 marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 7.3 Save All/conflict extraction", () => {
  it("moves Save All and conflict state/callback ownership out of App while leaving browser import for 7.4", () => {
    expect(app).toContain("useImportSaveAll({");
    expect(app).not.toContain("const handleReviewedSaveAll = useCallback");
    expect(app).not.toContain("setAudioConflictBatch");
    expect(app).not.toContain("setDropImportBatch");
    expect(app).not.toContain("saveBeatMeta({");
    expect(app).toContain("const importDroppedBrowserFiles = useCallback");
    expect(discovery).toContain("const [deferredImportBatch, setDeferredImportBatch]");
    expect(discovery).not.toContain("setAudioConflictBatch");
    expect(discovery).not.toContain("setDropImportBatch");
  });

  it("closes Review before waiting for the shared background worker and sends duplicate/errors back to Review", () => {
    expectOrdered(saveAll, [
      "setReviewQueue(null);",
      "cloudifyImportedBeats([currentUpdated])",
      "if (reviewPreparationPromiseRef.current)",
      "const remaining = allPrepared.slice(startIndex + 1)",
      "if (nameConflicts.length > 0)",
      "setReviewQueue({ beats: nameConflicts",
    ]);
    expect(saveAll).toContain("await services.saveMeta({");
    expect(saveAll).toContain("await new Promise<void>(resolve => window.setTimeout(resolve, 0));");
  });

  it("surfaces native conflicts only after normal Review and keeps staging protected across resolution", () => {
    expectOrdered(saveAll, [
      "if (!deferredImportBatch || !reviewPreparationDone || bulkSaveAllBusy) return;",
      "if (reviewBootstrap || reviewQueue || audioConflictBatch || dropImportBatch) return;",
      "if (deferredImportBatch.audio_conflicts.length > 0)",
      "if (deferredImportBatch.pending.length > 0)",
    ]);
    expect(saveAll).toContain("stagedImportPathsRef.current.delete(dropImportBatch.batch_id);");
    expect(saveAll).toContain("addBeatsAndReview(imported);");
    expect(host).toContain("export function ImportResolutionHost");
    expect(host).toContain("<ImportAudioConflictsModal");
    expect(host).toContain("<ImportDecisionsModal");
    expect(app).toContain("<ImportResolutionHost");
  });
});
''')

# 7.2 static test follows the exported worker at its new consumer.
static_discovery = "tests/integration/appImportDiscoveryExtraction.test.ts"
replace_once(static_discovery,
'const discovery = readFileSync(resolve(process.cwd(), "src/features/import/useImportDiscovery.ts"), "utf8");\n',
'const discovery = readFileSync(resolve(process.cwd(), "src/features/import/useImportDiscovery.ts"), "utf8");\nconst saveAll = readFileSync(resolve(process.cwd(), "src/features/import/useImportSaveAll.ts"), "utf8");\n')
replace_once(static_discovery,
'''  it("moves the progressive discovery owner out of App without moving Save All or browser import", () => {\n''',
'''  it("keeps progressive discovery outside App while Save All consumes its worker and browser import remains for 7.4", () => {\n''')
replace_once(static_discovery,
'''    expect(app).toContain("const handleReviewedSaveAll = useCallback");\n    expect(app).toContain("const importDroppedBrowserFiles = useCallback");\n''',
'''    expect(app).not.toContain("const handleReviewedSaveAll = useCallback");\n    expect(app).toContain("useImportSaveAll({");\n    expect(app).toContain("const importDroppedBrowserFiles = useCallback");\n''')
replace_once(static_discovery,
'''    expect(app).toContain("reviewPreparationPromiseRef,");\n    expect(app).toContain("await reviewPreparationPromiseRef.current");\n''',
'''    expect(app).toContain("reviewPreparationPromiseRef,");\n    expect(saveAll).toContain("await reviewPreparationPromiseRef.current");\n''')

# Task-1.3 characterization: follow Save All into its real owner.
characterization = "tests/integration/appMigrationCharacterization.test.ts"
replace_once(characterization,
'const importReviewHost = readFileSync(resolve(process.cwd(), "src/features/import/components/ImportReviewHost.tsx"), "utf8");\n',
'const importReviewHost = readFileSync(resolve(process.cwd(), "src/features/import/components/ImportReviewHost.tsx"), "utf8");\nconst importSaveAll = readFileSync(resolve(process.cwd(), "src/features/import/useImportSaveAll.ts"), "utf8");\n')
replace_once(characterization,
'    const add = section("const addBeatsAndReview = useCallback", "const handleReviewedSaveAll = useCallback");\n',
'    const add = section("const addBeatsAndReview = useCallback", "const {\\n  skipCurrentReviewBeat,");\n')
replace_once(characterization,
'''    expect(importReviewHost).toContain("onSkipAll={onCancel}");\n    expect(importReviewHost).toContain("onSaved={onSaved}");\n''',
'''    expect(importReviewHost).toContain("onSkipAll={onCancel}");\n    expect(importReviewHost).toContain("onSaved={onSaved}");\n    expectOrdered(importSaveAll, [\n      "setReviewQueue(null);",\n      "cloudifyImportedBeats([currentUpdated])",\n      "if (reviewPreparationPromiseRef.current)",\n      "if (nameConflicts.length > 0)",\n    ]);\n    expect(importSaveAll).toContain("if (deferredImportBatch.audio_conflicts.length > 0)");\n    expect(importSaveAll).toContain("if (deferredImportBatch.pending.length > 0)");\n''')

# Regression guard follows Save All at its new owner rather than weakening it.
regressions = "scripts/run-regressions.mjs"
replace_once(regressions,
'  const importDiscovery = readFileSync(path.join(root, "src", "features", "import", "useImportDiscovery.ts"), "utf8");\n',
'  const importDiscovery = readFileSync(path.join(root, "src", "features", "import", "useImportDiscovery.ts"), "utf8");\n  const importSaveAll = readFileSync(path.join(root, "src", "features", "import", "useImportSaveAll.ts"), "utf8");\n')
replace_once(regressions,
'''  if (!importDiscovery.includes("const reviewPreparationPromiseRef = useRef<Promise<Beat[]> | null>(null)") || !app.includes("reviewPreparationPromiseRef.current")) fail("Save All no longer shares the sequential Review preparation worker.");\n  if (!app.includes("setReviewQueue(null);") || !app.includes("cloudifyImportedBeats([currentUpdated])")) fail("Save All must close Review and upload the current beat without waiting for the rest.");\n''',
'''  if (!importDiscovery.includes("const reviewPreparationPromiseRef = useRef<Promise<Beat[]> | null>(null)") || !importSaveAll.includes("reviewPreparationPromiseRef.current")) fail("Save All no longer shares the sequential Review preparation worker.");\n  if (!importSaveAll.includes("setReviewQueue(null);") || !importSaveAll.includes("cloudifyImportedBeats([currentUpdated])")) fail("Save All must close Review and upload the current beat without waiting for the rest.");\n''')

print("Task 7.3 extraction applied.")
