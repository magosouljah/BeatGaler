import { isBeatPlaybackBlocked } from "../src/features/playback/playbackReadiness.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

for (const cloud_status of ["UPLOADING", "PLAYBACK_PREPARING", "uploading", "playback_preparing"]) {
  assert(isBeatPlaybackBlocked({ cloud_status }), `${cloud_status} must block Play`);
}

for (const cloud_status of ["UPLOAD_COMPLETE", "CLOUD_ONLY", "SYNCED", "ERROR", null, undefined]) {
  assert(!isBeatPlaybackBlocked({ cloud_status }), `${String(cloud_status)} must not be classified as loading`);
}

console.log("PASS playback readiness: uploading/preparing beats cannot Play; completed cloud beats can");
