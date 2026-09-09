import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = [
  readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/edit/useBeatEditing.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/dragdrop/useBeatFileDropRouting.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/cloud/beatCloudUpdateBusy.ts"), "utf8"),
].join("\n").replaceAll("../", "./");
const appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");
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
    expect(appShell).toContain("onClose={closeCloudFiles}");
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
