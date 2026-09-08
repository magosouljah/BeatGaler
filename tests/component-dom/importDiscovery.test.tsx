// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import type { ImportBatchPreview, ImportReviewStep } from "../../src/lib/tauri";
import { useImportSession, type ImportSession } from "../../src/features/import/useImportSession";
import { useImportDiscovery, type ImportDiscoveryServices } from "../../src/features/import/useImportDiscovery";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const beat = (id: string): Beat => ({
  id,
  name: id,
  bpm: 120,
  key: "c",
  tags: [],
  rating: 0,
  mp3_path: `C:\\staging\\${id}.mp3`,
} as Beat);

const summary = (normalCount: number): ImportBatchPreview => ({
  batch_id: "batch-1",
  confirmed_count: normalCount,
  normal_count: normalCount,
  pending: [],
  audio_conflicts: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Latest = {
  session: ImportSession;
  discovery: ReturnType<typeof useImportDiscovery>;
  dropImporting: boolean;
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: Latest | null = null;
let currentServices: ImportDiscoveryServices;

function Harness() {
  const session = useImportSession();
  const [dropImporting, setDropImporting] = useState(false);
  const [, setDropActive] = useState(false);
  const [, setShowAdd] = useState(false);
  const [, setDeferredImportBatch] = useState<ImportBatchPreview | null>(null);
  const [, setAudioConflictBatch] = useState<ImportBatchPreview | null>(null);
  const [, setDropImportBatch] = useState<ImportBatchPreview | null>(null);
  const stagedImportPathsRef = useRef<Map<string, string[]>>(new Map());
  const discovery = useImportDiscovery({
    dropImporting,
    setDropImporting,
    rejectOfflineMutation: () => false,
    setDropActive,
    setShowAdd,
    setDeferredImportBatch,
    setAudioConflictBatch,
    setDropImportBatch,
    setReviewQueue: session.setReviewQueue,
    skippedReviewSourceKeysRef: session.skippedReviewSourceKeysRef,
    stagedImportPathsRef,
    skeletonEnabled: true,
    services: currentServices,
  });
  latest = { session, discovery, dropImporting };
  return <div />;
}

async function renderHarness() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}

async function flushBackgroundTick() {
  await act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latest = null;
  vi.restoreAllMocks();
});

describe("incremental import discovery", () => {
  it("publishes Beat 1 before the background scan finishes and then appends later beats", async () => {
    const secondStep = deferred<ImportReviewStep>();
    let prepareCalls = 0;
    currentServices = {
      startStream: vi.fn(async () => ({ batch_id: "batch-1" })),
      prepareNext: vi.fn(async () => {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          return {
            beat: beat("first"),
            prepared_count: 1,
            total_normal: null,
            remaining_normal: null,
            discovery_complete: false,
          };
        }
        return secondStep.promise;
      }),
      getSummary: vi.fn(async () => summary(2)),
      discardBatch: vi.fn(async () => {}),
    };

    await renderHarness();
    await act(async () => {
      await latest!.discovery.importDroppedPaths([" C:\\drop-root "]);
    });

    expect(latest!.session.reviewQueue?.beats.map(item => item.id)).toEqual(["first"]);
    expect(latest!.session.reviewQueue?.total).toBeNull();
    expect(latest!.session.reviewQueue?.preparing).toBe(true);
    expect(latest!.discovery.reviewPreparationDone).toBe(false);

    await flushBackgroundTick();
    expect(prepareCalls).toBe(2);
    expect(latest!.session.reviewQueue?.beats.map(item => item.id)).toEqual(["first"]);

    secondStep.resolve({
      beat: beat("second"),
      prepared_count: 2,
      total_normal: 2,
      remaining_normal: 0,
      discovery_complete: true,
    });
    await act(async () => {
      await latest!.discovery.reviewPreparationPromiseRef.current;
    });

    expect(latest!.session.reviewQueue?.beats.map(item => item.id)).toEqual(["first", "second"]);
    expect(latest!.session.reviewQueue?.total).toBe(2);
    expect(latest!.session.reviewQueue?.preparing).toBe(false);
    expect(latest!.discovery.reviewPreparationDone).toBe(true);
  });

  it("discards a stream that resolves after Cancel and never reopens stale candidates", async () => {
    const streamStart = deferred<{ batch_id: string }>();
    const prepareNext = vi.fn(async () => ({
      beat: beat("stale"),
      prepared_count: 1,
      total_normal: 1,
      remaining_normal: 0,
      discovery_complete: true,
    }));
    const discardBatch = vi.fn(async () => {});
    currentServices = {
      startStream: vi.fn(() => streamStart.promise),
      prepareNext,
      getSummary: vi.fn(async () => summary(1)),
      discardBatch,
    };

    await renderHarness();
    let importPromise!: Promise<void>;
    await act(async () => {
      importPromise = latest!.discovery.importDroppedPaths(["C:\\slow-root"]);
      await Promise.resolve();
    });
    expect(latest!.dropImporting).toBe(true);

    await act(async () => {
      latest!.discovery.cancelPendingReviewWork();
      latest!.session.setReviewQueue(null);
    });
    streamStart.resolve({ batch_id: "batch-1" });
    await act(async () => { await importPromise; });

    expect(prepareNext).not.toHaveBeenCalled();
    expect(discardBatch).toHaveBeenCalledWith("batch-1");
    expect(latest!.session.reviewQueue).toBeNull();
    expect(latest!.dropImporting).toBe(false);
  });
});
