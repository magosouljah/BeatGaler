// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Beat } from "../../src/types";
import { useImportSession, type ImportSession } from "../../src/features/import/useImportSession";
import { useImportReview } from "../../src/features/import/useImportReview";

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

type Latest = {
  session: ImportSession;
  actions: ReturnType<typeof useImportReview>;
  library: Beat[];
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: Latest | null = null;
let uploads: string[][] = [];
let released: string[] = [];
let discarded: string[] = [];
let cleanupSnapshots: string[][] = [];
let cancelPendingCalls = 0;

function Harness() {
  const [library, setLibrary] = useState<Beat[]>([]);
  const beatsLatestRef = useRef<Beat[]>([]);
  const session = useImportSession();
  const actions = useImportReview({
    setBeats: setLibrary,
    beatsLatestRef,
    setReviewQueue: session.setReviewQueue,
    skippedReviewSourceKeysRef: session.skippedReviewSourceKeysRef,
    cloudifyImportedBeats: beats => uploads.push(beats.map(item => item.id)),
    getQueuedBeatsSnapshot: () => [],
    onCancelPendingWork: () => { cancelPendingCalls += 1; },
    releaseBeat: id => released.push(id),
    discardBatch: id => { discarded.push(id); },
    cleanupStaging: protectedBeats => { cleanupSnapshots.push(protectedBeats.map(item => item.id)); },
  });
  latest = { session, actions, library };
  return <div />;
}

async function renderHarness() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}

async function flushTimers() {
  await act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  uploads = [];
  released = [];
  discarded = [];
  cleanupSnapshots = [];
  cancelPendingCalls = 0;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latest = null;
});

describe("basic import Review actions", () => {
  it("keeps candidates outside the library until Save and sends only the saved beat to the upload queue", async () => {
    await renderHarness();
    const first = beat("first");
    const second = beat("second");

    await act(async () => { latest!.session.startReview([first, second]); });
    expect(latest!.library).toEqual([]);
    expect(latest!.session.reviewQueue?.index).toBe(0);

    const saved = { ...first, name: "first edited" };
    await act(async () => { latest!.actions.handleReviewedBeatSaved(saved); });

    expect(latest!.library.map(item => item.id)).toEqual(["first"]);
    expect(latest!.library[0].name).toBe("first edited");
    expect(latest!.session.reviewQueue?.index).toBe(1);
    expect(uploads).toEqual([["first"]]);
  });

  it("Skip never adds candidates and closes after the same last known beat", async () => {
    await renderHarness();
    const first = beat("first");
    const second = beat("second");
    await act(async () => { latest!.session.startReview([first, second]); });

    await act(async () => { latest!.actions.skipCurrentReviewBeat(); });
    expect(latest!.library).toEqual([]);
    expect(latest!.session.reviewQueue?.index).toBe(1);

    await act(async () => { latest!.actions.skipCurrentReviewBeat(); });
    expect(latest!.library).toEqual([]);
    expect(latest!.session.reviewQueue).toBeNull();
    expect(released).toEqual(["first", "second"]);
    await flushTimers();
    expect(cleanupSnapshots).toEqual([[]]);
  });

  it("Cancel preserves already-saved beats while discarding and releasing only the unsaved tail", async () => {
    await renderHarness();
    const first = beat("first");
    const second = beat("second");
    const third = beat("third");
    await act(async () => {
      latest!.session.startReview([first, second, third], { batchId: "batch-1" });
    });
    await act(async () => { latest!.actions.handleReviewedBeatSaved(first); });
    await act(async () => { latest!.actions.cancelReview(); });

    expect(latest!.library.map(item => item.id)).toEqual(["first"]);
    expect(latest!.session.reviewQueue).toBeNull();
    expect(cancelPendingCalls).toBe(1);
    expect(discarded).toEqual(["batch-1"]);
    expect(released).toEqual(["second", "third"]);
    await flushTimers();
    expect(cleanupSnapshots).toEqual([["first"]]);
  });
});
