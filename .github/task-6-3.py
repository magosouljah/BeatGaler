from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INITIAL_SHA = "988a0e2af912a06a0d186008de8f6b0a3d28f64e"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


PIPELINE = r'''import type { Beat } from "../../types";

export type DesktopBeatUploadPipelineFile = {
  file_type?: string | null;
};

export type DesktopBeatUploadPipelineProjectStatus = {
  synced?: boolean;
} | null;

export type DesktopBeatUploadPipelineDependencies = {
  uploadMaster: (beat: Beat) => Promise<Beat>;
  listCloudFiles: (beatId: string) => Promise<DesktopBeatUploadPipelineFile[]>;
  uploadWav: (beat: Beat, path: string) => Promise<unknown>;
  getProjectStatus: (beat: Beat) => Promise<DesktopBeatUploadPipelineProjectStatus>;
  uploadProject: (beat: Beat) => Promise<unknown>;
  detachLocalSources: (beatId: string) => Promise<Beat>;
  syncMetadata: (beat: Beat) => Promise<unknown>;
  commitSnapshot: (snapshot: Beat[], reason: string) => Promise<unknown>;
  clearUploadMarker: (beatId: string) => void;
  waitForPlaybackReady: (beat: Beat) => Promise<boolean>;
};

export type DesktopBeatUploadPipelineActions = {
  onMasterUploaded: (beat: Beat) => void;
  onDetached: (beat: Beat) => void;
  getLibrarySnapshot: () => Beat[];
  onIndexCommitted: (beat: Beat, snapshot: Beat[]) => void;
  onPlaybackPreparing: (beat: Beat) => void;
};

export type DesktopBeatUploadPipelineResult = {
  beat: Beat;
  playbackReady: boolean;
  remoteUploadCompleted: boolean;
  syncCommitted: boolean;
};

export class DesktopBeatUploadPipelineError extends Error {
  readonly stage: string;
  readonly beat: Beat;
  readonly remoteUploadCompleted: boolean;
  readonly syncCommitted: boolean;
  readonly originalError: unknown;

  constructor(input: {
    stage: string;
    beat: Beat;
    remoteUploadCompleted: boolean;
    syncCommitted: boolean;
    originalError: unknown;
  }) {
    super(`Desktop beat upload failed at ${input.stage}`);
    this.name = "DesktopBeatUploadPipelineError";
    this.stage = input.stage;
    this.beat = input.beat;
    this.remoteUploadCompleted = input.remoteUploadCompleted;
    this.syncCommitted = input.syncCommitted;
    this.originalError = input.originalError;
  }
}

export async function runDesktopBeatUploadPipeline(input: {
  original: Beat;
  dependencies: DesktopBeatUploadPipelineDependencies;
  actions: DesktopBeatUploadPipelineActions;
}): Promise<DesktopBeatUploadPipelineResult> {
  const { original, dependencies, actions } = input;
  let uploadStage = "Prepare upload";
  let remoteUploadCompleted = false;
  let syncCommitted = false;
  let currentBeat = original;

  try {
    let uploaded = original;

    // MASTER is a checkpoint: retry must not re-upload a slot already owned by the beat.
    if (!uploaded.telegram_file_id) {
      uploadStage = "Upload MASTER audio";
      uploaded = await dependencies.uploadMaster(uploaded);
      currentBeat = uploaded;
      actions.onMasterUploaded(uploaded);
    }

    uploadStage = "Read existing cloud file slots";
    const existingFiles = await dependencies.listCloudFiles(uploaded.id);
    const hasCloudWav = existingFiles.some(file => file.file_type === "WAV");

    if (uploaded.wav_path && !hasCloudWav) {
      uploadStage = "Upload WAV HQ";
      await dependencies.uploadWav(uploaded, uploaded.wav_path);
    }

    const hasProjectSource =
      !!uploaded.flp_path || !!uploaded.als_path || uploaded.has_flp || uploaded.has_als;

    if (hasProjectSource) {
      uploadStage = "Check PROJECT cloud state";
      const currentProject = await dependencies.getProjectStatus(uploaded);
      if (!currentProject?.synced) {
        uploadStage = "Build and upload PROJECT.zip";
        await dependencies.uploadProject(uploaded);
      }
    }

    // Every required Cloud media slot is durable after this point. Failures below
    // are finalization/playback failures and must never imply that media must roll back.
    remoteUploadCompleted = true;

    uploadStage = "Finalize cloud copy and detach local sources";
    const detached = await dependencies.detachLocalSources(uploaded.id);
    currentBeat = detached;
    actions.onDetached(detached);

    // Metadata/artwork belongs to the same logical beat transaction and precedes
    // the one authoritative INDEX commit for this beat.
    uploadStage = "Sync artwork and metadata";
    await dependencies.syncMetadata(detached);

    uploadStage = "Commit beat to authoritative INDEX";
    const indexSnapshot = actions.getLibrarySnapshot().map(beat =>
      beat.id === detached.id
        ? { ...detached, cloud_status: "CLOUD_ONLY" }
        : beat
    );
    await dependencies.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`);
    syncCommitted = true;
    actions.onIndexCommitted(detached, indexSnapshot);

    // This is the durable boundary. The recovery marker must be gone before any
    // playback preparation can fail or before the coordinator advances to another beat.
    dependencies.clearUploadMarker(original.id);

    uploadStage = "Prepare uploaded MASTER for first Play";
    actions.onPlaybackPreparing(detached);
    const playbackReady = await dependencies.waitForPlaybackReady(detached);

    return {
      beat: detached,
      playbackReady,
      remoteUploadCompleted,
      syncCommitted,
    };
  } catch (originalError) {
    throw new DesktopBeatUploadPipelineError({
      stage: uploadStage,
      beat: currentBeat,
      remoteUploadCompleted,
      syncCommitted,
      originalError,
    });
  }
}
'''


