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
import { WEB_PLAYBACK_ROUTE_RECOVERY_EVENT } from "../../src/features/playback/webPlaybackRouteRecoveryEvents";
import { WEB_TRANSPORT_INVALIDATED_EVENT } from "../../src/features/cloud/webTransportEvents";
import {
  beginWebPlaybackIntent,
  invalidateAllWebPlaybackIntents,
  rememberPreparedWebPlaybackUrl,
} from "../../src/features/playback/webPlaybackIntent";

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
    invalidateAllWebPlaybackIntents();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderPlayingBeat(): Promise<FakeAudio> {
    await act(async () => {
      root.render(<Harness onValue={value => { latest = value; }} />);
    });
    expect(latest).not.toBeNull();
    const intent = beginWebPlaybackIntent("beat-1");
    rememberPreparedWebPlaybackUrl("blob:session-audio", intent);
    await act(async () => {
      latest!.play("beat-1", ["blob:session-audio"]);
      await Promise.resolve();
    });
    return FakeAudio.instances[0];
  }

  it("stops audible playback, detaches src and releases the active beat when the Web session is invalidated", async () => {
    const audio = await renderPlayingBeat();
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

  it("rejects a late tracked Web URL after transport invalidation", async () => {
    const audio = await renderPlayingBeat();
    expect(audio.play).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event(WEB_TRANSPORT_INVALIDATED_EVENT));
    });

    await act(async () => {
      latest!.play("beat-1", ["blob:session-audio"]);
      await Promise.resolve();
    });

    expect(audio.src).toBe("");
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(latest!.state.playingId).toBeNull();
  });

  it("holds the current intent through an async route error and resumes the repaired URL at the previous playback time", async () => {
    const audio = await renderPlayingBeat();
    audio.currentTime = 7.25;
    releasePlayback.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, {
        detail: { beatId: "beat-1", phase: "begin" },
      }));
      audio.dispatchEvent(new Event("error"));
    });
    await act(async () => { await Promise.resolve(); });

    expect(releasePlayback).not.toHaveBeenCalled();
    expect(latest!.state.playingId).toBe("beat-1");

    await act(async () => {
      window.dispatchEvent(new CustomEvent(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, {
        detail: { beatId: "beat-1", phase: "ready", url: "blob:repaired-audio" },
      }));
      await Promise.resolve();
    });

    expect(audio.src).toBe("blob:repaired-audio");
    expect(audio.currentTime).toBe(7.25);
    expect(audio.load).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(releasePlayback).not.toHaveBeenCalled();
    expect(latest!.state.playingId).toBe("beat-1");
  });

  it("ignores a late repaired URL after a newer beat supersedes the recovering beat", async () => {
    const audio = await renderPlayingBeat();
    act(() => {
      window.dispatchEvent(new CustomEvent(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, {
        detail: { beatId: "beat-1", phase: "begin" },
      }));
    });

    await act(async () => {
      latest!.play("beat-2", ["blob:new-beat"]);
      await Promise.resolve();
    });
    expect(audio.src).toBe("blob:new-beat");

    act(() => {
      window.dispatchEvent(new CustomEvent(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, {
        detail: { beatId: "beat-1", phase: "ready", url: "blob:late-old-beat" },
      }));
    });

    expect(audio.src).toBe("blob:new-beat");
    expect(latest!.state.playingId).toBe("beat-2");
  });
});
