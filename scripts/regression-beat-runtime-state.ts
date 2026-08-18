import {
  InvalidBeatRuntimeTransitionError,
  createBeatRuntimeState,
  hydrateBeatRuntimeState,
  transitionBeatRuntimeState,
} from "../src/features/state/beatRuntimeState.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectInvalid(work: () => void, label: string) {
  try {
    work();
  } catch (error) {
    assert(error instanceof InvalidBeatRuntimeTransitionError, `${label}: wrong error type`);
    return;
  }
  throw new Error(`${label}: expected invalid transition`);
}

// Import: pending_upload -> uploading -> synced.
let state = createBeatRuntimeState({ telegram_file_id: null, offline_available: false });
assert(state.sync_state === "pending_upload", "local import must begin pending_upload");
state = transitionBeatRuntimeState(state, { type: "SYNC_UPLOAD_STARTED" });
assert(state.sync_state === "uploading", "upload must enter uploading");
state = transitionBeatRuntimeState(state, { type: "SYNC_UPLOAD_SUCCEEDED" });
assert(state.sync_state === "synced", "successful upload must enter synced");


// Upload failure: previous_state identifies the failed operation without inventing upload_error.
let uploadFailure = createBeatRuntimeState({ telegram_file_id: null, offline_available: false });
uploadFailure = transitionBeatRuntimeState(uploadFailure, { type: "SYNC_UPLOAD_STARTED" });
uploadFailure = transitionBeatRuntimeState(uploadFailure, {
  type: "SYNC_FAILED", code: "NETWORK", message: "offline", retryable: true,
});
assert(uploadFailure.sync_state === "error", "failed upload must enter error");
assert(uploadFailure.error?.previous_state === "uploading", "upload error must remember previous_state=uploading");
uploadFailure = transitionBeatRuntimeState(uploadFailure, { type: "SYNC_RETRY" });
assert(uploadFailure.sync_state === "pending_upload", "upload retry must re-enter the queue, not fake uploading");

// Delete has a real in-flight state. Success removes the runtime entry at the store layer; failure stays visible as error.
let deleting = createBeatRuntimeState({ telegram_file_id: "master", offline_available: false });
deleting = transitionBeatRuntimeState(deleting, { type: "SYNC_DELETE_STARTED" });
assert(deleting.sync_state === "deleting", "online delete must enter deleting");
deleting = transitionBeatRuntimeState(deleting, { type: "SYNC_FAILED", code: "DELETE", message: "failed", retryable: true });
assert(deleting.error?.previous_state === "deleting", "delete error must remember previous_state=deleting");
deleting = transitionBeatRuntimeState(deleting, { type: "SYNC_RETRY" });
assert(deleting.sync_state === "synced", "failed delete retry/reset must restore stable synced before trying delete again");

// Metadata/file update: synced -> pending_update -> updating -> synced.
state = transitionBeatRuntimeState(state, { type: "SYNC_QUEUE_UPDATE" });
assert(state.sync_state === "pending_update", "update must first enter pending_update");
state = transitionBeatRuntimeState(state, { type: "SYNC_UPDATE_STARTED" });
assert(state.sync_state === "updating", "queued update must enter updating");
state = transitionBeatRuntimeState(state, { type: "SYNC_UPDATE_SUCCEEDED" });
assert(state.sync_state === "synced", "successful update must return to synced");

// Errors remember the previous state and remain until an explicit retry.
state = transitionBeatRuntimeState(state, { type: "SYNC_QUEUE_UPDATE" });
state = transitionBeatRuntimeState(state, { type: "SYNC_UPDATE_STARTED" });
state = transitionBeatRuntimeState(state, {
  type: "SYNC_FAILED",
  code: "TELEGRAM_TIMEOUT",
  message: "Telegram timed out",
  retryable: true,
});
assert(state.sync_state === "error", "failed update must stay in error");
assert(state.error?.previous_state === "updating", "error must remember previous_state=updating");
state = transitionBeatRuntimeState(state, { type: "SYNC_RETRY" });
assert(state.sync_state === "pending_update", "retry after update error must return to pending_update");