TEST = r'''import { describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import {
  DesktopBeatUploadPipelineError,
  runDesktopBeatUploadPipeline,
  type DesktopBeatUploadPipelineActions,
  type DesktopBeatUploadPipelineDependencies,
} from "../../src/features/cloud/desktopBeatUploadPipeline";

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    id: "beat-1",
    name: "Night Drive",
    folder_path: "C:/beats/Night Drive",
    mp3_path: "C:/beats/Night Drive/Night Drive.mp3",
    wav_path: null,
    playback_path: "C:/beats/Night Drive/Night Drive.mp3",
    bpm: "120",
    key: "Am",
    needs_resolution: false,
    tags: [],
    rating: 0,
    image_base64: null,
    has_wav: false,
    has_stems: false,
    has_samples: false,
    samples_path: null,
    has_flp: false,
    has_als: false,
    stems_path: null,
    flp_path: null,
    als_path: null,
    other_files: [],
    color: "",
    color2: "",
    has_loop: false,
    loop_path: null,
    ...overrides,
  };
}

function baseDependencies(overrides: Partial<DesktopBeatUploadPipelineDependencies> = {}): DesktopBeatUploadPipelineDependencies {
  return {
    uploadMaster: async beat => ({ ...beat, telegram_file_id: "master-file" }),
    listCloudFiles: async () => [],
    uploadWav: async () => undefined,
    getProjectStatus: async () => null,
    uploadProject: async () => undefined,
    detachLocalSources: async beatId => makeBeat({ id: beatId, telegram_file_id: "master-file" }),
    syncMetadata: async () => undefined,
    commitSnapshot: async () => undefined,
    clearUploadMarker: () => undefined,
    waitForPlaybackReady: async () => true,
    ...overrides,
  };
}

function baseActions(original: Beat, overrides: Partial<DesktopBeatUploadPipelineActions> = {}): DesktopBeatUploadPipelineActions {
  return {
    onMasterUploaded: () => undefined,
    onDetached: () => undefined,
    getLibrarySnapshot: () => [original],
    onIndexCommitted: () => undefined,
    onPlaybackPreparing: () => undefined,
    ...overrides,
  };
}

describe("task 6.3 desktop beat upload pipeline", () => {
  it("retry respects MASTER, WAV and PROJECT checkpoints that are already durable", async () => {
    const original = makeBeat({
      telegram_file_id: "master-file",
      wav_path: "C:/beats/Night Drive/Night Drive.wav",
      has_wav: true,
      has_flp: true,
      flp_path: "C:/beats/Night Drive/Night Drive.flp",
    });
    const uploadMaster = vi.fn(async (beat: Beat) => beat);
    const uploadWav = vi.fn(async () => undefined);
    const uploadProject = vi.fn(async () => undefined);
    const detachLocalSources = vi.fn(async () => ({ ...original, mp3_path: "", wav_path: null }));
    const syncMetadata = vi.fn(async () => undefined);
    const commitSnapshot = vi.fn(async () => undefined);

    const result = await runDesktopBeatUploadPipeline({
      original,
      dependencies: baseDependencies({
        uploadMaster,
        listCloudFiles: async () => [{ file_type: "WAV" }],
        uploadWav,
        getProjectStatus: async () => ({ synced: true }),
        uploadProject,
        detachLocalSources,
        syncMetadata,
        commitSnapshot,
      }),
      actions: baseActions(original),
    });

    expect(uploadMaster).not.toHaveBeenCalled();
    expect(uploadWav).not.toHaveBeenCalled();
    expect(uploadProject).not.toHaveBeenCalled();
    expect(detachLocalSources).toHaveBeenCalledTimes(1);
    expect(syncMetadata).toHaveBeenCalledTimes(1);
    expect(commitSnapshot).toHaveBeenCalledTimes(1);
    expect(result.syncCommitted).toBe(true);
    expect(result.playbackReady).toBe(true);
  });

  it("commits the INDEX and clears the recovery marker before playback preparation", async () => {
    const original = makeBeat({ telegram_file_id: "master-file" });
    const order: string[] = [];

    const result = await runDesktopBeatUploadPipeline({
      original,
      dependencies: baseDependencies({
        commitSnapshot: async () => { order.push("commit"); },
        clearUploadMarker: () => { order.push("clear-marker"); },
        waitForPlaybackReady: async () => { order.push("playback"); return false; },
      }),
      actions: baseActions(original, {
        onDetached: () => { order.push("detached"); },
        onIndexCommitted: () => { order.push("index-committed"); },
        onPlaybackPreparing: () => { order.push("playback-preparing"); },
      }),
    });

    expect(order.indexOf("commit")).toBeLessThan(order.indexOf("clear-marker"));
    expect(order.indexOf("clear-marker")).toBeLessThan(order.indexOf("playback-preparing"));
    expect(order.indexOf("clear-marker")).toBeLessThan(order.indexOf("playback"));
    expect(result.syncCommitted).toBe(true);
    expect(result.remoteUploadCompleted).toBe(true);
    expect(result.playbackReady).toBe(false);
  });

  it("reports the exact failed checkpoint before the durable INDEX boundary", async () => {
    const original = makeBeat({ telegram_file_id: "master-file", wav_path: "beat.wav", has_wav: true });
    const clearUploadMarker = vi.fn();
    let caught: unknown = null;

    try {
      await runDesktopBeatUploadPipeline({
        original,
        dependencies: baseDependencies({
          listCloudFiles: async () => [],
          uploadWav: async () => { throw new Error("wav failed"); },
          clearUploadMarker,
        }),
        actions: baseActions(original),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DesktopBeatUploadPipelineError);
    const pipelineError = caught as DesktopBeatUploadPipelineError;
    expect(pipelineError.stage).toBe("Upload WAV HQ");
    expect(pipelineError.remoteUploadCompleted).toBe(false);
    expect(pipelineError.syncCommitted).toBe(false);
    expect(clearUploadMarker).not.toHaveBeenCalled();
  });

  it("keeps the upload durable when playback preparation itself throws", async () => {
    const original = makeBeat({ telegram_file_id: "master-file" });
    const clearUploadMarker = vi.fn();
    let caught: unknown = null;

    try {
      await runDesktopBeatUploadPipeline({
        original,
        dependencies: baseDependencies({
          clearUploadMarker,
          waitForPlaybackReady: async () => { throw new Error("playback failed"); },
        }),
        actions: baseActions(original),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DesktopBeatUploadPipelineError);
    const pipelineError = caught as DesktopBeatUploadPipelineError;
    expect(pipelineError.stage).toBe("Prepare uploaded MASTER for first Play");
    expect(pipelineError.remoteUploadCompleted).toBe(true);
    expect(pipelineError.syncCommitted).toBe(true);
    expect(clearUploadMarker).toHaveBeenCalledTimes(1);
  });
});
'''


