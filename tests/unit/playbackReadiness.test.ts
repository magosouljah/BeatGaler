import { isBeatPlaybackBlocked, PLAYBACK_BLOCKING_CLOUD_STATUSES } from "../../src/features/playback/playbackReadiness.js";
import { equal, runSuite } from "../helpers/testHarness.js";

runSuite("playback readiness", [
  ["blocks UPLOADING", () => equal(isBeatPlaybackBlocked({ cloud_status: "UPLOADING" }), true, "UPLOADING must block Play")],
  ["blocks PLAYBACK_PREPARING", () => equal(isBeatPlaybackBlocked({ cloud_status: "PLAYBACK_PREPARING" }), true, "PLAYBACK_PREPARING must block Play")],
  ["status matching is case-insensitive", () => equal(isBeatPlaybackBlocked({ cloud_status: "uploading" }), true, "Playback gate must be case-insensitive")],
  ["allows synchronized/complete states", () => {
    for (const value of ["SYNCED", "UPLOAD_COMPLETE", "READY", ""]) equal(isBeatPlaybackBlocked({ cloud_status: value }), false, `${value} unexpectedly blocked`);
  }],
  ["allows missing status", () => equal(isBeatPlaybackBlocked({}), false, "Missing status unexpectedly blocked")],
  ["blocking set contains only the two readiness gates", () => equal(PLAYBACK_BLOCKING_CLOUD_STATUSES.size, 2, "Unexpected playback blocking status added")],
]);
