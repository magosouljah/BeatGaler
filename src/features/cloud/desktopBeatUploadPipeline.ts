import type { Beat } from "../../types";

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
