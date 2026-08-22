// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBeat(id = "beat-1", name = "Purple Beat"): Beat {
  return {
    id,
    name,
    folder_path: `C:/beats/${name}`,
    mp3_path: `C:/beats/${name}/${name}.mp3`,
    wav_path: null,
    playback_path: `C:/beats/${name}/${name}.mp3`,
    bpm: "140",
    key: "F#m",
    needs_resolution: false,
    tags: ["dark", "trap"],
    rating: 4,
    image_base64: null,
    image_preview_base64: null,
    image_crop: null,
    has_wav: false,
    has_stems: false,
    has_samples: false,
    samples_path: null,
    has_flp: false,
    has_als: false,
    stems_path: null,
    flp_path: null,
    als_path: null,
    other_files: [],
    color: "#111111",
    color2: "#222222",
    has_loop: false,
    loop_path: null,
    cloud_status: "SYNCED",
    telegram_file_id: null,
    telegram_message_id: null,
    offline_available: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function loadLibraryManager(mocks?: {
  restore?: ReturnType<typeof vi.fn>;
  load?: ReturnType<typeof vi.fn>;
  sync?: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();
  const restore = mocks?.restore ?? vi.fn(async () => undefined);
  const load = mocks?.load ?? vi.fn(async () => [makeBeat()]);
  const sync = mocks?.sync ?? vi.fn(async () => ({ ok: true }));

  vi.doMock("../../src/platform", () => ({
    platform: { library: {
      restoreAuthoritative: restore,
      load,
      commitSnapshot: sync,
    } },
  }));

  const { libraryStateManager } = await import("../../src/lib/libraryStateManager");
  return { libraryStateManager, restore, load, sync };
}

describe("LibraryStateManager ↔ platform integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads the authority before reading the restored local library", async () => {
    const order: string[] = [];
    const restore = vi.fn(async () => { order.push("restore"); });
    const load = vi.fn(async () => { order.push("load"); return [makeBeat()]; });
    const { libraryStateManager } = await loadLibraryManager({ restore, load });

    const result = await libraryStateManager.reloadAuthoritative();

    expect(order).toEqual(["restore", "load"]);
    expect(result.map(beat => beat.id)).toEqual(["beat-1"]);
    expect(libraryStateManager.verifiedSnapshot()?.map(beat => beat.id)).toEqual(["beat-1"]);
  });

  it("serializes competing commits so the second INDEX transaction cannot overtake the first", async () => {
    const first = deferred<{ ok: boolean }>();
    const second = deferred<{ ok: boolean }>();
    const started: string[] = [];
    let call = 0;
    const sync = vi.fn(() => {
      call += 1;
      started.push(`commit-${call}`);
      return call === 1 ? first.promise : second.promise;
    });
    const { libraryStateManager } = await loadLibraryManager({ sync });

    const p1 = libraryStateManager.commitSnapshot([makeBeat("one", "One")], "first");
    const p2 = libraryStateManager.commitSnapshot([makeBeat("two", "Two")], "second");

    await waitForCondition(() => started.length === 1, "first commit never reached the Tauri sync layer");
    expect(started).toEqual(["commit-1"]);

    first.resolve({ ok: true });
    await p1;
    await waitForCondition(() => started.length === 2, "second commit never started after the first released the queue");
    expect(started).toEqual(["commit-1", "commit-2"]);

    second.resolve({ ok: true });
    await p2;
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("freezes the commit candidate before waiting, including nested tag arrays", async () => {
    const gate = deferred<{ ok: boolean }>();
    const sync = vi.fn(() => gate.promise);
    const { libraryStateManager } = await loadLibraryManager({ sync });
    const beats = [makeBeat()];

    const commit = libraryStateManager.commitSnapshot(beats, "freeze-test");
    beats[0].name = "Mutated Later";
    beats[0].tags.push("mutated-later");

    await waitForCondition(() => sync.mock.calls.length === 1, "commit never reached the Tauri sync layer");
    const sent = sync.mock.calls[0][0] as Beat[];
    expect(sent[0].name).toBe("Purple Beat");
    expect(sent[0].tags).toEqual(["dark", "trap"]);

    gate.resolve({ ok: true });
    await commit;
  });

  it("releases the transaction queue after a failed commit so later work can continue", async () => {
    const calls: string[] = [];
    const sync = vi.fn(async (beats: Beat[]) => {
      const id = beats[0].id;
      calls.push(id);
      if (id === "bad") throw new Error("simulated sync failure");
      return { ok: true };
    });
    const { libraryStateManager } = await loadLibraryManager({ sync });

    const failed = libraryStateManager.commitSnapshot([makeBeat("bad", "Bad")], "bad");
    const recovered = libraryStateManager.commitSnapshot([makeBeat("good", "Good")], "good");

    await expect(failed).rejects.toThrow("simulated sync failure");
    await expect(recovered).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["bad", "good"]);
  });

  it("returns defensive verified snapshots instead of exposing the stored authority candidate", async () => {
    const { libraryStateManager } = await loadLibraryManager();
    await libraryStateManager.commitSnapshot([makeBeat()], "verified-copy");

    const first = libraryStateManager.verifiedSnapshot()!;
    first.push(makeBeat("intruder", "Intruder"));

    const second = libraryStateManager.verifiedSnapshot()!;
    expect(second.map(beat => beat.id)).toEqual(["beat-1"]);
  });
});

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  src = "";
  currentTime = 0;
  duration = 120;
  volume = 0.75;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;

  constructor() {
    super();
    FakeAudio.instances.push(this);
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

async function mountAudioHook() {
  vi.resetModules();
  vi.doMock("../../src/platform", () => ({
    platform: {
      media: {
        resolveUrl: (path: string) => `asset://${path.replace(/\\/g, "/")}`,
        preparePlayback: async (beat: Beat) => ({ url: beat.playback_path, completed: Promise.resolve() }),
        releasePlayback: () => undefined,
      },
      diagnostics: { audioEvent: vi.fn(async () => undefined) },
    },
  }));

  FakeAudio.instances = [];
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
  const { useAudio } = await import("../../src/hooks/useAudio");

  let latest!: AudioHook;
  function Probe() {
    latest = useAudio();
    return <div data-playing={latest.state.playingId ?? ""} data-progress={latest.state.progress} />;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe />);
  });

  return {
    get hook() { return latest; },
    audio: FakeAudio.instances[0],
    root,
    host,
  };
}