APP_REPLACEMENT = r'''            transitionRuntime(original.id, { type: "SYNC_UPLOAD_STARTED" }, original);
            try {
              const pipelineResult = await runDesktopBeatUploadPipeline({
                original,
                dependencies: {
                  uploadMaster: uploadBeatToTelegram,
                  listCloudFiles: listCloudFilesForBeat,
                  uploadWav: (beat, path) => uploadDroppedFileToTelegram(beat, path, "WAV"),
                  getProjectStatus: getProjectCloudStatus,
                  uploadProject: uploadProjectToTelegram,
                  detachLocalSources: detachLocalSourcesAfterCloudUpload,
                  syncMetadata: syncBeatMetadataToTelegram,
                  commitSnapshot: (snapshot, reason) => libraryStateManager.commitSnapshot(snapshot, reason),
                  clearUploadMarker: clearCloudUploadActive,
                  waitForPlaybackReady: waitForUploadedBeatPlaybackReady,
                },
                actions: {
                  onMasterUploaded: uploaded => {
                    setBeats(current => current.map(b =>
                      b.id === uploaded.id ? { ...uploaded, cloud_status: "UPLOADING" } : b
                    ));
                  },
                  onDetached: detached => {
                    setBackgroundUploadErrors(current => {
                      if (!(detached.id in current)) return current;
                      const next = { ...current };
                      delete next[detached.id];
                      return next;
                    });

                    // Upload completion and playback readiness are deliberately separate.
                    // Keep the card blocked while metadata/INDEX finalization and cooking finish.
                    setBeats(current => {
                      const next = current.map(b =>
                        b.id === detached.id ? { ...detached, cloud_status: "PLAYBACK_PREPARING" } : b
                      );
                      beatsLatestRef.current = next;
                      return next;
                    });
                  },
                  getLibrarySnapshot: () => beatsLatestRef.current,
                  onIndexCommitted: (detached, indexSnapshot) => {
                    cloudLibrarySnapshotRef.current = indexSnapshot
                      .filter(item => !!item.telegram_file_id)
                      .map(cloudBeatFingerprint)
                      .join("\u001c");
                    transitionRuntime(detached.id, { type: "SYNC_UPLOAD_SUCCEEDED" }, detached);
                  },
                  onPlaybackPreparing: detached => {
                    transitionRuntime(detached.id, { type: "PLAYBACK_PREPARING" }, detached);
                  },
                },
              });

              const detached = pipelineResult.beat;
              const playbackReady = pipelineResult.playbackReady;

              if (!playbackReady) {
                const detail = buildPlaybackPreparationFailureDetail(detached.name);
                setBackgroundUploadErrors(current => ({ ...current, [detached.id]: detail }));
                transitionRuntime(detached.id, {
                  type: "PLAYBACK_FAILED",
                  code: "MASTER_PREPARE_TIMEOUT",
                  message: detail,
                  retryable: true,
                }, detached);
                setBeats(current => {
                  const next = current.map(b => b.id === detached.id ? { ...detached, cloud_status: "ERROR" } : b);
                  beatsLatestRef.current = next;
                  return next;
                });
              } else {
                transitionRuntime(detached.id, { type: "PLAYBACK_IDLE" }, detached);
                // Green completion state is intentionally transient and UI-only,
                // and now means something precise: the MASTER is actually playable.
                setBeats(current => {
                  const next = current.map(b =>
                    b.id === detached.id ? { ...detached, cloud_status: "UPLOAD_COMPLETE" } : b
                  );
                  beatsLatestRef.current = next;
                  return next;
                });
              }

              // IMPORTANT: one HTML drop session can contain MANY beats. Never delete
              // the whole drop-staging/<session> just because one beat finished.
              if (
                backgroundUploadQueueRef.current.length === 0 &&
                reviewQueueLatestRef.current === null &&
                stagedImportPathsRef.current.size === 0
              ) {
                await cleanupOrphanedDropStaging(beatsLatestRef.current);
              }

              if (playbackReady) {
                try {
                  const audio = new Audio(uploadCompleteWav);
                  audio.volume = 0.22;
                  void audio.play().catch(() => {});
                } catch {}

                const oldTimer = uploadCompleteTimersRef.current.get(detached.id);
                if (oldTimer) window.clearTimeout(oldTimer);
                const timer = window.setTimeout(() => {
                  setBeats(current => {
                    const next = current.map(b =>
                      b.id === detached.id && b.cloud_status === "UPLOAD_COMPLETE"
                        ? { ...b, cloud_status: "CLOUD_ONLY" }
                        : b
                    );
                    beatsLatestRef.current = next;
                    return next;
                  });
                  uploadCompleteTimersRef.current.delete(detached.id);
                }, 1050);
                uploadCompleteTimersRef.current.set(detached.id, timer);
              }

            } catch (error) {
              const pipelineError = error instanceof DesktopBeatUploadPipelineError ? error : null;
              const uploadStage = pipelineError?.stage ?? "Prepare upload";
              const remoteUploadCompleted = pipelineError?.remoteUploadCompleted ?? false;
              const syncCommitted = pipelineError?.syncCommitted ?? false;
              const reportedError = pipelineError?.originalError ?? error;
              console.warn(`Background Telegram upload failed for ${original.name} at ${uploadStage}:`, reportedError);

              const detail = buildUploadFailureDetail({
                beatName: original.name,
                stage: uploadStage,
                platform: navigator.platform || "unknown",
                error: reportedError,
              });

              if (!syncCommitted) {
                transitionRuntime(original.id, {
                  type: "SYNC_FAILED",
                  code: "UPLOAD_FAILED",
                  message: detail,
                  retryable: true,
                }, original);
              } else {
                const runtime = beatRuntimeStatesRef.current[original.id];
                if (runtime?.playback_state === "playback_preparing") {
                  transitionRuntime(original.id, {
                    type: "PLAYBACK_FAILED",
                    code: "PLAYBACK_PREPARATION_FAILED",
                    message: detail,
                    retryable: true,
                  }, original);
                }
              }
              setBackgroundUploadErrors(current => ({ ...current, [original.id]: detail }));
              setBeats(current => current.map(b =>
                b.id === original.id
                  ? {
                      ...b,
                      // A failure after durable media/INDEX finalization must expose
                      // the Cloud copy rather than reclassifying it as an interrupted upload.
                      cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR",
                    }
                  : b
              ));
            } finally {
              autoCloudUploadRef.current.delete(original.id);
            }

'''


