import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 INDEX priority", () => {
  it("opens INDEX after Direct connection without waiting for startup WARM", () => {
    const coordinator = source("src/features/playback/webStartupPlaybackCoordinator.ts");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");

    expect(coordinator).toContain("waitUntilIndexAllowed");
    expect(coordinator).toContain("await this.connect()");
    expect(coordinator).not.toContain("await this.indexBarrierPromise");
    expect(transport).toContain("await this.indexBarrier()");
  });

  it("lets INDEX run during WARM but still pauses for Play critical", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain('return playbackSchedulerState !== "PLAY_CRITICAL";');
    expect(worker).not.toContain("!hasWarmWork()");
    expect(worker).toContain("await waitUntilIndexPriorityAllowed()");
    expect(worker).toContain("if (!indexPriorityAllowed())");
  });

  it("aborts the INDEX byte transfer for Play but never for WARM", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain("activeIndexAbortController");
    expect(worker).toContain("const controller = activeIndexAbortController;");
    expect(worker).toContain("controller.abort();");
    expect(worker).toContain("abortSignal: controller.signal");
    expect(worker).toContain('preemptActiveIndex("play")');
    expect(worker).not.toContain('preemptActiveIndex("warm")');
    expect(worker).toContain('playTrace(resumed ? "INDEX_RESUMED" : "INDEX_BEGIN",');
    expect(worker).toContain('playTrace("INDEX_DONE"');
  });

  it("never interprets an INDEX preemption as an authoritative deletion or warm failure", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain("controller?.signal.aborted || isAbortError(error)");
    expect(worker).toContain("resumed = true");
    expect(worker).toContain("continue;");
  });
});