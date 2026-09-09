import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { syncBeatMetadataToTelegram, uploadBeatToTelegram } from "../../lib/tauri";
import type { BeatRuntimeRegistry } from "../state/useBeatRuntimeRegistry";

type UseCloudBeatTransferOptions = {
  rejectOfflineMutation: (action: string) => boolean;
  transitionRuntime: BeatRuntimeRegistry["transitionRuntime"];
  setBeats: Dispatch<SetStateAction<Beat[]>>;
};

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeConflictError(error: unknown): boolean {
  const message = runtimeErrorMessage(error).toLowerCase();
  return message.includes("409") || message.includes("conflict") || message.includes("revision mismatch") || message.includes("version mismatch");
}

export function useCloudBeatTransfer({ rejectOfflineMutation, transitionRuntime, setBeats }: UseCloudBeatTransferOptions) {
  const handleUploadTelegram = useCallback(async (beat: Beat) => {
    if (rejectOfflineMutation("Uploading a beat")) return;
    const existingCloudBeat = Boolean(beat.telegram_file_id);
    transitionRuntime(beat.id, { type: existingCloudBeat ? "SYNC_QUEUE_UPDATE" : "SYNC_QUEUE_UPLOAD" }, beat);
    transitionRuntime(beat.id, { type: existingCloudBeat ? "SYNC_UPDATE_STARTED" : "SYNC_UPLOAD_STARTED" }, beat);
    try {
      const updated = await uploadBeatToTelegram(beat);
      await syncBeatMetadataToTelegram(updated);
      transitionRuntime(updated.id, { type: existingCloudBeat ? "SYNC_UPDATE_SUCCEEDED" : "SYNC_UPLOAD_SUCCEEDED" }, updated);
      setBeats(bs => bs.map(b => b.id === updated.id ? updated : b));
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      if (existingCloudBeat && isRuntimeConflictError(error)) {
        transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      } else {
        transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "TELEGRAM_UPLOAD_FAILED", message, retryable: true }, beat);
      }
      await appAlert({ title: "Cloud upload failed", message, danger: true });
    }
  }, [rejectOfflineMutation, setBeats, transitionRuntime]);

  const handleDownloadTelegram = useCallback(async (_beat: Beat) => {
    await appAlert({
      title: "Cloud-only library",
      message: "Files are fetched into temporary storage automatically when needed.",
    });
  }, []);

  return { handleUploadTelegram, handleDownloadTelegram };
}