def apply() -> None:
    pipeline_path = ROOT / "src/features/cloud/desktopBeatUploadPipeline.ts"
    if pipeline_path.exists():
        raise SystemExit("desktopBeatUploadPipeline.ts already exists; refusing to duplicate task 6.3")
    write("src/features/cloud/desktopBeatUploadPipeline.ts", PIPELINE)
    write("tests/integration/appDesktopBeatUploadPipelineExtraction.test.ts", TEST)

    app = read("src/App.tsx")
    app = replace_once(
        app,
        'import { buildCloudSessionUnavailableDetail, buildPlaybackPreparationFailureDetail, buildUploadFailureDetail } from "./features/cloud/uploadErrorDetails";\n',
        'import { buildCloudSessionUnavailableDetail, buildPlaybackPreparationFailureDetail, buildUploadFailureDetail } from "./features/cloud/uploadErrorDetails";\n'
        'import { DesktopBeatUploadPipelineError, runDesktopBeatUploadPipeline } from "./features/cloud/desktopBeatUploadPipeline";\n',
        "App pipeline import",
    )
    start_marker = '            let uploadStage = "Prepare upload";\n'
    end_marker = '            // Yield between beats so React/WebView always gets a render opportunity.\n'
    start = app.find(start_marker)
    end = app.find(end_marker, start)
    if start < 0 or end < 0:
        raise SystemExit("Could not locate the Desktop per-beat upload body in App.tsx")
    app = app[:start] + APP_REPLACEMENT + app[end:]
    write("src/App.tsx", app)

    characterization = read("tests/integration/appMigrationCharacterization.test.ts")
    characterization = replace_once(
        characterization,
        'const uploadErrorDetails = readFileSync(resolve(process.cwd(), "src/features/cloud/uploadErrorDetails.ts"), "utf8");\n',
        'const uploadErrorDetails = readFileSync(resolve(process.cwd(), "src/features/cloud/uploadErrorDetails.ts"), "utf8");\n'
        'const desktopBeatUploadPipeline = readFileSync(resolve(process.cwd(), "src/features/cloud/desktopBeatUploadPipeline.ts"), "utf8");\n',
        "characterization pipeline source",
    )
    old_contract = r'''    expectOrdered(upload, [
      "uploaded = await uploadBeatToTelegram(uploaded)",
      "const existingFiles = await listCloudFilesForBeat(uploaded.id)",
      "await uploadDroppedFileToTelegram(uploaded, uploaded.wav_path, \"WAV\")",
      "await uploadProjectToTelegram(uploaded)",
      "const detached = await detachLocalSourcesAfterCloudUpload(uploaded.id)",
      "await syncBeatMetadataToTelegram(detached)",
      "await libraryStateManager.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`)",
      "clearCloudUploadActive(original.id)",
      "const playbackReady = await waitForUploadedBeatPlaybackReady(detached)",
    ]);

    expect(upload).toContain("if (!syncCommitted)");
    expect(upload).toContain('cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR"');
    expect(upload).toContain("reviewQueueLatestRef.current === null");
    expect(upload).toContain("stagedImportPathsRef.current.size === 0");
'''
    new_contract = r'''    expect(upload).toContain("runDesktopBeatUploadPipeline({");
    expectOrdered(desktopBeatUploadPipeline, [
      "uploaded = await dependencies.uploadMaster(uploaded)",
      "const existingFiles = await dependencies.listCloudFiles(uploaded.id)",
      "await dependencies.uploadWav(uploaded, uploaded.wav_path)",
      "await dependencies.uploadProject(uploaded)",
      "const detached = await dependencies.detachLocalSources(uploaded.id)",
      "await dependencies.syncMetadata(detached)",
      "await dependencies.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`)",
      "dependencies.clearUploadMarker(original.id)",
      "const playbackReady = await dependencies.waitForPlaybackReady(detached)",
    ]);
    expect(desktopBeatUploadPipeline).toContain("remoteUploadCompleted = true");
    expect(desktopBeatUploadPipeline).toContain("syncCommitted = true");

    expect(upload).toContain("if (!syncCommitted)");
    expect(upload).toContain('cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR"');
    expect(upload).toContain("reviewQueueLatestRef.current === null");
    expect(upload).toContain("stagedImportPathsRef.current.size === 0");
'''
    characterization = replace_once(characterization, old_contract, new_contract, "characterization Desktop upload contract")
    write("tests/integration/appMigrationCharacterization.test.ts", characterization)

    regressions = read("scripts/run-regressions.mjs")
    regressions = replace_once(
        regressions,
        '  const uploadErrorDetails = readFileSync(path.join(root, "src", "features", "cloud", "uploadErrorDetails.ts"), "utf8");\n',
        '  const uploadErrorDetails = readFileSync(path.join(root, "src", "features", "cloud", "uploadErrorDetails.ts"), "utf8");\n'
        '  const desktopBeatUploadPipeline = readFileSync(path.join(root, "src", "features", "cloud", "desktopBeatUploadPipeline.ts"), "utf8");\n',
        "regression pipeline source",
    )
    old_guard = r'''  if (!app.includes('cloud_status: "PLAYBACK_PREPARING"')) fail("Background upload must enter PLAYBACK_PREPARING before advertising completion.");
  if (app.includes("beatsLatestRef.current = indexSnapshot;")) fail("Manifest serialization must not overwrite the live PLAYBACK_PREPARING state in beatsLatestRef.");
  const preparingIndex = app.indexOf('cloud_status: "PLAYBACK_PREPARING"');
  const readyGateIndex = app.indexOf("await waitForUploadedBeatPlaybackReady(detached)", preparingIndex);
  const completeIndex = app.indexOf('cloud_status: "UPLOAD_COMPLETE"', readyGateIndex);
  if (preparingIndex < 0 || readyGateIndex < 0 || completeIndex < 0 || !(preparingIndex < readyGateIndex && readyGateIndex < completeIndex)) fail("Upload completion must occur only after the real playback readiness gate.");
'''
    new_guard = r'''  if (!app.includes('cloud_status: "PLAYBACK_PREPARING"')) fail("Background upload must enter PLAYBACK_PREPARING before advertising completion.");
  if (app.includes("beatsLatestRef.current = indexSnapshot;") || desktopBeatUploadPipeline.includes("beatsLatestRef.current = indexSnapshot;")) fail("Manifest serialization must not overwrite the live PLAYBACK_PREPARING state in beatsLatestRef.");
  if (!app.includes('cloud_status: "UPLOAD_COMPLETE"')) fail("Background upload lost its transient completion state after playback readiness.");
  if (!app.includes("waitForPlaybackReady: waitForUploadedBeatPlaybackReady")) fail("App no longer wires the real playback readiness gate into the Desktop upload pipeline.");
  const detachedIndex = desktopBeatUploadPipeline.indexOf("actions.onDetached(detached)");
  const commitIndex = desktopBeatUploadPipeline.indexOf("await dependencies.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`)", detachedIndex);
  const clearMarkerIndex = desktopBeatUploadPipeline.indexOf("dependencies.clearUploadMarker(original.id)", commitIndex);
  const readyGateIndex = desktopBeatUploadPipeline.indexOf("await dependencies.waitForPlaybackReady(detached)", clearMarkerIndex);
  if (detachedIndex < 0 || commitIndex < 0 || clearMarkerIndex < 0 || readyGateIndex < 0 || !(detachedIndex < commitIndex && commitIndex < clearMarkerIndex && clearMarkerIndex < readyGateIndex)) fail("Upload durability boundary must remain detach -> INDEX commit -> clear recovery marker -> playback readiness.");
'''
    regressions = replace_once(regressions, old_guard, new_guard, "regression upload/playback guard")
    write("scripts/run-regressions.mjs", regressions)

    print("Applied task 6.3 extraction")


