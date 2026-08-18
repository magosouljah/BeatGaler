import { createBeatRuntimeState, hydrateBeatRuntimeState, transitionBeatRuntimeState } from "../../src/features/state/beatRuntimeState.js";
import { equal, runSuite, throws } from "../helpers/testHarness.js";

runSuite("beat runtime state", [
  ["new local beat starts pending upload", () => equal(createBeatRuntimeState().sync_state, "pending_upload", "Local beat initial sync state changed")],
  ["cloud-backed beat starts synced", () => equal(createBeatRuntimeState({ telegram_file_id: "file-1" }).sync_state, "synced", "Cloud beat initial sync state changed")],
  ["hydrates only durable offline availability", () => {
    const uploading = transitionBeatRuntimeState(createBeatRuntimeState(), { type: "SYNC_UPLOAD_STARTED" });
    const hydrated = hydrateBeatRuntimeState(uploading, { telegram_file_id: "file-1", offline_available: true });
    equal(hydrated.sync_state, "uploading", "Hydration must not erase transient sync state");
    equal(hydrated.offline_available, true, "Hydration must refresh offline availability");
  }],
  ["valid upload lifecycle reaches synced", () => {
    let state = createBeatRuntimeState();
    state = transitionBeatRuntimeState(state, { type: "SYNC_UPLOAD_STARTED" });
    equal(state.sync_state, "uploading", "Upload did not start");
    state = transitionBeatRuntimeState(state, { type: "SYNC_UPLOAD_SUCCEEDED" });
    equal(state.sync_state, "synced", "Upload did not reach synced");
  }],
  ["invalid upload success is rejected", () => throws(() => transitionBeatRuntimeState(createBeatRuntimeState(), { type: "SYNC_UPLOAD_SUCCEEDED" }), "Upload success from pending_upload must throw")],
  ["sync failure remembers previous state and retryability", () => {
    const uploading = transitionBeatRuntimeState(createBeatRuntimeState(), { type: "SYNC_UPLOAD_STARTED" });
    const failed = transitionBeatRuntimeState(uploading, { type: "SYNC_FAILED", code: "NET", message: "network", retryable: true });
    equal(failed.sync_state, "error", "Sync failure must enter error");
    equal(failed.error?.previous_state, "uploading", "Sync error lost previous state");
    equal(failed.error?.retryable, true, "Sync error lost retryability");
    const retried = transitionBeatRuntimeState(failed, { type: "SYNC_RETRY" });
    equal(retried.sync_state, "pending_upload", "Upload retry must return to pending_upload");
  }],
  ["download progress is bounded and monotonic", () => {
    let state = transitionBeatRuntimeState(createBeatRuntimeState({ telegram_file_id: "file" }), { type: "DOWNLOAD_STARTED" });
    state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_PROGRESS", progress: 0.8 });
    state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_PROGRESS", progress: 0.2 });
    equal(state.download_progress, 0.8, "Download progress moved backwards");
    state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_PROGRESS", progress: 9 });
    equal(state.download_progress, 1, "Download progress was not capped at 1");
  }],
  ["download success returns to idle and clears progress", () => {
    let state = transitionBeatRuntimeState(createBeatRuntimeState({ telegram_file_id: "file" }), { type: "DOWNLOAD_STARTED" });
    state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_SUCCEEDED" });
    equal(state.download_state, "idle", "Download success must return to idle");
    equal(state.download_progress, null, "Download success must clear progress");
  }],
  ["playback requires preparing before playing", () => {
    const initial = createBeatRuntimeState({ telegram_file_id: "file" });
    throws(() => transitionBeatRuntimeState(initial, { type: "PLAYBACK_PLAYING" }), "Direct idle→playing transition must be rejected");
    const preparing = transitionBeatRuntimeState(initial, { type: "PLAYBACK_PREPARING" });
    const playing = transitionBeatRuntimeState(preparing, { type: "PLAYBACK_PLAYING" });
    equal(playing.playback_state, "playing", "Prepared playback did not start");
  }],
  ["playback error can retry through preparing", () => {
    let state = createBeatRuntimeState({ telegram_file_id: "file" });
    state = transitionBeatRuntimeState(state, { type: "PLAYBACK_PREPARING" });
    state = transitionBeatRuntimeState(state, { type: "PLAYBACK_FAILED", code: "MASTER", message: "not ready", retryable: true });
    equal(state.error?.previous_state, "playback_preparing", "Playback error lost previous state");
    state = transitionBeatRuntimeState(state, { type: "PLAYBACK_RETRY" });
    equal(state.playback_state, "playback_preparing", "Playback retry must prepare again");
  }],
  ["independent subsystem activity is preserved", () => {
    let state = createBeatRuntimeState({ telegram_file_id: "file" });
    state = transitionBeatRuntimeState(state, { type: "DOWNLOAD_STARTED" });
    state = transitionBeatRuntimeState(state, { type: "PLAYBACK_PREPARING" });
    equal(state.download_state, "downloading", "Playback transition must not erase download state");
    equal(state.playback_state, "playback_preparing", "Playback did not prepare while download active");
  }],
  ["offline and trash bits remain orthogonal", () => {
    let state = createBeatRuntimeState({ telegram_file_id: "file" });
    state = transitionBeatRuntimeState(state, { type: "SET_OFFLINE_AVAILABLE", available: true });
    state = transitionBeatRuntimeState(state, { type: "SET_TRASH_SYNC_REQUIRED", required: true });
    equal(state.sync_state, "synced", "Durable bits must not change sync state");
    equal(state.offline_available, true, "Offline bit was not set");
    equal(state.trash_sync_required, true, "Trash reconciliation bit was not set");
  }],
]);