// Conflict is reserved for a real concurrent mutation and current-online wins after refresh.
state = transitionBeatRuntimeState(state, { type: "SYNC_UPDATE_STARTED" });
state = transitionBeatRuntimeState(state, {
  type: "SYNC_CONFLICT",
  message: "Beat changed on another device",
  expected_revision: 20,
  current_revision: 21,
});
assert(state.sync_state === "conflict", "version mismatch must enter conflict");
assert(state.conflict?.current_revision === 21, "conflict must retain current revision detail");
state = transitionBeatRuntimeState(state, { type: "SYNC_CONFLICT_RESOLVED" });
assert(state.sync_state === "synced", "resolved conflict must accept latest online revision");

// Download is independent from sync and progress is optional, bounded, monotonic runtime data.
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_STARTED" });
assert(state.sync_state === "synced" && state.download_state === "downloading", "download must not replace sync state");
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_PROGRESS", progress: 0.7 });
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_PROGRESS", progress: 0.4 });
assert(state.download_progress === 0.7, "download progress must not move backwards");
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_PROGRESS", progress: 8 });
assert(state.download_progress === 1, "download progress must clamp to 1");
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_SUCCEEDED" });
assert(state.download_state === "idle" && state.download_progress === null, "completed download must return to idle and clear progress");

state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_STARTED" });
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_FAILED", code: "IO", message: "disk error", retryable: true });
assert(state.download_state === "error" && state.error?.previous_state === "downloading", "download error must remember downloading");
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_RETRY" });
assert(state.download_state === "downloading", "download retry must explicitly restart downloading");
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_SUCCEEDED" });

// Playback can prepare while download is active, then becomes playing.
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_STARTED" });
state = transitionBeatRuntimeState(state, { type: "PLAYBACK_PREPARING" });
assert(state.download_state === "downloading" && state.playback_state === "playback_preparing", "download and playback preparation must coexist");
state = transitionBeatRuntimeState(state, { type: "PLAYBACK_PLAYING" });
assert(state.playback_state === "playing", "prepared playback must enter playing");
state = transitionBeatRuntimeState(state, { type: "PLAYBACK_IDLE" });
assert(state.playback_state === "idle", "stopped playback must return to idle");
state = transitionBeatRuntimeState(state, { type: "PLAYBACK_PREPARING" });
state = transitionBeatRuntimeState(state, { type: "PLAYBACK_FAILED", code: "MASTER", message: "unavailable", retryable: true });
assert(state.playback_state === "error" && state.error?.previous_state === "playback_preparing", "playback error must remember playback_preparing");
state = transitionBeatRuntimeState(state, { type: "PLAYBACK_RETRY" });
assert(state.playback_state === "playback_preparing", "playback retry must prepare again");
state = transitionBeatRuntimeState(state, { type: "PLAYBACK_IDLE" });
state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_SUCCEEDED" });

// Available Offline is an independent durable bit, not a replacement status.
state = transitionBeatRuntimeState(state, { type: "SET_OFFLINE_AVAILABLE", available: true });
assert(state.offline_available && state.sync_state === "synced", "offline pin must coexist with synced");
const hydrated = hydrateBeatRuntimeState(state, { telegram_file_id: "cloud-master", offline_available: false });
assert(!hydrated.offline_available && hydrated.sync_state === "synced", "native Offline hydration must not reset transient machines");

// Offline Trash is the single explicit pending-reconciliation exception.
state = transitionBeatRuntimeState(hydrated, { type: "SET_TRASH_SYNC_REQUIRED", required: true });
assert(state.trash_sync_required, "offline trash must record reconciliation requirement");

// Invalid transitions are rejected instead of silently corrupting the machine.
expectInvalid(
  () => transitionBeatRuntimeState(state, { type: "SYNC_UPLOAD_STARTED" }),
  "synced cannot jump directly to uploading",
);
expectInvalid(
  () => transitionBeatRuntimeState(state, { type: "PLAYBACK_PLAYING" }),
  "idle cannot jump directly to playing",
);

console.log("PASS beat runtime state machine: independent sync/download/playback/offline states and strict transitions");