def finalize(initial_sha: str, implementation_sha: str, run_id: str, remote_pre_agent_state: str) -> None:
    if initial_sha != INITIAL_SHA:
        raise SystemExit(f"Unexpected initial SHA {initial_sha}")

    roadmap = read("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
    roadmap = replace_once(
        roadmap,
        "### [ ] 6.3 — Separar el proceso de subida de un beat",
        "### [x] 6.3 — Separar el proceso de subida de un beat",
        "roadmap task 6.3 checkbox",
    )
    write("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md", roadmap)

    registro = read("migration/Registro-de-avance.md")
    if "### Registro — 6.3" in registro:
        raise SystemExit("Registro 6.3 already exists; refusing to duplicate")
    entry = f'''\n\n### Registro — 6.3\n\n```\nTarea: 6.3 — Separar el proceso de subida de un beat\nEstado: Terminada\nFecha: 2026-09-08\n\nBase\n\n- Rama: v0.9.0-test-noche\n- SHA inicial de esta ejecución: {initial_sha}\n- SHA de implementación validada: {implementation_sha}\n- Última tarea verificada: 6.2 — Separar recuperación y errores de uploads\n\nCambio realizado\n\n- Se creó `src/features/cloud/desktopBeatUploadPipeline.ts` como dueño de la secuencia asíncrona Desktop por beat.\n- El pipeline recibe dependencias y acciones explícitas; `cloudifyImportedBeats` conserva la cola, la verificación de sesión, la ruta Web y la coordinación entre beats.\n- Se preservó el orden MASTER → WAV → PROJECT → detach local → metadata/artwork → commit del INDEX por beat → limpieza del marcador → preparación de playback.\n- Retry conserva checkpoints: un MASTER existente, WAV ya presente y PROJECT sincronizado se omiten en lugar de subirse de nuevo.\n- La frontera durable queda explícita: después del commit del INDEX se marca `syncCommitted`, se limpia el marcador y solo entonces se prepara playback. Un fallo posterior conserva `remoteUploadCompleted=true`/`syncCommitted=true` y no convierte la subida durable en una interrupción recuperable.\n- La cola completa, IDs activos, drenado y Reload diferido permanecen en App para 6.4. La ruta Web `platform.cloudData.commitImportedBeat` no se movió.\n\nAdaptación de pruebas\n\n- Se añadió `tests/integration/appDesktopBeatUploadPipelineExtraction.test.ts` con pruebas ejecutables de checkpoints de retry, orden INDEX→marker→playback, fallo antes del límite durable y fallo de playback después del commit.\n- `tests/integration/appMigrationCharacterization.test.ts` ahora sigue la secuencia Desktop en su nuevo owner y conserva en App las guardas de routing Web/cola.\n- `scripts/run-regressions.mjs` sigue protegiendo PLAYBACK_PREPARING/UPLOAD_COMPLETE y ahora verifica en el pipeline el orden detach → INDEX commit → clear marker → playback readiness.\n\nArchivos afectados\n\n- src/App.tsx\n- src/features/cloud/desktopBeatUploadPipeline.ts\n- tests/integration/appDesktopBeatUploadPipelineExtraction.test.ts\n- tests/integration/appMigrationCharacterization.test.ts\n- scripts/run-regressions.mjs\n- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md\n- migration/Registro-de-avance.md\n- migration/BeatGaler-agent-state.md\n\nComprobaciones ejecutadas\n\n- GitHub Actions `Task 6.3 Apply`, run {run_id} — SUCCESS.\n- Artifact `migration-check-logs-task-6-3-{run_id}` generado con la matriz completa.\n- `npm ci` — PASS.\n- `git diff --check` — PASS.\n- `npm run test:typecheck` — PASS.\n- `npm run test:unit:ts` — PASS.\n- `npm run test:component:dom` — PASS.\n- `npm run test:integration` — PASS.\n- `npm run test:regressions` — PASS.\n- `npm run build:web` — PASS.\n- `npm run build` — PASS.\n- Los checks anteriores validaron el SHA de implementación `{implementation_sha}`.\n\nComprobaciones no ejecutadas\n\n- `npm run check` — no requerido para esta extracción; la matriz ejecutó individualmente los checks aplicables del plan.\n- E2E completos de import/download/recovery — no se usaron como evidencia de 6.3 porque los harness existentes no ejercitan directamente este pipeline extraído.\n- Prueba física Desktop Windows/macOS — no ejecutada; la ronda trabaja mediante GitHub Actions sin una aplicación física interactiva.\n\nPrueba manual\n\n- No ejecutada ni inventada.\n- Desktop sugerido: interrumpir/reintentar después de MASTER, WAV y PROJECT; comprobar que los slots existentes no se repiten. Provocar además un fallo de preparación de playback después del commit del INDEX.\n- Resultado esperado: retry continúa desde el primer checkpoint faltante; tras un commit durable, un fallo de playback deja el beat en Cloud y no restaura el marcador de recuperación.\n\nPendientes / fuera de alcance\n\n- 6.4 — Separar la cola de uploads queda pendiente y no fue iniciada.\n- La verificación de sesión, secuencialidad de la cola, IDs activos, timers de finalización, limpieza de staging al drenar y Reload diferido permanecen en App para 6.4.\n- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.3.\n\nRiesgos previos relevantes\n\n- Ningún riesgo nuevo de integridad quedó abierto por 6.3.\n\nHerramientas temporales restantes\n\n- Ninguna creada por 6.3 debe permanecer tras el commit de cierre; el applier y workflow temporales se eliminan al finalizar.\n\nFallos encontrados y causa\n\n- Ninguno en el run final {run_id}; la matriz aplicable quedó verde.\n\nVeredicto\n\nTerminada.\n\nEl proceso Desktop por beat salió de `App.tsx` conservando checkpoints, frontera durable por beat y separación entre commit Cloud y preparación de playback.\n\nSiguiente tarea\n\n6.4 — Separar la cola de uploads.\n\nNo iniciada.\n```\n'''
    write("migration/Registro-de-avance.md", registro.rstrip() + entry)

    agent_state = f'''# BeatGaler — Agent State\n\nFecha de ejecución: 2026-09-08\nRama de trabajo obligatoria: `v0.9.0-test-noche`\n\n## Estado actual\n\n- Tarea trabajada: **6.3 — Separar el proceso de subida de un beat**\n- Estado: **Terminada**\n- Última tarea terminada: **6.3 — Separar el proceso de subida de un beat**\n- SHA inicial de esta ejecución: `{initial_sha}`\n- SHA de implementación validada: `{implementation_sha}`\n- HEAD remoto observado inmediatamente antes de la escritura final de agent-state: `{remote_pre_agent_state}`\n- Run de verificación principal: **{run_id} — SUCCESS**\n- Comprobaciones pendientes para 6.3: **ninguna automatizada necesaria**\n\n## Resultado verificado\n\n- `desktopBeatUploadPipeline.ts` posee la secuencia Desktop por beat con dependencias/acciones explícitas.\n- Retry omite MASTER/WAV/PROJECT ya durables y conserva el primer checkpoint faltante.\n- El INDEX se confirma por beat antes de limpiar el marcador de recuperación; el marcador se limpia antes de preparar playback.\n- Un fallo de playback posterior conserva la subida durable y no la reclasifica como subida interrumpida.\n- App conserva la cola, la verificación de sesión, la ruta Web, el drenado, staging y Reload diferido para 6.4.\n- Run {run_id} terminó PASS en npm ci, diff-check, typecheck, unit TS, component DOM, integration, regressions, build:web y build.\n\n## Pendientes concretos / fuera de alcance\n\n- 6.4 — Separar la cola de uploads queda pendiente y no fue iniciada.\n- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.3.\n- No deben quedar herramientas temporales creadas por 6.3 en el árbol final.\n\n## Siguiente tarea\n\n- **6.4 — Separar la cola de uploads**\n- Estado: **Pendiente**\n- No iniciarla hasta la próxima ronda.\n'''
    write("migration/BeatGaler-agent-state.md", agent_state)
    print("Finalized task 6.3 migration documents")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: task-6-3.py apply | finalize <initial> <implementation> <run> <remote-pre-agent-state>")
    if sys.argv[1] == "apply":
        apply()
        return
    if sys.argv[1] == "finalize" and len(sys.argv) == 6:
        finalize(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        return
    raise SystemExit("invalid arguments")


if __name__ == "__main__":
    main()
