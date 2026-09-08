import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const playbackController = readFileSync(resolve(process.cwd(), "src/features/playback/usePlaybackController.ts"), "utf8");
const interruptedUploadJournal = readFileSync(resolve(process.cwd(), "src/features/cloud/interruptedUploadJournal.ts"), "utf8");
const uploadErrorDetails = readFileSync(resolve(process.cwd(), "src/features/cloud/uploadErrorDetails.ts"), "utf8");
const desktopBeatUploadPipeline = readFileSync(resolve(process.cwd(), "src/features/cloud/desktopBeatUploadPipeline.ts"), "utf8");
const cloudUploadQueue = readFileSync(resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"), "utf8");
const importSession = readFileSync(resolve(process.cwd(), "src/features/import/useImportSession.ts"), "utf8");
const importReview = readFileSync(resolve(process.cwd(), "src/features/import/useImportReview.ts"), "utf8");
const importReviewHost = readFileSync(resolve(process.cwd(), "src/features/import/components/ImportReviewHost.tsx"), "utf8");

const migrationTargets = {
  uploads: { tasks: ["6.2", "6.3", "6.4"], owners: ["src/features/cloud/interruptedUploadJournal.ts", "src/features/cloud/uploadErrorDetails.ts", "src/features/cloud/desktopBeatUploadPipeline.ts", "src/features/cloud/useCloudUploadQueue.ts"] },
  review: { tasks: ["7.1", "7.2", "7.3", "7.4"], owners: ["src/features/import/useImportReview.ts", "src/features/import/useImportDiscovery.ts", "src/features/import/useImportSaveAll.ts", "src/features/import/useBrowserImport.ts"] },
  reload: { tasks: ["9.2"], owners: ["src/features/library/useLibraryReload.ts"] },
  audio: { tasks: ["4.2", "4.3"], owners: ["src/features/playback/usePlaybackController.ts", "src/features/playback/usePlaybackPreparation.ts", "src/features/playback/usePlaybackQueue.ts"] },
  recovery: { tasks: ["6.2"], owners: ["src/features/cloud/interruptedUploadJournal.ts"] },
  platformRouting: { tasks: ["4.2", "6.3", "7.4", "8.2", "8.3"], owners: ["src/features/playback/usePlaybackController.ts", "src/features/cloud/desktopBeatUploadPipeline.ts", "src/features/import/useBrowserImport.ts", "src/features/dragdrop/useHtmlLibraryDrop.ts", "src/features/dragdrop/useNativeLibraryDrop.ts"] },
} as const;

function sourceSection(source: string, startMarker: string, endMarker: string, label: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Could not find ${label} section: ${startMarker} -> ${endMarker}`);
  return source.slice(start, end);
}

function section(startMarker: string, endMarker: string): string {
  return sourceSection(app, startMarker, endMarker, "App.tsx");
}

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing migration contract marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("App migration characterization contracts", () => {
  it("records the precise future owners for every delicate flow covered by task 1.3", () => {
    expect(Object.keys(migrationTargets)).toEqual([
      "uploads",
      "review",
      "reload",
      "audio",
      "recovery",
      "platformRouting",
    ]);
    for (const contract of Object.values(migrationTargets)) {
      expect(contract.tasks.length).toBeGreaterThan(0);
      expect(contract.owners.length).toBeGreaterThan(0);
      expect(contract.owners.every(owner => owner.startsWith("src/features/"))).toBe(true);
    }
  });

  it("keeps browser commit routing separate and preserves the Desktop per-beat durability boundary", () => {
    expectOrdered(cloudUploadQueue, [
      "if (platform.capabilities.reviewBeatCloudCommit)",
      "platform.cloudData.commitImportedBeat(beat)",
      "markCloudUploadActive(beat)",
    ]);

    expect(cloudUploadQueue).toContain("runDesktopBeatUploadPipeline({");
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

    expect(cloudUploadQueue).toContain("if (!syncCommitted)");
    expect(cloudUploadQueue).toContain('cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR"');
    expect(cloudUploadQueue).toContain("!isReviewActive()");
    expect(cloudUploadQueue).toContain("!hasProtectedStaging()");
    expect(app).toContain("useCloudUploadQueue({");
  });

  it("keeps Review candidates outside the library until Save and preserves Skip versus Cancel", () => {
    const add = section("const addBeatsAndReview = useCallback", "const cancelPendingReviewWork = useCallback");
    expect(add).toContain("startReview(sanitized)");
    expect(add).not.toContain("setBeats(");
    expect(importSession).toContain("const [reviewQueue, setReviewQueue] = useState<ImportReviewQueueState | null>(null)");
    expect(importSession).toContain("setReviewQueue({");
    expect(importSession).not.toContain("setBeats(");

    const skip = sourceSection(importReview, "const skipCurrentReviewBeat = useCallback", "const cancelReview = useCallback", "useImportReview.ts Skip");
    expectOrdered(skip, [
      "setReviewQueue(queue => {",
      "if (currentBeat) releaseBeat?.(currentBeat.id);",
      "return { ...queue, index: queue.index + 1 };",
    ]);

    const cancel = sourceSection(importReview, "const cancelReview = useCallback", "const handleReviewedBeatSaved = useCallback", "useImportReview.ts Cancel");
    expectOrdered(cancel, [
      "onCancelPendingWork();",
      "queue.beats.slice(queue.index)",
      "if (queue.batchId) void discardBatch(queue.batchId);",
      "cleanupUnusedStaging();",
    ]);
    expect(cancel.lastIndexOf("return null;")).toBeGreaterThan(cancel.indexOf("cleanupUnusedStaging();"));

    const save = sourceSection(importReview, "const handleReviewedBeatSaved = useCallback", "\n  return {\n", "useImportReview.ts Save");
    expectOrdered(save, [
      "setBeats(current => {",
      "beatsLatestRef.current = next;",
      "setReviewQueue(queue => {",
      "cloudifyImportedBeats([updated]);",
    ]);

    expect(app).toContain("} = useImportSession();");
    expect(app).toContain("} = useImportReview({");
    expect(app).toContain("<ImportReviewHost");
    expect(importReviewHost).toContain("onSkipAll={onCancel}");
    expect(importReviewHost).toContain("onSaved={onSaved}");
  });

  it("defers manual Reload while uploads are active and consumes the deferred event after the queue drains", () => {
    const reload = section("const reloadLibrary = useCallback", "const applyBulkUpdate = useCallback");
    expectOrdered(reload, [
      "if (deferLibraryReloadIfUploading()) return",
      "const restored = await libraryStateManager.reloadAuthoritative()",
    ]);
    expect(reload).toContain('window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)');

    const desktopFinally = cloudUploadQueue.indexOf("backgroundUploadRunningRef.current = false");
    expect(desktopFinally).toBeGreaterThan(-1);
    expect(cloudUploadQueue.indexOf("finishDeferredReloadIfIdle();", desktopFinally)).toBeGreaterThan(desktopFinally);
    expect(cloudUploadQueue).toContain('window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))');
  });

  it("keeps playback cache invalidation, real audio events and Web/Desktop preparation paths distinct", () => {
    expectOrdered(playbackController, [
      "playbackCacheEpochRef.current += 1",
      "cookingPlaybackUrlRef.current.clear()",
      "cookingWarmPromisesRef.current.clear()",
    ]);
    expect(playbackController).toContain('window.addEventListener("beatgaler:audio-playing", onAudioPlaying)');
    expect(playbackController).toContain('transitionRuntime(beatId, { type: "PLAYBACK_PLAYING" })');
    expectOrdered(playbackController, [
      "if (!isTauriAvailable)",
      "const prepared = await platform.media.preparePlayback(beat)",
      "const ready = await prepareBeatForPlayback(beat)",
    ]);
    expect(playbackController).toContain("platform.media.releasePlayback(beat.id)");
    expect(app).toContain("usePlaybackController({");
  });

  it("fails closed during interrupted-upload recovery until cloud authority is known", () => {
    expectOrdered(interruptedUploadJournal, [
      "if (authoritativeBeatIds?.has(item.beatId))",
      "if (authoritativeBeatIds === null)",
      "const response = await fetchImpl(`${cloudApiBase}/beats/delete-topic`",
      "await purgeLocal(item.beatId, item.stagingPaths)",
      "writeActiveCloudUploads(remaining)",
    ]);
    expect(interruptedUploadJournal).toContain("remaining.push(item)");
    expect(app).toContain("rollbackInterruptedCloudUploads({");
    expect(app).not.toContain("async function rollbackInterruptedCloudUploads");
    expect(uploadErrorDetails).toContain("buildUploadFailureDetail");
    expect(uploadErrorDetails).toContain("buildPlaybackPreparationFailureDetail");
  });
});
