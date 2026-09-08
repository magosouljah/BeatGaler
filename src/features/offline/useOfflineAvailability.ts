import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import downloadCompleteWav from "../../assets/status/download-complete.wav";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { makeBeatAvailableOffline, removeBeatOfflineAvailability } from "../../lib/tauri";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { createBeatRuntimeState } from "../state/beatRuntimeState";
import type { BeatRuntimeRegistry } from "../state/useBeatRuntimeRegistry";

type ConnectionState = "checking" | "online" | "poor" | "offline";
type DrawerState = { beat: Beat; mode: "detail" | "edit" } | null;

type OfflineAvailabilityOptions = {
  connectionState: ConnectionState;
  audioPlayingId: string | null;
  releaseFile: () => void;
  invalidatePlaybackPreparation: (beatId: string) => void;
  ensureWarmPlaybackUrl: (beat: Beat) => Promise<unknown>;
  beatRuntimeStatesRef: BeatRuntimeRegistry["beatRuntimeStatesRef"];
  transitionRuntime: BeatRuntimeRegistry["transitionRuntime"];
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  setDrawer: Dispatch<SetStateAction<DrawerState>>;
  setRevealedBeatIds: Dispatch<SetStateAction<Set<string>>>;
};

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useOfflineAvailability({
  connectionState,
  audioPlayingId,
  releaseFile,
  invalidatePlaybackPreparation,
  ensureWarmPlaybackUrl,
  beatRuntimeStatesRef,
  transitionRuntime,
  setBeats,
  setDrawer,
  setRevealedBeatIds,
}: OfflineAvailabilityOptions) {
  const [offlineBusyIds, setOfflineBusyIds] = useState<Set<string>>(new Set());

  const handleToggleOffline = useCallback(async (beat: Beat) => {
    if (offlineBusyIds.has(beat.id)) return;
    if (!beat.offline_available && connectionState !== "online") {
      await appAlert({ title: "Internet required", message: "Connect to the internet once to download this beat for Offline mode." });
      return;
    }

    setOfflineBusyIds(current => new Set(current).add(beat.id));
    let offlineOwnsDownloadState = false;
    if (!beat.offline_available) {
      const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (runtime.download_state !== "downloading") {
        transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat);
        offlineOwnsDownloadState = true;
      }
    }

    try {
      if (beat.offline_available) {
        // Durable Offline and temporary playback caching are separate. Drop the
        // current/memoized local source before deleting the durable package.
        if (audioPlayingId === beat.id) releaseFile();
        invalidatePlaybackPreparation(beat.id);

        await removeBeatOfflineAvailability(beat.id);
        transitionRuntime(beat.id, { type: "SET_OFFLINE_AVAILABLE", available: false }, beat);

        if (connectionState !== "online") {
          // An Offline-only library cannot keep a card whose durable package was removed.
          setBeats(current => current.filter(item => item.id !== beat.id));
          setRevealedBeatIds(current => {
            const next = new Set(current);
            next.delete(beat.id);
            return next;
          });
        } else {
          // Keep current cloud metadata/artwork and clear only durable local paths.
          const withoutOfflinePaths = (item: Beat): Beat => ({
            ...item,
            offline_available: false,
            folder_path: "",
            mp3_path: "",
            wav_path: null,
            playback_path: "",
            stems_path: null,
            samples_path: null,
            flp_path: null,
            als_path: null,
            other_files: [],
            loop_path: null,
          });
          const cloudBeat = withoutOfflinePaths(beat);
          setBeats(current => current.map(item => item.id === beat.id ? withoutOfflinePaths(item) : item));
          setDrawer(current => current?.beat.id === beat.id
            ? { ...current, beat: withoutOfflinePaths(current.beat) }
            : current);

          // Restore the normal cloud fast path without recreating a durable pin.
          if (cloudBeat.telegram_file_id) void ensureWarmPlaybackUrl(cloudBeat);
        }
      } else {
        const offline = await makeBeatAvailableOffline(beat);
        if (offlineOwnsDownloadState) transitionRuntime(beat.id, { type: "DOWNLOAD_SUCCEEDED" }, offline);
        transitionRuntime(beat.id, { type: "SET_OFFLINE_AVAILABLE", available: true }, offline);
        setBeats(current => current.map(item => item.id === beat.id ? {
          ...item,
          offline_available: true,
          image_base64: item.image_base64 || offline.image_base64,
          image_preview_base64: item.image_preview_base64 || offline.image_preview_base64,
        } : item));
        try {
          const audio = new Audio(downloadCompleteWav);
          audio.volume = 0.68;
          void audio.play().catch(() => {});
        } catch {}
      }
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      if (offlineOwnsDownloadState) {
        transitionRuntime(beat.id, { type: "DOWNLOAD_FAILED", code: "OFFLINE_DOWNLOAD_FAILED", message, retryable: true }, beat);
      }
      await appAlert({
        title: beat.offline_available ? "Could not remove offline copy" : "Offline download failed",
        message,
        danger: true,
      });
    } finally {
      setOfflineBusyIds(current => {
        const next = new Set(current);
        next.delete(beat.id);
        return next;
      });
    }
  }, [audioPlayingId, connectionState, ensureWarmPlaybackUrl, invalidatePlaybackPreparation, offlineBusyIds, releaseFile, setBeats, setDrawer, setRevealedBeatIds, transitionRuntime, beatRuntimeStatesRef]);

  return { offlineBusyIds, handleToggleOffline };
}
