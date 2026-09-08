import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const queue = readFileSync(resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"), "utf8");

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing queue contract marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 6.4 cloud upload queue extraction", () => {
  it("moves queue ownership out of App while preserving the small Review/staging read bridge", () => {
    expect(app).toContain("useCloudUploadQueue({");
    expect(app).not.toContain("const backgroundUploadQueueRef = useRef");
    expect(app).not.toContain("const autoCloudUploadRef = useRef");
    expect(app).not.toContain("const backgroundUploadRunningRef = useRef");
    expect(app).toContain("isReviewActive: () => reviewQueueLatestRef.current !== null");
    expect(app).toContain("hasProtectedStaging: () => stagedImportPathsRef.current.size > 0");
    expect(queue).toContain("const backgroundUploadQueueRef = useRef<Beat[]>([])");
    expect(queue).toContain("const autoCloudUploadRef = useRef<Set<string>>(new Set())");
  });

  it("keeps Desktop uploads sequential and routes each item through the 6.3 pipeline", () => {
    expectOrdered(queue, [
      "while (backgroundUploadQueueRef.current.length > 0)",
      "const original = backgroundUploadQueueRef.current.shift()!",
      "await runDesktopBeatUploadPipeline({",
      "await new Promise<void>(resolve => window.setTimeout(resolve, 0))",
    ]);
  });

  it("keeps the existing Web commit path separate from the Desktop worker", () => {
    expectOrdered(queue, [
      "if (platform.capabilities.reviewBeatCloudCommit)",
      "platform.cloudData.commitImportedBeat(beat)",
      "markCloudUploadActive(beat)",
    ]);
  });

  it("runs a deferred Reload only after every queued or active upload has drained", () => {
    expect(queue).toContain("deferLibraryReloadIfUploading");
    expect(queue).toContain("finishDeferredReloadIfIdle");
    expect(queue).toContain('window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))');
    const desktopFinally = queue.indexOf("backgroundUploadRunningRef.current = false");
    expect(desktopFinally).toBeGreaterThan(-1);
    expect(queue.indexOf("finishDeferredReloadIfIdle();", desktopFinally)).toBeGreaterThan(desktopFinally);
    expect(app).toContain("if (deferLibraryReloadIfUploading())");
    expect(app).toContain('window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)');
  });

  it("preserves staging until the queue is empty and Review/import no longer protects it", () => {
    expect(queue).toContain("backgroundUploadQueueRef.current.length === 0");
    expect(queue).toContain("!isReviewActive()");
    expect(queue).toContain("!hasProtectedStaging()");
    expect(queue).toContain("cleanupOrphanedDropStaging(beatsLatestRef.current)");
  });

  it("keeps failed-upload retry connected to the checkpoint-aware queue", () => {
    expect(queue).toContain('cloudifyImportedBeats([{ ...beat, cloud_status: "UPLOADING" }])');
    expect(app).toContain("onRetryUpload={retryBackgroundUpload}");
  });
});
