import { useCallback, useEffect, useRef, useState } from "react";
import downloadCompleteWav from "../../assets/status/download-complete.wav";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import {
  chooseExportFilePath,
  chooseExportFolder,
  listCloudFilesForBeat,
  startBackgroundDownload,
  type BackgroundDownloadEvent,
  type CloudFileRecord,
} from "../../lib/tauri";
import { platform } from "../../platform";
import { createBeatRuntimeState } from "../state/beatRuntimeState";
import type { BeatRuntimeRegistry } from "../state/useBeatRuntimeRegistry";
import type { BeatDownloadKind } from "./components/CloudFilesModal";

export type DownloadConnectionState = "checking" | "online" | "poor" | "offline";

export type CloudDownloadNotice = {
  taskId: string;
  kind: BeatDownloadKind;
  beatName: string;
  status: "downloading" | "completed";
};

type TrackedDownload = {
  beatId: string;
  beatName: string;
  kind: BeatDownloadKind;
  ownsRuntimeDownloadState: boolean;
};

type Params = {
  connectionState: DownloadConnectionState;
  beatRuntimeStatesRef: BeatRuntimeRegistry["beatRuntimeStatesRef"];
  transitionRuntime: BeatRuntimeRegistry["transitionRuntime"];
};

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeBeatBaseName(beat: Beat): { safeBase: string; audioSafeBase: string } {
  const safeBase = (beat.name || "Beat")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim() || "Beat";
  const exportMeta = [String(beat.bpm || "").trim(), String(beat.key || "").trim()]
    .filter(Boolean)
    .join(" ");
  const audioSafeBase = exportMeta && !safeBase.endsWith(`[${exportMeta}]`)
    ? `${safeBase} [${exportMeta}]`
    : safeBase;
  return { safeBase, audioSafeBase };
}

