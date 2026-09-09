import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { cleanupStagedDropPaths } from "./dropStaging";
import { extensionFromPath } from "./pathHelpers";
import type { DroppedBeatFileRole } from "./components/BeatFileDropModal";

type BeatFileDropState = { beat: Beat; filePath: string; kind: "file" | "directory" } | null;

type Options = {
  beatFileDrop: BeatFileDropState;
  setBeatFileDrop: Dispatch<SetStateAction<BeatFileDropState>>;
  hasStoredProject: (beat: Beat) => Promise<boolean>;
  startMasterAssetUpdate: (beat: Beat, filePath: string) => void;
  startWavAssetUpdate: (beat: Beat, filePath: string) => void;
  startProjectAssetUpdate: (beat: Beat, filePath: string, kind: "projectFile" | "projectFolder") => void;
};

export function useBeatFileDropRouting({
  beatFileDrop,
  setBeatFileDrop,
  hasStoredProject,
  startMasterAssetUpdate,
  startWavAssetUpdate,
  startProjectAssetUpdate,
}: Options) {
  const handleDroppedBeatFileRole = useCallback(async (role: DroppedBeatFileRole) => {
    if (!beatFileDrop) return;
    const { beat, filePath } = beatFileDrop;
    const ext = extensionFromPath(filePath);

    if (role === "loop" || role === "stems") return;
    if (role === "main") {
      if (ext === "mp3") startMasterAssetUpdate(beat, filePath);
      return;
    }
    if (role === "wav") {
      if (ext === "wav") startWavAssetUpdate(beat, filePath);
      return;
    }
    if (role === "projectFolder") {
      const existing = await hasStoredProject(beat).catch(() => false);
      if (!existing) {
        await cleanupStagedDropPaths([filePath]).catch(() => {});
        setBeatFileDrop(null);
        await appAlert({
          title: "Project file required",
          message: "Add a .flp, .als, .logicx, .ptx/.ptf file or a valid PROJECT ZIP first. Then folders can be added to that PROJECT.zip using their original folder name.",
        });
        return;
      }
      startProjectAssetUpdate(beat, filePath, "projectFolder");
    }
  }, [beatFileDrop, hasStoredProject, setBeatFileDrop, startMasterAssetUpdate, startProjectAssetUpdate, startWavAssetUpdate]);

  return { handleDroppedBeatFileRole };
}
