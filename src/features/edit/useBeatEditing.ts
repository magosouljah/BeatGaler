import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Beat } from "../../types";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { platform } from "../../platform";
import { saveBeatMeta, syncBeatMetadataToTelegram } from "../../lib/tauri";
import { cloudBeatFingerprint } from "../library/libraryFingerprints";
import { createBeatRuntimeState, type BeatRuntimeState } from "../state/beatRuntimeState";
import type { BeatRuntimeRegistry } from "../state/useBeatRuntimeRegistry";
import type { ConnectionState } from "../session/useSessionState";

type DrawerState = { beat: Beat; mode: "detail" | "edit" } | null;

type UseBeatEditingOptions = {
  beats: Beat[];
  selectedIds: Set<string>;
  clearSelection: () => void;
  drawer: DrawerState;
  setDrawer: Dispatch<SetStateAction<DrawerState>>;
  rejectOfflineMutation: (action: string) => boolean;
  connectionState: ConnectionState;
  beatRuntimeStatesRef: MutableRefObject<Record<string, BeatRuntimeState>>;
  transitionRuntime: BeatRuntimeRegistry["transitionRuntime"];
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  beatsLatestRef: MutableRefObject<Beat[]>;
  cloudLibraryTimerRef: MutableRefObject<number | null>;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;
};

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useBeatEditing({
  beats,
  selectedIds,
  clearSelection,
  drawer,
  setDrawer,
  rejectOfflineMutation,
  connectionState,
  beatRuntimeStatesRef,
  transitionRuntime,
  setBeats,
  beatsLatestRef,
  cloudLibraryTimerRef,
  cloudLibrarySnapshotRef,
  cloudMetaSnapshotRef,
}: UseBeatEditingOptions) {
  const handleEditBulk = useCallback(() => {
    if (rejectOfflineMutation("Editing metadata")) return;
    const firstSelected = beats.find(beat => selectedIds.has(beat.id));
    if (firstSelected) setDrawer({ beat: firstSelected, mode: "edit" });
  }, [beats, selectedIds, rejectOfflineMutation, setDrawer]);

  const updateBeat = useCallback((updated: Beat) => {
    if (updated.telegram_file_id && connectionState === "online") {
      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);
      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);
    }
    setBeats(current => current.map(beat => beat.id === updated.id ? updated : beat));
    if (drawer?.beat.id === updated.id) setDrawer(current => current ? { ...current, beat: updated } : null);
  }, [beatRuntimeStatesRef, connectionState, drawer, setBeats, setDrawer, transitionRuntime]);

  const handleDropArtwork = useCallback(async (beat: Beat, imageBase64: string) => {
    if (rejectOfflineMutation("Changing artwork")) return;

    const updated = { ...beat, image_base64: imageBase64, image_preview_base64: null };

    if (platform.capabilities.browserCloudEditing) {
      updateBeat(updated);
      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);
      try {
        const committed = await platform.editor.commit(beat, updated, {});
        setBeats(current => {
          const next = current.map(item => item.id === committed.id ? committed : item);
          beatsLatestRef.current = next;
          return next;
        });
        setDrawer(current => current?.beat.id === committed.id ? { ...current, beat: committed } : current);
        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, committed);
      } catch (error) {
        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);
        throw error;
      }
      return;
    }

    await saveBeatMeta({
      mp3_path: beat.mp3_path,
      wav_path: beat.wav_path,
      bpm: beat.bpm,
      key: beat.key,
      tags: beat.tags,
      rating: beat.rating,
      image_base64: imageBase64,
      update_filename: false,
    });

    updateBeat(updated);

    if (updated.telegram_file_id && connectionState === "online") {
      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);
      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);
      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);
      try {
        await syncBeatMetadataToTelegram(updated);
        const indexSnapshot = beatsLatestRef.current.map(item => item.id === updated.id ? updated : item);
        await libraryStateManager.commitSnapshot(indexSnapshot, "upload-batch");
        if (cloudLibraryTimerRef.current) {
          window.clearTimeout(cloudLibraryTimerRef.current);
          cloudLibraryTimerRef.current = null;
        }
        cloudLibrarySnapshotRef.current = indexSnapshot
          .filter(item => !!item.telegram_file_id)
          .map(cloudBeatFingerprint)
          .join("\u001c");
        cloudMetaSnapshotRef.current?.set(updated.id, cloudBeatFingerprint(updated));
        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, updated);
      } catch (error) {
        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);
        throw error;
      }
    }
  }, [beatRuntimeStatesRef, beatsLatestRef, cloudLibrarySnapshotRef, cloudLibraryTimerRef, cloudMetaSnapshotRef, connectionState, rejectOfflineMutation, setBeats, setDrawer, transitionRuntime, updateBeat]);

  const applyBulkUpdate = useCallback((updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => {
    setBeats(current => current.map(beat => {
      if (!selectedIds.has(beat.id)) return beat;
      if (!updates.tags) return { ...beat, ...updates };

      const normalizedInput = Array.from(new Set(
        updates.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean),
      ));
      if (options?.tagsMode === "replace") return { ...beat, ...updates, tags: normalizedInput };
      if (options?.tagsMode === "remove") {
        const removeSet = new Set(normalizedInput);
        return { ...beat, ...updates, tags: beat.tags.filter(tag => !removeSet.has(tag.trim().toLowerCase())) };
      }
      const mergedTags = Array.from(new Set(
        [...beat.tags, ...normalizedInput].map(tag => tag.trim().toLowerCase()).filter(Boolean),
      ));
      return { ...beat, ...updates, tags: mergedTags };
    }));
    clearSelection();
  }, [clearSelection, selectedIds, setBeats]);

  return { handleEditBulk, updateBeat, handleDropArtwork, applyBulkUpdate };
}
