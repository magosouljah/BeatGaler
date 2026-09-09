import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { cleanTags } from "../../lib/metadataValidation";
import { cleanupOrphanedDropStaging } from "../dragdrop/dropStaging";
import type { ConnectionState } from "../session/useSessionState";
import type { ImportSession } from "./useImportSession";

type UseImportEntryOptions = {
  connectionState: ConnectionState;
  setShowAdd: Dispatch<SetStateAction<boolean>>;
  startReview: ImportSession["startReview"];
  beatsLatestRef: MutableRefObject<Beat[]>;
};

export function useImportEntry({ connectionState, setShowAdd, startReview, beatsLatestRef }: UseImportEntryOptions) {
  const addBeatsAndReview = useCallback((newBeats: Beat[]) => {
    if (newBeats.length === 0) return;
    if (connectionState !== "online") {
      void appAlert({
        title: "Internet connection required",
        message: "BeatGaler does not import new beats while offline. Reconnect and import them again.",
      });
      void cleanupOrphanedDropStaging(beatsLatestRef.current);
      return;
    }
    const sanitized = newBeats.map(beat => ({ ...beat, tags: cleanTags(beat.tags || []).tags }));

    // Review candidates are NOT library beats yet. Cancel leaves nothing behind,
    // duplicate-name checks see committed library items only, and upload begins
    // only after Review -> Save.
    setShowAdd(false);
    startReview(sanitized);
  }, [beatsLatestRef, connectionState, setShowAdd, startReview]);

  return { addBeatsAndReview };
}
