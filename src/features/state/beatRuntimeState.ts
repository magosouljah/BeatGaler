export type SyncState =
  | "pending_upload"
  | "uploading"
  | "synced"
  | "pending_update"
  | "updating"
  | "deleting"
  | "error"
  | "conflict";

export type DownloadState = "idle" | "downloading" | "error";
export type PlaybackState = "idle" | "playback_preparing" | "playing" | "error";
export type BeatRuntimeSubsystem = "sync" | "download" | "playback";
export type BeatRuntimeStateValue = SyncState | DownloadState | PlaybackState;

export interface BeatRuntimeError {
  subsystem: BeatRuntimeSubsystem;
  previous_state: BeatRuntimeStateValue;
  code: string;
  message: string;
  retryable: boolean;
}

export interface BeatRuntimeConflict {
  message: string;
  expected_revision?: number | null;
  current_revision?: number | null;
}

/**
 * Session-local operation state for one beat.
 *
 * Important invariants:
 * - sync/download/playback are independent state machines and may be active together.
 * - offline_available is NOT a state-machine phase. It is a durable desktop pin.
 * - download_progress is optional runtime data (0..1), never a state.
 * - transient operation states are intentionally not persisted across app restarts.
 * - trash_sync_required describes the one deliberate offline mutation exception.
 */
export interface BeatRuntimeState {
  sync_state: SyncState;
  download_state: DownloadState;
  playback_state: PlaybackState;
  offline_available: boolean;
  download_progress: number | null;
  trash_sync_required: boolean;
  error: BeatRuntimeError | null;
  conflict: BeatRuntimeConflict | null;
}

export type BeatRuntimeEvent =
  | { type: "SYNC_QUEUE_UPLOAD" }
  | { type: "SYNC_UPLOAD_STARTED" }
  | { type: "SYNC_UPLOAD_SUCCEEDED" }
  | { type: "SYNC_QUEUE_UPDATE" }
  | { type: "SYNC_UPDATE_SUCCEEDED" }
  | { type: "SYNC_UPDATE_STARTED" }
  | { type: "SYNC_DELETE_STARTED" }
  | { type: "SYNC_FAILED"; code: string; message: string; retryable: boolean }
  | { type: "SYNC_RETRY" }
  | { type: "SYNC_CONFLICT"; message: string; expected_revision?: number | null; current_revision?: number | null }
  | { type: "SYNC_CONFLICT_RESOLVED" }
  | { type: "DOWNLOAD_STARTED" }
  | { type: "DOWNLOAD_PROGRESS"; progress: number }
  | { type: "DOWNLOAD_SUCCEEDED" }
  | { type: "DOWNLOAD_FAILED"; code: string; message: string; retryable: boolean }
  | { type: "DOWNLOAD_RETRY" }
  | { type: "PLAYBACK_PREPARING" }
  | { type: "PLAYBACK_PLAYING" }
  | { type: "PLAYBACK_IDLE" }
  | { type: "PLAYBACK_FAILED"; code: string; message: string; retryable: boolean }
  | { type: "PLAYBACK_RETRY" }
  | { type: "SET_OFFLINE_AVAILABLE"; available: boolean }
  | { type: "SET_TRASH_SYNC_REQUIRED"; required: boolean };

export class InvalidBeatRuntimeTransitionError extends Error {
  constructor(machine: BeatRuntimeSubsystem, from: string, event: string) {
    super(`Invalid BeatGaler ${machine} transition: ${from} --${event}--> ?`);
    this.name = "InvalidBeatRuntimeTransitionError";
  }
}

function fail(machine: BeatRuntimeSubsystem, from: string, event: BeatRuntimeEvent["type"]): never {
  throw new InvalidBeatRuntimeTransitionError(machine, from, event);
}

function clearSubsystemError(state: BeatRuntimeState, subsystem: BeatRuntimeSubsystem): BeatRuntimeError | null {
  return state.error?.subsystem === subsystem ? null : state.error;
}

function runtimeError(
  subsystem: BeatRuntimeSubsystem,
  previousState: BeatRuntimeStateValue,
  code: string,
  message: string,
  retryable: boolean,
): BeatRuntimeError {
  return {
    subsystem,
    previous_state: previousState,
    code: code.trim() || "UNKNOWN",
    message: message.trim() || "Unknown error",
    retryable,
  };
}

