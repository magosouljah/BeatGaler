import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  src = "";
  currentTime = 0;
  duration = 120;
  volume = 0.75;
  muted = false;
  loop = false;
  preload = "";
  paused = true;
  readyState = 0;
  error: MediaError | null = null;

  constructor() {
    super();
    FakeAudio.instances.push(this);
  }

  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  load() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}

type Signal = {
  beatId: string;
  currentTime: number;
  state: "idle" | "playing" | "waiting";
};

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Web playback buffer signal bridge", () => {
  it("reports playing, currentTime, waiting and idle state from the shared audio element", async () => {
    vi.doMock("../../src/platform", () => ({
      platform: {
        media: {
          resolveUrl: (path: string) => `asset://${path}`,
          releasePlayback: vi.fn(),
        },
        diagnostics: { audioEvent: vi.fn(async () => undefined) },
      },
    }));
    FakeAudio.instances = [];
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    const { useAudio } = await import("../../src/hooks/useAudio");

    let hook!: ReturnType<typeof useAudio>;
    function Probe() {
      hook = useAudio();
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Probe />));

    const signals: Signal[] = [];
    const listener = (event: Event) => signals.push((event as CustomEvent<Signal>).detail);
    window.addEventListener("beatgaler:web-playback-buffer", listener);
    const audio = FakeAudio.instances[0];

    try {
      await act(async () => hook.play("beat-1", ["master.mp3"]));
      audio.currentTime = 0.25;
      audio.dispatchEvent(new Event("playing"));
      audio.currentTime = 0.75;
      audio.dispatchEvent(new Event("timeupdate"));
      audio.dispatchEvent(new Event("waiting"));
      audio.pause();
    } finally {
      window.removeEventListener("beatgaler:web-playback-buffer", listener);
    }

    expect(signals).toEqual(expect.arrayContaining([
      { beatId: "beat-1", currentTime: 0.25, state: "playing" },
      { beatId: "beat-1", currentTime: 0.75, state: "playing" },
      { beatId: "beat-1", currentTime: 0.75, state: "waiting" },
      { beatId: "beat-1", currentTime: 0.75, state: "idle" },
    ]));
  });
});
