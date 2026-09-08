// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import {
  useLibraryPresentationCache,
  useLibraryState,
  type LibraryState,
} from "../../src/features/library/useLibraryState";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIBRARY_CACHE_KEY = "beatvault:library:v1";
const INTERRUPTED_UPLOADS_KEY = "beatgaler:active-cloud-uploads:v1";
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latestState: LibraryState | null = null;

function beat(id: string): Beat {
  return { id, name: id, tags: [], other_files: [] } as unknown as Beat;
}

function Harness({ verified, connected }: { verified: boolean; connected: boolean | null }) {
  const state = useLibraryState();
  useLibraryPresentationCache(state.beats, verified, connected);
  latestState = state;
  return <div data-testid="ids">{state.beats.map(item => item.id).join(",")}</div>;
}

async function render(verified: boolean, connected: boolean | null) {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<Harness verified={verified} connected={connected} />);
  });
}

beforeEach(() => {
  localStorage.clear();
  latestState = null;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latestState = null;
  localStorage.clear();
  vi.useRealTimers();
});

describe("useLibraryState", () => {
  it("uses one presentation library while hiding interrupted-upload cache rows", async () => {
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify([beat("ready"), beat("interrupted")]));
    localStorage.setItem(INTERRUPTED_UPLOADS_KEY, JSON.stringify([
      { beatId: "interrupted", beatName: "Interrupted", stagingPaths: [] },
    ]));

    await render(false, true);

    expect(host!.querySelector('[data-testid="ids"]')?.textContent).toBe("ready");
    expect(latestState!.startupCachedBeatsRef.current?.map(item => item.id)).toEqual(["ready"]);
    expect(latestState!.initialLoading).toBe(false);
    // App intentionally owns the historical timing of publishing render state
    // into this ref; the extracted owner must not make cached rows authoritative.
    expect(latestState!.beatsLatestRef.current).toEqual([]);
  });

  it("writes the presentation cache only after cloud authority is verified", async () => {
    vi.useFakeTimers();
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify([beat("cached")]));
    await render(false, true);

    await act(async () => {
      latestState!.setBeats([beat("fresh")]);
    });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY) ?? "[]").map((item: Beat) => item.id)).toEqual(["cached"]);

    await render(true, true);
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY) ?? "[]").map((item: Beat) => item.id)).toEqual(["fresh"]);
  });
});
