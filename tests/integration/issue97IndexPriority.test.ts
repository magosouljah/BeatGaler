import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 INDEX priority", () => {
  it("keeps INDEX behind startup WARM with an explicit coordinator barrier", () => {
    const coordinator = source("src/features/playback/webStartupPlaybackCoordinator.ts");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");

    expect(coordinator).toContain("waitUntilIndexAllowed");
    expect(coordinator).toContain("await this.indexBarrierPromise");
    expect(transport).toContain("await this.indexBarrier()");
  });

  it("does not start INDEX while WARM exists or Play is critical", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain('playbackSchedulerState !== "PLAY_CRITICAL" && !hasWarmWork()');
    expect(worker).toContain("await waitUntilIndexPriorityAllowed()");
    expect(worker).toContain("if (!indexPriorityAllowed())");
  });

  it("aborts the INDEX byte transfer for Play/WARM and retries later", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain("activeIndexAbortController");
    expect(worker).toContain("activeIndexAbortController?.abort()");
    expect(worker).toContain("abortSignal: controller.signal");
    expect(worker).toContain('preemptActiveIndex("play")');
    expect(worker).toContain('preemptActiveIndex("warm")');
    expect(worker).toContain('playTrace("INDEX_RESUMED"');
    expect(worker).toContain('playTrace("INDEX_DONE"');
  });

  it("never interprets an INDEX preemption as an authoritative deletion or warm failure", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain("controller.signal.aborted || isAbortError(error)");
    expect(worker).toContain("resumed = true");
    expect(worker).toContain("continue;");
  });
});
