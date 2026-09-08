// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryViewState, type LibraryViewState } from "../../src/features/library/useLibraryViewState";

const mocks = vi.hoisted(() => ({ loadCachedSort: vi.fn(), saveCachedSort: vi.fn() }));
vi.mock("../../src/features/library/libraryPresentationCache", () => ({
  loadCachedSort: mocks.loadCachedSort,
  saveCachedSort: mocks.saveCachedSort,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: LibraryViewState | null = null;

function Harness() {
  latest = useLibraryViewState();
  return <div>{latest.search}:{latest.sortBy}</div>;
}

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}

beforeEach(() => {
  mocks.loadCachedSort.mockReset().mockReturnValue("rating");
  mocks.saveCachedSort.mockReset();
  latest = null;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latest = null;
});

describe("useLibraryViewState", () => {
  it("owns search and restores/persists the existing sort choice", async () => {
    await render();
    expect(latest!.sortBy).toBe("rating");
    expect(mocks.saveCachedSort).toHaveBeenLastCalledWith("rating");

    await act(async () => {
      latest!.setSearch("dream");
      latest!.setSortBy("bpm");
    });
    expect(latest!.search).toBe("dream");
    expect(latest!.sortBy).toBe("bpm");
    expect(mocks.saveCachedSort).toHaveBeenLastCalledWith("bpm");
  });
});