let audioRoot: Root | null = null;

afterEach(async () => {
  if (audioRoot) {
    await act(async () => audioRoot?.unmount());
    audioRoot = null;
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("useAudio ↔ platform integration", () => {
  it("converts file paths and falls back to the next source after a browser audio error", async () => {
    const mounted = await mountAudioHook();
    audioRoot = mounted.root;

    await act(async () => {
      mounted.hook.play("beat-1", ["C:\\beats\\master.wav", "C:\\beats\\master.mp3"]);
    });
    expect(mounted.audio.src).toBe("asset://C:/beats/master.wav");
    expect(mounted.hook.state.playingId).toBe("beat-1");

    await act(async () => {
      mounted.audio.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });

    expect(mounted.audio.src).toBe("asset://C:/beats/master.mp3");
    expect(mounted.audio.playCalls).toBe(2);
  });

  it("toggles pause when Play is requested again for the currently selected beat", async () => {
    const mounted = await mountAudioHook();
    audioRoot = mounted.root;

    await act(async () => {
      mounted.hook.play("beat-1", ["C:\\beats\\master.mp3"]);
    });
    expect(mounted.audio.paused).toBe(false);

    await act(async () => {
      mounted.hook.play("beat-1", ["C:\\beats\\master.mp3"]);
    });
    expect(mounted.audio.paused).toBe(true);
    expect(mounted.hook.state.isPlaying).toBe(false);
  });

  it("releases the browser file handle and resets playback state before Windows rename flows", async () => {
    const mounted = await mountAudioHook();
    audioRoot = mounted.root;

    await act(async () => {
      mounted.hook.play("beat-1", ["C:\\beats\\master.mp3"]);
    });
    expect(mounted.audio.src).not.toBe("");

    await act(async () => {
      mounted.hook.releaseFile();
    });

    expect(mounted.audio.src).toBe("");
    expect(mounted.audio.loadCalls).toBeGreaterThanOrEqual(2);
    expect(mounted.hook.state.playingId).toBeNull();
    expect(mounted.hook.state.progress).toBe(0);
    expect(mounted.hook.state.duration).toBe(0);
  });
});
