import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Beat } from "../../types";
import { loadOfflineLibrary, recordOfflineTrashIntent, removeBeatFromLibrary } from "../../lib/tauri";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { appAlert, appConfirm } from "../../lib/dialog";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { cloudBeatFingerprint } from "../library/libraryFingerprints";
import type { BeatRuntimeEvent, BeatRuntimeState } from "../state/beatRuntimeState";

type ConnectionState = "checking" | "online" | "poor" | "offline";

type TrashActionsOptions = {
  beats: Beat[];
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  beatsLatestRef: MutableRefObject<Beat[]>;
  selectedIds: Set<string>;
  clearSelection: () => void;
  connectionState: ConnectionState;
  audioPlayingId: string | null;
  releaseFile: () => void;
  beatRuntimeStatesRef: MutableRefObject<Record<string, BeatRuntimeState>>;
  transitionRuntime: (beatId: string, event: BeatRuntimeEvent, beatHint?: Beat) => void;
  forgetRuntimeState: (beatId: string) => void;
  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  invalidateArtworkHydration: (beatId: string) => void;
  ensureArtworkReady: (beat: Beat, allowNetwork?: boolean) => Promise<boolean>;
};

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useTrashActions({
  beats,
  setBeats,
  beatsLatestRef,
  selectedIds,
  clearSelection,
  connectionState,
  audioPlayingId,
  releaseFile,
  beatRuntimeStatesRef,
  transitionRuntime,
  forgetRuntimeState,
  cloudMetaSnapshotRef,
  cloudLibrarySnapshotRef,
  invalidateArtworkHydration,
  ensureArtworkReady,
}: TrashActionsOptions) {
  const deleteInFlightRef = useRef(new Set<string>());

  const deleteBeat = useCallback(async (beat: Beat) => {
    const approved = await appConfirm({
      title: "Remove beat?",
      message: beat.telegram_file_id
        ? `Remove "${beat.name}" from BeatGaler?\n\nIts cloud files will stay stored. The active Galer Library index will stop listing this beat after the next sync.`
        : `Are you sure you want to remove "${beat.name}"?\n\nThis will move its local files to BeatGaler trash.`,
      confirmLabel: beat.telegram_file_id ? "Remove beat" : "Move to trash",
      cancelLabel: "Cancel",
      danger: true,
    });

    if (!approved) return;
    if (deleteInFlightRef.current.has(beat.id)) return;

    deleteInFlightRef.current.add(beat.id);
    if (beat.telegram_file_id) {
      if (connectionState === "online") transitionRuntime(beat.id, { type: "SYNC_DELETE_STARTED" }, beat);
      else transitionRuntime(beat.id, { type: "SET_TRASH_SYNC_REQUIRED", required: true }, beat);
    }
    try {
      if (audioPlayingId === beat.id) {
        transitionRuntime(beat.id, { type: "PLAYBACK_IDLE" }, beat);
        releaseFile();
      }
      await removeBeatFromLibrary(beat.id);
      let trashIntentError: unknown = null;
      if (connectionState !== "online" && beat.telegram_file_id) {
        try {
          await recordOfflineTrashIntent(beat.id);
        } catch (error) {
          trashIntentError = error;
          console.error("Could not persist Offline Trash reconciliation intent:", error);
        }
      }
      const nextLibrary = beatsLatestRef.current.filter(item => item.id !== beat.id);
      beatsLatestRef.current = nextLibrary;
      setBeats(nextLibrary);

      if (connectionState === "online" && beat.telegram_file_id) {
        try {
          await libraryStateManager.commitSnapshot(nextLibrary, "move-to-trash");
          forgetRuntimeState(beat.id);
        } catch (error) {
          const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
          const runtime = beatRuntimeStatesRef.current[beat.id];
          if (runtime?.sync_state === "deleting") {
            transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "DELETE_INDEX_SYNC_FAILED", message, retryable: true }, beat);
          }
          console.warn("Telegram library index refresh after Remove failed:", error);
        }
      }

      if (trashIntentError) {
        await appAlert({
          title: "Moved to Trash locally",
          message: "BeatGaler could not save the reconnect instruction for this beat. Restore it from Trash before closing the app, or reconnect and try again.",
          danger: true,
        });
      }
    } catch (err) {
      console.error(err);
      const runtime = beatRuntimeStatesRef.current[beat.id];
      if (runtime?.sync_state === "deleting") {
        transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "DELETE_FAILED", message: sanitizeUserVisibleText(runtimeErrorMessage(err), "Cloud operation failed."), retryable: true }, beat);
      }
      await appAlert({
        title: "Could not remove beat",
        message: "The beat could not be removed from the library.",
        danger: true,
      });
    } finally {
      deleteInFlightRef.current.delete(beat.id);
    }
  }, [audioPlayingId, beatRuntimeStatesRef, beatsLatestRef, connectionState, forgetRuntimeState, releaseFile, setBeats, transitionRuntime]);

  const handleRemoveBulk = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const approved = await appConfirm({
      title: `Remove ${ids.length} beat${ids.length === 1 ? "" : "s"}?`,
      message: "Remove the selected beats from BeatGaler? Cloud-backed files remain stored; local-only files are moved to BeatGaler trash.",
      confirmLabel: ids.length === 1 ? "Remove beat" : "Remove beats",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!approved) return;

    const deleted = new Set<string>();
    for (const id of ids) {
      if (deleteInFlightRef.current.has(id)) continue;
      deleteInFlightRef.current.add(id);
      const beat = beats.find(item => item.id === id);
      if (beat?.telegram_file_id) {
        if (connectionState === "online") transitionRuntime(id, { type: "SYNC_DELETE_STARTED" }, beat);
        else transitionRuntime(id, { type: "SET_TRASH_SYNC_REQUIRED", required: true }, beat);
      }
      try {
        await removeBeatFromLibrary(id);
        deleted.add(id);
      } catch (err) {
        console.error(err);
        const runtime = beatRuntimeStatesRef.current[id];
        if (runtime?.sync_state === "deleting") {
          transitionRuntime(id, { type: "SYNC_FAILED", code: "DELETE_FAILED", message: sanitizeUserVisibleText(runtimeErrorMessage(err), "Cloud operation failed."), retryable: true }, beat);
        }
      } finally {
        deleteInFlightRef.current.delete(id);
      }
    }

    if (deleted.size > 0) {
      const next = beats.filter(beat => !deleted.has(beat.id));
      setBeats(next);

      if (connectionState !== "online") {
        const deletedCloudIds = beats
          .filter(beat => deleted.has(beat.id) && !!beat.telegram_file_id)
          .map(beat => beat.id);
        const intentResults = await Promise.allSettled(deletedCloudIds.map(id => recordOfflineTrashIntent(id)));
        const failedIntentCount = intentResults.filter(result => result.status === "rejected").length;
        if (failedIntentCount > 0) {
          await appAlert({
            title: "Some Trash changes are local only",
            message: `${failedIntentCount} beat${failedIntentCount === 1 ? "" : "s"} could not be queued for reconnect. Restore those beats before closing BeatGaler, or reconnect and remove them again.`,
            danger: true,
          });
        }
      } else {
        const cloudBacked = next.filter(beat => !!beat.telegram_file_id);
        cloudLibrarySnapshotRef.current = cloudBacked.map(cloudBeatFingerprint).join("\u001c");
        try {
          await libraryStateManager.commitSnapshot(next, "bulk-remove");
          for (const id of deleted) forgetRuntimeState(id);
        } catch (error) {
          console.warn("Telegram library index refresh after Remove all failed:", error);
          const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
          for (const id of deleted) {
            const runtime = beatRuntimeStatesRef.current[id];
            if (runtime?.sync_state === "deleting") {
              transitionRuntime(id, { type: "SYNC_FAILED", code: "DELETE_INDEX_SYNC_FAILED", message, retryable: true });
            }
          }
        }
      }
    }
    if (deleted.size !== ids.length) {
      await appAlert({
        title: "Some beats were not removed",
        message: "One or more selected beats could not be removed from the library.",
        danger: true,
      });
    }
    clearSelection();
  }, [beatRuntimeStatesRef, beats, clearSelection, cloudLibrarySnapshotRef, connectionState, forgetRuntimeState, selectedIds, setBeats, transitionRuntime]);

  const handleBeatRestored = useCallback((beat: Beat) => {
    if (connectionState !== "online") {
      void loadOfflineLibrary().then(setBeats).catch(error => {
        console.warn("Could not refresh Offline library after Trash restore:", error);
      });
      return;
    }

    // Native restore already commits Cloud Trash -> active. Seed snapshots before
    // rendering so the restored row cannot trigger a second INDEX/metadata publish.
    const current = beatsLatestRef.current;
    const next = current.some(item => item.id === beat.id)
      ? current.map(item => item.id === beat.id ? beat : item)
      : [...current, beat];

    if (beat.telegram_file_id) {
      if (cloudMetaSnapshotRef.current === null) cloudMetaSnapshotRef.current = new Map();
      cloudMetaSnapshotRef.current.set(beat.id, cloudBeatFingerprint(beat));
      cloudLibrarySnapshotRef.current = next
        .filter(item => !!item.telegram_file_id)
        .map(cloudBeatFingerprint)
        .join("\u001c");
    }

    beatsLatestRef.current = next;
    setBeats(next);
    invalidateArtworkHydration(beat.id);
    void ensureArtworkReady(beat);
  }, [beatsLatestRef, cloudLibrarySnapshotRef, cloudMetaSnapshotRef, connectionState, ensureArtworkReady, invalidateArtworkHydration, setBeats]);

  return { deleteBeat, handleRemoveBulk, handleBeatRestored };
}
