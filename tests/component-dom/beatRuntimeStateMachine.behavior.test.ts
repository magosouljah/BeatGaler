import { describe, expect, it } from "vitest";
import {
  createBeatRuntimeState,
  transitionBeatRuntimeState as step,
  type BeatRuntimeEvent,
  type BeatRuntimeState,
} from "../../src/features/state/beatRuntimeState";

const fail = (type: "SYNC_FAILED" | "DOWNLOAD_FAILED" | "PLAYBACK_FAILED"): BeatRuntimeEvent =>
  ({ type, code: "X", message: "m", retryable: true }) as BeatRuntimeEvent;
const run = (state: BeatRuntimeState, ...events: BeatRuntimeEvent[]) => events.reduce(step, state);
const synced = () => createBeatRuntimeState({ telegram_file_id: "f" });

describe("beat runtime state machine (behavior)", () => {
  it("reaches every one of the twelve definitive states through valid transitions", () => {
    const seen = new Set<string>();
    const note = (s: BeatRuntimeState) => { seen.add(s.sync_state); seen.add(s.download_state); seen.add(s.playback_state); return s; };
    let s = note(createBeatRuntimeState());
    s = note(run(s, { type: "SYNC_UPLOAD_STARTED" }));
    s = note(run(s, { type: "SYNC_UPLOAD_SUCCEEDED" }));
    s = note(run(s, { type: "SYNC_QUEUE_UPDATE" }));
    s = note(run(s, { type: "SYNC_UPDATE_STARTED" }));
    s = note(run(s, { type: "SYNC_CONFLICT", message: "c" }));
    s = note(run(s, { type: "SYNC_CONFLICT_RESOLVED" }));
    s = note(run(s, { type: "SYNC_DELETE_STARTED" }));
    s = note(run(s, fail("SYNC_FAILED")));
    s = note(run(s, { type: "DOWNLOAD_STARTED" }));
    s = note(run(s, { type: "PLAYBACK_PREPARING" }));
    s = note(run(s, { type: "PLAYBACK_PLAYING" }));
    expect([...seen].sort()).toEqual([
      "conflict", "deleting", "downloading", "error", "idle", "pending_update", "pending_upload",
      "playback_preparing", "playing", "synced", "updating", "uploading",
    ].sort());
  });

  it("errors remember the exact previous state per subsystem", () => {
    expect(run(synced(), { type: "SYNC_QUEUE_UPDATE" }, { type: "SYNC_UPDATE_STARTED" }, fail("SYNC_FAILED")).error)
      .toMatchObject({ subsystem: "sync", previous_state: "updating", retryable: true });
    expect(run(synced(), { type: "DOWNLOAD_STARTED" }, fail("DOWNLOAD_FAILED")).error)
      .toMatchObject({ subsystem: "download", previous_state: "downloading" });
    expect(run(synced(), { type: "PLAYBACK_PREPARING" }, fail("PLAYBACK_FAILED")).error)
      .toMatchObject({ subsystem: "playback", previous_state: "playback_preparing" });
  });

  it("offline availability, trash reconciliation and download progress are data, not phases", () => {
    const s = run(synced(), { type: "SET_OFFLINE_AVAILABLE", available: true }, { type: "SET_TRASH_SYNC_REQUIRED", required: true });
    expect(s).toMatchObject({ sync_state: "synced", download_state: "idle", playback_state: "idle", offline_available: true, trash_sync_required: true, download_progress: null });
    const downloading = run(s, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_PROGRESS", progress: 0.5 });
    expect(downloading.download_progress).toBe(0.5);
    expect(downloading.offline_available).toBe(true);
    expect(run(downloading, { type: "DOWNLOAD_SUCCEEDED" }).download_progress).toBeNull();
  });
});
