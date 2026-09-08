import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const discovery = readFileSync(resolve(process.cwd(), "src/features/import/useImportDiscovery.ts"), "utf8");

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Could not find discovery section: ${startMarker} -> ${endMarker}`);
  return source.slice(start, end);
}

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing task 7.2 marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 7.2 incremental discovery extraction", () => {
  it("moves the progressive discovery owner out of App without moving Save All or browser import", () => {
    expect(app).toContain("} = useImportDiscovery({");
    expect(app).not.toContain("const importDroppedPaths = useCallback");
    expect(app).not.toContain("const reviewPreparationRunRef = useRef");
    expect(app).not.toContain("const importReviewRequestRunRef = useRef");
    expect(app).not.toContain("startImportReviewStream");
    expect(app).not.toContain("prepareNextImportReviewBeat");
    expect(app).not.toContain("getImportReviewBatchSummary");
    expect(app).toContain("const handleReviewedSaveAll = useCallback");
    expect(app).toContain("const importDroppedBrowserFiles = useCallback");
    expect(discovery).toContain("startStream: startImportReviewStream");
    expect(discovery).toContain("prepareNext: prepareNextImportReviewBeat");
    expect(discovery).toContain("getSummary: getImportReviewBatchSummary");
  });

  it("publishes the first prepared beat before allowing the background worker to continue", () => {
    const flow = section(discovery, "const importDroppedPaths = useCallback", "\n  return {\n");
    expectOrdered(flow, [
      "setReviewBootstrap({ total: null });",
      "const stream = await services.startStream(normalized);",
      "const firstStep = await services.prepareNext(stream.batch_id);",
      "setReviewQueue({",
      "requestAnimationFrame(() => {",
      "setReviewBootstrap(null);",
      "const preparation = (async () => {",
      "while (!step.discovery_complete",
    ]);
    expect(flow).toContain("await new Promise<void>(resolve => window.setTimeout(resolve, 0));");
    expect(flow).toContain("FIRST_REVIEW_READY");
    expect(flow).toContain("DISCOVERY_FINISHED");
  });

  it("invalidates both bootstrap and background generations so stale results can only be discarded", () => {
    const cancel = section(discovery, "const cancelPendingReviewWork = useCallback", "const importDroppedPaths = useCallback");
    expectOrdered(cancel, [
      "importReviewRequestRunRef.current += 1;",
      "reviewPreparationRunRef.current += 1;",
      "reviewPreparationPromiseRef.current = null;",
      "setReviewBootstrap(null);",
    ]);
    const flow = section(discovery, "const importDroppedPaths = useCallback", "\n  return {\n");
    expect((flow.match(/importReviewRequestRunRef\.current !== requestRunId/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(flow).toContain("void services.discardBatch(stream.batch_id);");
    expect(app).toContain("reviewPreparationPromiseRef,");
    expect(app).toContain("await reviewPreparationPromiseRef.current");
  });
});
