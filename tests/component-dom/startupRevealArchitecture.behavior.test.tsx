// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import BeatCard from "../../src/components/BeatCard";
import type { Beat } from "../../src/types";

vi.mock("../../src/platform", () => ({ platform: { kind: "web" } }));

const beat: Beat = {
  id: "reveal-beat",
  name: "Midnight",
  folder_path: "",
  mp3_path: "",
  wav_path: null,
  playback_path: "",
  bpm: "120",
  key: "Am",
  needs_resolution: false,
  tags: [],
  rating: 0,
  image_base64: null,
  artwork_pending: true,
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
  color: "#222222",
  color2: "#333333",
  has_loop: false,
  loop_path: null,
  cloud_status: "SYNCED",
  telegram_file_id: "audio-fixture",
};

const noop = () => {};
const cardProps = {
  beat,
  tagFrequency: new Map<string, number>(),
  showIncompleteWarnings: false,
  openableProject: false,
  playing: false,
  selected: false,
  selectedCount: 0,
  selectMode: false,
  onPlay: noop,
  onDetail: noop,
  onEdit: noop,
  onDelete: noop,
  onAddToQueue: noop,
  onUpload: noop,
  onUploadTelegram: noop,
  onDownloadTelegram: noop,
  onUploadProjectTelegram: noop,
  onOpenProject: noop,
  onUpdateProject: noop,
  onCloudFiles: noop,
  onBulkEdit: noop,
  onBulkUpload: noop,
  onBulkDelete: noop,
  onToggleSelect: noop,
  dragEnabled: false,
  networkOnline: true,
  offlineBusy: false,
  canUseOfflinePackage: false,
  canUseLocalHelper: false,
  canInspectNativeProject: false,
  onToggleOffline: noop,
  onRetryUpload: noop,
} satisfies Omit<ComponentProps<typeof BeatCard>, "onWarm">;

it("keeps the slot mounted and warms audio only for a revealed, playable card that has entered the viewport and has a file", async () => {
  const onWarm = vi.fn();
  const observed = new Map<Element, (ratio: number) => void>();
  class TestIntersectionObserver {
    private target?: Element;

    constructor(private readonly callback: IntersectionObserverCallback) {}

    observe(target: Element) {
      this.target = target;
      observed.set(target, ratio => {
        this.callback([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver);
      });
    }

    disconnect() {
      if (this.target) observed.delete(this.target);
    }
  }

  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const slotSelector = `[data-beat-slot-id="${beat.id}"]`;
  const render = async (props: Partial<Pick<ComponentProps<typeof BeatCard>, "beat" | "visible" | "playbackInteractive">> = {}) => {
    await act(async () => root.render(<BeatCard {...cardProps} onWarm={onWarm} {...props} />));
  };

  try {
    await render({ visible: false });
    const slot = host.querySelector<HTMLElement>(slotSelector)!;
    expect(slot.style.visibility).toBe("hidden");
    expect(slot.style.pointerEvents).toBe("none");
    expect(onWarm).not.toHaveBeenCalled();

    await render();
    expect(host.querySelector(slotSelector)).toBe(slot);
    expect(slot.style.visibility).toBe("visible");
    expect(slot.style.pointerEvents).toBe("auto");
    await act(async () => observed.get(slot)!(0));
    expect(onWarm).not.toHaveBeenCalled();

    await render({ beat: { ...beat, telegram_file_id: null } });
    await act(async () => observed.get(slot)!(1));
    expect(onWarm).not.toHaveBeenCalled();

    await render({ visible: false });
    expect(onWarm).not.toHaveBeenCalled();
    await render({ playbackInteractive: false });
    expect(onWarm).not.toHaveBeenCalled();

    await render();
    expect(onWarm).toHaveBeenCalledTimes(1);
    expect(onWarm).toHaveBeenCalledWith(beat);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
