// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: TestIntersectionObserver });

vi.mock("../../src/components/ui", () => ({
  Artwork: ({ beat }: { beat: Beat }) => <div data-testid="artwork">{beat.name}</div>,
  TagPill: ({ label }: { label: string }) => <span>{label}</span>,
  PulsingBars: () => <span data-testid="pulsing-bars" />,
  Stars: () => <div data-testid="stars" />,
  TagEditor: ({ tags }: { tags: string[] }) => <div data-testid="tag-editor">{tags.join(",")}</div>,
}));

vi.mock("../../src/components/ImageCropModal", () => ({
  default: () => <div data-testid="crop-modal" />,
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    setActivatorNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock("../../src/lib/tagColors", () => ({
  useTagColors: () => ({}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("../../src/lib/dialog", () => ({
  appConfirm: vi.fn(async () => true),
}));

vi.mock("../../src/lib/tauri", () => ({
  getCloudClientId: vi.fn(() => "test-desktop-client"),
  revealInExplorer: vi.fn(async () => undefined),
  getProjectCloudStatus: vi.fn(async () => ({ state: "LOCAL" })),
  saveBeatMeta: vi.fn(async (payload: { mp3_path: string; wav_path: string | null }) => ({
    new_mp3_path: payload.mp3_path,
    new_wav_path: payload.wav_path,
  })),
  renameBeat: vi.fn(async () => ({
    new_folder_path: "C:/beats/Purple Beat",
    new_mp3_path: "C:/beats/Purple Beat/Purple Beat.mp3",
    new_wav_path: null,
    new_stems_path: null,
    new_flp_path: null,
  })),
  addFileToBeat: vi.fn(async () => undefined),
  pickFile: vi.fn(async () => null),
  pickFolder: vi.fn(async () => null),
  isTauriAvailable: false,
  listCloudFilesForBeat: vi.fn(async () => []),
  downloadCloudFileToCache: vi.fn(async () => "C:/cache/test.mp3"),
  uploadDroppedFileToTelegram: vi.fn(async () => undefined),
  uploadProjectToTelegram: vi.fn(async () => undefined),
  updateProjectArchiveFromSource: vi.fn(async () => undefined),
  inspectAudioMetadata: vi.fn(async () => ({
    has_metadata: false,
    bpm: "",
    key: "",
    tags: [],
    rating: 0,
    image_base64: null,
  })),
  readImagePathAsDataUrl: vi.fn(async () => null),
  diagnosticLog: vi.fn(async () => undefined),
}));

import BeatCard from "../../src/components/BeatCard";
import Drawer from "../../src/components/Drawer";
import Player from "../../src/components/Player";

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    id: "beat-1",
    name: "Purple Beat",
    folder_path: "C:/beats/Purple Beat",
    mp3_path: "C:/beats/Purple Beat/Purple Beat.mp3",
    wav_path: null,
    playback_path: "C:/beats/Purple Beat/Purple Beat.mp3",
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
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

async function render(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
});

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Player real DOM", () => {
  it("renders Play and a real click calls onToggle exactly once", async () => {
    const onToggle = vi.fn();
    const beat = makeBeat();

    await render(
      <Player
        beat={beat}
        playing={false}
        progress={0}
        duration={180}
        volume={0.8}
        queue={[beat]}
        currentIndex={0}
        showQueue={false}
        canShowQueue={true}
        shuffleEnabled={false}
        repeatMode="off"
        onToggle={onToggle}
        onSeek={() => undefined}
        onPrev={() => undefined}
        onNext={() => undefined}
        onVolumeChange={() => undefined}
        onToggleShuffle={() => undefined}
        onCycleRepeat={() => undefined}
        onToggleQueue={() => undefined}
        onPlayQueueIndex={() => undefined}
        onAddBeat={() => undefined}
        onDetail={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onAddToQueue={() => undefined}
      />
    );

    const play = document.querySelector('button[title="Play"]');
    expect(play).not.toBeNull();
    await click(play!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders Pause when the player is already playing", async () => {
    const beat = makeBeat();
    await render(
      <Player
        beat={beat} playing progress={0.2} duration={180} volume={1}
        queue={[beat]} currentIndex={0} showQueue={false} canShowQueue
        shuffleEnabled={false} repeatMode="off"
        onToggle={() => undefined} onSeek={() => undefined} onPrev={() => undefined}
        onNext={() => undefined} onVolumeChange={() => undefined}
        onToggleShuffle={() => undefined} onCycleRepeat={() => undefined}
        onToggleQueue={() => undefined} onPlayQueueIndex={() => undefined}
        onAddBeat={() => undefined} onDetail={() => undefined} onEdit={() => undefined}
        onDelete={() => undefined} onAddToQueue={() => undefined}
      />
    );
    expect(document.querySelector('button[title="Pause"]')).not.toBeNull();
  });
});

describe("BeatCard real DOM", () => {
  function cardProps(beat: Beat, onPlay: (beat: Beat) => void) {
    return {
      beat,
      tagFrequency: new Map<string, number>(),
      showIncompleteWarnings: true,
      openableProject: false,
      playing: false,
      selected: false,
      selectedCount: 0,
      selectMode: false,
      onPlay,
      onWarm: () => undefined,
      onDetail: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
      onAddToQueue: () => undefined,
      onUpload: () => undefined,
      onUploadTelegram: () => undefined,
      onDownloadTelegram: () => undefined,
      onUploadProjectTelegram: () => undefined,
      onOpenProject: () => undefined,
      onUpdateProject: () => undefined,
      onCloudFiles: () => undefined,
      onBulkEdit: () => undefined,
      onBulkUpload: () => undefined,
      onBulkDelete: () => undefined,
      onToggleSelect: () => undefined,
      dragEnabled: false,
      networkOnline: true,
      offlineBusy: false,
      onToggleOffline: () => undefined,
      onRetryUpload: () => undefined,
    };
  }

  it("clicking synced artwork calls onPlay with the rendered beat", async () => {
    const onPlay = vi.fn();
    const beat = makeBeat({ cloud_status: "SYNCED" });
    await render(<BeatCard {...cardProps(beat, onPlay)} />);

    const artwork = document.querySelector('[data-beat-artwork-id="beat-1"]');
    expect(artwork).not.toBeNull();
    expect(artwork?.getAttribute("aria-disabled")).toBe("false");
    await click(artwork!);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(beat);
  });

  it("UPLOADING artwork stays DOM-disabled and ignores clicks", async () => {
    const onPlay = vi.fn();
    const beat = makeBeat({ cloud_status: "UPLOADING" });
    await render(<BeatCard {...cardProps(beat, onPlay)} />);

    const artwork = document.querySelector('[data-beat-artwork-id="beat-1"]');
    expect(artwork?.getAttribute("aria-disabled")).toBe("true");
    await click(artwork!);
    expect(onPlay).not.toHaveBeenCalled();
  });
});

describe("Review Beat / Drawer real DOM", () => {
  it("invalid BPM disables Save; correcting it enables Save again", async () => {
    const beat = makeBeat({ bpm: "140", key: "F#m" });
    await render(
      <Drawer
        beat={beat}
        mode="edit"
        reviewInfo={{ current: 1, total: 2 }}
        closeAfterSave={false}
        mutationAllowed
        onClose={() => undefined}
        onSaved={() => undefined}
        onReleaseAudio={() => undefined}
      />
    );

    const findSave = () => Array.from(document.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Save and next") as HTMLButtonElement | undefined;
    const bpmInput = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null;

    expect(bpmInput).not.toBeNull();
    expect(findSave()).toBeDefined();
    expect(findSave()?.disabled).toBe(false);

    await setInputValue(bpmInput!, "999");
    expect(bpmInput?.getAttribute("aria-invalid")).toBe("true");
    expect(findSave()?.disabled).toBe(true);

    await setInputValue(bpmInput!, "120");
    expect(bpmInput?.getAttribute("aria-invalid")).toBe("false");
    expect(findSave()?.disabled).toBe(false);
  });

  it("offline mutation policy disables Review Save in the rendered footer", async () => {
    const beat = makeBeat();
    await render(
      <Drawer
        beat={beat}
        mode="edit"
        reviewInfo={{ current: 1, total: 1 }}
        mutationAllowed={false}
        onClose={() => undefined}
        onSaved={() => undefined}
        onReleaseAudio={() => undefined}
      />
    );

    const save = Array.from(document.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Internet connection required") as HTMLButtonElement | undefined;
    expect(save).toBeDefined();
    expect(save?.disabled).toBe(true);
  });

  it("commits cloud metadata through the authoritative INDEX before reporting Drawer save", async () => {
    const beat = makeBeat({ telegram_file_id: "cloud-master", telegram_message_id: 42 });
    const onCloudMutationCommit = vi.fn(async () => undefined);
    const onSaved = vi.fn();
    await render(
      <Drawer
        beat={beat}
        mode="edit"
        mutationAllowed
        onClose={() => undefined}
        onSaved={onSaved}
        onReleaseAudio={() => undefined}
        onCloudMutationCommit={onCloudMutationCommit}
      />
    );

    const bpmInput = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
    await setInputValue(bpmInput, "121");
    const save = Array.from(document.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Save changes") as HTMLButtonElement;
    await click(save);

    expect(onCloudMutationCommit).toHaveBeenCalledTimes(1);
    expect(onCloudMutationCommit.mock.calls[0][0].bpm).toBe("121");
    expect(onCloudMutationCommit.mock.calls[0][1]).toEqual({
      syncMetadata: true,
      reason: "drawer-metadata-save",
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
