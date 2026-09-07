// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import SearchBar from "../../src/features/library/components/SearchBar";
import SortMenu, { type SortKey } from "../../src/features/library/components/SortMenu";
import TagColorMenu from "../../src/features/tags/components/TagColorMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
}

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("extracted library controls", () => {
  it("SearchBar preserves toggle, clear and empty-blur close", async () => {
    function Harness() {
      const [value, setValue] = useState("purple");
      return <SearchBar value={value} onChange={setValue} />;
    }
    await render(<Harness />);
    await click(host!.querySelector("button")!);
    let input = host!.querySelector('input[placeholder="Search beats…"]') as HTMLInputElement;
    expect(input.value).toBe("purple");
    const clear = host!.querySelector("button")!;
    await act(async () => { clear.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    input = host!.querySelector('input[placeholder="Search beats…"]') as HTMLInputElement;
    expect(input.value).toBe("");
    await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(host!.querySelector('input[placeholder="Search beats…"]')).toBeNull();
  });

  it("SortMenu preserves options, selection and Escape close", async () => {
    function Harness() {
      const [value, setValue] = useState<SortKey>("rating");
      return <SortMenu value={value} onChange={setValue} />;
    }
    await render(<Harness />);
    expect(host!.querySelector("button")?.textContent).toBe("Rating");
    await click(host!.querySelector("button")!);
    const bpm = Array.from(host!.querySelectorAll("button")).find(button => button.textContent === "BPM")!;
    await click(bpm);
    expect(host!.querySelector("button")?.textContent).toBe("BPM");
    await click(host!.querySelector("button")!);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(host!.querySelectorAll("button")).toHaveLength(1);
  });

  it("TagColorMenu preserves body portal, actions and Escape close", async () => {
    const onSelect = vi.fn();
    const onRename = vi.fn();
    const onClose = vi.fn();
    await render(<TagColorMenu x={12} y={34} current={null} onSelect={onSelect} onRename={onRename} onClose={onClose} />);
    expect(host!.querySelector("button")).toBeNull();
    await click(document.body.querySelector('button[title]')!);
    expect(onSelect).toHaveBeenCalledWith(expect.any(String));
    const none = Array.from(document.body.querySelectorAll("button")).find(button => button.textContent?.trim() === "Ninguno")!;
    await click(none);
    expect(onSelect).toHaveBeenCalledWith(null);
    const rename = Array.from(document.body.querySelectorAll("button")).find(button => button.textContent?.trim() === "Renombrar…")!;
    await click(rename);
    expect(onRename).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalled();
  });
});
