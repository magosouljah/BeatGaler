// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useAppShortcuts } from "../../src/app/useAppShortcuts";

type ShortcutActions = Parameters<typeof useAppShortcuts>[0];

function ShortcutSurface({ actions }: { actions: ShortcutActions }) {
  useAppShortcuts(actions);
  return <><button type="button">Playback</button><input aria-label="Search beats" /></>;
}

function press(target: EventTarget, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

it("dispatches workspace shortcuts from the mounted surface and releases them on unmount", async () => {
  const actions = {
    togglePauseRef: { current: vi.fn() },
    clearSelection: vi.fn(),
    setDrawer: vi.fn(),
    setShowAdd: vi.fn(),
    setShowSettings: vi.fn(),
    closeQueue: vi.fn(),
    setShowUpload: vi.fn(),
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ShortcutSurface actions={actions} />));
    const input = host.querySelector("input")!;
    const button = host.querySelector("button")!;

    input.focus();
    expect(press(input, " ")).toBe(false);
    expect(actions.togglePauseRef.current).not.toHaveBeenCalled();
    expect(press(button, " ")).toBe(true);
    expect(actions.togglePauseRef.current).toHaveBeenCalledTimes(1);

    press(input, "Escape");
    expect(document.activeElement).not.toBe(input);
    expect(actions.clearSelection).toHaveBeenCalledTimes(1);
    expect(actions.setDrawer).toHaveBeenCalledWith(null);
    expect(actions.setShowAdd).toHaveBeenCalledWith(false);
    expect(actions.setShowSettings).toHaveBeenCalledWith(false);
    expect(actions.closeQueue).toHaveBeenCalledTimes(1);
    expect(actions.setShowUpload).toHaveBeenCalledWith(null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
  expect(press(document.body, " ")).toBe(false);
  expect(actions.togglePauseRef.current).toHaveBeenCalledTimes(1);
});
