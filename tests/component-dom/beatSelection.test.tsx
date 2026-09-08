// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Beat } from "../../src/types";
import { useBeatSelection, type BeatSelection } from "../../src/features/selection/useBeatSelection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: BeatSelection | null = null;
let currentBeats: Beat[] = [];

const beat = (id: string): Beat => ({ id, name: id, bpm: 120, key: "c", tags: [], rating: 0 } as Beat);

function Harness() { latest = useBeatSelection(currentBeats); return <div />; }
async function render(beats: Beat[]) {
  currentBeats = beats;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}
async function rerender(beats: Beat[]) { currentBeats = beats; await act(async () => { root!.render(<Harness />); }); }

afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); host = null; latest = null; currentBeats = []; });

describe("useBeatSelection", () => {
  it("preserves single toggle, fixed-anchor Shift range, select all and cleanup", async () => {
    const beats = [beat("a"), beat("b"), beat("c"), beat("d")];
    await render(beats);
    await act(async () => { latest!.toggleSelection(beats[1], false, beats); });
    expect([...latest!.selectedIds]).toEqual(["b"]);
    expect(latest!.selectMode).toBe(true);
    await act(async () => { latest!.toggleSelection(beats[3], true, beats); });
    expect([...latest!.selectedIds]).toEqual(["b", "c", "d"]);
    await act(async () => { latest!.toggleSelection(beats[2], true, beats); });
    expect([...latest!.selectedIds]).toEqual(["b", "c"]);
    await act(async () => { latest!.toggleSelectAll(beats); });
    expect([...latest!.selectedIds]).toEqual(["a", "b", "c", "d"]);
    await rerender([beats[0], beats[2]]);
    expect([...latest!.selectedIds]).toEqual(["a", "c"]);
    await act(async () => { latest!.finishSelection(); });
    expect(latest!.selectedIds.size).toBe(0);
    expect(latest!.selectMode).toBe(false);
  });
});
