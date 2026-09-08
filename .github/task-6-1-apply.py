from pathlib import Path

HOOK = r'''import { useCallback, useEffect, useRef, useState } from "react";
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
  return {
    safeBase,
    audioSafeBase: exportMeta && !safeBase.endsWith(`[${exportMeta}]`)
      ? `${safeBase} [${exportMeta}]`
      : safeBase,
  };
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
'''

TEST = r'''import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const downloads = readFileSync(resolve(process.cwd(), "src/features/downloads/useBeatDownloads.ts"), "utf8");
const modal = readFileSync(resolve(process.cwd(), "src/features/downloads/components/CloudFilesModal.tsx"), "utf8");

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing download contract marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("App beat download extraction", () => {
  it("moves export state, destination selection, task start and result listener out of App", () => {
    expect(app).toContain("useBeatDownloads");
    expect(app).toContain("const {\n    cloudFilesBeat,");
    expect(app).not.toContain("const handleGetCloudFile = useCallback");
    expect(app).not.toContain('"beatgaler-download-event"');
    expect(app).not.toContain("startBackgroundDownload");
    expect(downloads).toContain("const handleGetCloudFile = useCallback");
    expect(downloads).toContain('platform.events.listen<BackgroundDownloadEvent>("beatgaler-download-event"');
  });

  it("does not start a native export or claim runtime ownership when destination selection is cancelled", () => {
    expectOrdered(downloads, [
      "destination = await chooseExportFilePath",
      "if (!destination) return;",
      'transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat)',
      "startBackgroundDownload(kind, beat, destination)",
    ]);
  });

  it("keeps background task ownership alive outside the modal and settles only tracked task IDs", () => {
    expect(downloads).toContain("trackedDownloadsRef = useRef<Map<string, TrackedDownload>>(new Map())");
    expect(downloads).toContain("if (!trackedDownloadsRef.current.has(payload.task_id)) return");
    expect(downloads).toContain("trackedDownloadsRef.current.get(taskId)");
    expect(downloads).toContain("cloudFilesBeatRef.current?.id !== tracked.beatId");
    expect(downloads).toContain("if (tracked.ownsRuntimeDownloadState)");
    expect(downloads).toContain('type: "DOWNLOAD_SUCCEEDED"');
    expect(downloads).toContain('type: "DOWNLOAD_FAILED"');
    expect(app).toContain("onClose={closeCloudFiles}");
  });

  it("routes Web exports through the existing web downloads manager and treats picker cancellation as a no-op", () => {
    expect(downloads).toContain('if (platform.kind === "web")');
    expect(downloads).toContain("platform.downloads.start(beat, kind)");
    expect(downloads).toContain("task.completed.then(result =>");
    expect(downloads).toContain("if (result.cancelled) cancelTrackedDownloadUi(task.id)");
    expect(modal).toContain("beat.assets?.master");
    expect(modal).toContain("beat.assets?.wav");
    expect(modal).toContain("beat.assets?.project");
  });
});
'''

app_path = Path("src/App.tsx")
text = app_path.read_text()


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one App.tsx match, got {count}: {old[:100]!r}")
    text = text.replace(old, new, 1)


if "### [ ] 6.1 — Separar las descargas de exportación" not in Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md").read_text():
    raise SystemExit("Task 6.1 is not pending on this branch")
if Path("src/features/downloads/useBeatDownloads.ts").exists():
    raise SystemExit("Task 6.1 implementation file already exists; refusing to duplicate it")

replace_once('import downloadCompleteWav from "./assets/status/download-complete.wav";\n', '')
replace_once('listCloudFilesForBeat, downloadCloudFileToCache, downloadProjectToCache, startBackgroundDownload, revealInExplorer,', 'downloadCloudFileToCache, downloadProjectToCache, revealInExplorer,')
replace_once('getCloudClientId, chooseExportFilePath, chooseExportFolder, copyExportFile,', 'getCloudClientId, copyExportFile,')
replace_once('type CloudFileType, type CloudFileRecord, type BackgroundDownloadEvent, type ImportBatchPreview,', 'type CloudFileType, type ImportBatchPreview,')
replace_once('import { listen } from "@tauri-apps/api/event";\n', '')
replace_once(
    'import CloudFilesModal, { type BeatDownloadKind } from "./features/downloads/components/CloudFilesModal";\n',
    'import CloudFilesModal from "./features/downloads/components/CloudFilesModal";\nimport { useBeatDownloads } from "./features/downloads/useBeatDownloads";\n',
)

state_start = text.index('  const [cloudFilesBeat, setCloudFilesBeat] = useState<Beat | null>(null);')
state_end_marker = '  const backgroundDownloadRuntimeOwnersRef = useRef<Set<string>>(new Set());\n'
state_end = text.index(state_end_marker, state_start) + len(state_end_marker)
text = text[:state_start] + text[state_end:]

connection_marker = '''  const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
    typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "checking"
  );
'''
hook_call = '''  const {
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
  } = useBeatDownloads({ connectionState, beatRuntimeStatesRef, transitionRuntime });
'''
replace_once(connection_marker, connection_marker + hook_call)

block_start = text.index('  const handleCloudFiles = useCallback')
block_end = text.index('  const reloadLibrary = useCallback', block_start)
text = text[:block_start] + text[block_end:]

replace_once('onClick={() => setCloudFilesDownloadError(null)}', 'onClick={dismissDownloadError}')
replace_once('onClose={() => setCloudFilesBeat(null)}', 'onClose={closeCloudFiles}')
app_path.write_text(text)

modal_path = Path("src/features/downloads/components/CloudFilesModal.tsx")
modal = modal_path.read_text()
old = '''  const hasMp3 = Boolean(beat.telegram_file_id) || Boolean(beat.offline_available && beat.mp3_path);
  const hasWav = Boolean(beat.offline_available && beat.wav_path) || files.some(file => file.file_type === "WAV");
  const hasProject = Boolean(beat.offline_available && (beat.flp_path || beat.als_path)) || files.some(file => file.file_type === "PROJECT");
'''
new = '''  const hasMp3 = Boolean(beat.assets?.master) || Boolean(beat.telegram_file_id) || Boolean(beat.offline_available && beat.mp3_path);
  const hasWav = Boolean(beat.assets?.wav) || Boolean(beat.offline_available && beat.wav_path) || files.some(file => file.file_type === "WAV");
  const hasProject = Boolean(beat.assets?.project) || Boolean(beat.offline_available && (beat.flp_path || beat.als_path)) || files.some(file => file.file_type === "PROJECT");
'''
if modal.count(old) != 1:
    raise SystemExit("Expected CloudFilesModal availability block once")
modal_path.write_text(modal.replace(old, new, 1))

Path("src/features/downloads/useBeatDownloads.ts").write_text(HOOK)
Path("tests/integration/appBeatDownloadsExtraction.test.ts").write_text(TEST)

final_app = app_path.read_text()
if 'const handleGetCloudFile = useCallback' in final_app or '"beatgaler-download-event"' in final_app:
    raise SystemExit("Download ownership still remains in App.tsx")
if 'useBeatDownloads({ connectionState, beatRuntimeStatesRef, transitionRuntime })' not in final_app:
    raise SystemExit("App composition does not call useBeatDownloads")
