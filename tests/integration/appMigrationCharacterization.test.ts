import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

const migrationTargets = {
  uploads: { tasks: ["6.2", "6.3", "6.4"], owners: ["src/features/cloud/interruptedUploadJournal.ts", "src/features/cloud/desktopBeatUploadPipeline.ts", "src/features/cloud/useCloudUploadQueue.ts"] },
  review: { tasks: ["7.1", "7.2", "7.3", "7.4"], owners: ["src/features/import/useImportReview.ts", "src/features/import/useImportDiscovery.ts", "src/features/import/useImportSaveAll.ts", "src/features/import/useBrowserImport.ts"] },
  reload: { tasks: ["9.2"], owners: ["src/features/library/useLibraryReload.ts"] },
  audio: { tasks: ["4.2", "4.3"], owners: ["src/features/playback/usePlaybackController.ts", "src/features/playback/usePlaybackPreparation.ts", "src/features/playback/usePlaybackQueue.ts"] },
  recovery: { tasks: ["6.2"], owners: ["src/features/cloud/interruptedUploadJournal.ts"] },
  platformRouting: { tasks: ["4.2", "6.3", "7.4", "8.2", "8.3"], owners: ["src/features/playback/usePlaybackController.ts", "src/features/cloud/desktopBeatUploadPipeline.ts", "src/features/import/useBrowserImport.ts", "src/features/dragdrop/useHtmlLibraryDrop.ts", "src/features/dragdrop/useNativeLibraryDrop.ts"] },
} as const;

function section(startMarker: string, endMarker: string): string {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Could not find App.tsx section: ${startMarker} -> ${endMarker}`);
  return app.slice(start, end);
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
    const upload = section("const cloudifyImportedBeats = useCallback", "const retryBackgroundUpload = useCallback");

    expectOrdered(upload, [
      "if (platform.capabilities.reviewBeatCloudCommit)",
      "platform.cloudData.commitImportedBeat(beat)",
      "markCloudUploadActive(beat)",
    ]);

    expectOrdered(upload, [
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
  });

  it("keeps Review candidates outside the library until Save and preserves Skip versus Cancel", () => {
    const add = section("const addBeatsAndReview = useCallback", "const skipCurrentReviewBeat = useCallback");
    expect(add).toContain("setReviewQueue({ beats: sanitized, index: 0");
    expect(add).not.toContain("setBeats(");

    const skip = section("const skipCurrentReviewBeat = useCallback", "const skipAllReviewQueue = useCallback");
    expect(skip).toContain("platform.importer.releaseBeat(currentBeat.id)");
    expect(skip).toContain("return { ...q, index: q.index + 1 }");

    const cancel = section("const skipAllReviewQueue = useCallback", "const handleReviewedBeatSaved = useCallback");
    expectOrdered(cancel, [
      "q.beats.slice(q.index)",
      "platform.importer.releaseBeat(beat.id)",
      "cleanupOrphanedDropStaging(protectedBeats)",
    ]);
    expect(cancel.lastIndexOf("return null")).toBeGreaterThan(cancel.indexOf("cleanupOrphanedDropStaging(protectedBeats)"));

    const save = section("const handleReviewedBeatSaved = useCallback", "const handleReviewedSaveAll = useCallback");
    expectOrdered(save, ["setBeats(bs =>", "setReviewQueue(q =>", "cloudifyImportedBeats([updated])"]);
  });

  it("defers manual Reload while uploads are active and consumes the deferred event after the queue drains", () => {
    const reload = section("const reloadLibrary = useCallback", "const applyBulkUpdate = useCallback");
    expectOrdered(reload, [
      "const uploadInFlight = backgroundUploadRunningRef.current || autoCloudUploadRef.current.size > 0",
      "deferredLibraryReloadRef.current = true",
      "const restored = await libraryStateManager.reloadAuthoritative()",
    ]);
    expect(reload).toContain('window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)');

    const upload = section("const cloudifyImportedBeats = useCallback", "const retryBackgroundUpload = useCallback");
    expectOrdered(upload, [
      "backgroundUploadRunningRef.current = false",
      "if (deferredLibraryReloadRef.current)",
      "deferredLibraryReloadRef.current = false",
      'window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))',
    ]);
  });

  it("keeps playback cache invalidation, real audio events and Web/Desktop preparation paths distinct", () => {
    const audioEvents = section("const onPlaybackCacheCleared = () =>", "const previousAudioBeatIdRef = useRef");
    expectOrdered(audioEvents, [
      "playbackCacheEpochRef.current += 1",
      "cookingPlaybackUrlRef.current.clear()",
      "cookingWarmPromisesRef.current.clear()",
    ]);
    expect(audioEvents).toContain('window.addEventListener("beatgaler:audio-playing", onAudioPlaying)');
    expect(audioEvents).toContain('transitionRuntime(beatId, { type: "PLAYBACK_PLAYING" })');

    const play = section("const handlePlay = useCallback", "const handleUpload = useCallback");
    expectOrdered(play, [
      "if (!isTauriAvailable)",
      "const prepared = await platform.media.preparePlayback(beat)",
      "const ready = await prepareBeatForPlayback(beat)",
    ]);
    expect(play).toContain("platform.media.releasePlayback(beat.id)");
  });

  it("fails closed during interrupted-upload recovery until cloud authority is known", () => {
    const recovery = section("async function rollbackInterruptedCloudUploads", "function loadCachedBeats");
    expectOrdered(recovery, [
      "if (authoritativeBeatIds?.has(item.beatId))",
      "if (authoritativeBeatIds === null)",
      "const response = await fetch(`${base}/beats/delete-topic`",
      "await purgeInterruptedUploadLocal(item.beatId, item.stagingPaths)",
      "writeActiveCloudUploads(remaining)",
    ]);
    expect(recovery).toContain("remaining.push(item)");
  });
});
