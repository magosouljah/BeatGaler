import { deepEqual, equal, runSuite } from "../helpers/testHarness.js";
import {
  beatCardIncompleteReasons,
  beatCardPlaybackBlocked,
  getReviewFooterState,
  playerMetaLabel,
  playerToggleTitle,
  reviewHeaderLabel,
  shouldShowIncompleteWarning,
  sortBeatCardTags,
} from "../../src/features/components/componentLogic.js";

runSuite("BeatCard component contract", [
  ["uploading and playback-preparing beats remain non-interactive", () => {
    equal(beatCardPlaybackBlocked({ cloud_status: "UPLOADING" }, false), true, "UPLOADING must block Play");
    equal(beatCardPlaybackBlocked({ cloud_status: "PLAYBACK_PREPARING" }, false), true, "PLAYBACK_PREPARING must block Play");
    equal(beatCardPlaybackBlocked({ cloud_status: "UPLOAD_COMPLETE" }, false), false, "completed beat should be playable");
  }],
  ["slot update blocks Play independently from cloud status", () => {
    equal(beatCardPlaybackBlocked({ cloud_status: "UPLOAD_COMPLETE" }, true), true, "slot update must block Play");
  }],
  ["invalid PROJECT produces one stable warning reason", () => {
    equal(beatCardIncompleteReasons(null).length, 0, "unknown PROJECT status must not flash a warning");
    equal(beatCardIncompleteReasons({ valid: true }).length, 0, "valid PROJECT must not warn");
    equal(beatCardIncompleteReasons({ valid: false }).length, 1, "invalid PROJECT must warn exactly once");
  }],
  ["incomplete warning stays hidden while upload is active or just completed", () => {
    const reasons = beatCardIncompleteReasons({ valid: false });
    equal(shouldShowIncompleteWarning({ showIncompleteWarnings: true, incompleteReasons: reasons, cloudUploading: true, cloudUploadComplete: false }), false, "uploading should suppress warning");
    equal(shouldShowIncompleteWarning({ showIncompleteWarnings: true, incompleteReasons: reasons, cloudUploading: false, cloudUploadComplete: true }), false, "upload complete should suppress warning");
    equal(shouldShowIncompleteWarning({ showIncompleteWarnings: true, incompleteReasons: reasons, cloudUploading: false, cloudUploadComplete: false }), true, "stable invalid PROJECT should warn");
  }],
  ["tags are deduplicated and sorted by usage, then alphabetically", () => {
    const result = sortBeatCardTags(["Trap", "lofi", " trap ", "Drill", ""], new Map([["trap", 2], ["lofi", 9], ["drill", 2]]));
    deepEqual(result.map(([, display]) => display), ["lofi", "Drill", "Trap"], "BeatCard display order changed");
  }],
]);

runSuite("Review Beat / Drawer component contract", [
  ["review header handles known and streaming totals", () => {
    equal(reviewHeaderLabel({ reviewCurrent: 2, reviewTotal: 5, isBulk: false, selectedBeatsCount: 0, isEdit: true }), "Review beat 2 of 5", "known total label mismatch");
    equal(reviewHeaderLabel({ reviewCurrent: 1, reviewTotal: null, isBulk: false, selectedBeatsCount: 0, isEdit: true }), "Review beat 1", "streaming label mismatch");
  }],
  ["review Save labels progress from next to finish", () => {
    const common = { mutationAllowed: true, saving: false, isBulk: false, bulkFieldCount: 0, bulkTagsMode: "add" as const, tagsCount: 0, selectedBeatsCount: 0, bpmValid: true, keyValid: true, bulkHasBpm: false, bulkHasKey: false, bulkHasTags: false, hasOnSaveAll: true, pendingFileCount: 0 };
    equal(getReviewFooterState({ ...common, reviewCurrent: 1, reviewTotal: 3 }).label, "Save and next", "first review should save and advance");
    equal(getReviewFooterState({ ...common, reviewCurrent: 3, reviewTotal: 3 }).label, "Save and finish", "last review should finish");
    equal(getReviewFooterState({ ...common, reviewCurrent: 1, reviewTotal: null }).label, "Save", "streaming total should use neutral Save");
  }],
  ["Save all only appears when there are known remaining beats", () => {
    const common = { mutationAllowed: true, saving: false, isBulk: false, bulkFieldCount: 0, bulkTagsMode: "add" as const, tagsCount: 0, selectedBeatsCount: 0, bpmValid: true, keyValid: true, bulkHasBpm: false, bulkHasKey: false, bulkHasTags: false, hasOnSaveAll: true, pendingFileCount: 0 };
    equal(getReviewFooterState({ ...common, reviewCurrent: 1, reviewTotal: 3 }).canSaveAll, true, "Save all should exist with remaining beats");
    equal(getReviewFooterState({ ...common, reviewCurrent: 3, reviewTotal: 3 }).canSaveAll, false, "Save all should disappear on final beat");
    equal(getReviewFooterState({ ...common, reviewCurrent: 1, reviewTotal: null }).canSaveAll, false, "Save all needs a known total");
  }],
  ["offline, saving and invalid metadata disable mutation", () => {
    const common = { mutationAllowed: true, saving: false, isBulk: false, bulkFieldCount: 0, bulkTagsMode: "add" as const, tagsCount: 0, selectedBeatsCount: 0, bpmValid: true, keyValid: true, bulkHasBpm: false, bulkHasKey: false, bulkHasTags: false, hasOnSaveAll: false, pendingFileCount: 0 };
    equal(getReviewFooterState({ ...common, mutationAllowed: false }).disabled, true, "offline Review must be read-only");
    equal(getReviewFooterState({ ...common, saving: true }).disabled, true, "saving must disable repeated Save");
    equal(getReviewFooterState({ ...common, bpmValid: false }).disabled, true, "invalid BPM must block Save");
    equal(getReviewFooterState({ ...common, keyValid: false }).disabled, true, "invalid Key must block Save");
  }],
  ["normal edit label counts pending files", () => {
    const state = getReviewFooterState({ mutationAllowed: true, saving: false, isBulk: false, bulkFieldCount: 0, bulkTagsMode: "add", tagsCount: 0, selectedBeatsCount: 0, bpmValid: true, keyValid: true, bulkHasBpm: false, bulkHasKey: false, bulkHasTags: false, hasOnSaveAll: false, pendingFileCount: 2 });
    equal(state.label, "Save changes (2 files pending)", "pending file count should be visible");
  }],
]);

runSuite("Player component contract", [
  ["play/pause title follows playback state", () => {
    equal(playerToggleTitle(false), "Play", "stopped player must offer Play");
    equal(playerToggleTitle(true), "Pause", "playing player must offer Pause");
  }],
  ["metadata label has safe fallbacks", () => {
    equal(playerMetaLabel("F#m", "140"), "F#m • 140 BPM", "normal player metadata mismatch");
    equal(playerMetaLabel("", ""), "Unknown Key • -- BPM", "empty metadata fallback mismatch");
  }],
]);
