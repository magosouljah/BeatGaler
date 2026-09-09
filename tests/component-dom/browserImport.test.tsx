// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import * as dialog from "../../src/lib/dialog";
import { platform } from "../../src/platform";
import { useBrowserImport } from "../../src/features/import/useBrowserImport";
import type { ImportReviewQueueState } from "../../src/features/import/useImportSession";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Latest = {
  importDroppedBrowserFiles: ReturnType<typeof useBrowserImport>["importDroppedBrowserFiles"];
  reviewQueue: ImportReviewQueueState | null;
  dropImporting: boolean;
  dropActive: boolean;
  showAdd: boolean;
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: Latest | null = null;
let preparationCalls = 0;
let resetCalls = 0;

function Harness() {
  const [dropImporting, setDropImporting] = useState(false);
  const [dropActive, setDropActive] = useState(true);
  const [showAdd, setShowAdd] = useState(true);
  const [reviewQueue, setReviewQueue] = useState<ImportReviewQueueState | null>(null);
  const { importDroppedBrowserFiles } = useBrowserImport({
    dropImporting,
    setDropImporting,
    rejectOfflineMutation: () => false,
    setDropActive,
    setShowAdd,
    setReviewQueue,
    completeImmediateReviewPreparation: () => { preparationCalls += 1; },
    resetImportResolutionState: () => { resetCalls += 1; },
  });
  latest = { importDroppedBrowserFiles, reviewQueue, dropImporting, dropActive, showAdd };
  return <div />;
}

async function renderHarness() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latest = null;
  preparationCalls = 0;
  resetCalls = 0;
});

describe("browser import entry", () => {
  it("hydrates one browser File and opens exactly one Review candidate", async () => {
    const sourceBeat = {
      id: "browser-1",
      name: "Browser Beat",
      bpm: 128,
      key: "c",
      tags: ["trap"],
      rating: 0,
      mp3_path: "browser://browser-1",
    } as Beat;
    const fromFile = vi.spyOn(platform.importer, "fromFile").mockReturnValue({
      beat: sourceBeat,
      hydrated: Promise.resolve({ ...sourceBeat, tags: ["trap"] }),
      release: vi.fn(),
    } as any);
    vi.spyOn(dialog, "appAlert").mockResolvedValue(undefined as any);
    await renderHarness();

    const file = new File([new Uint8Array([1, 2, 3])], "beat.mp3", { type: "audio/mpeg" });
    await act(async () => { await latest!.importDroppedBrowserFiles([file]); });

    expect(fromFile).toHaveBeenCalledTimes(1);
    expect(fromFile).toHaveBeenCalledWith(file);
    expect(latest!.reviewQueue?.beats.map(item => item.id)).toEqual(["browser-1"]);
    expect(latest!.reviewQueue?.total).toBe(1);
    expect(latest!.dropImporting).toBe(false);
    expect(latest!.dropActive).toBe(false);
    expect(latest!.showAdd).toBe(false);
    expect(preparationCalls).toBe(1);
    expect(resetCalls).toBe(1);
  });

  it("rejects a multi-beat browser gesture before creating any candidate", async () => {
    const fromFile = vi.spyOn(platform.importer, "fromFile");
    const alertSpy = vi.spyOn(dialog, "appAlert").mockResolvedValue(undefined as any);
    await renderHarness();

    const first = new File(["a"], "one.mp3", { type: "audio/mpeg" });
    const second = new File(["b"], "two.wav", { type: "audio/wav" });
    await act(async () => { await latest!.importDroppedBrowserFiles([first, second]); });

    expect(fromFile).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith({
      title: "Drop one beat at a time",
      message: "BeatGaler Web imports one beat per drag action.",
    });
    expect(latest!.reviewQueue).toBeNull();
    expect(preparationCalls).toBe(0);
    expect(resetCalls).toBe(0);
  });
});
