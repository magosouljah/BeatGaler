import { describe, expect, it, vi } from "vitest";
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
