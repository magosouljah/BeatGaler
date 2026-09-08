// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useTagFilters, type TagFilters } from "../../src/features/tags/useTagFilters";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: TagFilters | null = null;

function Harness() {
  latest = useTagFilters();
  return <div />;
}

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latest = null;
});

describe("useTagFilters", () => {
  it("preserves include/exclude mutual exclusion, clear and rename reconciliation", async () => {
    await render();

    await act(async () => { latest!.toggleTagFilter("dark", "include"); });
    expect([...latest!.includedTags]).toEqual(["dark"]);
    expect([...latest!.excludedTags]).toEqual([]);

    await act(async () => { latest!.toggleTagFilter("dark", "exclude"); });
    expect([...latest!.includedTags]).toEqual([]);
    expect([...latest!.excludedTags]).toEqual(["dark"]);

    await act(async () => { latest!.replaceTagFilter("dark", "moody"); });
    expect([...latest!.excludedTags]).toEqual(["moody"]);

    await act(async () => { latest!.clearTagFilters(); });
    expect(latest!.includedTags.size).toBe(0);
    expect(latest!.excludedTags.size).toBe(0);
  });
});