type BeatRuntimeSeed = { telegram_file_id?: string | null; offline_available?: boolean };

export function createBeatRuntimeState(beat?: BeatRuntimeSeed | null): BeatRuntimeState {
  return {
    // A cloud-backed beat loaded on a fresh app session is stable/synced.
    // A local import candidate has no Telegram MASTER yet and is waiting to upload.
    sync_state: beat?.telegram_file_id ? "synced" : "pending_upload",
    download_state: "idle",
    playback_state: "idle",
    offline_available: Boolean(beat?.offline_available),
    download_progress: null,
    trash_sync_required: false,
    error: null,
    conflict: null,
  };
}

/** Keep transient machine phases, but re-hydrate the durable Offline bit from native BeatMeta. */
export function hydrateBeatRuntimeState(current: BeatRuntimeState | undefined, beat: BeatRuntimeSeed): BeatRuntimeState {
  if (!current) return createBeatRuntimeState(beat);
  return current.offline_available === Boolean(beat.offline_available)
    ? current
    : { ...current, offline_available: Boolean(beat.offline_available) };
}

export function transitionBeatRuntimeState(state: BeatRuntimeState, event: BeatRuntimeEvent): BeatRuntimeState {
  switch (event.type) {
    case "SYNC_QUEUE_UPLOAD": {
      if (state.sync_state !== "pending_upload" && state.sync_state !== "error") {
        return fail("sync", state.sync_state, event.type);
      }
      if (state.sync_state === "error" && state.error?.subsystem === "sync") {
        const previous = state.error.previous_state;
        if (previous !== "pending_upload" && previous !== "uploading") {
          return fail("sync", state.sync_state, event.type);
        }
      }
      return { ...state, sync_state: "pending_upload", error: clearSubsystemError(state, "sync"), conflict: null };
    }

    case "SYNC_UPLOAD_STARTED":
      if (state.sync_state !== "pending_upload") return fail("sync", state.sync_state, event.type);
      return { ...state, sync_state: "uploading", error: clearSubsystemError(state, "sync"), conflict: null };

    case "SYNC_UPLOAD_SUCCEEDED":
      if (state.sync_state !== "uploading") return fail("sync", state.sync_state, event.type);
      return { ...state, sync_state: "synced", error: clearSubsystemError(state, "sync"), conflict: null };

    case "SYNC_UPDATE_SUCCEEDED":
      if (state.sync_state !== "updating") return fail("sync", state.sync_state, event.type);
      return { ...state, sync_state: "synced", error: clearSubsystemError(state, "sync"), conflict: null };

    case "SYNC_QUEUE_UPDATE":
      if (state.sync_state !== "synced" && state.sync_state !== "error") return fail("sync", state.sync_state, event.type);
      if (state.sync_state === "error" && state.error?.subsystem === "sync") {
        const previous = state.error.previous_state;
        if (previous !== "pending_update" && previous !== "updating") return fail("sync", state.sync_state, event.type);
      }
      return { ...state, sync_state: "pending_update", error: clearSubsystemError(state, "sync"), conflict: null };

    case "SYNC_UPDATE_STARTED":
      if (state.sync_state !== "pending_update") return fail("sync", state.sync_state, event.type);
      return { ...state, sync_state: "updating", error: clearSubsystemError(state, "sync"), conflict: null };

    case "SYNC_DELETE_STARTED":
      if (state.sync_state !== "synced" && state.sync_state !== "error") return fail("sync", state.sync_state, event.type);
      return { ...state, sync_state: "deleting", error: clearSubsystemError(state, "sync"), conflict: null };

    case "SYNC_FAILED": {
      if (state.sync_state === "synced" || state.sync_state === "error" || state.sync_state === "conflict") {
        return fail("sync", state.sync_state, event.type);
      }
      return {
        ...state,
        sync_state: "error",
        error: runtimeError("sync", state.sync_state, event.code, event.message, event.retryable),
      };
    }

    case "SYNC_RETRY": {
      if (state.sync_state !== "error" || state.error?.subsystem !== "sync") return fail("sync", state.sync_state, event.type);
      const previous = state.error.previous_state;
      if (previous === "pending_upload" || previous === "uploading") {
        return { ...state, sync_state: "pending_upload", error: null, conflict: null };
      }
      if (previous === "pending_update" || previous === "updating") {
        return { ...state, sync_state: "pending_update", error: null, conflict: null };
      }
      if (previous === "deleting") {
        return { ...state, sync_state: "synced", error: null, conflict: null };
      }
      return fail("sync", state.sync_state, event.type);
    }

    case "SYNC_CONFLICT":
      if (state.sync_state !== "pending_update" && state.sync_state !== "updating" && state.sync_state !== "deleting") {
        return fail("sync", state.sync_state, event.type);
      }
      return {
        ...state,
        sync_state: "conflict",
        conflict: {
          message: event.message,
          expected_revision: event.expected_revision ?? null,
          current_revision: event.current_revision ?? null,
        },
        error: null,
      };

    case "SYNC_CONFLICT_RESOLVED":
      if (state.sync_state !== "conflict") return fail("sync", state.sync_state, event.type);
      return { ...state, sync_state: "synced", conflict: null, error: null };

    case "DOWNLOAD_STARTED":
      if (state.download_state !== "idle" && state.download_state !== "error") return fail("download", state.download_state, event.type);
      return {
        ...state,
        download_state: "downloading",
        download_progress: 0,
        error: clearSubsystemError(state, "download"),
      };

    case "DOWNLOAD_PROGRESS": {
      if (state.download_state !== "downloading") return fail("download", state.download_state, event.type);
      const bounded = Math.max(0, Math.min(1, Number.isFinite(event.progress) ? event.progress : 0));
      const monotonic = Math.max(state.download_progress ?? 0, bounded);
      return { ...state, download_progress: monotonic };
    }

    case "DOWNLOAD_SUCCEEDED":
      if (state.download_state !== "downloading") return fail("download", state.download_state, event.type);
      return {
        ...state,
        download_state: "idle",
        download_progress: null,
        error: clearSubsystemError(state, "download"),
      };

    case "DOWNLOAD_FAILED":
      if (state.download_state !== "downloading") return fail("download", state.download_state, event.type);
      return {
        ...state,
        download_state: "error",
        download_progress: null,
        error: runtimeError("download", "downloading", event.code, event.message, event.retryable),
      };

    case "DOWNLOAD_RETRY":
      if (state.download_state !== "error" || state.error?.subsystem !== "download") return fail("download", state.download_state, event.type);
      return { ...state, download_state: "downloading", download_progress: 0, error: null };

    case "PLAYBACK_PREPARING":
      if (state.playback_state !== "idle" && state.playback_state !== "error" && state.playback_state !== "playing") {
        return fail("playback", state.playback_state, event.type);
      }
      return { ...state, playback_state: "playback_preparing", error: clearSubsystemError(state, "playback") };

    case "PLAYBACK_PLAYING":
      if (state.playback_state !== "playback_preparing") return fail("playback", state.playback_state, event.type);
      return { ...state, playback_state: "playing", error: clearSubsystemError(state, "playback") };

    case "PLAYBACK_IDLE":
      if (state.playback_state === "idle") return state;
      return { ...state, playback_state: "idle", error: clearSubsystemError(state, "playback") };

    case "PLAYBACK_FAILED":
      if (state.playback_state !== "playback_preparing" && state.playback_state !== "playing") {
        return fail("playback", state.playback_state, event.type);
      }
      return {
        ...state,
        playback_state: "error",
        error: runtimeError("playback", state.playback_state, event.code, event.message, event.retryable),
      };

    case "PLAYBACK_RETRY":
      if (state.playback_state !== "error" || state.error?.subsystem !== "playback") return fail("playback", state.playback_state, event.type);
      return { ...state, playback_state: "playback_preparing", error: null };

    case "SET_OFFLINE_AVAILABLE":
      return { ...state, offline_available: event.available };

    case "SET_TRASH_SYNC_REQUIRED":
      return { ...state, trash_sync_required: event.required };
  }
}
