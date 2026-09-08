import { useCallback, useMemo, useState } from "react";
import type { Beat } from "../../types";
import { renameTagEverywhere } from "../../lib/tauri";
import { renameTagColor } from "../../lib/tagColors";
import { registerJob, updateJob } from "../../lib/jobStore";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";

export type TagRenameState = {
  oldTag: string;
  newTag: string;
  stage: "name" | "confirm";
};

type Params = {
  beats: Beat[];
  setBeats: React.Dispatch<React.SetStateAction<Beat[]>>;
  replaceTagFilter: (oldTag: string, newTag: string) => void;
};

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useTagRename({ beats, setBeats, replaceTagFilter }: Params) {
  const [tagRename, setTagRename] = useState<TagRenameState | null>(null);
  const [tagRenameBusy, setTagRenameBusy] = useState(false);
  const [tagRenameError, setTagRenameError] = useState<string | null>(null);

  const normalizedOldTag = tagRename?.oldTag.trim().toLowerCase() ?? "";
  const affectedBeats = useMemo(() => {
    if (!normalizedOldTag) return [];
    return beats.filter(beat => beat.tags.some(tag => tag.trim().toLowerCase() === normalizedOldTag));
  }, [beats, normalizedOldTag]);

  const openTagRename = useCallback((tag: string) => {
    const oldTag = tag.trim().toLowerCase();
    setTagRename({ oldTag, newTag: oldTag, stage: "name" });
    setTagRenameError(null);
  }, []);

  const setNewTag = useCallback((newTag: string) => {
    setTagRename(current => current ? { ...current, newTag } : current);
  }, []);

  const continueTagRename = useCallback(() => {
    setTagRename(current => {
      if (!current) return current;
      const oldTag = current.oldTag.trim().toLowerCase();
      const newTag = current.newTag.trim().toLowerCase();
      if (!newTag || newTag === oldTag) return current;
      return { ...current, stage: "confirm" };
    });
  }, []);

  const backTagRename = useCallback(() => {
    if (tagRenameBusy) return;
    setTagRename(current => current ? { ...current, stage: "name" } : current);
  }, [tagRenameBusy]);

  const cancelTagRename = useCallback(() => {
    if (tagRenameBusy) return;
    setTagRename(null);
    setTagRenameError(null);
  }, [tagRenameBusy]);

  const confirmTagRename = useCallback(async () => {
    if (!tagRename) return;
    const oldTag = tagRename.oldTag.trim().toLowerCase();
    const newTag = tagRename.newTag.trim().toLowerCase();
    if (!oldTag || !newTag || oldTag === newTag) return;
    const jobId = `tag-rename-${Date.now()}`;
    setTagRenameBusy(true);
    setTagRenameError(null);
    registerJob(jobId, `Rename “${oldTag}” → “${newTag}”`, "tag-rename");
    updateJob(jobId, { status: "processing", progress: 0, message: "Preparing journal…" });
    try {
      await renameTagEverywhere(oldTag, newTag, jobId);
      setBeats(current => current.map(beat => {
        if (!beat.tags.some(tag => tag.trim().toLowerCase() === oldTag)) return beat;
        const renamed = beat.tags.map(tag => tag.trim().toLowerCase() === oldTag ? newTag : tag);
        return { ...beat, tags: Array.from(new Set(renamed)) };
      }));
      replaceTagFilter(oldTag, newTag);
      renameTagColor(oldTag, newTag);
      setTagRename(null);
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Could not rename tag.");
      setTagRenameError(message);
      updateJob(jobId, { status: "error", message });
    } finally {
      setTagRenameBusy(false);
    }
  }, [tagRename, replaceTagFilter, setBeats]);

  return {
    tagRename,
    tagRenameBusy,
    tagRenameError,
    affectedCount: affectedBeats.length,
    affectedMp3Count: affectedBeats.filter(beat => !!beat.mp3_path).length,
    affectedWavCount: affectedBeats.filter(beat => !!beat.wav_path).length,
    openTagRename,
    setNewTag,
    continueTagRename,
    backTagRename,
    cancelTagRename,
    confirmTagRename,
  };
}
