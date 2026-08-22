import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

vi.mock("../../src/platform", () => ({
  platform: {
    kind: "web",
    capabilities: {
      reviewBeatCloudCommit: true,
      directGalerCloudTransport: false,
    },
    importer: {
      slotFilesForBeat: () => ({ MASTER: { name: "Review Beat.mp3" } }),
      pickSlotFile: vi.fn(async () => null),
    },
  },
}));

import Drawer from "../../src/components/Drawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function beat(): Beat {
  return {
    id: "review-1",
    name: "Review Beat",
    folder_path: "web-file://review-1",
    mp3_path: "Review Beat.mp3",
    wav_path: null,
    playback_path: "blob:review",
    bpm: "120",
    key: "Cm",
    needs_resolution: false,
    tags: [],
    rating: 0,
    image_base64: "data:image/png;base64,iVBORw==",
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
    color: "#777777",
    color2: "#999999",
    has_loop: false,
    loop_path: null,
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

describe("Review Beat Web Save progress", () => {
  it("keeps Review saving until the durable commit resolves and renders byte progress", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const onSaved = vi.fn((_beat: Beat, onProgress?: (progress: any) => void) => {
      onProgress?.({ stage: "master", uploadedBytes: 5, totalBytes: 10 });
      return pending;
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    cleanup = async () => act(async () => root.unmount());

    await act(async () => {
      root.render(<Drawer
        beat={beat()}
        mode="edit"
        reviewInfo={{ current: 1, total: 1 }}
        closeAfterSave={false}
        mutationAllowed
        onClose={() => undefined}
        onSaved={onSaved}
        onReleaseAudio={() => undefined}
      />);
    });
    const save = Array.from(host.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Save and finish") as HTMLButtonElement;

    await act(async () => save.click());
    expect(onSaved).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Saving 50%…");
    expect(save.disabled).toBe(true);

    await act(async () => {
      finish();
      await pending;
    });
    expect(host.textContent).toContain("Save and finish");
  });
});
