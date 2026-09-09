import type { ComponentProps } from "react";
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
