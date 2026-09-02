// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class LoadingAudio extends EventTarget {
  static instances: LoadingAudio[] = [];
  src = "";
  currentTime = 0;
  duration = 0;
  volume = 0.75;
  muted = false;
  loop = false;
  preload = "";
  paused = true;
  readyState = 0;
  error: MediaError | null = null;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;

  constructor() {
    super();
    LoadingAudio.instances.push(this);
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  load() {
    this.loadCalls += 1;
  }

  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}

type AudioHook = ReturnType<(typeof import("../../src/hooks/useAudio"))["useAudio"]>;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.resetModules();
  vi.clearAllMocks();
});

describe("useAudio duplicate Play protection", () => {
  it("does not reload the same MediaSource when Play is clicked again before current data exists", async () => {
    vi.resetModules();
    vi.doMock("../../src/platform", () => ({
      platform: {
        media: {
          resolveUrl: (path: string) => path,
          releasePlayback: vi.fn(),
        },
        diagnostics: { audioEvent: vi.fn(async () => undefined) },
      },
    }));

    LoadingAudio.instances = [];
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: LoadingAudio });
    const { useAudio } = await import("../../src/hooks/useAudio");

    let latest!: AudioHook;
    function Probe() {
      latest = useAudio();
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Probe />));
    const audio = LoadingAudio.instances[0];
    const source = "blob:https://beatgaler.com/current-session-source";

    await act(async () => {
      latest.play("beat-1", [source]);
      latest.play("beat-1", [source]);
      await Promise.resolve();
    });

    expect(audio.src).toBe(source);
    expect(audio.readyState).toBe(0);
    expect(audio.playCalls).toBe(1);
    expect(audio.pauseCalls).toBe(1);
    expect(audio.loadCalls).toBe(1);
  });
});
