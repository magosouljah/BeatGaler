import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

const { editorCommit } = vi.hoisted(() => ({ editorCommit: vi.fn() }));

vi.mock("../../src/platform", () => ({
  platform: {
    kind: "web",
    capabilities: {
      reviewBeatCloudCommit: false,
      browserCloudEditing: true,
      directGalerCloudTransport: false,
    },
    importer: {
      slotFilesForBeat: () => ({}),
      pickSlotFile: vi.fn(async () => null),
    },
    editor: {
      pickFile: vi.fn(async () => null),
      commit: editorCommit,
    },
  },
}));

import Drawer from "../../src/components/Drawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function beat(): Beat {
  return {
    id: "cloud-edit-1",
    name: "Before",
    folder_path: "",
    mp3_path: "",
    wav_path: null,
    playback_path: "",
    bpm: "120",
    key: "Cm",
    needs_resolution: false,
    tags: [],
    rating: 1,
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
    cloud_status: "CLOUD_ONLY",
    assets: {
      master: { object_id: "direct:10", revision: null, filename: "Before.mp3", mime_type: "audio/mpeg", size_bytes: 10 },
      wav: null,
      artwork: null,
      project: null,
      samples: null,
      stems: null,
      loop: null,
    },
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  editorCommit.mockReset();
  document.body.innerHTML = "";
});

describe("Web edit Drawer", () => {
  it("routes Save Changes through the transactional Web editor and awaits it", async () => {
    const source = beat();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    editorCommit.mockImplementation(async (_original, updated, _files, onProgress) => {
      onProgress?.({ stage: "library", uploadedBytes: 0, totalBytes: 0 });
      await pending;
      return { ...updated, telegram_file_id: "direct:10", telegram_message_id: 10 };
    });
    const onSaved = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    cleanup = async () => act(async () => root.unmount());

    await act(async () => {
      root.render(<Drawer
        beat={source}
        mode="edit"
        closeAfterSave={false}
        mutationAllowed
        onClose={() => undefined}
        onSaved={onSaved}
        onReleaseAudio={() => undefined}
      />);
    });
    expect(host.textContent).toContain("GALER CLOUD");
    expect(host.textContent).toContain("Before.mp3");
    const name = host.querySelector("input[value='Before']") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "After");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(host.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Save changes") as HTMLButtonElement;

    await act(async () => save.click());
    expect(editorCommit).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(save.disabled).toBe(true);

    await act(async () => {
      finish();
      await pending;
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onSaved.mock.calls[0][0].name).toBe("After");
  });
});
