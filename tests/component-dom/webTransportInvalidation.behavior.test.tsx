import React, { useEffect } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const releasePlayback = vi.fn();
const audioEvent = vi.fn(async () => {});

vi.mock("../../src/platform", () => ({
  platform: {
    media: {
      resolveUrl: (value: string) => value,
      releasePlayback,
    },
    diagnostics: { audioEvent },
  },
}));

import { useAudio } from "../../src/hooks/useAudio";
import { WEB_TRANSPORT_INVALIDATED_EVENT } from "../../src/features/cloud/webTransportEvents";

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
  ended = false;
  readyState = 4;
  error: MediaError | null = null;
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  load = vi.fn();
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
  });
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });

  constructor() {
    super();
    FakeAudio.instances.push(this);
  }
}

type AudioApi = ReturnType<typeof useAudio>;

function Harness({ onValue }: { onValue(value: AudioApi): void }) {
  const value = useAudio();
  useEffect(() => onValue(value), [value, onValue]);
  return null;
}

describe("Web transport invalidation behavior", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: AudioApi | null;

  beforeEach(() => {
    FakeAudio.instances = [];
    releasePlayback.mockClear();
    audioEvent.mockClear();
    vi.stubGlobal("Audio", FakeAudio);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("stops audible playback, detaches src and releases the active beat when the Web session is invalidated", async () => {
    await act(async () => {
      root.render(<Harness onValue={value => { latest = value; }} />);
    });
    expect(latest).not.toBeNull();

    await act(async () => {
      latest!.play("beat-1", ["blob:session-audio"]);
      await Promise.resolve();
    });

    const audio = FakeAudio.instances[0];
    expect(audio.src).toBe("blob:session-audio");
    expect(audio.paused).toBe(false);

    act(() => {
      window.dispatchEvent(new Event(WEB_TRANSPORT_INVALIDATED_EVENT));
    });

    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalled();
    expect(audio.src).toBe("");
    expect(releasePlayback).toHaveBeenCalledWith("beat-1");
    expect(latest!.state.playingId).toBeNull();
    expect(latest!.state.isPlaying).toBe(false);
  });
});