export function useBeatDownloads({ connectionState, beatRuntimeStatesRef, transitionRuntime }: Params) {
  const [cloudFilesBeat, setCloudFilesBeat] = useState<Beat | null>(null);
  const cloudFilesBeatRef = useRef<Beat | null>(null);
  const [cloudFiles, setCloudFiles] = useState<CloudFileRecord[]>([]);
  const [cloudFilesBusyId, setCloudFilesBusyId] = useState<string | null>(null);
  const [cloudFilesDownloadedIds, setCloudFilesDownloadedIds] = useState<Set<string>>(new Set());
  const [cloudFilesDownloadError, setCloudFilesDownloadError] = useState<string | null>(null);
  const [cloudDownloadNotice, setCloudDownloadNotice] = useState<CloudDownloadNotice | null>(null);
  const trackedDownloadsRef = useRef<Map<string, TrackedDownload>>(new Map());

  const closeCloudFiles = useCallback(() => {
    cloudFilesBeatRef.current = null;
    setCloudFilesBeat(null);
  }, []);

  const dismissDownloadError = useCallback(() => setCloudFilesDownloadError(null), []);

  const handleCloudFiles = useCallback(async (beat: Beat) => {
    if (connectionState !== "online" && !beat.offline_available) {
      await appAlert({
        title: "Files unavailable offline",
        message: "This beat was not made Available Offline. Reconnect to download its cloud files.",
      });
      return;
    }
    try {
      // Web already carries authoritative asset refs on the Beat. Desktop keeps
      // the existing native file inventory, which also understands durable Offline packages.
      const files = platform.kind === "web" ? [] : await listCloudFilesForBeat(beat.id);
      cloudFilesBeatRef.current = beat;
      setCloudFiles(files);
      setCloudFilesDownloadedIds(new Set());
      setCloudFilesDownloadError(null);
      setCloudFilesBeat(beat);
    } catch (error) {
      await appAlert({ title: "Cloud files", message: String(error), danger: true });
    }
  }, [connectionState]);

  const completeTrackedDownload = useCallback((taskId: string) => {
    const tracked = trackedDownloadsRef.current.get(taskId);
    if (!tracked) return;
    trackedDownloadsRef.current.delete(taskId);

    if (tracked.ownsRuntimeDownloadState) {
      transitionRuntime(tracked.beatId, { type: "DOWNLOAD_SUCCEEDED" });
    }
    setCloudFilesBusyId(current => current === tracked.kind ? null : current);
    setCloudFilesDownloadedIds(previous => {
      // A task may finish after its modal was closed or another beat was opened.
      // Never mark a different beat's row as downloaded.
      if (cloudFilesBeatRef.current?.id !== tracked.beatId) return previous;
      const next = new Set(previous);
      next.add(tracked.kind);
      return next;
    });

    try {
      const audio = new Audio(downloadCompleteWav);
      audio.volume = 0.68;
      void audio.play().catch(() => {});
    } catch {}

    setCloudDownloadNotice({
      taskId,
      kind: tracked.kind,
      beatName: tracked.beatName,
      status: "completed",
    });
    window.setTimeout(() => {
      setCloudDownloadNotice(current =>
        current?.taskId === taskId && current.status === "completed" ? null : current
      );
    }, 1000);
  }, [transitionRuntime]);

  const failTrackedDownload = useCallback((taskId: string, error: unknown) => {
    const tracked = trackedDownloadsRef.current.get(taskId);
    if (!tracked) return;
    trackedDownloadsRef.current.delete(taskId);
    const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Download failed.");
    if (tracked.ownsRuntimeDownloadState) {
      transitionRuntime(tracked.beatId, {
        type: "DOWNLOAD_FAILED",
        code: "DOWNLOAD_FAILED",
        message,
        retryable: true,
      });
    }
    setCloudFilesBusyId(current => current === tracked.kind ? null : current);
    setCloudDownloadNotice(current => current?.taskId === taskId ? null : current);
    setCloudFilesDownloadError(message);
  }, [transitionRuntime]);

  const cancelTrackedDownloadUi = useCallback((taskId: string) => {
    const tracked = trackedDownloadsRef.current.get(taskId);
    if (!tracked) return;
    trackedDownloadsRef.current.delete(taskId);
    setCloudFilesBusyId(current => current === tracked.kind ? null : current);
    setCloudDownloadNotice(current => current?.taskId === taskId ? null : current);
  }, []);

  const handleGetCloudFile = useCallback(async (kind: BeatDownloadKind) => {
    const beat = cloudFilesBeatRef.current;
    if (!beat || cloudFilesBusyId) return;
    setCloudFilesDownloadError(null);

    if (platform.kind === "web") {
      try {
        const task = platform.downloads.start(beat, kind);
        trackedDownloadsRef.current.set(task.id, {
          beatId: beat.id,
          beatName: beat.name || "Beat",
          kind,
          ownsRuntimeDownloadState: false,
        });
        setCloudFilesBusyId(kind);
        setCloudDownloadNotice({ taskId: task.id, kind, beatName: beat.name || "Beat", status: "downloading" });
        void task.completed.then(result => {
          if (result.cancelled) cancelTrackedDownloadUi(task.id);
          else completeTrackedDownload(task.id);
        }).catch(error => failTrackedDownload(task.id, error));
      } catch (error) {
        setCloudFilesBusyId(null);
        setCloudDownloadNotice(null);
        setCloudFilesDownloadError(sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed."));
      }
      return;
    }

    const { safeBase, audioSafeBase } = safeBeatBaseName(beat);
    let ownsRuntimeDownloadState = false;
    try {
      let destination: string | null = null;
      if (kind === "MP3") destination = await chooseExportFilePath(`${audioSafeBase}.mp3`, "mp3");
      else if (kind === "WAV") destination = await chooseExportFilePath(`${audioSafeBase}.wav`, "wav");
      else if (kind === "PROJECT") destination = await chooseExportFilePath(`${safeBase}.zip`, "zip");
      else destination = await chooseExportFolder();

      // The native worker must not start, and runtime state must not change,
      // when the user cancels the destination selector.
      if (!destination) return;

      const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (runtime.download_state !== "downloading") {
        transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat);
        ownsRuntimeDownloadState = true;
      }

      const taskId = await startBackgroundDownload(kind, beat, destination);
      trackedDownloadsRef.current.set(taskId, {
        beatId: beat.id,
        beatName: beat.name || "Beat",
        kind,
        ownsRuntimeDownloadState,
      });
      setCloudFilesBusyId(kind);
      setCloudDownloadNotice({ taskId, kind, beatName: beat.name || "Beat", status: "downloading" });
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      if (ownsRuntimeDownloadState) {
        transitionRuntime(beat.id, {
          type: "DOWNLOAD_FAILED",
          code: "DOWNLOAD_START_FAILED",
          message,
          retryable: true,
        }, beat);
      }
      setCloudFilesBusyId(null);
      setCloudDownloadNotice(null);
      setCloudFilesDownloadError(message);
    }
  }, [beatRuntimeStatesRef, cancelTrackedDownloadUi, cloudFilesBusyId, completeTrackedDownload, failTrackedDownload, transitionRuntime]);

  useEffect(() => {
    if (platform.kind !== "desktop") return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void platform.events.listen<BackgroundDownloadEvent>("beatgaler-download-event", payload => {
      if (disposed) return;
      // Other subsystems may use the same native event family. Only settle
      // tasks started by this export owner.
      if (!trackedDownloadsRef.current.has(payload.task_id)) return;
      if (payload.status === "error") {
        failTrackedDownload(payload.task_id, payload.error || "Download failed.");
        return;
      }
      completeTrackedDownload(payload.task_id);
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => console.warn("Background download listener failed:", error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [completeTrackedDownload, failTrackedDownload]);

  return {
    cloudFilesBeat,
    cloudFiles,
    cloudFilesBusyId,
    cloudFilesDownloadedIds,
    cloudFilesDownloadError,
    cloudDownloadNotice,
    handleCloudFiles,
    handleGetCloudFile,
    closeCloudFiles,
    dismissDownloadError,
  };
}
