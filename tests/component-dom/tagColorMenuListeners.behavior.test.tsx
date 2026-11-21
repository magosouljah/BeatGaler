// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TagColorMenu from "../../src/features/tags/components/TagColorMenu";

let host: HTMLDivElement;
let root: Root;

function mountMenu() {
  const onClose = vi.fn();
  act(() => {
    root.render(
      <TagColorMenu x={12} y={34} current={null} onSelect={vi.fn()} onRename={vi.fn()} onClose={onClose} />,
    );
  });
  return onClose;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TagColorMenu window listeners", () => {
  it("cleans up when the menu unmounts before the click listener is registered", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const onClose = mountMenu();

    vi.advanceTimersByTime(5);
    act(() => root.render(null));
    vi.advanceTimersByTime(10);
    const clickRegistrations = addListener.mock.calls.filter(([type]) => type === "click");

    try {
      window.dispatchEvent(new MouseEvent("click"));
      expect(onClose).not.toHaveBeenCalled();
      expect(clickRegistrations).toHaveLength(0);

      const immediateListeners = addListener.mock.calls.filter(([type]) =>
        type === "beatcard:close-menus" || type === "contextmenu" || type === "keydown",
      );
      expect(immediateListeners).toHaveLength(3);
      for (const registration of immediateListeners) {
        expect(removeListener.mock.calls).toContainEqual(registration);
      }
    } finally {
      // Remove any leaked listener even if the regression assertion fails.
      for (const registration of clickRegistrations) {
        window.removeEventListener(...registration);
      }
    }
  });

  it("closes on an outside click after the delay and removes the click listener on unmount", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const onClose = mountMenu();

    vi.advanceTimersByTime(11);
    window.dispatchEvent(new MouseEvent("click"));
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => root.render(null));
    const clickRegistrations = addListener.mock.calls.filter(([type]) => type === "click");
    expect(clickRegistrations).toHaveLength(1);
    expect(removeListener.mock.calls).toContainEqual(clickRegistrations[0]);
    window.dispatchEvent(new MouseEvent("click"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = mountMenu();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
