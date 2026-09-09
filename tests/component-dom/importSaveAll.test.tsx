// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import type { ImportBatchPreview } from "../../src/lib/tauri";
import { useImportSession, type ImportSession } from "../../src/features/import/useImportSession";
import { useImportSaveAll, type ImportSaveAllServices } from "../../src/features/import/useImportSaveAll";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const beat = (id: string, name = id): Beat => ({
  id,
  name,
  bpm: 120,
  key: "c",
  tags: [],
  rating: 0,
  mp3_path: `C:\\staging\\${id}.mp3`,
} as Beat);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

type Latest = {
  session: ImportSession;
  actions: ReturnType<typeof useImportSaveAll>;
  library: Beat[];
  preparationRef: React.MutableRefObject<Promise<Beat[]> | null>;
  setDeferredBatch: React.Dispatch<React.SetStateAction<ImportBatchPreview | null>>;
  stagedRef: React.MutableRefObject<Map<string, string[]>>;
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: Latest | null = null;
let uploads: string[][] = [];
let imported: string[][] = [];
let discarded: string[] = [];
let cleaned: string[][] = [];
let saveMeta = vi.fn();

function Harness() {
  const [library, setLibrary] = useState<Beat[]>([]);
  const beatsLatestRef = useRef<Beat[]>([]);
  const session = useImportSession();
  const preparationRef = useRef<Promise<Beat[]> | null>(null);
  const [deferredBatch, setDeferredBatch] = useState<ImportBatchPreview | null>(null);
  const stagedRef = useRef<Map<string, string[]>>(new Map());
  const services: ImportSaveAllServices = {
    saveMeta: saveMeta as ImportSaveAllServices["saveMeta"],
    discardBatch: (async batchId => { discarded.push(batchId); }) as ImportSaveAllServices["discardBatch"],
    cleanupStaging: (async paths => { cleaned.push([...paths]); }) as ImportSaveAllServices["cleanupStaging"],
  };
  const actions = useImportSaveAll({
    setBeats: setLibrary,
    beatsLatestRef,
    reviewQueue: session.reviewQueue,
    setReviewQueue: session.setReviewQueue,
    reviewQueueLatestRef: session.reviewQueueLatestRef,
    reviewBootstrap: null,
    reviewPreparationDone: true,
    reviewPreparationPromiseRef: preparationRef,
    deferredImportBatch: deferredBatch,
    setDeferredImportBatch: setDeferredBatch,
    stagedImportPathsRef: stagedRef,
    setDropImporting: () => {},
    cloudifyImportedBeats: beats => { uploads.push(beats.map(item => item.id)); },
    addBeatsAndReview: beats => { imported.push(beats.map(item => item.id)); },
    services,
  });
  latest = { session, actions, library, preparationRef, setDeferredBatch, stagedRef };
  return <div />;
}

async function renderHarness() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}

beforeEach(() => {
  uploads = [];
  imported = [];
  discarded = [];
  cleaned = [];
  saveMeta = vi.fn(async (input: { mp3_path: string }) => ({
    new_mp3_path: input.mp3_path,
    new_wav_path: null,
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latest = null;
});

describe("task 7.3 Save All and deferred conflicts", () => {
  it("closes Review and saves the current beat before waiting for background preparation", async () => {
    await renderHarness();
    const first = beat("first");
    const second = beat("second");
    const preparation = deferred<Beat[]>();

    await act(async () => {
      latest!.session.startReview([first], { batchId: "batch-1", total: null, preparing: true });
      latest!.preparationRef.current = preparation.promise;
    });

    let savePromise!: Promise<void>;
    await act(async () => {
      savePromise = latest!.actions.handleReviewedSaveAll(first);
      await Promise.resolve();
    });

    expect(latest!.session.reviewQueue).toBeNull();
    expect(latest!.library.map(item => item.id)).toEqual(["first"]);
    expect(uploads).toEqual([["first"]]);
    expect(saveMeta).not.toHaveBeenCalled();

    preparation.resolve([first, second]);
    await act(async () => { await savePromise; });

    expect(saveMeta).toHaveBeenCalledTimes(1);
    expect(latest!.library.map(item => item.id)).toEqual(["second", "first"]);
    expect(uploads).toEqual([["first"], ["second"]]);
  });

  it("reopens duplicate-name candidates at the end instead of auto-renaming or uploading them", async () => {
    await renderHarness();
    const first = beat("first", "same name");
    const duplicate = beat("duplicate", "same name");

    await act(async () => {
      latest!.session.startReview([first, duplicate], { batchId: "batch-dup", total: 2, preparing: false });
    });
    await act(async () => { await latest!.actions.handleReviewedSaveAll(first); });

    expect(saveMeta).not.toHaveBeenCalled();
    expect(uploads).toEqual([["first"]]);
    expect(latest!.session.reviewQueue?.beats.map(item => item.id)).toEqual(["duplicate"]);
    expect(latest!.session.reviewQueue?.batchId).toBe("batch-dup");
  });

  it("defers audio conflicts until normal Review is closed and cancels only the unresolved tail without deleting staged files", async () => {
    await renderHarness();
    const batch = {
      batch_id: "batch-audio",
      confirmed_count: 0,
      normal_count: 0,
      pending: [],
      audio_conflicts: [{ root_path: "C:\\drop", candidates: ["a.mp3", "b.wav"] }],
    } as unknown as ImportBatchPreview;
    latest!.stagedRef.current.set("batch-audio", ["C:\\staging\\a.mp3"]);

    await act(async () => { latest!.setDeferredBatch(batch); });
    expect(latest!.actions.audioConflictBatch?.batch_id).toBe("batch-audio");
    expect(latest!.stagedRef.current.has("batch-audio")).toBe(true);

    await act(async () => { latest!.actions.cancelAudioConflicts(); });
    expect(latest!.stagedRef.current.has("batch-audio")).toBe(false);
    expect(discarded).toContain("batch-audio");
    expect(cleaned).toEqual([]);
  });

  it("keeps decision-import staging alive when imported beats still point at it", async () => {
    await renderHarness();
    const batch = {
      batch_id: "batch-pending",
      confirmed_count: 0,
      normal_count: 0,
      pending: [{ root_path: "C:\\drop" }],
      audio_conflicts: [],
    } as unknown as ImportBatchPreview;
    latest!.stagedRef.current.set("batch-pending", ["C:\\staging\\kept.mp3"]);

    await act(async () => { latest!.setDeferredBatch(batch); });
    expect(latest!.actions.dropImportBatch?.batch_id).toBe("batch-pending");

    const capturedActions = latest!.actions;
    await act(async () => {
      capturedActions.importResolvedDecisions([beat("resolved")]);
      capturedActions.closeImportDecisions();
    });

    expect(imported).toEqual([["resolved"]]);
    expect(discarded).toContain("batch-pending");
    expect(cleaned).toEqual([[]]);
  });
});
