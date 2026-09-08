import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import uploadCompleteWav from "../../assets/status/upload-complete.wav";
import type { Beat } from "../../types";
import { appAlert, appConfirm } from "../../lib/dialog";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { platform } from "../../platform";
import { loadLibrary, uploadDroppedFileToTelegram } from "../../lib/tauri";
import { cleanupStagedDropPaths } from "../dragdrop/dropStaging";
import { cloudBeatFingerprint } from "../library/libraryFingerprints";
import { createBeatRuntimeState, type BeatRuntimeState } from "../state/beatRuntimeState";
import type { BeatRuntimeRegistry } from "../state/useBeatRuntimeRegistry";

type BeatFileDropState = { beat: Beat; filePath: string; kind: "file" | "directory" } | null;
type DrawerState = { beat: Beat; mode: "detail" | "edit" } | null;

type UseBeatAssetUpdatesOptions = {
  rejectOfflineMutation: (label: string) => boolean;
  setBeatFileDrop: Dispatch<SetStateAction<BeatFileDropState>>;
  setBeatCloudUpdateBusy: (beatId: string, active: boolean, success?: boolean) => void;
  beatRuntimeStatesRef: MutableRefObject<Record<string, BeatRuntimeState>>;
  transitionRuntime: BeatRuntimeRegistry["transitionRuntime"];
  beatsLatestRef: MutableRefObject<Beat[]>;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  setDrawer: Dispatch<SetStateAction<DrawerState>>;
  waitForUploadedBeatPlaybackReady: (beat: Beat) => Promise<boolean>;
};

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeConflictError(error: unknown): boolean {
  const message = runtimeErrorMessage(error).toLowerCase();
  return message.includes("409") || message.includes("conflict") || message.includes("revision mismatch") || message.includes("version mismatch");
}

export function useBeatAssetUpdates({
  rejectOfflineMutation,
  setBeatFileDrop,
  setBeatCloudUpdateBusy,
  beatRuntimeStatesRef,
  transitionRuntime,
  beatsLatestRef,
  cloudLibrarySnapshotRef,
  setBeats,
  setDrawer,
  waitForUploadedBeatPlaybackReady,
}: UseBeatAssetUpdatesOptions) {
  const runBeatCloudUpdate = useCallback((beat: Beat, filePath: string, work: () => Promise<void>) => {
    if (rejectOfflineMutation("Updating beat files")) {
      setBeatFileDrop(null);
      void cleanupStagedDropPaths([filePath]);
      return;
    }

    // Once the user chose a destination, the chooser is done. The long cloud/ZIP
    // task belongs to the beat card, not to a blocking modal.
    setBeatFileDrop(null);
    setBeatCloudUpdateBusy(beat.id, true);
    const before = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
    if (before.sync_state === "synced") transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);

    void (async () => {
      let succeeded = false;
      try {
        await work();
        transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, beat);
        succeeded = true;
        setBeatCloudUpdateBusy(beat.id, false, true);
        try {
          const audio = new Audio(uploadCompleteWav);
          audio.volume = 0.72;
          void audio.play().catch(() => {});
        } catch {}
      } catch (error) {
        console.error(error);
        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
        if (isRuntimeConflictError(error)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
        else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "BEAT_UPDATE_FAILED", message, retryable: true }, beat);
        setBeatCloudUpdateBusy(beat.id, false, false);
        await appAlert({ title: "Beat update failed", message, danger: true });
      } finally {
        // Drag/drop roots are private staging copies and are reclaimed regardless
        // of success or failure once the background task has finished.
        await cleanupStagedDropPaths([filePath]).catch(() => {});
        if (!succeeded) setBeatCloudUpdateBusy(beat.id, false, false);
      }
    })();
  }, [beatRuntimeStatesRef, rejectOfflineMutation, setBeatCloudUpdateBusy, setBeatFileDrop, transitionRuntime]);

  const startMasterAssetUpdate = useCallback((beat: Beat, filePath: string) => {
    runBeatCloudUpdate(beat, filePath, async () => {
      await uploadDroppedFileToTelegram(beat, filePath, "MASTER");
      const refreshed = await loadLibrary();
      beatsLatestRef.current = refreshed;
      setBeats(refreshed);
      const cloudBacked = refreshed.filter(item => !!item.telegram_file_id);
      cloudLibrarySnapshotRef.current = cloudBacked.map(cloudBeatFingerprint).join("\u001c");
      await libraryStateManager.commitSnapshot(refreshed, "dropped-master");

      const updated = refreshed.find(item => item.id === beat.id);
      if (updated?.telegram_file_id) {
        const ready = await waitForUploadedBeatPlaybackReady(updated);
        if (!ready) throw new Error("The new MASTER uploaded, but did not become playback-ready in time.");
      }
    });
  }, [beatsLatestRef, cloudLibrarySnapshotRef, runBeatCloudUpdate, setBeats, waitForUploadedBeatPlaybackReady]);

  const startWavAssetUpdate = useCallback((beat: Beat, filePath: string) => {
    runBeatCloudUpdate(beat, filePath, async () => {
      await uploadDroppedFileToTelegram(beat, filePath, "WAV");
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
    });
  }, [beatsLatestRef, runBeatCloudUpdate]);

  const handleBrowserBeatAssetDrop = useCallback(async (
    beat: Beat,
    file: File,
    kind: "MASTER" | "WAV",
  ): Promise<boolean> => {
    if (kind === "MASTER" && beat.telegram_file_id) {
      const replace = await appConfirm({
        title: "Replace MASTER?",
        message: `Replace the current MASTER for "${beat.name}" with ${file.name}?`,
        confirmLabel: "Replace",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!replace) return false;
    }

    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      const committed = await platform.editor.commit(beat, beat, { [kind]: file });
      setBeats(current => {
        const next = current.map(item => item.id === committed.id ? committed : item);
        beatsLatestRef.current = next;
        return next;
      });
      setDrawer(current => current?.beat.id === committed.id ? { ...current, beat: committed } : current);
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, committed);
      return false;
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "WEB_FILE_UPDATE_FAILED", message, retryable: true }, beat);
      throw error;
    }
  }, [beatsLatestRef, setBeats, setDrawer, transitionRuntime]);

  return {
    runBeatCloudUpdate,
    startMasterAssetUpdate,
    startWavAssetUpdate,
    handleBrowserBeatAssetDrop,
  };
}
