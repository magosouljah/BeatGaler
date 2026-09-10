import { useCallback, type Dispatch, type SetStateAction } from "react";
import { appAlert } from "../../lib/dialog";
import { cleanTags } from "../../lib/metadataValidation";
import { platform } from "../../platform";
import type { ImportReviewQueueState } from "./useImportSession";

type UseBrowserImportOptions = {
  dropImporting: boolean;
  setDropImporting: Dispatch<SetStateAction<boolean>>;
  rejectOfflineMutation: (action: string) => boolean;
  setDropActive: Dispatch<SetStateAction<boolean>>;
  setShowAdd: Dispatch<SetStateAction<boolean>>;
  setReviewQueue: Dispatch<SetStateAction<ImportReviewQueueState | null>>;
  completeImmediateReviewPreparation: () => void;
  resetImportResolutionState: () => void;
};

export function useBrowserImport({
  dropImporting,
  setDropImporting,
  rejectOfflineMutation,
  setDropActive,
  setShowAdd,
  setReviewQueue,
  completeImmediateReviewPreparation,
  resetImportResolutionState,
}: UseBrowserImportOptions) {
  const importDroppedBrowserFiles = useCallback(async (files: File[]) => {
    if (rejectOfflineMutation("Importing beats")) return;
    if (dropImporting) return;

    const supported = files.filter(file =>
      /\.(mp3|wav)$/i.test(file.name) ||
      file.type === "audio/mpeg" ||
      file.type === "audio/wav" ||
      file.type === "audio/x-wav"
    );
    if (supported.length === 0) {
      await appAlert({ title: "Nothing to import", message: "Drop an MP3 or WAV file to add a beat." });
      return;
    }
    if (supported.length > 1) {
      await appAlert({ title: "Drop one beat at a time", message: "BeatGaler Web imports one beat per drag action." });
      return;
    }

    setDropImporting(true);
    setDropActive(false);
    try {
      const candidate = platform.importer.fromFile(supported[0]);
      const beat = candidate.beat;
      setShowAdd(false);
      completeImmediateReviewPreparation();
      resetImportResolutionState();
      setReviewQueue({ beats: [beat], index: 0, total: 1, batchId: null, preparing: false });
      void candidate.hydrated.then(hydrated => {
        setReviewQueue(queue => queue ? { ...queue, beats: queue.beats.map(current => current.id === beat.id
          ? { ...hydrated, tags: cleanTags(hydrated.tags || []).tags } : current) } : null);
      }).catch(error => {
        if (platform.importer.fileForBeat(beat.id)) {
          void appAlert({ title: "Import failed", message: String(error), danger: true });
        }
      });
    } catch (error) {
      await appAlert({ title: "Import failed", message: String(error), danger: true });
    } finally {
      setDropImporting(false);
    }
  }, [
    completeImmediateReviewPreparation,
    dropImporting,
    rejectOfflineMutation,
    resetImportResolutionState,
    setDropActive,
    setDropImporting,
    setReviewQueue,
    setShowAdd,
  ]);

  return { importDroppedBrowserFiles };
}
