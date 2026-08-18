import { isBeatPlaybackBlocked } from "../playback/playbackReadiness.js";

export type ProjectCloudView = { valid: boolean } | null;

export function beatCardPlaybackBlocked(
  beat: { cloud_status?: string | null },
  slotUpdating: boolean,
): boolean {
  return isBeatPlaybackBlocked(beat) || slotUpdating;
}

export function beatCardIncompleteReasons(projectCloud: ProjectCloudView): string[] {
  if (projectCloud === null || projectCloud.valid) return [];
  return [
    "No valid PROJECT.zip was found. A valid project ZIP must contain a .flp, .als, .logicx, .ptx, or .ptf project file and no Backup/Backups folder.",
  ];
}

export function shouldShowIncompleteWarning(input: {
  showIncompleteWarnings: boolean;
  incompleteReasons: readonly string[];
  cloudUploading: boolean;
  cloudUploadComplete: boolean;
}): boolean {
  return (
    input.showIncompleteWarnings &&
    input.incompleteReasons.length > 0 &&
    !input.cloudUploading &&
    !input.cloudUploadComplete
  );
}

export function sortBeatCardTags(
  tags: readonly string[],
  tagFrequency: ReadonlyMap<string, number>,
): Array<[string, string]> {
  const uniqueByNormalized = new Map<string, string>();
  for (const rawTag of tags) {
    const normalized = rawTag.trim().toLowerCase();
    if (normalized && !uniqueByNormalized.has(normalized)) {
      uniqueByNormalized.set(normalized, rawTag.trim());
    }
  }
  return [...uniqueByNormalized.entries()].sort(
    ([a], [b]) =>
      (tagFrequency.get(b) ?? 0) - (tagFrequency.get(a) ?? 0) || a.localeCompare(b),
  );
}

export type ReviewFooterInput = {
  mutationAllowed: boolean;
  saving: boolean;
  isBulk: boolean;
  bulkFieldCount: number;
  bulkTagsMode: "add" | "replace" | "remove";
  tagsCount: number;
  selectedBeatsCount: number;
  bpmValid: boolean;
  keyValid: boolean;
  bulkHasBpm: boolean;
  bulkHasKey: boolean;
  bulkHasTags: boolean;
  reviewCurrent?: number;
  reviewTotal?: number | null;
  hasOnSaveAll: boolean;
  pendingFileCount: number;
};

export function getReviewFooterState(input: ReviewFooterInput): {
  disabled: boolean;
  label: string;
  canSaveAll: boolean;
} {
  const hasReview = input.reviewCurrent !== undefined;
  const removeNothingSelected =
    input.isBulk && input.bulkHasTags && input.bulkTagsMode === "remove" && input.tagsCount === 0;
  const metadataInvalid = input.isBulk
    ? (input.bulkHasBpm && !input.bpmValid) || (input.bulkHasKey && !input.keyValid)
    : !input.bpmValid || !input.keyValid;
  const disabled =
    !input.mutationAllowed ||
    input.saving ||
    (input.isBulk && input.bulkFieldCount === 0) ||
    removeNothingSelected ||
    metadataInvalid;

  const label = !input.mutationAllowed
    ? "Internet connection required"
    : input.saving
      ? "Saving…"
      : input.isBulk && input.bulkTagsMode === "remove" && input.bulkHasTags
        ? `Remove ${input.tagsCount || "selected"} tag${input.tagsCount === 1 ? "" : "s"} from ${input.selectedBeatsCount} beats`
        : input.isBulk
          ? `Apply to ${input.selectedBeatsCount} beats`
          : hasReview
            ? input.reviewTotal === null || input.reviewTotal === undefined
              ? "Save"
              : input.reviewCurrent === input.reviewTotal
                ? "Save and finish"
                : "Save and next"
            : input.pendingFileCount > 0
              ? `Save changes (${input.pendingFileCount} file${input.pendingFileCount > 1 ? "s" : ""} pending)`
              : "Save changes";

  const canSaveAll =
    hasReview &&
    input.reviewTotal !== null &&
    input.reviewTotal !== undefined &&
    input.reviewCurrent! < input.reviewTotal &&
    input.hasOnSaveAll;

  return { disabled, label, canSaveAll };
}

export function reviewHeaderLabel(input: {
  reviewCurrent?: number;
  reviewTotal?: number | null;
  isBulk: boolean;
  selectedBeatsCount: number;
  isEdit: boolean;
}): string {
  if (input.reviewCurrent !== undefined) {
    return `Review beat ${input.reviewCurrent}${input.reviewTotal !== null && input.reviewTotal !== undefined ? ` of ${input.reviewTotal}` : ""}`;
  }
  if (input.isBulk) return `Edit ${input.selectedBeatsCount} beats`;
  return input.isEdit ? "Edit metadata" : "Beat detail";
}

export function formatPlayerTime(secs: number): string {
  if (!secs || Number.isNaN(secs)) return "0:00";
  const safe = Math.max(0, secs);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function playerToggleTitle(playing: boolean): "Play" | "Pause" {
  return playing ? "Pause" : "Play";
}

export function playerMetaLabel(key: string, bpm: string): string {
  return `${key || "Unknown Key"} • ${bpm || "--"} BPM`;
}
